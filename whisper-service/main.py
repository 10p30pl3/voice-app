import asyncio
import time
import json
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, UploadFile, File
from fastapi.responses import JSONResponse
from contextlib import asynccontextmanager

from priority_worker import PriorityInferenceWorker
from classifier import AMDClassifier
from pii_redactor import redact_pii

worker = PriorityInferenceWorker()
classifier = AMDClassifier()

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Inicializa o worker do Whisper no boot
    await worker.start()
    yield
    worker.stop()

app = FastAPI(title="Whisper Voice IA (AMD + STT Engine)", lifespan=lifespan)

# Métricas simples em memória
stats = {
    "total_connections": 0,
    "active_connections": 0,
    "amd_decisions": 0,
    "stt_transcriptions": 0
}

@app.get("/healthz")
async def health_check():
    return {
        "status": "ok",
        "model": worker.model_size,
        "device": worker.device,
        "queue_size": len(worker.queue),
        "stats": stats
    }

@app.post("/v1/transcribe")
async def transcribe_file(file: UploadFile = File(...)):
    """Transcrição sob demanda de arquivo de áudio (Fila P2 - Baixa prioridade)"""
    content = await file.read()
    # Converte PCM16 para float32
    audio_int16 = np.frombuffer(content, dtype=np.int16)
    audio_float32 = audio_int16.astype(np.float32) / 32768.0

    raw_text = await worker.submit_task(audio_float32, priority=2)
    clean_text = redact_pii(raw_text)

    stats["stt_transcriptions"] += 1
    return {"text": clean_text}

@app.websocket("/ws/audio")
async def audio_stream_endpoint(
    websocket: WebSocket,
    call_id: str = Query("unknown"),
    tenant_id: str = Query("default"),
    amd: bool = Query(True),
    stt: bool = Query(False),
    mode: str = Query("active")
):
    await websocket.accept()
    stats["total_connections"] += 1
    stats["active_connections"] += 1

    start_time = time.time()
    audio_buffer = [] # Lista de buffers float32
    speech_samples = 0
    total_samples = 0
    silence_samples = 0
    amd_decided = False

    # VAD simples e ultrarrápido em CPU (RMS por chunk)
    VAD_THRESHOLD = 0.015 # Threshold normalizado de energia para voz ativa
    CHUNK_SAMPLES = 320 # 20ms a 16kHz

    try:
        while True:
            data = await websocket.receive()

            if "bytes" in data and data["bytes"]:
                chunk = data["bytes"]
                # Converte bytes PCM16 LE para float32 normalizado (-1.0 a 1.0)
                pcm16 = np.frombuffer(chunk, dtype=np.int16)
                if len(pcm16) == 0:
                    continue

                f32 = pcm16.astype(np.float32) / 32768.0
                audio_buffer.append(f32)
                total_samples += len(f32)

                # Cálculo de energia do bloco
                rms = np.sqrt(np.mean(f32 ** 2)) if len(f32) > 0 else 0
                if rms > VAD_THRESHOLD:
                    speech_samples += len(f32)
                    silence_samples = 0
                else:
                    silence_samples += len(f32)

                speech_ms = int((speech_samples / 16000.0) * 1000)
                silence_ms = int((silence_samples / 16000.0) * 1000)
                elapsed_ms = int((time.time() - start_time) * 1000)

                # --- 1. LÓGICA DE DECISÃO DO AMD (Fila P0) ---
                if amd and not amd_decided:
                    should_decide = False
                    is_silence_timeout = False

                    # Condição A: Silêncio absoluto após 2.2s de ligação
                    if elapsed_ms >= 2200 and speech_ms < 150:
                        should_decide = True
                        is_silence_timeout = True

                    # Condição B: Fala inicial detectada seguida de pausa dialógica (ex: "Alô?" -> pausa)
                    elif speech_ms >= 300 and silence_ms >= 350:
                        should_decide = True

                    # Condição C: Limite de tempo de fala (acumulou 1.8s a 2.0s de áudio)
                    elif speech_ms >= 1800 or elapsed_ms >= 2400:
                        should_decide = True

                    if should_decide:
                        amd_decided = True
                        stats["amd_decisions"] += 1

                        if is_silence_timeout:
                            decision = {
                                "type": "decision",
                                "call_id": call_id,
                                "label": "silencio",
                                "confidence": 0.98,
                                "transcript": "",
                                "speech_ms": speech_ms,
                                "elapsed_ms": elapsed_ms,
                                "reason": "silence_timeout"
                            }
                        else:
                            # Submete áudio para o Whisper na Prioridade 0 (Fura fila!)
                            full_audio = np.concatenate(audio_buffer)
                            raw_transcript = await worker.submit_task(full_audio, priority=0)
                            transcript = redact_pii(raw_transcript)

                            clf_result = classifier.classify(
                                text=transcript,
                                speech_ms=speech_ms,
                                silence_ms=silence_ms,
                                is_early_media=False
                            )

                            decision = {
                                "type": "decision",
                                "call_id": call_id,
                                "label": clf_result["label"],
                                "confidence": clf_result["confidence"],
                                "transcript": transcript,
                                "speech_ms": speech_ms,
                                "elapsed_ms": elapsed_ms,
                                "reason": clf_result["reason"],
                                "probas": clf_result.get("probas", {})
                            }

                        await websocket.send_text(json.dumps(decision))

                        # Se não contratou STT, pode encerrar o WebSocket
                        if not stt:
                            break

                # --- 2. LÓGICA DE TRANSCRIÇÃO CONTÍNUA (STT) (Fila P1) ---
                if stt and amd_decided:
                    # Quando detecta fim de frase pelo silêncio ou buffer de 3 segundos
                    if (speech_ms >= 500 and silence_ms >= 600) or total_samples >= (16000 * 4):
                        if audio_buffer:
                            phrase_audio = np.concatenate(audio_buffer)
                            audio_buffer = [] # Reseta buffer para a próxima frase
                            speech_samples = 0
                            silence_samples = 0
                            total_samples = 0

                            raw_stt = await worker.submit_task(phrase_audio, priority=1)
                            clean_stt = redact_pii(raw_stt)

                            if clean_stt.strip():
                                stats["stt_transcriptions"] += 1
                                await websocket.send_text(json.dumps({
                                    "type": "transcript",
                                    "call_id": call_id,
                                    "text": clean_stt,
                                    "speech_ms": speech_ms,
                                    "is_final": True
                                }))

            elif "text" in data and data["text"]:
                try:
                    payload = json.loads(data["text"])
                    if payload.get("type") == "stop":
                        break
                except:
                    pass

    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[WS] Erro na sessão {call_id}: {e}")
    finally:
        stats["active_connections"] = Math_max = max(0, stats["active_connections"] - 1)

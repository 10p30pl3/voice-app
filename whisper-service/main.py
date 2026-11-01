import asyncio
import time
import json
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, UploadFile, File
from contextlib import asynccontextmanager

from priority_worker import PriorityInferenceWorker
from classifier import AMDClassifier
from pii_redactor import redact_pii

worker = PriorityInferenceWorker()
classifier = AMDClassifier()

@asynccontextmanager
async def lifespan(app: FastAPI):
    await worker.start()
    yield
    worker.stop()

app = FastAPI(title="Whisper Voice IA (AMD + STT Engine)", lifespan=lifespan)

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
        "num_workers": worker.num_workers,
        "queue_size": len(worker.queue),
        "stats": stats
    }

@app.post("/v1/transcribe")
async def transcribe_file(file: UploadFile = File(...)):
    """Transcrição sob demanda de arquivo de áudio (Fila P2 - Baixa prioridade)"""
    content = await file.read()
    # Se for arquivo WAV (cabeçalho RIFF de 44 bytes), remove o cabeçalho
    if len(content) > 44 and content[:4] == b"RIFF":
        content = content[44:]
    # Garante tamanho par para int16
    if len(content) % 2 != 0:
        content = content[:-1]
    if len(content) == 0:
        return {"text": ""}

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
    audio_buffer = []
    speech_samples = 0
    total_samples = 0
    silence_samples = 0
    # Se amd=False (Modo Somente STT), amd_decided já inicia como True para liberar o STT imediatamente
    amd_decided = not amd

    VAD_THRESHOLD = 0.015

    try:
        while True:
            data = await websocket.receive()

            if "bytes" in data and data["bytes"]:
                chunk = data["bytes"]
                if len(chunk) % 2 != 0:
                    chunk = chunk[:-1]
                if len(chunk) == 0:
                    continue

                pcm16 = np.frombuffer(chunk, dtype=np.int16)
                f32 = pcm16.astype(np.float32) / 32768.0
                audio_buffer.append(f32)
                total_samples += len(f32)

                rms = float(np.sqrt(np.mean(f32 ** 2)))
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

                    # Condição C: Limite de tempo de fala (acumulou 1.8s a 2.4s de áudio)
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
                            full_audio = np.concatenate(audio_buffer) if audio_buffer else np.zeros(0, dtype=np.float32)
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

                        # Limpa os acumuladores do AMD para não duplicar áudio caso o STT contínuo esteja ativo
                        audio_buffer = []
                        speech_samples = 0
                        silence_samples = 0
                        total_samples = 0

                        await websocket.send_text(json.dumps(decision))

                        # Se for "Somente AMD" (sem STT), encerra a conexão imediatamente
                        if not stt:
                            break

                # --- 2. LÓGICA DE TRANSCRIÇÃO CONTÍNUA (STT) (Fila P1) ---
                elif stt and amd_decided:
                    if (speech_ms >= 400 and silence_ms >= 550) or total_samples >= (16000 * 4):
                        if audio_buffer and speech_ms >= 200:
                            phrase_audio = np.concatenate(audio_buffer)
                            phrase_speech_ms = speech_ms
                            audio_buffer = []
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
                                    "speech_ms": phrase_speech_ms,
                                    "is_final": True
                                }))
                        elif total_samples >= (16000 * 4):
                            # Descarta silêncio acumulado > 4s para não crescer memória
                            audio_buffer = []
                            speech_samples = 0
                            silence_samples = 0
                            total_samples = 0

            elif "text" in data and data["text"]:
                try:
                    payload = json.loads(data["text"])
                    if payload.get("type") == "stop":
                        break
                except Exception:
                    pass

    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[WS] Erro na sessão {call_id}: {e}")
    finally:
        stats["active_connections"] = max(0, stats["active_connections"] - 1)

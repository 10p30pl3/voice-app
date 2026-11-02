import os
import asyncio
import time
import json
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, UploadFile, File
from contextlib import asynccontextmanager

from priority_worker import PriorityInferenceWorker
from classifier import AMDClassifier
from pii_redactor import redact_pii
from speaker_verifier import speaker_verifier, MODEL_PATHS

worker = PriorityInferenceWorker()
classifier = AMDClassifier()

@asynccontextmanager
async def lifespan(app: FastAPI):
    await worker.start()
    yield
    worker.stop()

app = FastAPI(title="Whisper Voice IA (AMD + STT + Biometrics Engine)", lifespan=lifespan)

stats = {
    "total_connections": 0,
    "active_connections": 0,
    "amd_decisions": 0,
    "stt_transcriptions": 0,
    "speaker_verifications": 0
}

@app.get("/healthz")
async def health_check():
    return {
        "status": "ok",
        "model": worker.model_size,
        "device": worker.device,
        "num_workers": worker.num_workers,
        "queue_size": len(worker.queue),
        "speaker_models": {
            "wespeaker": os.path.exists(MODEL_PATHS["wespeaker"]),
            "ecapa": os.path.exists(MODEL_PATHS["ecapa"])
        },
        "stats": stats
    }

@app.post("/v1/transcribe")
async def transcribe_file(file: UploadFile = File(...)):
    """Transcrição sob demanda de arquivo de áudio (Fila P2 - Baixa prioridade)"""
    content = await file.read()
    if len(content) > 44 and content[:4] == b"RIFF":
        content = content[44:]
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

@app.post("/v1/speaker/verify")
async def verify_speakers_api(
    file1: UploadFile = File(...),
    file2: UploadFile = File(...),
    model: str = Query("wespeaker"),
    threshold: float = Query(0.55)
):
    """
    Compara dois áudios usando WeSpeaker (CAM++) ou ECAPA-TDNN para verificar se pertencem ao mesmo locutor
    """
    c1 = await file1.read()
    c2 = await file2.read()
    if len(c1) > 44 and c1[:4] == b"RIFF": c1 = c1[44:]
    if len(c2) > 44 and c2[:4] == b"RIFF": c2 = c2[44:]
    if len(c1) % 2 != 0: c1 = c1[:-1]
    if len(c2) % 2 != 0: c2 = c2[:-1]

    a1 = np.frombuffer(c1, dtype=np.int16).astype(np.float32) / 32768.0
    a2 = np.frombuffer(c2, dtype=np.int16).astype(np.float32) / 32768.0

    emb1 = speaker_verifier.extract_embedding(a1, model_name=model)
    emb2 = speaker_verifier.extract_embedding(a2, model_name=model)
    sim = speaker_verifier.cosine_similarity(emb1, emb2)

    stats["speaker_verifications"] += 1
    return {
        "model": model,
        "similarity": round(sim, 4),
        "threshold": threshold,
        "is_match": bool(sim >= threshold)
    }

@app.websocket("/ws/audio")
async def audio_stream_endpoint(
    websocket: WebSocket,
    call_id: str = Query("unknown"),
    tenant_id: str = Query("default"),
    amd: bool = Query(True),
    stt: bool = Query(False),
    mode: str = Query("active"),
    spk_filter: str = Query("none"), # "none", "wespeaker", "ecapa"
    spk_threshold: float = Query(0.55)
):
    await websocket.accept()
    stats["total_connections"] += 1
    stats["active_connections"] += 1

    start_time = time.time()
    audio_buffer = []
    speech_samples = 0
    total_samples = 0
    silence_samples = 0
    # Se amd=False, amd_decided já inicia como True para liberar STT/Biometria imediatamente
    amd_decided = not amd
    speaker_enrolled = False
    is_spk_active = spk_filter.lower() in ["wespeaker", "ecapa"]

    BASE_VAD_THRESHOLD = 0.015
    noise_floor = 0.008

    try:
        while True:
            data = await websocket.receive()
            if data.get("type") == "websocket.disconnect":
                break

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
                dynamic_threshold = max(BASE_VAD_THRESHOLD, min(0.06, noise_floor * 2.2))

                if rms > dynamic_threshold:
                    speech_samples += len(f32)
                    silence_samples = 0
                else:
                    silence_samples += len(f32)
                    noise_floor = 0.92 * noise_floor + 0.08 * rms
                    if speech_samples == 0 and len(audio_buffer) > 10:
                        dropped = audio_buffer.pop(0)
                        total_samples = max(0, total_samples - len(dropped))

                speech_ms = int((speech_samples / 16000.0) * 1000)
                silence_ms = int((silence_samples / 16000.0) * 1000)
                elapsed_ms = int((time.time() - start_time) * 1000)

                # --- 1. LÓGICA DE DECISÃO DO AMD (Fila P0) ---
                if amd and not amd_decided:
                    should_decide = False
                    is_silence_timeout = False

                    if elapsed_ms >= 2200 and speech_ms < 150:
                        should_decide = True
                        is_silence_timeout = True
                    elif speech_ms >= 300 and silence_ms >= 350:
                        should_decide = True
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

                            # Auto-Enrollment Biométrico imediato no 1º turno de fala humana
                            if is_spk_active and not speaker_enrolled and len(full_audio) >= 4800:
                                enroll_res = speaker_verifier.enroll(call_id, full_audio, model_name=spk_filter)
                                if enroll_res.get("success"):
                                    speaker_enrolled = True
                                    try:
                                        await websocket.send_text(json.dumps({
                                            "type": "speaker_enrolled",
                                            "call_id": call_id,
                                            "model": spk_filter,
                                            "duration_s": enroll_res.get("duration_s", 0)
                                        }))
                                    except Exception:
                                        pass

                        audio_buffer = []
                        speech_samples = 0
                        silence_samples = 0
                        total_samples = 0

                        try:
                            await websocket.send_text(json.dumps(decision))
                        except Exception:
                            break

                        if not stt and not is_spk_active:
                            break

                # --- 2. LÓGICA DE BIOMETRIA VOCAL CONTÍNUA & STT (Fila P1) ---
                elif (stt or is_spk_active) and amd_decided:
                    if (speech_ms >= 400 and silence_ms >= 400) or total_samples >= (16000 * 3):
                        if audio_buffer and speech_ms >= 200:
                            phrase_audio = np.concatenate(audio_buffer)
                            phrase_speech_ms = speech_ms
                            audio_buffer = []
                            speech_samples = 0
                            silence_samples = 0
                            total_samples = 0

                            # Auto-Enrollment (caso o AMD tenha vindo desabilitado ou não tenha cadastrado antes)
                            if is_spk_active and not speaker_enrolled and len(phrase_audio) >= 4800:
                                enroll_res = speaker_verifier.enroll(call_id, phrase_audio, model_name=spk_filter)
                                if enroll_res.get("success"):
                                    speaker_enrolled = True
                                    try:
                                        await websocket.send_text(json.dumps({
                                            "type": "speaker_enrolled",
                                            "call_id": call_id,
                                            "model": spk_filter,
                                            "duration_s": enroll_res.get("duration_s", 0)
                                        }))
                                    except Exception:
                                        pass
                            # Verificação Biométrica Contínua
                            elif is_spk_active and speaker_enrolled and len(phrase_audio) >= 3200:
                                ver_res = speaker_verifier.verify(
                                    call_id, phrase_audio, model_name=spk_filter, threshold=spk_threshold
                                )
                                stats["speaker_verifications"] += 1
                                try:
                                    await websocket.send_text(json.dumps({
                                        "type": "speaker_verification",
                                        "call_id": call_id,
                                        "model": spk_filter,
                                        "is_match": ver_res["is_match"],
                                        "similarity": ver_res["similarity"],
                                        "threshold": spk_threshold
                                    }))
                                except Exception:
                                    break

                            # STT via Whisper
                            if stt:
                                raw_stt = await worker.submit_task(phrase_audio, priority=1)
                                clean_stt = redact_pii(raw_stt)

                                if clean_stt.strip():
                                    stats["stt_transcriptions"] += 1
                                    try:
                                        await websocket.send_text(json.dumps({
                                            "type": "transcript",
                                            "call_id": call_id,
                                            "text": clean_stt,
                                            "speech_ms": phrase_speech_ms,
                                            "is_final": True
                                        }))
                                    except Exception:
                                        break
                        elif total_samples >= (16000 * 3):
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
        speaker_verifier.clear_call(call_id)
        stats["active_connections"] = max(0, stats["active_connections"] - 1)

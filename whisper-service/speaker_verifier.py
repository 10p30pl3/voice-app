import os
import time
import numpy as np
import onnxruntime as ort
import torch
import torchaudio.compliance.kaldi as kaldi

# Diretório padrão para modelos ONNX
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.environ.get("MODELS_DIR", os.path.join(BASE_DIR, "models"))
if not os.path.exists(MODELS_DIR):
    # Fallback para o path do host caso executado fora do container
    alt_dir = "/home/rmimura/mini-jambonz-lab/models"
    if os.path.exists(alt_dir):
        MODELS_DIR = alt_dir

MODEL_PATHS = {
    "wespeaker": os.path.join(MODELS_DIR, "campplus.onnx"),
    "ecapa": os.path.join(MODELS_DIR, "ecapa512.onnx")
}

class SpeakerVerifierManager:
    """
    Gerenciador de Biometria Vocal de Locutor (WeSpeaker CAM++ e ECAPA-TDNN)
    Permite auto-enrollment na 1ª fala e verificação contínua para rejeição de vozes de fundo.
    """
    def __init__(self):
        self.sessions = {}
        self.enrolled_speakers = {} # call_id -> {'embedding': np.ndarray, 'model': str, 'created_at': float}

    def _get_session(self, model_name: str):
        model_key = "ecapa" if "ecapa" in model_name.lower() else "wespeaker"
        if model_key in self.sessions:
            return self.sessions[model_key]

        path = MODEL_PATHS.get(model_key)
        if not path or not os.path.exists(path):
            raise FileNotFoundError(f"Modelo ONNX '{model_key}' não encontrado em: {path}")

        opts = ort.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 2
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

        session = ort.InferenceSession(path, sess_options=opts)
        self.sessions[model_key] = session
        print(f"[SpeakerVerifier] 🟢 Modelo '{model_key.upper()}' carregado com sucesso ({path})")
        return session

    def extract_embedding(self, audio_float32: np.ndarray, model_name: str = "wespeaker") -> np.ndarray:
        """
        Extrai vetor embedding (512-dim L2 normalizado) de áudio 16kHz float32 [-1.0, 1.0]
        """
        if len(audio_float32) < 3200: # Mínimo 200ms de áudio
            return np.zeros(512, dtype=np.float32)

        session = self._get_session(model_name)

        # Tensor de áudio em escala int16 [-32768, 32767]
        waveform = torch.from_numpy(audio_float32).unsqueeze(0).float() * 32768.0

        # Kaldi 80-dim log-mel filterbank (janela 25ms, shift 10ms)
        feats = kaldi.fbank(
            waveform,
            num_mel_bins=80,
            frame_length=25,
            frame_shift=10,
            dither=0.0,
            sample_frequency=16000,
            window_type="hamming",
            use_energy=False
        )

        # Cepstral Mean Normalization (CMN)
        feats = feats - torch.mean(feats, dim=0)
        feats_np = feats.unsqueeze(0).numpy() # Shape [1, T, 80]

        outputs = session.run(["embs"], {"feats": feats_np})
        emb = outputs[0][0] # Shape [512]

        norm = np.linalg.norm(emb)
        if norm > 1e-6:
            emb = emb / norm
        return emb

    def cosine_similarity(self, e1: np.ndarray, e2: np.ndarray) -> float:
        dot = np.dot(e1, e2)
        norm1 = np.linalg.norm(e1)
        norm2 = np.linalg.norm(e2)
        if norm1 <= 1e-6 or norm2 <= 1e-6:
            return 0.0
        return float(dot / (norm1 * norm2))

    def enroll(self, call_id: str, audio_float32: np.ndarray, model_name: str = "wespeaker") -> dict:
        """
        Cadastra a assinatura biométrica vocal do titular no 1º turno da chamada
        """
        emb = self.extract_embedding(audio_float32, model_name=model_name)
        if np.linalg.norm(emb) < 1e-3:
            return {"success": False, "reason": "audio_too_short"}

        model_key = "ecapa" if "ecapa" in model_name.lower() else "wespeaker"
        self.enrolled_speakers[call_id] = {
            "embedding": emb,
            "model": model_key,
            "created_at": time.time(),
            "samples": len(audio_float32)
        }
        return {
            "success": True,
            "call_id": call_id,
            "model": model_key,
            "duration_s": round(len(audio_float32) / 16000.0, 2)
        }

    def verify(self, call_id: str, audio_float32: np.ndarray, model_name: str = "wespeaker", threshold: float = 0.55) -> dict:
        """
        Verifica se o áudio recente pertence ao titular cadastrado
        """
        enrolled = self.enrolled_speakers.get(call_id)
        if not enrolled:
            return {
                "enrolled": False,
                "is_match": True, # Fail-open se ainda não foi cadastrado
                "similarity": 1.0,
                "threshold": threshold,
                "model": model_name
            }

        emb = self.extract_embedding(audio_float32, model_name=model_name)
        sim = self.cosine_similarity(emb, enrolled["embedding"])
        is_match = bool(sim >= threshold)

        return {
            "enrolled": True,
            "is_match": is_match,
            "similarity": round(sim, 4),
            "threshold": threshold,
            "model": enrolled["model"]
        }

    def clear_call(self, call_id: str):
        if call_id in self.enrolled_speakers:
            del self.enrolled_speakers[call_id]

# Instância singleton global
speaker_verifier = SpeakerVerifierManager()

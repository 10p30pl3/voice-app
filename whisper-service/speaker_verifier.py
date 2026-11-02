import os
import time
import threading
import numpy as np
import onnxruntime as ort
import kaldi_native_fbank as knf

# Diretório dos modelos ONNX (montado como volume em /app/models; configurável via MODELS_DIR)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.environ.get("MODELS_DIR", os.path.join(BASE_DIR, "models"))

MODEL_PATHS = {
    "wespeaker": os.path.join(MODELS_DIR, "campplus.onnx"),
    "ecapa": os.path.join(MODELS_DIR, "ecapa512.onnx")
}

# Limiares padrão por modelo, calibrados com scripts/eval_synthetic_telephony.py (8 vozes, canal G.711
# simulado, janela de 1.5s). WeSpeaker 0.38: FRR ~1-3% / FAR ~7-13% (limpo); ECAPA 0.40: FRR 0-9% / FAR ~8-12%.
# ATENÇÃO: limiares como 0.55-0.65 (comuns em áudio de banda larga) bloqueariam o PRÓPRIO titular em
# telefonia (FRR 40-90%).
DEFAULT_THRESHOLDS = {
    "wespeaker": 0.38,
    "ecapa": 0.40
}

# Se a similaridade ficar este tanto abaixo do limiar, uma única janela já basta para bloquear;
# caso contrário exigimos 2 janelas consecutivas abaixo do limiar (evita bloquear o titular por ruído pontual).
HARD_REJECT_MARGIN = 0.15
CONSECUTIVE_REJECTS = 2

SAMPLE_RATE = 16000


def model_key_of(model_name: str) -> str:
    return "ecapa" if "ecapa" in (model_name or "").lower() else "wespeaker"


def compute_fbank(audio_float32: np.ndarray) -> np.ndarray:
    """
    Kaldi 80-dim log-mel fbank (25ms / 10ms, hamming, sem dither) + CMN.
    Equivalente a torchaudio.compliance.kaldi.fbank (erro máx ~3e-4), sem depender de torch.
    """
    opts = knf.FbankOptions()
    opts.frame_opts.dither = 0.0
    opts.frame_opts.samp_freq = SAMPLE_RATE
    opts.frame_opts.frame_length_ms = 25
    opts.frame_opts.frame_shift_ms = 10
    opts.frame_opts.window_type = "hamming"
    opts.mel_opts.num_bins = 80
    opts.use_energy = False

    fb = knf.OnlineFbank(opts)
    fb.accept_waveform(SAMPLE_RATE, (audio_float32 * 32768.0).tolist())
    fb.input_finished()
    n = fb.num_frames_ready
    if n == 0:
        return np.zeros((0, 80), dtype=np.float32)
    feats = np.stack([fb.get_frame(i) for i in range(n)]).astype(np.float32)
    return feats - feats.mean(axis=0, keepdims=True)


class SpeakerVerifierManager:
    """
    Gerenciador de Biometria Vocal de Locutor (WeSpeaker CAM++ e ECAPA-TDNN).
    Thread-safe: as chamadas bloqueantes (extract/enroll/verify) devem ser executadas fora do
    event loop (asyncio.to_thread).
    """
    def __init__(self):
        self.sessions = {}
        self.enrolled_speakers = {}  # call_id -> {'embedding', 'model', 'created_at', 'samples'}
        self._lock = threading.Lock()

    def _get_session(self, model_name: str):
        model_key = model_key_of(model_name)
        with self._lock:
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
            print(f"[SpeakerVerifier] 🟢 Modelo '{model_key.upper()}' carregado ({path})")
            return session

    def models_available(self) -> dict:
        return {k: os.path.exists(p) for k, p in MODEL_PATHS.items()}

    def extract_embedding(self, audio_float32: np.ndarray, model_name: str = "wespeaker") -> np.ndarray:
        """Vetor embedding (512-dim L2 normalizado) de áudio 16kHz float32 [-1.0, 1.0]."""
        if len(audio_float32) < 3200:  # mínimo 200ms
            return np.zeros(512, dtype=np.float32)

        session = self._get_session(model_name)
        feats = compute_fbank(audio_float32)
        if feats.shape[0] < 20:
            return np.zeros(512, dtype=np.float32)

        emb = session.run(["embs"], {"feats": feats[np.newaxis, :, :]})[0][0]
        norm = np.linalg.norm(emb)
        if norm > 1e-6:
            emb = emb / norm
        return emb

    @staticmethod
    def cosine_similarity(e1: np.ndarray, e2: np.ndarray) -> float:
        n1 = np.linalg.norm(e1)
        n2 = np.linalg.norm(e2)
        if n1 <= 1e-6 or n2 <= 1e-6:
            return 0.0
        return float(np.dot(e1, e2) / (n1 * n2))

    def enroll(self, call_id: str, audio_float32: np.ndarray, model_name: str = "wespeaker") -> dict:
        """Cadastra a assinatura vocal do titular (embedding de fala >= ~1s)."""
        emb = self.extract_embedding(audio_float32, model_name=model_name)
        if np.linalg.norm(emb) < 1e-3:
            return {"success": False, "reason": "audio_too_short"}

        model_key = model_key_of(model_name)
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
            "duration_s": round(len(audio_float32) / float(SAMPLE_RATE), 2)
        }

    def verify(self, call_id: str, audio_float32: np.ndarray, model_name: str = "wespeaker",
               threshold: float = None) -> dict:
        """Verifica se o áudio recente pertence ao titular cadastrado."""
        model_key = model_key_of(model_name)
        if threshold is None:
            threshold = DEFAULT_THRESHOLDS[model_key]

        enrolled = self.enrolled_speakers.get(call_id)
        if not enrolled:
            # Fail-open enquanto não houver cadastro
            return {"enrolled": False, "is_match": True, "similarity": 1.0,
                    "threshold": threshold, "model": model_key}

        emb = self.extract_embedding(audio_float32, model_name=model_name)
        if np.linalg.norm(emb) < 1e-3:
            # Janela curta demais para decidir: não bloqueia
            return {"enrolled": True, "is_match": True, "similarity": 1.0,
                    "threshold": threshold, "model": model_key, "inconclusive": True}

        sim = self.cosine_similarity(emb, enrolled["embedding"])
        return {
            "enrolled": True,
            "is_match": bool(sim >= threshold),
            "similarity": round(sim, 4),
            "threshold": threshold,
            "model": enrolled["model"]
        }

    def clear_call(self, call_id: str):
        self.enrolled_speakers.pop(call_id, None)


# Instância singleton global
speaker_verifier = SpeakerVerifierManager()


class SpeakerStream:
    """
    Verificação de locutor em janela deslizante para uma chamada.

    Acumula apenas frames de FALA da rajada atual. Cadastra o titular após ENROLL_S de fala e,
    a partir daí, verifica a cada STEP_S de fala nova usando as últimas MIN..MAX_WINDOW de fala
    (decisão ainda durante a fala, e não só no fim da frase). Ao fim da rajada (silêncio),
    emite 'speaker_idle' para liberar o bloqueio e descarta os frames, de modo que a próxima
    rajada (possivelmente outro falante) não seja diluída pela anterior.

    `feed()` é barato (só contabilidade) e indica se há trabalho a fazer; `run()` faz a inferência
    e deve ser chamado fora do event loop (asyncio.to_thread).
    """

    def __init__(self, call_id: str, model_name: str, threshold: float,
                 enroll_samples=int(1.5 * SAMPLE_RATE), min_window=int(1.0 * SAMPLE_RATE),
                 max_window=int(1.5 * SAMPLE_RATE), step=int(0.4 * SAMPLE_RATE),
                 idle_samples=int(0.3 * SAMPLE_RATE), manager: SpeakerVerifierManager = None):
        self.call_id = call_id
        self.model_name = model_name
        self.threshold = threshold
        self.enroll_samples = enroll_samples
        self.min_window = min_window
        self.max_window = max_window
        self.step = step
        self.idle_samples = idle_samples
        self.mgr = manager or speaker_verifier

        self.frames = []
        self.frames_len = 0
        self.new_samples = 0
        self.idle = 0
        self.in_burst = False
        self.enrolled = False
        self.reject_run = 0

    def feed(self, f32: np.ndarray, is_speech: bool):
        """Retorna None, 'enroll', 'verify' ou 'idle'."""
        if is_speech:
            self.idle = 0
            self.in_burst = True
            self.frames.append(f32)
            self.frames_len += len(f32)
            self.new_samples += len(f32)
            # Limita memória: mantém no máximo max(enroll, max_window) de fala
            keep = max(self.enroll_samples, self.max_window)
            while self.frames_len - len(self.frames[0]) >= keep:
                self.frames_len -= len(self.frames.pop(0))

            if not self.enrolled:
                return "enroll" if self.frames_len >= self.enroll_samples else None
            if self.frames_len >= self.min_window and self.new_samples >= self.step:
                return "verify"
            return None

        self.idle += len(f32)
        if self.in_burst and self.idle >= self.idle_samples:
            self.in_burst = False
            self.reject_run = 0
            self.frames = []
            self.frames_len = 0
            self.new_samples = 0
            return "idle"
        return None

    def run(self, work: str):
        """Executa o trabalho pendente e retorna o evento (dict) a enviar, ou None."""
        if work == "idle":
            return {"type": "speaker_idle", "call_id": self.call_id}

        audio = np.concatenate(self.frames)[-self.max_window:] if self.frames else np.zeros(0, np.float32)
        self.new_samples = 0

        if work == "enroll":
            res = self.mgr.enroll(self.call_id, audio, model_name=self.model_name)
            if res.get("success"):
                self.enrolled = True
                return {"type": "speaker_enrolled", "call_id": self.call_id,
                        "model": model_key_of(self.model_name), "duration_s": res.get("duration_s", 0)}
            return None

        if work == "verify":
            res = self.mgr.verify(self.call_id, audio, model_name=self.model_name, threshold=self.threshold)
            if res.get("inconclusive"):
                return None
            # Histerese: bloqueia com rejeição forte (1 janela) ou 2 janelas consecutivas abaixo do limiar
            if res["is_match"]:
                self.reject_run = 0
            else:
                self.reject_run += 1
            hard = res["similarity"] < res["threshold"] - HARD_REJECT_MARGIN
            is_match = True if (res["is_match"] or (not hard and self.reject_run < CONSECUTIVE_REJECTS)) else False
            return {"type": "speaker_verification", "call_id": self.call_id, "model": res["model"],
                    "is_match": is_match, "raw_match": res["is_match"], "similarity": res["similarity"],
                    "threshold": res["threshold"], "window_s": round(len(audio) / SAMPLE_RATE, 2)}
        return None

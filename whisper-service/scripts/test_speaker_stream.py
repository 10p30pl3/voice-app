"""
Testes offline da SpeakerStream (janela deslizante, enrollment, histerese e idle), sem modelos ONNX.
Uso: python scripts/test_speaker_stream.py
"""
import sys
import types
import numpy as np

# Stubs para rodar sem onnxruntime / kaldi_native_fbank instalados
for name in ("onnxruntime", "kaldi_native_fbank"):
    if name not in sys.modules:
        try:
            __import__(name)
        except ImportError:
            sys.modules[name] = types.ModuleType(name)

sys.path.insert(0, ".")
sys.path.insert(0, "whisper-service")
import speaker_verifier as sv  # noqa: E402

SR = 16000
FRAME = np.zeros(320, dtype=np.float32) + 0.05  # 20ms


class FakeMgr:
    """Gerenciador falso: a similaridade devolvida é controlada pelo teste."""
    def __init__(self):
        self.sims = []
        self.enrolled = False

    def enroll(self, call_id, audio, model_name="wespeaker"):
        self.enrolled = True
        return {"success": True, "duration_s": round(len(audio) / SR, 2)}

    def verify(self, call_id, audio, model_name="wespeaker", threshold=None):
        sim = self.sims.pop(0)
        return {"enrolled": True, "is_match": sim >= threshold, "similarity": sim,
                "threshold": threshold, "model": "wespeaker"}


def drive(stream, n_frames, speech=True):
    events = []
    for _ in range(n_frames):
        work = stream.feed(FRAME, speech)
        if work:
            e = stream.run(work)
            if e:
                events.append(e)
    return events


def new_stream(mgr, thr=0.38):
    return sv.SpeakerStream("c1", "wespeaker", thr, manager=mgr)


def test_enroll_after_1_5s_of_speech():
    m = FakeMgr(); s = new_stream(m)
    assert drive(s, 70) == []                 # 1.4s -> ainda não cadastra
    ev = drive(s, 10)                          # passa de 1.5s
    assert [e["type"] for e in ev] == ["speaker_enrolled"] and m.enrolled


def test_silence_never_triggers_work():
    m = FakeMgr(); s = new_stream(m)
    assert drive(s, 500, speech=False) == []   # silêncio puro: nada a fazer (nem 'idle', sem rajada)


def test_verifies_during_speech_every_400ms():
    m = FakeMgr(); s = new_stream(m)
    drive(s, 80)                               # enroll
    m.sims = [0.6] * 20
    ev = drive(s, 100)                         # 2.0s de fala -> ~5 verificações
    assert 4 <= len(ev) <= 6 and all(e["type"] == "speaker_verification" and e["is_match"] for e in ev), ev


def test_single_mild_mismatch_does_not_block_but_two_do():
    m = FakeMgr(); s = new_stream(m, thr=0.38)
    drive(s, 80)
    m.sims = [0.30, 0.30]                      # abaixo do limiar, mas dentro da margem (>= 0.23)
    ev = drive(s, 45)                          # 0.9s de fala nova -> 2 verificações
    assert len(ev) == 2 and ev[0]["is_match"] is True and ev[1]["is_match"] is False, ev


def test_hard_mismatch_blocks_immediately():
    m = FakeMgr(); s = new_stream(m, thr=0.38)
    drive(s, 80)
    m.sims = [0.05]
    ev = drive(s, 25)
    assert len(ev) == 1 and ev[0]["is_match"] is False, ev


def test_idle_resets_burst_and_releases_block():
    m = FakeMgr(); s = new_stream(m)
    drive(s, 80)
    ev = drive(s, 20, speech=False)            # 400ms de silêncio (> 300ms)
    assert [e["type"] for e in ev] == ["speaker_idle"], ev
    assert s.frames_len == 0 and s.reject_run == 0
    # nova rajada só verifica depois de min_window de fala nova
    m.sims = [0.6]
    assert drive(s, 40) == []                  # 0.8s < 1.0s
    assert len(drive(s, 20)) == 1


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
    print("TODOS OS TESTES DA SpeakerStream PASSARAM")

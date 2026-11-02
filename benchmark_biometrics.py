import time
import numpy as np
import soundfile as sf
import onnxruntime as ort
import torch
import torchaudio
import torchaudio.compliance.kaldi as kaldi

def load_session(onnx_path):
    opts = ort.SessionOptions()
    opts.inter_op_num_threads = 1
    opts.intra_op_num_threads = 2
    return ort.InferenceSession(onnx_path, sess_options=opts)

def extract_emb(session, audio_samples, sample_rate):
    t0 = time.perf_counter()
    if not isinstance(audio_samples, torch.Tensor):
        audio_tensor = torch.from_numpy(audio_samples).float()
    else:
        audio_tensor = audio_samples.float()

    if audio_tensor.ndim == 1:
        audio_tensor = audio_tensor.unsqueeze(0)

    if sample_rate != 16000:
        resampler = torchaudio.transforms.Resample(sample_rate, 16000)
        audio_16k = resampler(audio_tensor)
    else:
        audio_16k = audio_tensor

    waveform = audio_16k * (1 << 15)

    feats = kaldi.fbank(
        waveform,
        num_mel_bins=80,
        frame_length=25,
        frame_shift=10,
        dither=0.0,
        sample_frequency=16000,
        window_type='hamming',
        use_energy=False
    )
    feats = feats - torch.mean(feats, dim=0)
    feats = feats.unsqueeze(0).numpy()

    t_feat = time.perf_counter()
    embs = session.run(['embs'], {'feats': feats})[0][0]
    t_infer = time.perf_counter()

    norm = np.linalg.norm(embs)
    if norm > 1e-6:
        embs = embs / norm

    total_ms = (t_infer - t0) * 1000
    infer_ms = (t_infer - t_feat) * 1000
    return embs, total_ms, infer_ms

def cosine_similarity(e1, e2):
    return float(np.dot(e1, e2) / (np.linalg.norm(e1) * np.linalg.norm(e2) + 1e-9))

def benchmark_model(name, model_path, test_slices):
    print(f"\n=================================================================")
    print(f"🔹 AVALIANDO MODELO: {name}")
    print(f"=================================================================")
    
    t_load_start = time.perf_counter()
    session = load_session(model_path)
    load_time_ms = (time.perf_counter() - t_load_start) * 1000
    print(f"• Tempo de Carregamento ONNX: {load_time_ms:.1f} ms")

    results = {}
    latencies = []

    for label, (audio, sr) in test_slices.items():
        dur_s = len(audio) / sr
        emb, total_ms, infer_ms = extract_emb(session, audio, sr)
        results[label] = emb
        latencies.append((dur_s, infer_ms))
        print(f"  [{label} ({dur_s:.1f}s)]: Inferencia ONNX = {infer_ms:.1f}ms (Total c/ Resample/Fbank: {total_ms:.1f}ms)")

    avg_rtf = np.mean([infer_ms / (dur_s * 1000) for dur_s, infer_ms in latencies])
    print(f"• Real-Time Factor (RTF Médio na CPU): {avg_rtf:.4f}x (Ex: 1s de fala processado em ~{avg_rtf*1000:.1f}ms)")

    # Testes de Similaridade
    # 1. Mesmo locutor com 0.5s de deslocamento
    sim_same_1 = cosine_similarity(results['speaker_A_part1'], results['speaker_A_part2'])
    # 2. Mesmo locutor com 1.5s de deslocamento
    sim_same_2 = cosine_similarity(results['speaker_A_part1'], results['speaker_A_part3'])
    # 3. Locutores cruzados (Pessoa A vs Pessoa B - IVR)
    sim_diff_1 = cosine_similarity(results['speaker_A_part1'], results['speaker_B_ivr'])
    sim_diff_2 = cosine_similarity(results['speaker_A_part2'], results['speaker_B_ivr'])

    same_avg = (sim_same_1 + sim_same_2) / 2
    diff_avg = (sim_diff_1 + sim_diff_2) / 2
    delta = same_avg - diff_avg

    print("\n📊 Resultados de Separação de Locutor:")
    print(f"  • Mesmo Locutor (Pessoa A vs Pessoa A):       {sim_same_1:.4f} / {sim_same_2:.4f} (Média: {same_avg:.4f})")
    print(f"  • Locutores Distintos (Pessoa A vs Pessoa B): {sim_diff_1:.4f} / {sim_diff_2:.4f} (Média: {diff_avg:.4f})")
    print(f"  • Margem de Separação (Delta):                +{delta:.4f} ({'EXCELENTE' if delta > 0.40 else 'BOM'})")

    return {
        'name': name,
        'rtf': avg_rtf,
        'same_avg': same_avg,
        'diff_avg': diff_avg,
        'delta': delta,
        'load_ms': load_time_ms
    }

def main():
    call_path = '/home/rmimura/Downloads/call-1773931797582.wav'
    ivr_path = '/home/rmimura/mini-jambonz-lab/audio/boasvindas.wav'

    call_data, call_sr = sf.read(call_path)
    ivr_data, ivr_sr = sf.read(ivr_path)

    # Prepara trechos de teste
    test_slices = {
        'speaker_A_part1': (ivr_data[0 : int(ivr_sr * 3.0)], ivr_sr),
        'speaker_A_part2': (ivr_data[int(ivr_sr * 0.5) : int(ivr_sr * 3.5)], ivr_sr),
        'speaker_A_part3': (ivr_data[int(ivr_sr * 1.5) : int(ivr_sr * 4.5)], ivr_sr),
        'speaker_B_ivr':   (call_data[int(call_sr * 2.0) : int(call_sr * 5.0)], call_sr)
    }

    models = [
        ("WeSpeaker CAM++ (CAMPPlus)", "/home/rmimura/mini-jambonz-lab/models/campplus.onnx"),
        ("ECAPA-TDNN 512 (WeSpeaker/SpeechBrain)", "/home/rmimura/mini-jambonz-lab/models/ecapa512.onnx")
    ]

    summaries = []
    for name, path in models:
        res = benchmark_model(name, path, test_slices)
        summaries.append(res)

    print("\n" + "="*65)
    print("🏆 COMPARATIVO FINAL: WESPEAKER CAM++ vs ECAPA-TDNN")
    print("="*65)
    print(f"{'Métrica':<30} | {'CAM++':<15} | {'ECAPA-TDNN':<15}")
    print("-" * 65)
    print(f"{'Tempo Carregamento (ms)':<30} | {summaries[0]['load_ms']:<15.1f} | {summaries[1]['load_ms']:<15.1f}")
    print(f"{'RTF Médio (CPU i5-12450H)':<30} | {summaries[0]['rtf']:<15.4f} | {summaries[1]['rtf']:<15.4f}")
    print(f"{'Latência p/ 1s áudio (ms)':<30} | {summaries[0]['rtf']*1000:<15.1f} | {summaries[1]['rtf']*1000:<15.1f}")
    print(f"{'Similaridade Mesmo Locutor':<30} | {summaries[0]['same_avg']:<15.4f} | {summaries[1]['same_avg']:<15.4f}")
    print(f"{'Similaridade Voz Diferente':<30} | {summaries[0]['diff_avg']:<15.4f} | {summaries[1]['diff_avg']:<15.4f}")
    print(f"{'Margem de Separação (Delta)':<30} | +{summaries[0]['delta']:<14.4f} | +{summaries[1]['delta']:<14.4f}")
    print("="*65)

if __name__ == '__main__':
    main()

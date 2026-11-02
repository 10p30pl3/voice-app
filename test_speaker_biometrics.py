import sys
import time
import numpy as np
import soundfile as sf
import onnxruntime as ort
import torch
import torchaudio
import torchaudio.compliance.kaldi as kaldi

ONNX_MODEL_PATH = '/home/rmimura/mini-jambonz-lab/models/campplus.onnx'

def init_extractor(model_path=ONNX_MODEL_PATH):
    opts = ort.SessionOptions()
    opts.inter_op_num_threads = 1
    opts.intra_op_num_threads = 2
    session = ort.InferenceSession(model_path, sess_options=opts)
    return session

def extract_embedding(session, audio_samples, sample_rate):
    """
    audio_samples: float32 numpy array or torch tensor in [-1.0, 1.0]
    sample_rate: 8000 or 16000
    """
    t0 = time.perf_counter()
    if not isinstance(audio_samples, torch.Tensor):
        audio_tensor = torch.from_numpy(audio_samples).float()
    else:
        audio_tensor = audio_samples.float()

    if audio_tensor.ndim == 1:
        audio_tensor = audio_tensor.unsqueeze(0)

    # Resample to 16000Hz if needed
    if sample_rate != 16000:
        resampler = torchaudio.transforms.Resample(sample_rate, 16000)
        audio_16k = resampler(audio_tensor)
    else:
        audio_16k = audio_tensor

    # Kaldi fbank expects 16-bit integer scale amplitude [-32768, 32767]
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
    # Cepstral Mean Normalization (CMN)
    feats = feats - torch.mean(feats, dim=0)
    feats = feats.unsqueeze(0).numpy()  # shape: [1, T, 80]

    t_feat = time.perf_counter()
    embs = session.run(['embs'], {'feats': feats})[0][0]  # shape: [512]
    t_infer = time.perf_counter()

    # L2 normalize
    norm = np.linalg.norm(embs)
    if norm > 1e-6:
        embs = embs / norm

    elapsed_ms = (t_infer - t0) * 1000
    infer_ms = (t_infer - t_feat) * 1000
    return embs, elapsed_ms, infer_ms

def cosine_similarity(e1, e2):
    return float(np.dot(e1, e2) / (np.linalg.norm(e1) * np.linalg.norm(e2) + 1e-9))

def main():
    print('=================================================================')
    print('TESTE DE BIOMETRIA VOCAL WE-SPEAKER (CAM++) EM GRAVACOES')
    print('=================================================================')

    session = init_extractor()
    print('Modelo CAM++ ONNX carregado com sucesso!')

    call_path = '/home/rmimura/Downloads/call-1773931797582.wav'
    ivr_path = '/home/rmimura/mini-jambonz-lab/audio/boasvindas.wav'

    call_data, call_sr = sf.read(call_path)
    ivr_data, ivr_sr = sf.read(ivr_path)

    print(f'Chamada A: {call_path} ({len(call_data)/call_sr:.1f}s @ {call_sr}Hz)')
    print(f'Voz IVR:   {ivr_path} ({len(ivr_data)/ivr_sr:.1f}s @ {ivr_sr}Hz)')
    print('-----------------------------------------------------------------')

    # Trecho 1 da Chamada: 2s a 6s (Locutor 1 da chamada)
    seg1 = call_data[int(2 * call_sr) : int(6 * call_sr)]
    # Trecho 2 da Chamada: 6s a 10s (Mesmo Locutor 1 da chamada)
    seg2 = call_data[int(6 * call_sr) : int(10 * call_sr)]

    # Trecho 1 da IVR: 0s a 4s (Locutor 2 - locutora do áudio de boas-vindas)
    ivr_seg1 = ivr_data[int(0 * ivr_sr) : int(4 * ivr_sr)]
    # Trecho 2 da IVR: 28s a 32s (Mesma Locutora 2)
    ivr_seg2 = ivr_data[int(28 * ivr_sr) : int(32 * ivr_sr)]

    print('Calculando assinaturas biometricas (Embeddings de 512 dimensoes)...')
    e1, total1, infer1 = extract_embedding(session, seg1, call_sr)
    print(f'  [Locutor 1 (Chamada) - Trecho A (02s-06s)]: Extraido em {total1:.1f}ms (Inferencia: {infer1:.1f}ms)')

    e2, total2, infer2 = extract_embedding(session, seg2, call_sr)
    print(f'  [Locutor 1 (Chamada) - Trecho B (06s-10s)]: Extraido em {total2:.1f}ms (Inferencia: {infer2:.1f}ms)')

    e_ivr1, total_ivr1, infer_ivr1 = extract_embedding(session, ivr_seg1, ivr_sr)
    print(f'  [Locutor 2 (IVR)     - Trecho A (00s-04s)]: Extraido em {total_ivr1:.1f}ms (Inferencia: {infer_ivr1:.1f}ms)')

    e_ivr2, total_ivr2, infer_ivr2 = extract_embedding(session, ivr_seg2, ivr_sr)
    print(f'  [Locutor 2 (IVR)     - Trecho B (28s-32s)]: Extraido em {total_ivr2:.1f}ms (Inferencia: {infer_ivr2:.1f}ms)')

    print('-----------------------------------------------------------------')
    print('MATRIZ DE SIMILARIDADE BIOMETRICA (COSINE SIMILARITY):')
    print('-----------------------------------------------------------------')

    # Mesmo locutor 1
    sim_call_same = cosine_similarity(e1, e2)
    # Mesmo locutor 2
    sim_ivr_same = cosine_similarity(e_ivr1, e_ivr2)
    # Locutores cruzados (Diferentes pessoas)
    sim_cross_1 = cosine_similarity(e1, e_ivr1)
    sim_cross_2 = cosine_similarity(e2, e_ivr2)
    sim_cross_3 = cosine_similarity(e1, e_ivr2)

    print(f'  * Locutor 1 (02-06s) vs Locutor 1 (06-10s) [MESMA PESSOA]:  Similaridade = {sim_call_same:.4f}  -> {"MATCH (TITULAR IDENTIFICADO)" if sim_call_same >= 0.60 else "MISMATCH"}')
    print(f'  * Locutor 2 (00-04s) vs Locutor 2 (28-32s) [MESMA PESSOA]:  Similaridade = {sim_ivr_same:.4f}  -> {"MATCH (TITULAR IDENTIFICADO)" if sim_ivr_same >= 0.60 else "MISMATCH"}')
    print('  ---------------------------------------------------------------')
    print(f'  * Locutor 1 (Chamada) vs Locutor 2 (IVR-A) [VOZ DIFERENTE]: Similaridade = {sim_cross_1:.4f}  -> {"BLOQUEADO (REJEITADO COM SUCESSO)" if sim_cross_1 < 0.50 else "FALSO POSITIVO"}')
    print(f'  * Locutor 1 (Chamada) vs Locutor 2 (IVR-B) [VOZ DIFERENTE]: Similaridade = {sim_cross_3:.4f}  -> {"BLOQUEADO (REJEITADO COM SUCESSO)" if sim_cross_3 < 0.50 else "FALSO POSITIVO"}')
    print(f'  * Locutor 1 (Chamada-B) vs Locutor 2 (IVR) [VOZ DIFERENTE]: Similaridade = {sim_cross_2:.4f}  -> {"BLOQUEADO (REJEITADO COM SUCESSO)" if sim_cross_2 < 0.50 else "FALSO POSITIVO"}')

    print('=================================================================')

if __name__ == '__main__':
    main()

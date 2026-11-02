/**
 * Filtro Biométrico de Vozes de Fundo (Biometric Voiceprint & Crosstalk Filter)
 * 
 * Extrai a assinatura acústico-biométrica da primeira pessoa que responde à chamada:
 * 1. Frequência Fundamental (Pitch F0 via estimador YIN normalizado, 75Hz - 320Hz)
 * 2. Efeito de Proximidade Espectral (Proporção de energia em graves <600Hz do mouthpiece)
 * 3. Envelope dinâmico de volume (RMS calibrado da fala direta do interlocutor)
 * 
 * Bloqueia vozes secundárias, conversas de fundo e aparelhos de som/TV que
 * possuam características vocais ou timbres diferentes da pessoa cadastrada.
 */
class CrosstalkFilter {
  constructor({
    ratio = 0.45,               // Vozes de fundo abaixo de ~45% do envelope de voz do usuário são bloqueadas
    initialUserRms = 1800,      // Estimativa inicial do envelope de fala do usuário principal (Int16 PCM 8kHz)
    minUserRms = 1200,          // Limite inferior para a referência de voz principal
    maxUserRms = 9000,          // Limite superior de volume
    maxThresholdRms = 4500,     // Teto máximo do gate proporcional a vozes próximas ao microfone
    minFloorRms = 800,          // Piso mínimo absoluto para rejeitar vozes de fundo antes da 1ª fala
    attackFrames = 3,           // Exige 3 frames consecutivos (60ms) acima do limiar para abrir o gate
    hangoverMs = 400,           // Janela de sustentação (400ms) para não picotar sílabas suaves
    frameDurationMs = 20        // Duração de cada chunk RTP (20ms = 160 samples a 8kHz)
  } = {}) {
    this.ratio = ratio;
    this.userVoiceRms = initialUserRms;
    this.minUserRms = minUserRms;
    this.maxUserRms = maxUserRms;
    this.maxThresholdRms = maxThresholdRms;
    this.minFloorRms = minFloorRms;
    this.attackFrames = Math.max(1, attackFrames);
    this.hangoverMs = hangoverMs;
    this.frameDurationMs = frameDurationMs;
    this.hangoverFrames = Math.max(1, Math.ceil(hangoverMs / frameDurationMs));

    // Assinatura Biométrica do Titular da Chamada (Owner Voiceprint)
    this.enrolled = false;
    this.enrollCount = 0;
    this.ownerPitchHz = 0;
    this.ownerLowRatio = 0;

    this.recentPitches = [];
    this.recentLowRatios = [];

    this.consecutiveAbove = 0;
    this.hangoverCounter = 0;
    this.isGateOpen = false;
    this.lastRms = 0;
    this.lastPitchHz = 0;
    this.noiseFloor = 80;
    this.speechFramesCount = 0;
    this.blockedFramesCount = 0;
    this.passedFramesCount = 0;
  }

  /**
   * Extrai características biométricas de um frame PCM16:
   * - RMS (energia linear)
   * - Proporção de graves (<600Hz, efeito de proximidade do microfone do telefone)
   * - Pitch F0 (frequência fundamental da voz via YIN CMNDF)
   */
  extractFeatures(buffer) {
    if (!buffer || buffer.length < 4) {
      return { rms: 0, voiced: false, pitchHz: 0, lowRatio: 0 };
    }
    const samplesCount = buffer.length >> 1;
    const n = Math.min(160, samplesCount);
    const samples = new Int16Array(n);
    let sumSq = 0, lp = 0, lpSq = 0;

    for (let i = 0; i < n; i++) {
      const s = buffer.readInt16LE(i * 2);
      samples[i] = s;
      sumSq += s * s;
      lp = 0.75 * lp + 0.25 * s; // Filtro passa-baixa de 1ª ordem (~600Hz)
      lpSq += lp * lp;
    }

    const rms = Math.sqrt(sumSq / n);
    if (rms < 150) {
      return { rms, voiced: false, pitchHz: 0, lowRatio: 0 };
    }

    const lowRatio = lpSq / (sumSq + 1);

    // Algoritmo YIN (CMNDF): cálculo de autocorrelação normalizada da diferença
    // Faixa vocal humana: 80Hz (lag 100) a 320Hz (lag 25) a 8kHz
    const maxLag = Math.min(100, n - 20);
    const minLag = 25;
    const cmndf = new Float32Array(maxLag + 1);
    cmndf[0] = 1;
    let runningSum = 0;

    for (let tau = 1; tau <= maxLag; tau++) {
      let diff = 0;
      for (let i = 0; i < n - maxLag; i++) {
        const delta = samples[i] - samples[i + tau];
        diff += delta * delta;
      }
      runningSum += diff;
      cmndf[tau] = runningSum > 0 ? (diff * tau) / runningSum : 1;
    }

    // Primeiro mínimo local abaixo do limiar YIN (0.32)
    let bestTau = 0;
    let minVal = 1.0;
    for (let tau = minLag; tau < maxLag; tau++) {
      if (cmndf[tau] < 0.32 && cmndf[tau] <= cmndf[tau - 1] && cmndf[tau] <= cmndf[tau + 1]) {
        bestTau = tau;
        minVal = cmndf[tau];
        break;
      }
      if (cmndf[tau] < minVal) {
        minVal = cmndf[tau];
        bestTau = tau;
      }
    }

    const voiced = minVal < 0.40 && bestTau >= minLag;
    const pitchHz = voiced ? (8000 / bestTau) : 0;
    return { rms, voiced, pitchHz, lowRatio };
  }

  /**
   * Calcula o nível de energia RMS de um buffer linear PCM16 (Int16Array)
   * @param {Buffer} buffer 
   * @returns {number} RMS (0 a 32768)
   */
  calculateRms(buffer) {
    if (!buffer || buffer.length < 2) return 0;
    const samples = buffer.length >> 1;
    let sumSquares = 0;
    for (let i = 0; i < samples; i++) {
      const s = buffer.readInt16LE(i * 2);
      sumSquares += s * s;
    }
    return Math.sqrt(sumSquares / samples) || 0;
  }

  /**
   * Processa um chunk de áudio e determina se pertence ao titular cadastrado
   * ou se é uma voz de fundo com características vocais divergentes.
   * @param {Buffer} buffer - Chunk PCM16 de 20ms
   * @returns {boolean} true se deve passar para a OpenAI, false se deve ser silenciado (voz de fundo)
   */
  process(buffer) {
    const feat = this.extractFeatures(buffer);
    this.lastRms = feat.rms;

    // Silêncio de linha ou ruído desprezível
    if (feat.rms < 200) {
      this.consecutiveAbove = 0;
      if (this.hangoverCounter > 0) {
        this.hangoverCounter--;
        this.isGateOpen = true;
        this.passedFramesCount++;
        return true;
      }
      this.isGateOpen = false;
      this.blockedFramesCount++;
      return false;
    }

    if (feat.voiced) {
      this.lastPitchHz = feat.pitchHz;
      this.recentPitches.push(feat.pitchHz);
      this.recentLowRatios.push(feat.lowRatio);
      if (this.recentPitches.length > 5) {
        this.recentPitches.shift();
        this.recentLowRatios.shift();
      }
    }

    const sortedP = this.recentPitches.slice().sort((a, b) => a - b);
    const currentPitch = sortedP.length > 0 ? sortedP[Math.floor(sortedP.length / 2)] : feat.pitchHz;
    const currentLowRatio = this.recentLowRatios.length > 0
      ? this.recentLowRatios.reduce((a, b) => a + b, 0) / this.recentLowRatios.length
      : feat.lowRatio;

    // FASE 1: Calibração da Assinatura Biométrica (Voiceprint Enrollment)
    // Aprende as características acústicas da voz dominante da chamada
    const isDominantFrame = feat.voiced && feat.rms >= Math.max(1100, this.userVoiceRms * 0.50) && currentLowRatio >= 0.30;
    if (isDominantFrame) {
      if (!this.enrolled) {
        this.ownerPitchHz = this.enrollCount === 0 ? currentPitch : (0.3 * currentPitch + 0.7 * this.ownerPitchHz);
        this.ownerLowRatio = this.enrollCount === 0 ? currentLowRatio : (0.3 * currentLowRatio + 0.7 * this.ownerLowRatio);
        this.userVoiceRms = Math.min(this.maxUserRms, Math.max(this.userVoiceRms, feat.rms * 0.85));
        this.enrollCount++;
        if (this.enrollCount >= 5) {
          this.enrolled = true;
        }
      } else {
        // Atualização suave se a fala for claramente do titular
        const weight = feat.rms > this.userVoiceRms * 1.3 ? 0.25 : 0.08;
        this.ownerPitchHz = weight * currentPitch + (1 - weight) * this.ownerPitchHz;
        this.ownerLowRatio = weight * currentLowRatio + (1 - weight) * this.ownerLowRatio;
        if (feat.rms > this.userVoiceRms) {
          this.userVoiceRms = 0.22 * Math.min(this.maxUserRms, feat.rms) + 0.78 * this.userVoiceRms;
        } else {
          this.userVoiceRms = 0.02 * feat.rms + 0.98 * this.userVoiceRms;
        }
      }
    }

    // FASE 2: Verificação Biométrica (Pitch F0 + Efeito de Proximidade)
    const pitchDiff = (this.enrolled && currentPitch > 0)
      ? Math.abs(currentPitch - this.ownerPitchHz) / this.ownerPitchHz
      : 0.5;
    const isBiometricMatch = this.enrolled && feat.voiced && pitchDiff <= 0.34 && currentLowRatio >= (this.ownerLowRatio - 0.20);

    // Limiar dinâmico inteligente:
    // - Antes da calibração (fase de saudação/primeira fala): usa o ratio padrão sobre a estimativa inicial
    // - Após a calibração biométrica:
    //   * Se as características coincidem com a voz do titular:
    //     limiar adaptativo baixo (permite falar naturalmente e suavemente a partir de ~300-950 RMS)
    //   * Se as características são de OUTRA pessoa / TV / ruído secundário:
    //     limiar alto (60% do pico do titular, mínimo 1.200 RMS) -> BLOQUEIA COMPLETAMENTE!
    const dynamicThreshold = this.enrolled
      ? (isBiometricMatch
          ? Math.max(300, Math.min(950, this.userVoiceRms * 0.22))
          : Math.max(1200, this.userVoiceRms * 0.60))
      : Math.max(300, this.userVoiceRms * this.ratio);

    const requiredAttack = isBiometricMatch ? 1 : this.attackFrames;
    if (feat.rms >= dynamicThreshold) {
      this.consecutiveAbove++;
      if (this.isGateOpen || this.consecutiveAbove >= requiredAttack) {
        this.isGateOpen = true;
        this.hangoverCounter = this.hangoverFrames;
        this.speechFramesCount++;
        this.passedFramesCount++;
        return true;
      }
      this.blockedFramesCount++;
      return false;
    }

    this.consecutiveAbove = 0;

    // Sustentação (hangover de 400ms) para não picotar finais de palavras
    if (this.hangoverCounter > 0) {
      this.hangoverCounter--;
      this.isGateOpen = true;
      this.passedFramesCount++;
      return true;
    }

    this.isGateOpen = false;
    this.blockedFramesCount++;
    return false;
  }

  /**
   * Indica se o locutor está falando ativamente no frame atual (energia acima do limiar)
   * e não apenas na cauda de sustentação passiva (hangover).
   */
  isActivelySpeaking() {
    return this.isGateOpen && this.consecutiveAbove > 0;
  }

  /**
   * Retorna métricas do filtro para telemetria e dashboard
   */
  getMetrics() {
    return {
      userVoiceRms: Math.round(this.userVoiceRms),
      ownerPitchHz: Math.round(this.ownerPitchHz),
      ownerLowRatio: Number(this.ownerLowRatio.toFixed(2)),
      enrolled: this.enrolled,
      lastPitchHz: Math.round(this.lastPitchHz),
      lastRms: Math.round(this.lastRms),
      isGateOpen: this.isGateOpen,
      speechFramesCount: this.speechFramesCount,
      blockedFramesCount: this.blockedFramesCount,
      passedFramesCount: this.passedFramesCount
    };
  }

  /**
   * Reseta o estado do filtro
   */
  reset() {
    this.consecutiveAbove = 0;
    this.hangoverCounter = 0;
    this.isGateOpen = false;
    this.enrolled = false;
    this.enrollCount = 0;
    this.ownerPitchHz = 0;
    this.ownerLowRatio = 0;
    this.recentPitches = [];
    this.recentLowRatios = [];
    this.speechFramesCount = 0;
    this.blockedFramesCount = 0;
    this.passedFramesCount = 0;
  }
}

module.exports = CrosstalkFilter;

/**
 * Filtro de Vozes de Fundo (Crosstalk Gate & Adaptive Voice Calibrator)
 * 
 * Calibra dinamicamente o volume real da voz do usuário principal (mouthpiece)
 * e bloqueia vozes secundárias, conversas de terceiros e ruídos de fundo que
 * estejam abaixo de ~40% do volume real da voz do usuário.
 */
class CrosstalkFilter {
  constructor({
    ratio = 0.40,               // Vozes de fundo são as que têm menos de 40% do volume do usuário
    initialUserRms = 450,       // Estimativa inicial realista de voz telefônica (Int16 PCM 8kHz)
    minUserRms = 300,           // Limite inferior para a calibração do usuário
    maxUserRms = 1200,          // Limite superior para evitar que picos/estalos deixem o filtro surdo
    maxThresholdRms = 350,      // Teto máximo do gate: qualquer voz >= 350 RMS sempre passa como usuário principal
    hangoverMs = 600,           // Janela de sustentação (600ms) para não picotar pausas ou final de palavras
    frameDurationMs = 20,       // Duração de cada chunk RTP (20ms = 160 samples a 8kHz)
    minFloorRms = 80            // Piso mínimo absoluto de ruído ambiente
  } = {}) {
    this.ratio = ratio;
    this.userVoiceRms = initialUserRms;
    this.minUserRms = minUserRms;
    this.maxUserRms = maxUserRms;
    this.maxThresholdRms = maxThresholdRms;
    this.hangoverMs = hangoverMs;
    this.frameDurationMs = frameDurationMs;
    this.hangoverFrames = Math.max(1, Math.ceil(hangoverMs / frameDurationMs));
    this.minFloorRms = minFloorRms;

    this.hangoverCounter = 0;
    this.isGateOpen = false;
    this.lastRms = 0;
    this.noiseFloor = minFloorRms;
    this.speechFramesCount = 0;
    this.blockedFramesCount = 0;
    this.passedFramesCount = 0;
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
   * Retorna o limiar dinâmico atual (40% da voz do usuário, limitado entre minFloorRms e maxThresholdRms)
   */
  getDynamicThreshold() {
    return Math.min(
      this.maxThresholdRms,
      Math.max(this.minFloorRms, this.userVoiceRms * this.ratio)
    );
  }

  /**
   * Processa um chunk de áudio e determina se pertence ao usuário principal ou a voz de fundo.
   * @param {Buffer} buffer - Chunk PCM16 de 20ms
   * @returns {boolean} true se deve passar para a OpenAI, false se deve ser silenciado (voz de fundo)
   */
  process(buffer) {
    const rms = this.calculateRms(buffer);
    this.lastRms = rms;

    // Limiar dinâmico: 40% da voz real do usuário (com teto de segurança para vozes suaves)
    const dynamicThreshold = this.getDynamicThreshold();

    // Atualiza ruído de fundo se o sinal for muito baixo (silêncio de linha)
    if (rms < dynamicThreshold * 0.5 && rms > 0) {
      this.noiseFloor = 0.05 * rms + 0.95 * this.noiseFloor;
    }

    if (rms >= dynamicThreshold) {
      // Fala do usuário principal detectada!
      this.isGateOpen = true;
      this.hangoverCounter = this.hangoverFrames;
      this.speechFramesCount++;
      this.passedFramesCount++;

      // Atualiza o volume real do usuário suavemente (limitando picos de microfone a maxUserRms)
      if (rms >= this.minUserRms) {
        const clampedRms = Math.min(rms, this.maxUserRms);
        this.userVoiceRms = 0.08 * clampedRms + 0.92 * this.userVoiceRms;
      }

      return true;
    }

    // Se estiver na janela de sustentação (hangover de 600ms), mantém o áudio aberto
    // para evitar que o final de palavras ou fonemas suaves sejam cortados
    if (this.hangoverCounter > 0) {
      this.hangoverCounter--;
      this.isGateOpen = true;
      this.passedFramesCount++;
      return true;
    }

    // Hangover esgotado e sinal abaixo do limiar: voz de fundo ou silêncio -> substituir por silêncio digital
    this.isGateOpen = false;
    this.blockedFramesCount++;
    return false;
  }

  /**
   * Retorna métricas do filtro para telemetria e dashboard
   */
  getMetrics() {
    return {
      userVoiceRms: Math.round(this.userVoiceRms),
      backgroundThresholdRms: Math.round(this.getDynamicThreshold()),
      lastRms: Math.round(this.lastRms),
      isGateOpen: this.isGateOpen,
      ratio: this.ratio,
      speechFramesCount: this.speechFramesCount,
      blockedFramesCount: this.blockedFramesCount,
      passedFramesCount: this.passedFramesCount
    };
  }

  /**
   * Reseta o estado do filtro
   */
  reset() {
    this.hangoverCounter = 0;
    this.isGateOpen = false;
    this.speechFramesCount = 0;
    this.blockedFramesCount = 0;
    this.passedFramesCount = 0;
  }
}

module.exports = CrosstalkFilter;

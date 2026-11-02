/**
 * Filtro de Vozes de Fundo (Crosstalk Gate & Adaptive Voice Calibrator)
 * 
 * Calibra dinamicamente o volume real da voz do usuário principal (mouthpiece)
 * e bloqueia vozes secundárias, conversas de terceiros e ruídos de fundo que
 * estejam abaixo de ~40% do volume real da voz do usuário.
 */
class CrosstalkFilter {
  constructor({
    ratio = 0.48,               // Vozes de fundo abaixo de ~48% do envelope de voz do usuário são bloqueadas
    initialUserRms = 1400,      // Estimativa inicial do envelope de fala do usuário principal (Int16 PCM 8kHz)
    minUserRms = 1100,          // Limite inferior para a referência de voz principal
    maxUserRms = 3500,          // Limite superior para evitar que gritos/estalos deixem o filtro surdo
    maxThresholdRms = 1250,     // Teto máximo do gate: qualquer voz sustentada >= 1250 RMS passa como usuário principal
    minFloorRms = 650,          // Piso mínimo absoluto para rejeitar vozes de fundo antes mesmo da 1ª fala
    attackFrames = 3,           // Exige 3 frames consecutivos (60ms) acima do limiar para abrir o gate (ignora picos isolados)
    hangoverMs = 400,           // Janela de sustentação (400ms) para não picotar sílabas suaves ou pausas curtas
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

    this.consecutiveAbove = 0;
    this.hangoverCounter = 0;
    this.isGateOpen = false;
    this.lastRms = 0;
    this.noiseFloor = 80;
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
   * Retorna o limiar dinâmico atual (limitado entre minFloorRms e maxThresholdRms)
   */
  getDynamicThreshold() {
    return Math.min(
      this.maxThresholdRms,
      Math.max(this.minFloorRms, this.userVoiceRms * this.ratio)
    );
  }

  /**
   * Processa um chunk de áudio e determina se pertence ao usuário principal ou a voz de fundo.
   * Utiliza rastreamento de envelope assimétrico (ataque rápido nos picos vocais do usuário e
   * decaimento lento) + validação de sustentação (attackFrames) para impedir que vozes de fundo
   * façam barge-in.
   * @param {Buffer} buffer - Chunk PCM16 de 20ms
   * @returns {boolean} true se deve passar para a OpenAI, false se deve ser silenciado (voz de fundo)
   */
  process(buffer) {
    const rms = this.calculateRms(buffer);
    this.lastRms = rms;

    const dynamicThreshold = this.getDynamicThreshold();

    // Atualiza ruído de fundo se o sinal for muito baixo (silêncio de linha)
    if (rms < dynamicThreshold * 0.3 && rms > 0) {
      this.noiseFloor = 0.05 * rms + 0.95 * this.noiseFloor;
    }

    if (rms >= dynamicThreshold) {
      this.consecutiveAbove++;

      // Abre o gate se já estava aberto ou se atingiu a sustentação mínima (60ms = 3 frames)
      if (this.isGateOpen || this.consecutiveAbove >= this.attackFrames) {
        this.isGateOpen = true;
        this.hangoverCounter = this.hangoverFrames;
        this.speechFramesCount++;
        this.passedFramesCount++;

        // Rastreamento assimétrico do envelope de voz do usuário principal:
        // Sobe rápido (25%) nas sílabas fortes do usuário e desce muito devagar (1%)
        // para que finais de palavras suaves não reduzam a referência de volume do usuário.
        const clampedRms = Math.min(this.maxUserRms, Math.max(this.minUserRms, rms));
        if (clampedRms > this.userVoiceRms) {
          this.userVoiceRms = 0.25 * clampedRms + 0.75 * this.userVoiceRms;
        } else {
          this.userVoiceRms = 0.01 * clampedRms + 0.99 * this.userVoiceRms;
        }

        return true;
      }

      // Ainda acumulando frames de ataque (< 60ms): mantém fechado para filtrar picos isolados de fundo
      this.blockedFramesCount++;
      return false;
    }

    this.consecutiveAbove = 0;

    // Se estiver na janela de sustentação (hangover de 400ms), mantém o áudio aberto
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

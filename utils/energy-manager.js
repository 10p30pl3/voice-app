/**
 * Gerenciador de Energia de Áudio (PCM16)
 * Calcula o nível de ruído ambiente para ajuste dinâmico de VAD.
 */
class EnergyManager {
  constructor() {
    this.noiseFloor = 0;
    this.samplesCount = 0;
    this.alpha = 0.1; // Fator de suavização (Moving Average)
    
    // Para detecção automática de Viva-voz (Eco)
    this.echoEnergySum = 0;
    this.echoSamplesCount = 0;
  }

  /**
   * Calcula a energia (RMS) de um buffer PCM16 (Int16Array)
   * @param {Buffer} buffer 
   * @param {boolean} isAgentTalking 
   * @returns {number} Energy level (0 to 32768)
   */
  calculateEnergy(buffer, isAgentTalking = false) {
    if (!buffer || buffer.length === 0) return 0;
    
    this.samplesCount++;

    // Converte Buffer para Int16Array (PCM16 Little Endian)
    const pcm16 = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
    let sumSquares = 0;
    
    for (let i = 0; i < pcm16.length; i++) {
        sumSquares += pcm16[i] * pcm16[i];
    }
    
    const rms = Math.sqrt(sumSquares / pcm16.length);
    
    // 1. Se o agente está falando, acumulamos para detectar Eco (Modo Viva-voz)
    if (isAgentTalking) {
      this.echoEnergySum += rms;
      this.echoSamplesCount++;
    } 
    // 2. Se o agente está em silêncio, refinamos o Piso de Ruído (Noise Floor)
    else if (rms < 3000) { 
        this.noiseFloor = (this.alpha * rms) + ((1 - this.alpha) * this.noiseFloor);
    }
    
    return rms;
  }

  /**
   * Classifica se o ambiente parece estar em Viva-voz baseado no retorno do áudio
   * @returns {string} viva_voz | fone_ouvido
   */
  detectDeviceMode() {
    if (this.echoSamplesCount < 10) return 'fone_ouvido'; // Sem dados suficientes
    
    const avgEcho = this.echoEnergySum / this.echoSamplesCount;
    
    // Heurística sênior v5: Ultra-conservadora.
    // Para ser viva-voz, o eco deve ser:
    // 1. Pelo menos 10x maior que o ruído de fundo (Noise Floor)
    // 2. Acima de um piso absoluto de 4000 (Apenas caixas de som reais atingem isso no mic)
    const isLikelyEcho = avgEcho > (this.noiseFloor * 10.0) && avgEcho > 4000;

    console.log(`[DEBUG ENERGY] AvgEcho: ${avgEcho.toFixed(0)} | NoiseFloor: ${this.noiseFloor.toFixed(0)} | Ratio: ${(avgEcho / (this.noiseFloor || 1)).toFixed(1)}x`);

    if (isLikelyEcho) {
      return 'viva_voz';
    }
    return 'fone_ouvido';
  }

  /**
   * Sugere um threshold de VAD para a OpenAI (0.0 a 1.0)
   * @returns {number}
   */
  suggestThreshold(baseThreshold = 0.5) {
    const maxThreshold = 0.98;
    const mapped = baseThreshold + (this.noiseFloor / 1000) * 0.4;
    return Math.min(maxThreshold, mapped);
  }

  /**
   * Classifica o ambiente baseado no nível de ruído atual
   * @returns {string} SILENCE | OFFICE | STREET | TV
   */
  getClassification() {
    const nf = this.noiseFloor;
    if (nf < 50) return 'SILENCE';
    if (nf < 200) return 'OFFICE';
    if (nf < 600) return 'STREET';
    return 'TV';
  }
}

module.exports = EnergyManager;

const WebSocket = require('ws');
const { EventEmitter } = require('events');

/**
 * Helper de reamostragem rápida PCM16: 8kHz para 16kHz (Interpolação Linear leve)
 * O Whisper espera áudio mono de 16kHz (16.000 amostras/segundo).
 */
function upsample8to16(buffer8k) {
  const samplesCount = buffer8k.length >> 1;
  if (samplesCount === 0) return Buffer.alloc(0);
  const buffer16k = Buffer.allocUnsafe(samplesCount * 4); // 2 samples de saída para cada 1 de entrada (2x bytes)

  for (let i = 0; i < samplesCount; i++) {
    const s0 = buffer8k.readInt16LE(i * 2);
    const s1 = i + 1 < samplesCount ? buffer8k.readInt16LE((i + 1) * 2) : s0;

    const mid = (s0 + s1) >> 1;
    const pos = i * 4;
    buffer16k.writeInt16LE(s0, pos);
    buffer16k.writeInt16LE(mid, pos + 2);
  }
  return buffer16k;
}

/**
 * Pool de Conexões com Múltiplos Nós do whisper-service
 * Suporta balanceamento Least-Connections e Fail-open (Circuit Breaker)
 */
class WhisperPool {
  constructor() {
    this.nodes = [];
    this.roundRobinIdx = 0;
    this.parseNodes();
  }

  parseNodes() {
    const raw = process.env.WHISPER_NODES || process.env.WHISPER_SERVICE_URL || 'ws://127.0.0.1:8080/ws/audio';
    const entries = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    this.nodes = entries.map((url, idx) => {
      // Normaliza para incluir o path /ws/audio se não estiver na URL
      const wsUrl = url.includes('/ws/') ? url : `${url.replace(/\/+$/, '')}/ws/audio`;
      return {
        id: `whisper-${idx + 1}`,
        url: wsUrl,
        activeSessions: 0,
        isHealthy: true,
        lastError: null
      };
    });
  }

  selectNode() {
    const healthy = this.nodes.filter((n) => n.isHealthy);
    if (healthy.length === 0) return this.nodes[0] || null;
    if (healthy.length === 1) return healthy[0];

    // Least-Connections
    let min = Infinity;
    for (const n of healthy) {
      if (n.activeSessions < min) min = n.activeSessions;
    }
    const candidates = healthy.filter((n) => n.activeSessions === min);
    const chosen = candidates[this.roundRobinIdx % candidates.length];
    this.roundRobinIdx = (this.roundRobinIdx + 1) % 1000000;
    return chosen;
  }
}

const globalWhisperPool = new WhisperPool();

/**
 * Gerenciador de Sessão AMD/STT por Chamada (WhisperSession)
 */
class WhisperSession extends EventEmitter {
  constructor({ callId, channelUuid, tenant, sipHeaders = {} }) {
    super();
    this.callId = callId;
    this.channelUuid = channelUuid;
    this.tenant = tenant;

    // Resolução dos 4 Modos:
    // Header SIP tem prioridade se enviado; senão consulta tenant; senão false
    const sipAmdHeader = sipHeaders['x-amd-enabled'] || sipHeaders['X-AMD-Enabled'];
    const sipSttHeader = sipHeaders['x-stt-enabled'] || sipHeaders['X-STT-Enabled'];

    this.isAmdEnabled =
      sipAmdHeader !== undefined
        ? sipAmdHeader === 'true' || sipAmdHeader === true
        : !!(tenant.amd && tenant.amd.enabled);

    this.isSttEnabled =
      sipSttHeader !== undefined
        ? sipSttHeader === 'true' || sipSttHeader === true
        : !!(tenant.stt && tenant.stt.enabled);

    this.amdMode = (tenant.amd && tenant.amd.mode) || 'active'; // 'active' ou 'shadow'
    this.ws = null;
    this.node = null;
    this.decisionReceived = false;
    this.circuitBreakerTimer = null;
    this.closed = false;
  }

  isActive() {
    return this.isAmdEnabled || this.isSttEnabled;
  }

  start() {
    if (!this.isActive()) {
      // Ambos desligados: emite imediatamente decisão 'humano' para seguir fluxo
      this.emit('decision', {
        label: 'humano',
        confidence: 1.0,
        reason: 'amd_disabled'
      });
      return;
    }

    this.node = globalWhisperPool.selectNode();
    if (!this.node) {
      console.warn(`[${this.callId}] [WhisperSession] Nenhum nó Whisper disponível. Fallback para humano.`);
      this.emit('decision', { label: 'humano', confidence: 0.5, reason: 'no_whisper_node' });
      return;
    }

    this.node.activeSessions += 1;

    // Constrói URL com parâmetros da chamada
    const urlObj = new URL(this.node.url);
    urlObj.searchParams.set('call_id', this.callId);
    urlObj.searchParams.set('tenant_id', this.tenant.id || 'default');
    urlObj.searchParams.set('amd', this.isAmdEnabled ? 'true' : 'false');
    urlObj.searchParams.set('stt', this.isSttEnabled ? 'true' : 'false');
    urlObj.searchParams.set('mode', this.amdMode);

    // Circuit Breaker Fail-Open: se o AMD não decidir em 3500ms, assume humano
    if (this.isAmdEnabled) {
      this.circuitBreakerTimer = setTimeout(() => {
        if (!this.decisionReceived && !this.closed) {
          console.warn(`[${this.callId}] ⏱️ [AMD] Circuit Breaker atingido (3.5s sem resposta). Assumindo HUMANO.`);
          this.decisionReceived = true;
          this.emit('decision', {
            label: 'humano',
            confidence: 0.5,
            reason: 'circuit_breaker_timeout'
          });
          // Se for somente AMD, encerra
          if (!this.isSttEnabled) {
            this.stop();
          }
        }
      }, 3500);
    }

    try {
      this.ws = new WebSocket(urlObj.toString());

      this.ws.on('open', () => {
        console.log(`[${this.callId}] 🧠 Conectado ao nó [${this.node.id}] (${this.node.url}) | AMD: ${this.isAmdEnabled} | STT: ${this.isSttEnabled}`);
      });

      this.ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());

          // Evento de Decisão do AMD
          if (msg.type === 'decision' && !this.decisionReceived) {
            this.decisionReceived = true;
            if (this.circuitBreakerTimer) clearTimeout(this.circuitBreakerTimer);

            console.log(
              `[${this.callId}] 🎯 [AMD] Decisão: [${msg.label.toUpperCase()}] (Confiança: ${(msg.confidence * 100).toFixed(0)}% | Fala: ${msg.speech_ms || 0}ms | Texto: "${msg.transcript || ''}")`
            );

            this.emit('decision', msg);

            // Se for modo "Somente AMD" (sem STT contínuo), desconecta do Whisper imediatamente
            if (!this.isSttEnabled) {
              this.stop();
            }
          }

          // Evento de Transcrição Contínua de STT
          if (msg.type === 'transcript') {
            this.emit('transcript', msg);
          }
        } catch (err) {
          console.error(`[${this.callId}] [WhisperSession] Erro ao decodificar JSON do Whisper:`, err.message);
        }
      });

      this.ws.on('error', (err) => {
        console.warn(`[${this.callId}] ⚠️ Erro no WebSocket do Whisper [${this.node.id}]:`, err.message);
        if (!this.decisionReceived) {
          this.decisionReceived = true;
          this.emit('decision', { label: 'humano', confidence: 0.5, reason: 'whisper_ws_error' });
        }
      });

      this.ws.on('close', () => {
        if (!this.decisionReceived) {
          this.decisionReceived = true;
          this.emit('decision', { label: 'humano', confidence: 0.5, reason: 'whisper_ws_closed' });
        }
      });
    } catch (err) {
      console.error(`[${this.callId}] Erro ao instanciar WebSocket Whisper:`, err.message);
      this.emit('decision', { label: 'humano', confidence: 0.5, reason: 'whisper_init_failed' });
    }
  }

  /**
   * Recebe o chunk de áudio da chamada (Buffer PCM16 8kHz ou 16kHz) e envia ao Whisper
   * @param {Buffer} audioBuffer - Buffer binário de áudio
   * @param {number} inputRate - 8000 ou 16000 (se 8000, faz upsampling automático para 16k)
   */
  pushAudio(audioBuffer, inputRate = 8000) {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Se já decidiu AMD e não tem STT ligado, ignora envio
    if (this.decisionReceived && !this.isSttEnabled) return;

    try {
      const pcm16k = inputRate === 8000 ? upsample8to16(audioBuffer) : audioBuffer;
      this.ws.send(pcm16k);
    } catch {}
  }

  stop() {
    if (this.closed) return;
    this.closed = true;

    if (this.circuitBreakerTimer) {
      clearTimeout(this.circuitBreakerTimer);
      this.circuitBreakerTimer = null;
    }

    if (this.node) {
      this.node.activeSessions = Math.max(0, this.node.activeSessions - 1);
    }

    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'stop' }));
        }
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }
}

module.exports = {
  WhisperPool,
  whisperPool: globalWhisperPool,
  WhisperSession,
  upsample8to16
};

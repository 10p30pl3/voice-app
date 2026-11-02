require('dotenv').config({ override: true });
// Voice App - High-Scalability Multi-Tenant & Multi-FreeSWITCH Voice Gateway

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
const getTS = () => new Date().toLocaleTimeString('pt-BR', { hour12: false });
console.log = (...args) => originalLog(`[${getTS()}]`, ...args);
console.error = (...args) => originalError(`[${getTS()}]`, ...args);
console.warn = (...args) => originalWarn(`[${getTS()}]`, ...args);

const Srf = require('drachtio-srf');
const Mrf = require('drachtio-fsmrf');
const WebSocket = require('ws');

const DRACHTIO_MODE = (process.env.DRACHTIO_MODE || 'inbound').toLowerCase(); // 'inbound' (connect) ou 'outbound' (listen)
const DRACHTIO_HOST = process.env.DRACHTIO_HOST || '127.0.0.1';
const DRACHTIO_PORT = parseInt(process.env.DRACHTIO_PORT || '9022', 10);
const DRACHTIO_SECRET = process.env.DRACHTIO_SECRET || 'cymru';
const DRACHTIO_LISTEN_PORT = parseInt(process.env.DRACHTIO_LISTEN_PORT || '3000', 10);
const WORKER_ID = parseInt(process.env.NODE_APP_INSTANCE || process.env.WORKER_ID || '0', 10);

const EnergyManager = require('./utils/energy-manager');
const CrosstalkFilter = require('./utils/crosstalk-filter');
const FrameVad = require('./utils/frame-vad');
const WsMediaBridge = require('./media/ws-media-bridge');
const { mediaServer } = require('./media/ws-media-bridge');
const tenantManager = require('./utils/tenant-manager');
const FreeSwitchPool = require('./utils/freeswitch-pool');
const { WhisperSession, whisperPool } = require('./media/whisper-client');
const { CallRecorder, formatDateTime } = require('./utils/call-recorder');
const { createApiRouter } = require('./utils/api-router');

const srf = new Srf();
const mrf = new Mrf(srf);
const fsPool = new FreeSwitchPool(mrf);

let isShuttingDown = false;
let isDrachtioConnected = false;
const activeBridges = new Map(); // callId -> OpenAIS2SBridge

// Endpoint /health agora exibe métricas do Worker, Tenants e de todo o Cluster FreeSWITCH
mediaServer.setHealthCallback(() => ({
  drachtioMode: DRACHTIO_MODE,
  drachtioConnected: DRACHTIO_MODE === 'outbound' ? true : isDrachtioConnected,
  freeSwitchCluster: fsPool.getPoolStats(),
  activeCallsByTenant: tenantManager.getTenantStats(),
  shuttingDown: isShuttingDown
}));

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timeout após ${ms}ms`)), ms)
    )
  ]);
}

function getCallId(req) {
  return req.get('Call-ID') || req.get('call-id') || `call-${Date.now()}`;
}

function getChannelUuid(endpoint) {
  return (
    endpoint?.uuid ||
    endpoint?.id ||
    endpoint?.sessionId ||
    endpoint?.channelId ||
    endpoint?.conn?.uuid
  );
}

// Helper de upsampling PCM16: 8kHz -> 24kHz com Interpolação Linear e Buffer.allocUnsafe (Zero-Fill Overhead)
function upsample8to24(buffer8k) {
  const samplesCount = buffer8k.length >> 1; // Math.floor(length / 2) via bitshift
  if (samplesCount === 0) return Buffer.alloc(0);
  const buffer24k = Buffer.allocUnsafe(samplesCount * 6);

  for (let i = 0; i < samplesCount; i++) {
    const s0 = buffer8k.readInt16LE(i * 2);
    const s1 = i + 1 < samplesCount ? buffer8k.readInt16LE((i + 1) * 2) : s0;

    const diff = s1 - s0;
    const pos = i * 6;
    buffer24k.writeInt16LE(s0, pos);
    buffer24k.writeInt16LE((s0 + diff * 0.3333) | 0, pos + 2);
    buffer24k.writeInt16LE((s0 + diff * 0.6667) | 0, pos + 4);
  }
  return buffer24k;
}

// Helper de downsampling PCM16: 24kHz -> 8kHz com filtro FIR Anti-Aliasing (elimina chiado/hiss de frequências agudas)
function downsample24to8(buffer24k) {
  const samplesCount = buffer24k.length >> 1;
  const targetSamplesCount = (samplesCount / 3) | 0;
  if (targetSamplesCount === 0) return Buffer.alloc(0);
  const buffer8k = Buffer.allocUnsafe(targetSamplesCount * 2);

  // Filtro FIR anti-aliasing simétrico de 7 taps (cutoff ~3.6kHz)
  // Coeficientes: [-500, 1200, 6500, 18368, 6500, 1200, -500] (soma = 32768, ganho unitário DC exato)
  // Rejeita frequências acima de 4kHz antes do subamostragem para evitar aliasing espectral (chiado)
  const getSample = (idx) => {
    if (idx < 0) idx = 0;
    else if (idx >= samplesCount) idx = samplesCount - 1;
    return buffer24k.readInt16LE(idx * 2);
  };

  for (let i = 0; i < targetSamplesCount; i++) {
    const center = i * 3;
    const s_m3 = getSample(center - 3);
    const s_m2 = getSample(center - 2);
    const s_m1 = getSample(center - 1);
    const s_0  = getSample(center);
    const s_p1 = getSample(center + 1);
    const s_p2 = getSample(center + 2);
    const s_p3 = getSample(center + 3);

    const acc = -500 * (s_m3 + s_p3) + 1200 * (s_m2 + s_p2) + 6500 * (s_m1 + s_p1) + 18368 * s_0;
    let out = (acc >> 15) | 0;
    if (out > 32767) out = 32767;
    else if (out < -32768) out = -32768;

    buffer8k.writeInt16LE(out, i * 2);
  }
  return buffer8k;
}

// Tabelas rápidas de conversão Linear PCM16 <-> G.711 u-law (8kHz nativo, zero resampling)
function linear16ToMulaw(pcm16Buffer) {
  const samples = pcm16Buffer.length >> 1;
  const mulaw = Buffer.allocUnsafe(samples);
  const BIAS = 0x84;
  const CLIP = 32635;

  for (let i = 0; i < samples; i++) {
    let sample = pcm16Buffer.readInt16LE(i * 2);
    const sign = (sample >> 8) & 0x80;
    if (sign !== 0) sample = -sample;
    if (sample > CLIP) sample = CLIP;
    sample += BIAS;

    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    mulaw[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return mulaw;
}

function mulawToLinear16(mulawBuffer) {
  if (!mulawToLinear16.table) {
    const table = new Int16Array(256);
    for (let i = 0; i < 256; i++) {
      const u = ~i;
      let t = ((u & 0x0f) << 3) + 0x84;
      t <<= (u & 0x70) >> 4;
      table[i] = (u & 0x80) ? (0x84 - t) : (t - 0x84);
    }
    mulawToLinear16.table = table;
  }
  const table = mulawToLinear16.table;
  const len = mulawBuffer.length;
  const pcm16 = Buffer.allocUnsafe(len * 2);
  for (let i = 0; i < len; i++) {
    pcm16.writeInt16LE(table[mulawBuffer[i]], i * 2);
  }
  return pcm16;
}

class OpenAIS2SBridge {
  constructor(tenant, sipHeaders = {}) {
    this.tenant = tenant;
    this.sipHeaders = sipHeaders;
    this.whisperSession = null;
    this.useG711 = tenant.audioCodec === 'g711_ulaw';
    this.endpoint = null;
    this.dialog = null;
    this.channelUuid = null;
    this.callId = null;
    this.energyManager = new EnergyManager();
    this.mediaBridge = new WsMediaBridge();

    this.baseThreshold = 0.45;
    this.isAgentTalking = false;
    this.deviceMode = 'viva_voz';
    this.isToneProbe = false;

    this.calibrationActive = true;
    this.calibrationSamplesRecv = 0;

    this.profiles = {
      SILENCE: {
        fone: { base: 0.38, prefix: 200, silence: 350 },
        viva: { base: 0.45, prefix: 250, silence: 400 }
      },
      OFFICE: {
        fone: { base: 0.55, prefix: 400, silence: 500 },
        viva: { base: 0.55, prefix: 500, silence: 600 }
      },
      STREET: {
        fone: { base: 0.75, prefix: 500, silence: 600 },
        viva: { base: 0.75, prefix: 600, silence: 800 }
      },
      TV: {
        fone: { base: 0.95, prefix: 1000, silence: 1200 },
        viva: { base: 0.95, prefix: 1200, silence: 1500 }
      }
    };
    this.currentProfile = 'SILENCE';

    this.openaiSocket = null;
    this.openaiConnected = false;
    this.openaiReady = false;
    this.openaiReadyPromise = null;
    this.openaiReadyResolve = null;

    this.maxDurationTimer = null;
    this.warningDurationTimer = null;
    this.safetyCloseTimer = null;
    this.isSafetyExpiring = false;
    this.maxDurationSec = 180;
    this.isTerminated = false;

    const sipBargeinGrace = this.sipHeaders['x-bargein-grace-sec'] || this.sipHeaders['X-Bargein-Grace-Sec'];
    this.bargeinGraceSec = Number(
      sipBargeinGrace !== undefined
        ? sipBargeinGrace
        : this.tenant.bargeinGraceSec ?? process.env.BARGEIN_GRACE_SEC ?? 8
    );
    this.isMicMutedByGrace = false;
    this.graceUnmuteTimer = null;
    this.isGreetingInProgress = false;
    this.greetingResponsePending = false;
    this.greetingResponseId = null;
    this.greetingAudioBytes = 0;
    this.greetingPlaybackStartTime = null;
    this.greetingFinishTimer = null;
    this.greetingSafetyTimer = null;
    this.graceCompleted = false;

    // Configuração dos 3 Modos de Filtro de Voz de Fundo:
    // 1. 'atual' (ou 'dsp'): Filtro Acústico (YIN CMNDF pitch + proximidade spectral + RMS)
    // 2. 'wespeaker': Biometria Neural CAM++ (ONNX 512-dim)
    // 3. 'ecapa': Biometria Neural ECAPA-TDNN (ONNX 512-dim)
    // 4. 'none': Filtro desligado
    const rawFilterMode = String(
      this.sipHeaders['x-crosstalk-mode'] ||
      this.sipHeaders['X-Crosstalk-Mode'] ||
      (this.tenant.crosstalkFilter && this.tenant.crosstalkFilter.mode) ||
      this.tenant.crosstalkMode ||
      process.env.CROSSTALK_FILTER_MODE ||
      'atual'
    ).toLowerCase();

    this.crosstalkMode = ['atual', 'dsp', 'wespeaker', 'ecapa', 'none'].includes(rawFilterMode)
      ? rawFilterMode
      : 'atual';

    this.isDspFilterActive = this.crosstalkMode === 'atual' || this.crosstalkMode === 'dsp';
    this.isNeuralFilterActive = this.crosstalkMode === 'wespeaker' || this.crosstalkMode === 'ecapa';

    const crosstalkRatio = Number(
      this.sipHeaders['x-crosstalk-ratio'] ||
      this.sipHeaders['X-Crosstalk-Ratio'] ||
      (this.tenant.crosstalkFilter && this.tenant.crosstalkFilter.ratio) ||
      this.tenant.crosstalkRatio ||
      process.env.CROSSTALK_RATIO ||
      0.45
    );

    this.crosstalkFilter = this.isDspFilterActive
      ? new CrosstalkFilter({ ratio: crosstalkRatio, hangoverMs: 400 })
      : null;
    this.crosstalkEnrolledLogged = false;

    // VAD de energia por frame: detector de "fala ativa" quando o gate DSP não está em uso
    // (modos 'wespeaker', 'ecapa' e 'none'), evitando barge-in por frames de silêncio.
    this.frameVad = this.crosstalkFilter ? null : new FrameVad();

    // Estado da Biometria Neural ('wespeaker' / 'ecapa')
    this.isSecondaryVoiceBlocked = false;
    this.lastSpeakerScore = 1.0;
    this.agentPlaybackStartTime = null;

    this.recorder = null;
    this.isResponseCancelled = false;
    this.dtmfBuffer = '';
    this.dtmfTimer = null;
    this.startedAt = null;
    this.caller = null;
    this.called = null;
    this.isMuted = false;
    this.isOnHold = false;
    this.transcriptLog = [];
    this.lastTurn = null;
    this.activeAudioFormat = this.useG711 ? 'g711_ulaw' : 'pcm24k';
    this.cleanupHandler = null;
    this.graceEndLogged = false;

    this.handleEslEvent = this.handleEslEvent.bind(this);
    this.handleDtmf = this.handleDtmf.bind(this);
  }

  setCleanupHandler(handler) {
    this.cleanupHandler = handler;
  }

  isBargeinGraceActive() {
    if (this.graceCompleted) return false;
    if (this.isGreetingInProgress || this.isMicMutedByGrace) return true;
    if (!this.startedAt || this.bargeinGraceSec <= 0) return false;
    const elapsedSec = (Date.now() - this.startedAt.getTime()) / 1000;
    return elapsedSec < this.bargeinGraceSec;
  }

  canTriggerBargeIn() {
    if (this.isSafetyExpiring) return false;
    if (this.isGreetingInProgress || this.isMicMutedByGrace) return false;
    if (this.isBargeinGraceActive()) return false;
    // Carência mínima de 250ms após o início do áudio do agente para evitar falso corte pelo eco/cauda do usuário
    if (this.agentPlaybackStartTime && Date.now() - this.agentPlaybackStartTime < 250) {
      return false;
    }
    return true;
  }

  async openCustomerChannel(reason = 'greeting_completed') {
    if (!this.isMicMutedByGrace && !this.isGreetingInProgress) return;
    this.isGreetingInProgress = false;
    this.isMicMutedByGrace = false;
    this.graceCompleted = true;

    if (this.greetingFinishTimer) {
      clearTimeout(this.greetingFinishTimer);
      this.greetingFinishTimer = null;
    }
    if (this.greetingSafetyTimer) {
      clearTimeout(this.greetingSafetyTimer);
      this.greetingSafetyTimer = null;
    }
    if (this.graceUnmuteTimer) {
      clearTimeout(this.graceUnmuteTimer);
      this.graceUnmuteTimer = null;
    }

    if (this.endpoint && this.channelUuid && !this.isTerminated) {
      await this.endpoint.api(`uuid_audio ${this.channelUuid} stop read`).catch((err) => {
        console.error(`[${this.callId}] 🎙️ [BARGE-IN DINÂMICO] Erro ao abrir canal no FreeSWITCH:`, err.message);
      });
    }

    console.log(
      `[${this.callId}] 🎙️ [BARGE-IN DINÂMICO] Saudação inicial do agente concluída (${reason}). Canal do cliente ABERTO no FreeSWITCH. Pedidos e barge-in liberados!`
    );

    if (this.openaiSocket && this.openaiSocket.readyState === WebSocket.OPEN) {
      try {
        this.openaiSocket.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
      } catch {}
    }
  }

  triggerBargeIn(reason = 'speech_started') {
    if (!this.canTriggerBargeIn()) {
      const elapsedSec = this.startedAt ? (Date.now() - this.startedAt.getTime()) / 1000 : 0;
      console.log(
        `[${this.callId}] 🛡️ [BARGE-IN GRACE] Tentativa de interrupção (${reason}) bloqueada: ${elapsedSec.toFixed(1)}s < ${this.bargeinGraceSec}s (Pedido do cliente ignorado durante saudação).`
      );
      if (this.openaiSocket && this.openaiSocket.readyState === WebSocket.OPEN) {
        try {
          this.openaiSocket.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
        } catch {}
      }
      return false;
    }

    console.log(`[${this.callId}] 🎤 BARGE-IN: Interrompendo agente imediatamente (${reason})...`);
    this.isAgentTalking = false;
    this.agentPlaybackStartTime = null;
    this.isResponseCancelled = true;
    this.mediaBridge.killAudio();
    if (this.openaiSocket && this.openaiSocket.readyState === WebSocket.OPEN) {
      try {
        this.openaiSocket.send(JSON.stringify({ type: 'response.cancel' }));
      } catch {}
    }
    if (this.endpoint && this.channelUuid) {
      this.endpoint.api(`uuid_audio_fork ${this.channelUuid} stop_play`).catch(() => {});
      this.endpoint.api(`uuid_break ${this.channelUuid} all`).catch(() => {});
    }
    return true;
  }

  handleEslEvent(evt) {
    if (!evt || !evt.getHeader) return;
    const subclass = evt.getHeader('Event-Subclass');
    const eventUuid = evt.getHeader('Unique-ID');
    if (eventUuid && eventUuid !== this.channelUuid) return;

    if (subclass === 'mod_audio_fork::play_audio') {
      const file = evt.getHeader('file');
      if (file && this.endpoint) {
        console.log(`[${this.callId}] 🔊 Evento play_audio recebido: ${file}`);
        this.endpoint.play(file).catch((e) => {
          if (!e.message?.includes('break')) {
            console.error(`[${this.callId}] Erro ao tocar play_audio:`, e.message);
          }
        });
      }
    }
  }

  initOpenAiConnection() {
    this.openaiReadyPromise = new Promise((resolve) => {
      this.openaiReadyResolve = resolve;
    });

    const apiKey = this.tenant.openaiApiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error(`[${this.callId}] 🔴 Erro: Chave de API da OpenAI não configurada para o tenant ${this.tenant.id}`);
      this.terminateCall('missing_openai_key');
      return;
    }

    const model = this.tenant.openaiModel || 'gpt-realtime-mini';
    const openaiUrl = `wss://api.openai.com/v1/realtime?model=${model}`;

    console.log(`[${this.callId}] ⚡ Conectando à OpenAI Realtime (${model}) em paralelo...`);
    this.openaiSocket = new WebSocket(openaiUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    });

    this.openaiSocket.on('open', () => {
      console.log(`[${this.callId}] 🟢 WebSocket OpenAI conectado com sucesso!`);
      this.openaiConnected = true;
      if (this.openaiReadyResolve) this.openaiReadyResolve();
    });

    this.openaiSocket.on('message', (data) => {
      this.handleOpenAiMessage(data);
    });

    this.openaiSocket.on('close', (code, reason) => {
      console.log(`[${this.callId}] 🔴 WebSocket OpenAI fechado. Código: ${code}, Razão: ${reason.toString()}`);
      this.openaiConnected = false;
      this.openaiReady = false;
      if (!this.isTerminated) {
        this.terminateCall('openai_disconnected');
      }
    });

    this.openaiSocket.on('error', (err) => {
      console.error(`[${this.callId}] 🔴 Erro no WebSocket OpenAI:`, err.message);
      if (!this.openaiConnected && this.openaiReadyResolve) {
        this.openaiReadyResolve();
      }
    });
  }

  handleOpenAiMessage(data) {
    try {
      const body = JSON.parse(data.toString());

      if (body.type !== 'response.output_audio.delta' && body.type !== 'input_audio_buffer.committed') {
        console.log(`[${this.callId}] 🔍 [OpenAI] Evento: ${body.type}`);
      }

      if (body.type === 'error') {
        if (body.error && body.error.code !== 'response_cancel_not_active') {
          console.error(`[${this.callId}] 🔴 Erro recebido da OpenAI Realtime:`, body.error);
        }
      }

      if (body.type === 'session.updated' && body.session) {
        const outFmt = body.session.audio?.output?.format?.type;
        const confirmedVoice = body.session.audio?.output?.voice;
        if (outFmt === 'audio/pcmu') {
          this.activeAudioFormat = 'g711_ulaw';
          console.log(`[${this.callId}] 🟢 Formato de áudio confirmado pela OpenAI: G.711 u-law | Voz: ${confirmedVoice || 'n/a'}`);
        } else {
          this.activeAudioFormat = 'pcm24k';
          console.log(`[${this.callId}] ℹ️ Formato de áudio da OpenAI: ${outFmt || 'pcm24k'} | Voz: ${confirmedVoice || 'n/a'}`);
        }
      }

      if (body.type === 'response.created' || body.type === 'response.output_item.added') {
        this.isResponseCancelled = false;
        if (this.greetingResponsePending && body.type === 'response.created') {
          this.greetingResponsePending = false;
          this.greetingResponseId = body.response?.id;
          console.log(
            `[${this.callId}] ⏳ [BARGE-IN DINÂMICO] IA gerando saudação inicial (Response ID: ${this.greetingResponseId || 'n/a'}). Canal do cliente permanece fechado.`
          );
        } else if (this.isBargeinGraceActive() && body.type === 'response.created') {
          console.log(
            `[${this.callId}] 🛡️ [BARGE-IN DINÂMICO] Resposta da IA cancelada: pedido do cliente ignorado durante a saudação do agente.`
          );
          if (this.openaiSocket && this.openaiSocket.readyState === WebSocket.OPEN) {
            try {
              this.openaiSocket.send(JSON.stringify({ type: 'response.cancel' }));
              this.openaiSocket.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
            } catch {}
          }
          return;
        }
      } else if (body.type === 'response.cancelled') {
        this.isResponseCancelled = false;
        this.isAgentTalking = false;
        this.agentPlaybackStartTime = null;
        this.mediaBridge.killAudio();
      }

      if (body.type === 'response.output_audio.delta' && body.delta) {
        if (this.isResponseCancelled) {
          return;
        }
        if (!this.isAgentTalking) {
          this.isAgentTalking = true;
          this.agentPlaybackStartTime = Date.now();
          this.mediaBridge.startPlaybackStream();
        }
        const rawDelta = Buffer.from(body.delta, 'base64');
        const pcm8k = this.activeAudioFormat === 'g711_ulaw'
          ? mulawToLinear16(rawDelta)
          : downsample24to8(rawDelta);
        this.mediaBridge.pushAudioChunk(pcm8k);

        if (this.isGreetingInProgress) {
          if (!this.greetingPlaybackStartTime) {
            this.greetingPlaybackStartTime = Date.now();
          }
          this.greetingAudioBytes += pcm8k.length;
        }
      }

      // 1. Transcrição do Atendente (IA) via eventos da OpenAI Realtime
      if (
        (body.type === 'response.output_audio_transcript.done' ||
         body.type === 'response.audio_transcript.done') &&
        body.transcript
      ) {
        this.recordTranscriptTurn('Atendente', body.transcript);
      } else if (body.type === 'response.done' && body.response?.output) {
        // Fallback para capturar transcript do response.done caso evento individual não tenha sido disparado
        for (const outItem of body.response.output) {
          if (outItem.content) {
            for (const c of outItem.content) {
              if (c.transcript) {
                this.recordTranscriptTurn('Atendente', c.transcript);
              }
            }
          }
        }
      }

      // 2. Transcrição da fala do Cliente recebida nativamente da OpenAI Realtime
      if (
        body.type === 'conversation.item.input_audio_transcription.completed' &&
        body.transcript
      ) {
        if (this.isBargeinGraceActive()) {
          console.log(
            `[${this.callId}] 🛡️ [BARGE-IN GRACE] Transcrição do cliente ignorada durante carência: "${body.transcript}"`
          );
          this.recordTranscriptTurn('Cliente', `[Ignorado na Saudação]: ${body.transcript}`);
        } else {
          this.recordTranscriptTurn('Cliente', body.transcript);
        }
      }

      if (['response.output_audio.done', 'response.done'].includes(body.type)) {
        if (this.isAgentTalking) {
          this.isAgentTalking = false;
          console.log(`[${this.callId}] 🔊 Fim da transmissão de áudio da IA.`);
          this.mediaBridge.endPlaybackStream();
        }

        // Barge-in Dinâmico: Quando a IA termina de gerar a saudação de boas-vindas, aguarda a finalização
        // do playout do buffer de áudio no FreeSWITCH e então abre o canal do microfone do cliente.
        if (this.isGreetingInProgress && !this.greetingFinishTimer) {
          const audioDurationMs = Math.round(this.greetingAudioBytes / 16);
          const elapsedPlaybackMs = this.greetingPlaybackStartTime
            ? Date.now() - this.greetingPlaybackStartTime
            : 0;
          const remainingMs = Math.max(0, audioDurationMs - elapsedPlaybackMs) + 350;

          console.log(
            `[${this.callId}] ⏳ [BARGE-IN DINÂMICO] Saudação da IA transmitida (${(audioDurationMs / 1000).toFixed(1)}s de áudio). Aguardando término da reprodução (${remainingMs}ms) para abrir o canal.`
          );

          this.greetingFinishTimer = setTimeout(async () => {
            await this.openCustomerChannel('greeting_completed');
          }, remainingMs);
        }

        if (this.isSafetyExpiring && !this.safetyCloseTimer) {
          console.log(
            `[${this.callId}] ⏱️ Aviso de limite de segurança reproduzido pela IA. Encerrando chamada com tolerância de 1.5s.`
          );
          this.safetyCloseTimer = setTimeout(() => {
            this.terminateCall('safety_limit_3_minutes');
          }, 1500);
        }
      }

      if (body.type === 'input_audio_buffer.speech_started') {
        if (!this.isSecondaryVoiceBlocked) {
          this.triggerBargeIn('speech_started');
        } else {
          console.log(`[${this.callId}] 🛡️ [BIOMETRIA] speech_started ignorado (voz secundária/fundo bloqueada).`);
        }
      }
    } catch (err) {
      console.error(`[${this.callId}] Erro ao decodificar mensagem OpenAI:`, err.message);
    }
  }

  handleDtmf(evt) {
    if (this.isTerminated) return;
    const digit = evt?.dtmf || evt?.digit;
    if (!digit) return;

    if (this.isBargeinGraceActive()) {
      console.log(`[${this.callId}] 🛡️ [BARGE-IN GRACE] Dígito DTMF '${digit}' ignorado durante o período de carência (saudação inicial).`);
      return;
    }

    console.log(`[${this.callId}] 🔢 [DTMF] Dígito capturado: '${digit}'`);

    // Barge-in no primeiro dígito caso a IA esteja falando
    if (this.isAgentTalking) {
      if (typeof this.triggerBargeIn === 'function') {
        this.triggerBargeIn('dtmf_input');
      } else {
        this.isAgentTalking = false;
        if (this.mediaBridge) this.mediaBridge.killAudio();
        if (this.openaiSocket && this.openaiSocket.readyState === WebSocket.OPEN) {
          this.openaiSocket.send(JSON.stringify({ type: 'response.cancel' }));
        }
      }
    }

    if (this.dtmfTimer) {
      clearTimeout(this.dtmfTimer);
      this.dtmfTimer = null;
    }

    // Se o usuário pressionar '#', envia os dígitos acumulados imediatamente sem aguardar debounce
    if (digit === '#') {
      if (this.dtmfBuffer.length > 0) {
        this.flushDtmfBuffer();
      }
      return;
    }

    this.dtmfBuffer += String(digit);
    const debounceMs = this.tenant?.dtmf?.debounceMs || 1200;
    this.dtmfTimer = setTimeout(() => {
      this.flushDtmfBuffer();
    }, debounceMs);
  }

  flushDtmfBuffer() {
    if (this.dtmfTimer) {
      clearTimeout(this.dtmfTimer);
      this.dtmfTimer = null;
    }
    if (!this.dtmfBuffer || this.isTerminated) return;

    if (this.isBargeinGraceActive()) {
      console.log(`[${this.callId}] 🛡️ [BARGE-IN GRACE] Sequência DTMF "${this.dtmfBuffer}" ignorada durante o período de carência.`);
      this.dtmfBuffer = '';
      return;
    }

    const digits = this.dtmfBuffer;
    this.dtmfBuffer = '';

    console.log(`[${this.callId}] 🔢 [DTMF FLUSH] Sequência completa enviada à IA: "${digits}"`);

    this.recordTranscriptTurn('Cliente', `[DTMF: ${digits}]`);

    if (this.openaiSocket && this.openaiSocket.readyState === WebSocket.OPEN) {
      this.openaiSocket.send(
        JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: `[DTMF digitado pelo usuário no teclado: ${digits}]`
              }
            ]
          }
        })
      );
      this.openaiSocket.send(JSON.stringify({ type: 'response.create' }));
    }
  }

  async start({ callId, endpoint, dialog, caller = null, called = null }) {
    this.callId = callId;
    this.endpoint = endpoint;
    this.dialog = dialog;
    this.caller = caller;
    this.called = called;
    this.startedAt = new Date();
    this.channelUuid = getChannelUuid(endpoint);

    if (!this.channelUuid) {
      throw new Error('Não consegui identificar o UUID do canal FreeSWITCH');
    }

    // 0. Bloqueio Dinâmico de Barge-in: Corta o microfone do interlocutor no FreeSWITCH durante a frase inicial do agente
    if (this.bargeinGraceSec > 0) {
      this.isMicMutedByGrace = true;
      this.isGreetingInProgress = true;
      this.greetingAudioBytes = 0;
      this.greetingPlaybackStartTime = null;

      this.endpoint.api(`uuid_audio ${this.channelUuid} start read mute`).catch((err) => {
        console.error(`[${this.callId}] 🔇 [BARGE-IN DINÂMICO] Erro ao cortar microfone no FreeSWITCH:`, err.message);
      });
      console.log(
        `[${this.callId}] 🔇 [BARGE-IN DINÂMICO] Canal do microfone do cliente CORTADO no FreeSWITCH durante a frase inicial do agente.`
      );

      // Timeout de segurança (20s) para garantir abertura do canal caso haja falha inesperada na OpenAI
      this.greetingSafetyTimer = setTimeout(() => {
        if (this.isGreetingInProgress && !this.isTerminated) {
          console.warn(`[${this.callId}] ⏱️ [BARGE-IN DINÂMICO] Timeout de segurança de saudação (20s). Liberando canal do cliente.`);
          this.openCustomerChannel('safety_timeout');
        }
      }, 20000);
    }

    this.maxDurationSec = Number(
      this.tenant.maxDurationSec || process.env.MAX_CALL_DURATION_SEC || 180
    );
    const warningLeadSec = Math.min(10, Math.max(4, Math.floor(this.maxDurationSec / 10)));
    const warningTimeMs = Math.max(1000, (this.maxDurationSec - warningLeadSec) * 1000);

    // 1. Timer de Aviso Prévio com Fala Explícita de Interrupção aos ~170s
    this.warningDurationTimer = setTimeout(() => {
      if (this.isTerminated) return;
      this.isSafetyExpiring = true;
      const warningText =
        'Atenção: esta chamada atingiu o limite de segurança de três minutos e foi interrompida para sua proteção. Agradecemos pelo contato e até logo!';
      console.warn(
        `[${this.callId}] ⏱️ Limite de segurança de 3 minutos atingido (${this.maxDurationSec}s). Falando aviso de interrupção ao interlocutor.`
      );

      // Injeta instrução prioritária na OpenAI Realtime para falar imediatamente
      if (this.openaiSocket && this.openaiSocket.readyState === WebSocket.OPEN) {
        try {
          this.say(
            'AVISO DO SISTEMA: O limite máximo de segurança de 3 minutos foi atingido. Encerre imediatamente com o aviso regulamentar.',
            {
              role: 'system',
              interrupt: true,
              triggerResponse: true,
              instructions: `Fale IMEDIATAMENTE com voz clara, firme e educada: "${warningText}". Não responda nem diga mais nada.`
            }
          );
        } catch (e) {
          console.error(`[${this.callId}] Erro ao injetar fala de limite de segurança na OpenAI:`, e.message);
        }
      } else if (this.endpoint) {
        // Fallback acústico caso a OpenAI não esteja conectada
        try {
          this.endpoint.play('tone_stream://v=-10;%(400,200,425);%(400,200,425)').catch(() => {});
        } catch {}
      }
    }, warningTimeMs);

    // 2. Hard Cap Inegociável aos 180s (3 minutos): derruba a chamada incondicionalmente para proteção de custos
    this.maxDurationTimer = setTimeout(() => {
      console.warn(
        `[${this.callId}] 🛑 Limite rígido de segurança atingido (${this.maxDurationSec}s). Encerrando chamada para evitar cobrança indevida da OpenAI.`
      );
      this.terminateCall('safety_limit_3_minutes');
    }, this.maxDurationSec * 1000);

    // 1. Inicia sessão Whisper (AMD Inteligente e/ou Transcrição STT) se configurado
    this.whisperSession = new WhisperSession({
      callId: this.callId,
      channelUuid: this.channelUuid,
      tenant: this.tenant,
      sipHeaders: this.sipHeaders
    });

    const isActiveAmd =
      this.whisperSession.isAmdEnabled && this.whisperSession.amdMode === 'active';

    // Se o AMD ativo NÃO estiver bloqueando, inicia o handshake da OpenAI em paralelo com o Sonar.
    // Se o AMD ativo estiver ligado, só conectamos à OpenAI APÓS confirmar HUMANO (Zero sessões OpenAI em Caixa Postal/Operadora!).
    if (!isActiveAmd) {
      this.initOpenAiConnection();
    }

    if (this.whisperSession.isActive()) {
      this.whisperSession.on('decision', (decision) => {
        if (['caixa_postal', 'operadora', 'silencio'].includes(decision.label)) {
          if (this.whisperSession.amdMode === 'active') {
            console.log(
              `[${this.callId}] 🤖 AMD [ACTIVE]: Detectada ${decision.label.toUpperCase()} (${decision.reason}). Encerrando chamada.`
            );
            this.terminateCall(`amd_${decision.label}`);
          } else {
            console.log(
              `[${this.callId}] 🔍 AMD [SHADOW]: Detectada ${decision.label.toUpperCase()} (${decision.reason}). Chamada mantida.`
            );
          }
        } else {
          console.log(`[${this.callId}] 👤 AMD: HUMANO confirmado (${decision.reason}).`);
        }
      });

      this.whisperSession.on('transcript', (stt) => {
        if (this.isBargeinGraceActive()) {
          console.log(`[${this.callId}] 🛡️ [BARGE-IN GRACE] Transcrição do cliente ignorada durante carência: "${stt.text}"`);
          this.recordTranscriptTurn('Cliente', `[Ignorado na Saudação]: ${stt.text}`);
        } else {
          this.recordTranscriptTurn('Cliente', stt.text);
        }
      });

      this.whisperSession.on('speaker_enrolled', (evt) => {
        console.log(
          `[${this.callId}] 👤 [BIOMETRIA NEURAL ${evt.model.toUpperCase()}] Assinatura vocal do titular cadastrada (${evt.duration_s || 0}s). Vozes divergentes serão bloqueadas.`
        );
      });

      this.whisperSession.on('speaker_verification', (evt) => {
        this.lastSpeakerScore = evt.similarity;
        if (!evt.is_match) {
          this.isSecondaryVoiceBlocked = true;
          console.log(
            `[${this.callId}] 🛡️ [BIOMETRIA ${evt.model.toUpperCase()}] Voz de fundo/terceiro BLOQUEADA: similaridade ${evt.similarity} < limiar ${evt.threshold}. Áudio e barge-in barrados.`
          );
        } else {
          this.isSecondaryVoiceBlocked = false;
        }
      });

      // Fim da rajada de fala: libera o bloqueio para que a próxima fala (do titular) não seja mutada
      this.whisperSession.on('speaker_idle', () => {
        this.isSecondaryVoiceBlocked = false;
      });

      this.whisperSession.start();
    }

    // 2. Gravação Dual-Stream Stereo (.wav) + Transcrição (.txt) SOMENTE quando a transcrição (STT) estiver habilitada
    if (this.whisperSession && this.whisperSession.isSttEnabled) {
      this.recorder = new CallRecorder({
        callId: this.callId,
        tenantId: this.tenant.id,
        recordingDir: this.tenant.recordingDir
      });
      this.mediaBridge.setRecorder(this.recorder);
      await this.recorder.start();
    }

    // 2.1 Captura de DTMF In-Call via FreeSWITCH ESL / drachtio-fsmrf
    const dtmfHeader = this.sipHeaders['x-dtmf-enabled'];
    const isDtmfEnabled =
      dtmfHeader !== undefined
        ? String(dtmfHeader).toLowerCase() !== 'false'
        : this.tenant.dtmf?.enabled !== false;

    if (isDtmfEnabled && this.endpoint && typeof this.endpoint.on === 'function') {
      this.endpoint.on('dtmf', this.handleDtmf);
    }

    // 3. Limpeza de sessões residuais
    this.endpoint.api(`uuid_audio_fork ${this.channelUuid} stop`).catch(() => {});
    await wait(100);
    if (this.isTerminated) return;

    if (this.endpoint.conn) {
      try {
        this.endpoint.conn.subscribe('CUSTOM mod_audio_fork::play_audio');
        this.endpoint.conn.on('esl::event::CUSTOM::*', this.handleEslEvent);
      } catch (err) {
        console.error(`[${this.callId}] Erro ao subscrever eventos ESL:`, err.message);
      }
    }

    this.endpoint.api(`uuid_setvar ${this.channelUuid} echo_cancellation false`).catch(() => {});
    this.endpoint.api(`uuid_setvar ${this.channelUuid} noise_suppression true`).catch(() => {});

    let vadThreshold = 0.45;
    let prefixPaddingMs = 300;
    let silenceDurationMs = 500;

    // 3. Inicia ponte de áudio recebendo Buffer binário direto (sem conversão Base64 intermediária)
    this.energyManager.reset();
    this.calibrationActive = true;

    await this.mediaBridge.start({
      callId: this.callId,
      endpoint: this.endpoint,
      onAudio: (buffer) => {
        if (this.isTerminated) return;

        // Gravação Stereo (Left=Cliente, Right=Atendente) guiada pelo clock de 20ms do RTP (somente quando STT/Gravação ativa)
        if (this.recorder && !this.isToneProbe) {
          this.recorder.writeUserChunk(buffer);
        }

        // OTIMIZAÇÃO DE ESCALA: Só calcula RMS e Goertzel durante os 1.1s iniciais de calibração Sonar!
        if (this.calibrationActive) {
          let isEcoSample = false;
          if (this.isToneProbe || this.isAgentTalking) {
            isEcoSample = true;
            this.calibrationSamplesRecv++;
            if (this.calibrationSamplesRecv > 500) {
              this.calibrationActive = false;
            }
          }
          this.energyManager.calculateEnergy(buffer, isEcoSample);
        }

        // Se o AMD ativo ainda está decidindo, não envia áudio da operadora/caixa postal para a OpenAI
        const amdStillDeciding =
          this.whisperSession &&
          this.whisperSession.isAmdEnabled &&
          this.whisperSession.amdMode === 'active' &&
          !this.whisperSession.decisionReceived;

        // Período de Graça de Barge-in: Durante a saudação inicial do agente, qualquer fala do cliente é bloqueada
        const isGraceActive = this.isBargeinGraceActive();

        if (!isGraceActive && !this.graceEndLogged && this.bargeinGraceSec > 0 && this.startedAt) {
          this.graceEndLogged = true;
          console.log(
            `[${this.callId}] ⏳ [BARGE-IN GRACE] Período de carência finalizado (${this.bargeinGraceSec}s). Processamento de fala e pedidos do cliente liberados.`
          );
          if (this.openaiSocket && this.openaiSocket.readyState === WebSocket.OPEN) {
            try {
              this.openaiSocket.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
            } catch {}
          }
        }

        // Filtros de Voz de Fundo Selecionáveis: 'atual' (DSP), 'wespeaker' (CAM++) ou 'ecapa' (ECAPA-TDNN)
        // 1. Filtro DSP ('atual'):
        let isPrimaryVoiceDsp = true;
        if (this.isDspFilterActive && this.crosstalkFilter) {
          isPrimaryVoiceDsp = !this.isToneProbe && !amdStillDeciding && !isGraceActive
            ? this.crosstalkFilter.process(buffer)
            : false;
        } else if (isGraceActive || this.isToneProbe || amdStillDeciding) {
          isPrimaryVoiceDsp = false;
        }

        // 2. Filtro Neural ('wespeaker' / 'ecapa'):
        let isPrimaryVoiceNeural = true;
        if (this.isNeuralFilterActive && this.isSecondaryVoiceBlocked) {
          isPrimaryVoiceNeural = false;
        }

        const isPrimaryVoice = isPrimaryVoiceDsp && isPrimaryVoiceNeural;

        if (this.crosstalkFilter && this.crosstalkFilter.enrolled && !this.crosstalkEnrolledLogged) {
          this.crosstalkEnrolledLogged = true;
          console.log(
            `[${this.callId}] 👤 [BIOMETRIA VOCAL DSP] Assinatura do titular capturada: F0 = ${Math.round(this.crosstalkFilter.ownerPitchHz)}Hz | Graves = ${this.crosstalkFilter.ownerLowRatio.toFixed(2)} | RMS = ${Math.round(this.crosstalkFilter.userVoiceRms)}. Vozes divergentes serão bloqueadas.`
          );
        }

        const effectiveBuffer = isPrimaryVoice ? buffer : Buffer.alloc(buffer.length);

        // Barge-in Instantâneo (<20ms): só interrompe se for fala ativa legítima (não cauda/hangover silencioso)
        const isActivelySpeaking = this.crosstalkFilter
          ? this.crosstalkFilter.isActivelySpeaking()
          : this.frameVad.process(buffer);
        if (isPrimaryVoice && isActivelySpeaking && this.isAgentTalking && this.canTriggerBargeIn()) {
          this.triggerBargeIn(this.isNeuralFilterActive ? `biometric_${this.crosstalkMode}` : 'local_biometric_vad');
        }

        // Encaminha áudio ao Whisper / Verifier:
        // Se a biometria neural estiver ativa, envia o áudio bruto para o modelo poder avaliar a voz;
        // caso contrário, envia o effectiveBuffer para o Whisper não transcrever ruídos de fundo.
        if (this.whisperSession && !this.isToneProbe) {
          if (this.whisperSession.isAmdEnabled && !this.whisperSession.decisionReceived) {
            this.whisperSession.pushAudio(buffer, 8000);
          } else if (this.isNeuralFilterActive) {
            this.whisperSession.pushAudio(buffer, 8000);
          } else if (!isGraceActive) {
            this.whisperSession.pushAudio(effectiveBuffer, 8000);
          }
        }

        if (
          !this.isToneProbe &&
          !amdStillDeciding &&
          !isGraceActive &&
          this.openaiReady &&
          this.openaiSocket &&
          this.openaiSocket.readyState === WebSocket.OPEN
        ) {
          const outboundAudio = this.useG711 ? linear16ToMulaw(effectiveBuffer) : upsample8to24(effectiveBuffer);
          this.openaiSocket.send(
            JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: outboundAudio.toString('base64')
            })
          );
        }
      }
    });
    if (this.isTerminated) return;

    // 4. Se o AMD estiver ligado na chamada, aguarda a classificação antes de falar na OpenAI
    const amdWasExecuted = !!(this.whisperSession && this.whisperSession.isAmdEnabled);
    if (amdWasExecuted) {
      console.log(`[${this.callId}] 🕵️ Aguardando análise do Detector de Secretária (AMD)...`);
      await this.whisperSession.waitForDecision();
      if (this.isTerminated) {
        return; // Chamada encerrada pelo AMD (caixa_postal / operadora / silencio) sem abrir nem gastar sessão na OpenAI!
      }
      if (isActiveAmd && !this.openaiSocket) {
        this.initOpenAiConnection();
      }
    }

    const bargeinLevel = this.tenant.bargeinLevel ?? 3;

    // 4. Calibração acústica (Sonar Mode)
    // Se o AMD já executou, já coletamos amostras acústicas reais durante o "Alô?" (~1.5s),
    // então pulamos os 1.1s do bip Sonar para responder ao humano imediatamente sem silêncio duplo!
    if (amdWasExecuted) {
      this.calibrationActive = false;
      this.deviceMode = 'fone_ouvido';
      this.currentProfile = this.energyManager.getClassification();
      const config = this.profiles[this.currentProfile].fone;
      vadThreshold = config.base;
      prefixPaddingMs = config.prefix;
      silenceDurationMs = config.silence;
      console.log(
        `[${this.callId}] ⚡ FAST-LOCK (Pós-AMD): Ambiente ${this.currentProfile} | VAD ${vadThreshold} (Sonar pulado para 0ms de atraso)`
      );
    } else if (bargeinLevel >= 3) {
      this.endpoint.api(`uuid_setvar ${this.channelUuid} echo_cancellation false`).catch(() => {});
      await wait(400);

      this.isToneProbe = true;
      this.endpoint.play('tone_stream://v=0;%(700,0,425)').catch(() => {});
      const startSamples = this.energyManager.echoSamplesCount;
      await wait(700);
      this.isToneProbe = false;
      const collected = this.energyManager.echoSamplesCount - startSamples;

      if (collected > 0) {
        console.log(`[${this.callId}] [SONAR] Capturadas ${collected} amostras acústicas.`);
      }

      this.deviceMode = this.energyManager.detectDeviceMode(this.callId);

      // Desliga o cálculo de energia após travar o perfil do Sonar (economia de ~30% de CPU por chamada)
      this.calibrationActive = false;

      if (this.deviceMode === 'viva_voz') {
        console.log(`[${this.callId}] 🛡️ Ativando AEC para proteção de Viva-voz.`);
        this.endpoint.api(`uuid_setvar ${this.channelUuid} echo_cancellation true`).catch(() => {});
      } else {
        console.log(`[${this.callId}] 🎧 Mantendo AEC desligado para máxima fluidez no Fone.`);
        this.endpoint.api(`uuid_setvar ${this.channelUuid} echo_cancellation false`).catch(() => {});
      }

      this.currentProfile = this.energyManager.getClassification();
      const config = this.profiles[this.currentProfile][this.deviceMode === 'fone_ouvido' ? 'fone' : 'viva'];

      vadThreshold = config.base;
      prefixPaddingMs = config.prefix;
      silenceDurationMs = config.silence;

      console.log(
        `[${this.callId}] 🎯 SONAR LOCK: Dispositivo ${this.deviceMode.toUpperCase()} | Ambiente ${this.currentProfile} | VAD ${vadThreshold}`
      );
    } else {
      this.calibrationActive = false;
      this.endpoint.play('tone_stream://v=-13;%(500,0,425)').catch(() => {});
      await wait(500);
    }

    if (this.isTerminated) return;

    // 5. Aguarda confirmação do handshake OpenAI
    if (!this.openaiConnected && this.openaiReadyPromise) {
      await withTimeout(this.openaiReadyPromise, 4000).catch((e) => {
        console.warn(`[${this.callId}] Alerta no handshake OpenAI:`, e.message);
      });
    }

    if (this.isTerminated) return;

    if (!this.openaiSocket || this.openaiSocket.readyState !== WebSocket.OPEN) {
      console.error(`[${this.callId}] 🔴 Falha ao estabelecer conexão com a OpenAI Realtime.`);
      this.terminateCall('openai_connection_failed');
      return;
    }

    // 6. Envia configuração da sessão compatível com OpenAI Realtime GA (type: 'realtime')
    const sessionUpdate = {
      type: 'session.update',
      session: {
        type: 'realtime',
        audio: {
          input: {
            transcription: {
              model: 'whisper-1',
              language: 'pt'
            },
            turn_detection: {
              type: 'server_vad',
              threshold: vadThreshold,
              prefix_padding_ms: prefixPaddingMs,
              silence_duration_ms: silenceDurationMs
            }
          }
        }
      }
    };

    if (this.useG711) {
      sessionUpdate.session.audio.input.format = { type: 'audio/pcmu' };
      sessionUpdate.session.audio.output = {
        format: { type: 'audio/pcmu' }
      };
    }

    if (this.tenant.voice) {
      sessionUpdate.session.audio.output = {
        ...(sessionUpdate.session.audio.output || {}),
        voice: this.tenant.voice
      };
    }

    if (this.tenant.openaiPromptId) {
      sessionUpdate.session.prompt = { id: this.tenant.openaiPromptId };
    } else if (this.tenant.instructions) {
      sessionUpdate.session.instructions = this.tenant.instructions;
    }

    this.openaiSocket.send(JSON.stringify(sessionUpdate));

    const responseCreate = {
      type: 'response.create',
      response: {
        instructions: 'Dê as boas-vindas cordialmente de forma curta e amigável e pergunte em que pode ajudar hoje.'
      }
    };
    this.greetingResponsePending = true;
    this.openaiSocket.send(JSON.stringify(responseCreate));

    // Somente após session.update e response.create liberamos o envio de input_audio_buffer.append
    this.openaiReady = true;

    console.log(
      `[${this.callId}] 🟢 IA configurada (Codec: ${this.useG711 ? 'g711_ulaw' : 'pcm24k'}) e pronta para conversação.`
    );
  }

  recordTranscriptTurn(speaker, text) {
    const cleanText = String(text || '').trim();
    if (!cleanText) return null;

    // Deduplicação: se a mesma fala do mesmo interlocutor chegar em menos de 3.5 segundos, não duplica
    const now = Date.now();
    if (
      this.lastTurn &&
      this.lastTurn.speaker === speaker &&
      this.lastTurn.text.toLowerCase() === cleanText.toLowerCase() &&
      now - this.lastTurn.time < 3500
    ) {
      return this.lastTurn.entry;
    }

    if (this.recorder && !this.recorder.isStopped && !this.recorder.isPaused) {
      const entry = this.recorder.addTranscript(speaker, cleanText);
      if (entry) {
        this.transcriptLog.push(entry);
        this.lastTurn = { speaker, text: cleanText, time: now, entry };
        return entry;
      }
    }

    const role = speaker === 'Atendente' ? 'Atendente' : 'Cliente';
    const timestamp = formatDateTime();
    const formatted = `[${timestamp}] ${role}: ${cleanText}`;
    const entry = { timestamp, speaker: role, text: cleanText, formatted };
    this.transcriptLog.push(entry);
    this.lastTurn = { speaker, text: cleanText, time: now, entry };
    console.log(`[${this.callId}] 📝 ${formatted}`);
    return entry;
  }

  getCallInfo(includeTranscript = false) {
    const durationSec = this.startedAt ? Math.floor((Date.now() - this.startedAt.getTime()) / 1000) : 0;
    const lastTurnEntry = this.transcriptLog.length > 0 ? this.transcriptLog[this.transcriptLog.length - 1] : null;
    const info = {
      callId: this.callId,
      channelUuid: this.channelUuid,
      tenantId: this.tenant?.id || 'default',
      caller: this.caller,
      called: this.called,
      startedAt: this.startedAt ? this.startedAt.toISOString() : null,
      durationSec,
      maxDurationSec: this.maxDurationSec || 180,
      isSafetyExpiring: this.isSafetyExpiring,
      bargeinGraceSec: this.bargeinGraceSec,
      isBargeinGraceActive: this.isBargeinGraceActive(),
      isMicMutedByGrace: this.isMicMutedByGrace,
      isGreetingInProgress: this.isGreetingInProgress,
      crosstalkFilter: {
        mode: this.crosstalkMode,
        isDspActive: this.isDspFilterActive,
        isNeuralActive: this.isNeuralFilterActive,
        lastSpeakerScore: this.lastSpeakerScore,
        isSecondaryVoiceBlocked: this.isSecondaryVoiceBlocked,
        dspMetrics: this.crosstalkFilter ? this.crosstalkFilter.getMetrics() : null
      },
      codec: this.useG711 ? 'g711_ulaw' : 'pcm24k',
      deviceMode: this.deviceMode,
      noiseProfile: this.currentProfile,
      isAgentTalking: this.isAgentTalking,
      isMuted: this.isMuted,
      isOnHold: this.isOnHold,
      openaiConnected: this.openaiConnected,
      amdEnabled: !!(this.whisperSession && this.whisperSession.isAmdEnabled),
      sttEnabled: !!(this.whisperSession && this.whisperSession.isSttEnabled),
      recordingActive: !!(this.recorder && this.recorder.isStarted && !this.recorder.isStopped && !this.recorder.isPaused),
      recordingPaused: !!(this.recorder && this.recorder.isPaused),
      recordingFile: this.recorder ? this.recorder.fileName : null,
      transcriptFile: this.recorder ? this.recorder.transcriptFileName : null,
      transcriptTurnsCount: this.transcriptLog.length,
      lastTranscript: lastTurnEntry
    };

    if (includeTranscript) {
      info.transcript = this.transcriptLog;
    }
    return info;
  }

  interruptAgent() {
    this.isAgentTalking = false;
    this.mediaBridge.killAudio();
    if (this.openaiSocket && this.openaiSocket.readyState === WebSocket.OPEN) {
      this.openaiSocket.send(JSON.stringify({ type: 'response.cancel' }));
    }
    if (this.endpoint && this.channelUuid) {
      this.endpoint.api(`uuid_audio_fork ${this.channelUuid} stop_play`).catch(() => {});
      this.endpoint.api(`uuid_break ${this.channelUuid} all`).catch(() => {});
    }
  }

  say(text, { role = 'user', interrupt = true, triggerResponse = true, instructions = null } = {}) {
    if (interrupt && this.isAgentTalking) {
      this.interruptAgent();
    }
    if (!this.openaiSocket || this.openaiSocket.readyState !== WebSocket.OPEN) {
      throw new Error('Sessão OpenAI Realtime não está conectada');
    }

    const validRole = ['user', 'system', 'assistant'].includes(role) ? role : 'user';
    this.openaiSocket.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: validRole,
          content: [
            {
              type: 'input_text',
              text: String(text)
            }
          ]
        }
      })
    );

    if (triggerResponse) {
      const respPayload = { type: 'response.create' };
      if (instructions) {
        respPayload.response = { instructions: String(instructions) };
      }
      this.openaiSocket.send(JSON.stringify(respPayload));
    }

    return { role: validRole, interrupt, triggerResponse };
  }

  async transfer(target, { mode = 'blind', dialplan = 'XML', context = 'default' } = {}) {
    if (mode === 'refer' && this.dialog && typeof this.dialog.request === 'function') {
      const referTo = target.startsWith('sip:') || target.startsWith('<sip:') ? target : `<sip:${target}>`;
      await this.dialog.request({
        method: 'REFER',
        headers: {
          'Refer-To': referTo
        }
      });
      return { mode: 'refer', target: referTo };
    }

    if (!this.endpoint || !this.channelUuid) {
      throw new Error('Canal FreeSWITCH indisponível para transferência');
    }
    const cleanTarget = String(target).replace(/[^a-zA-Z0-9_+*#@.-]/g, '');
    await this.endpoint.api(`uuid_transfer ${this.channelUuid} ${cleanTarget} ${dialplan} ${context}`);
    return { mode: 'blind', target: cleanTarget, dialplan, context };
  }

  async sendDtmf(digits, direction = 'outbound') {
    const cleanDigits = String(digits).replace(/[^0-9A-D*#wW]/g, '');
    if (!cleanDigits) {
      throw new Error('Nenhum dígito DTMF válido informado');
    }

    if (direction === 'inbound') {
      for (const ch of cleanDigits) {
        this.handleDtmf({ dtmf: ch });
      }
      this.flushDtmfBuffer();
      return { direction: 'inbound', digits: cleanDigits };
    }

    if (!this.endpoint || !this.channelUuid) {
      throw new Error('Canal FreeSWITCH indisponível para envio de DTMF');
    }
    await this.endpoint.api(`uuid_send_dtmf ${this.channelUuid} ${cleanDigits}`);
    return { direction: 'outbound', digits: cleanDigits };
  }

  async playAudioFile(file) {
    if (!this.endpoint) {
      throw new Error('Endpoint FreeSWITCH indisponível');
    }
    await this.endpoint.play(file);
    return { file };
  }

  async setMute(muted) {
    this.isMuted = Boolean(muted);
    if (this.endpoint && this.channelUuid) {
      if (this.isMuted) {
        await this.endpoint.api(`uuid_audio ${this.channelUuid} start read mute`).catch(() => {});
      } else {
        await this.endpoint.api(`uuid_audio ${this.channelUuid} stop read`).catch(() => {});
      }
    }
    return { isMuted: this.isMuted };
  }

  async setHold(held) {
    this.isOnHold = Boolean(held);
    if (this.endpoint && this.channelUuid) {
      const subCmd = this.isOnHold ? `${this.channelUuid}` : `off ${this.channelUuid}`;
      await this.endpoint.api(`uuid_hold ${subCmd}`).catch(() => {});
    }
    return { isOnHold: this.isOnHold };
  }

  async controlRecording(action = 'start') {
    if (action === 'start') {
      if (!this.recorder || this.recorder.isStopped) {
        this.recorder = new CallRecorder({
          callId: this.callId,
          tenantId: this.tenant.id,
          recordingDir: this.tenant.recordingDir
        });
        this.mediaBridge.setRecorder(this.recorder);
        await this.recorder.start();
      } else if (this.recorder.isPaused) {
        this.recorder.resume();
      }
      return {
        recordingActive: true,
        recordingPaused: false,
        fileName: this.recorder.fileName
      };
    }

    if (action === 'pause') {
      if (this.recorder && this.recorder.isStarted && !this.recorder.isStopped) {
        this.recorder.pause();
      }
      return {
        recordingActive: false,
        recordingPaused: !!(this.recorder && this.recorder.isPaused)
      };
    }

    if (action === 'resume') {
      if (this.recorder && this.recorder.isStarted && !this.recorder.isStopped) {
        this.recorder.resume();
      }
      return {
        recordingActive: !!(this.recorder && this.recorder.isStarted && !this.recorder.isPaused),
        recordingPaused: false
      };
    }

    if (action === 'stop') {
      if (this.recorder) {
        await this.recorder.stop();
      }
      return {
        recordingActive: false,
        recordingPaused: false
      };
    }

    throw new Error(`Ação de gravação inválida: ${action} (use start, pause, resume ou stop)`);
  }

  terminateCall(reason = 'normal_hangup') {
    if (this.graceUnmuteTimer) {
      clearTimeout(this.graceUnmuteTimer);
      this.graceUnmuteTimer = null;
    }
    if (this.greetingFinishTimer) {
      clearTimeout(this.greetingFinishTimer);
      this.greetingFinishTimer = null;
    }
    if (this.greetingSafetyTimer) {
      clearTimeout(this.greetingSafetyTimer);
      this.greetingSafetyTimer = null;
    }

    if (this.isTerminated) {
      if (this.cleanupHandler) {
        const cb = this.cleanupHandler;
        this.cleanupHandler = null;
        try { cb(reason); } catch {}
      }
      return;
    }
    this.isTerminated = true;

    console.log(`[${this.callId}] Encerrando chamada (Motivo: ${reason})...`);
    if (this.dialog) {
      try {
        this.dialog.destroy();
      } catch {}
      this.dialog = null;
    }
    if (this.endpoint) {
      try {
        this.endpoint.destroy();
      } catch {}
      this.endpoint = null;
    }
    this.stop().catch(() => {});
    if (this.cleanupHandler) {
      const cb = this.cleanupHandler;
      this.cleanupHandler = null;
      try { cb(reason); } catch {}
    }
  }

  async stop() {
    this.isTerminated = true;

    if (this.graceUnmuteTimer) {
      clearTimeout(this.graceUnmuteTimer);
      this.graceUnmuteTimer = null;
    }
    if (this.greetingFinishTimer) {
      clearTimeout(this.greetingFinishTimer);
      this.greetingFinishTimer = null;
    }
    if (this.greetingSafetyTimer) {
      clearTimeout(this.greetingSafetyTimer);
      this.greetingSafetyTimer = null;
    }

    if (this.warningDurationTimer) {
      clearTimeout(this.warningDurationTimer);
      this.warningDurationTimer = null;
    }

    if (this.safetyCloseTimer) {
      clearTimeout(this.safetyCloseTimer);
      this.safetyCloseTimer = null;
    }

    if (this.maxDurationTimer) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }

    if (this.dtmfTimer) {
      clearTimeout(this.dtmfTimer);
      this.dtmfTimer = null;
    }

    if (this.endpoint && typeof this.endpoint.removeListener === 'function') {
      try {
        this.endpoint.removeListener('dtmf', this.handleDtmf);
      } catch {}
    }

    if (this.endpoint && this.endpoint.conn) {
      try {
        this.endpoint.conn.removeListener('esl::event::CUSTOM::*', this.handleEslEvent);
      } catch {}
    }

    if (this.endpoint) {
      try {
        this.endpoint.destroy();
      } catch {}
      this.endpoint = null;
    }

    if (this.mediaBridge) {
      await this.mediaBridge.stop();
    }

    if (this.recorder) {
      await this.recorder.stop();
      this.recorder = null;
    }

    if (this.whisperSession) {
      this.whisperSession.stop();
      this.whisperSession = null;
    }

    if (this.openaiSocket) {
      try {
        this.openaiSocket.close();
      } catch {}
      this.openaiSocket = null;
    }
    this.openaiReady = false;
  }
}

// Inicialização Drachtio SRF (Suporta Modo Inbound e Modo Outbound para Load Balancing)
if (DRACHTIO_MODE === 'outbound') {
  const listenPort = DRACHTIO_LISTEN_PORT + WORKER_ID;
  srf.listen({ port: listenPort, secret: DRACHTIO_SECRET });
  console.log(`✅ Drachtio SRF em modo OUTBOUND ouvindo na porta ${listenPort} (Worker #${WORKER_ID})`);
} else {
  srf.connect({
    host: DRACHTIO_HOST,
    port: DRACHTIO_PORT,
    secret: DRACHTIO_SECRET
  });

  srf.on('connect', (err, hp) => {
    if (err) {
      console.error('🔴 Erro conectando ao Drachtio:', err);
      return;
    }
    isDrachtioConnected = true;
    console.log(`✅ Conectado ao Drachtio SRF: ${hp} (Worker #${WORKER_ID})`);
  });
}

srf.on('disconnect', () => {
  isDrachtioConnected = false;
  console.error('🚨 Drachtio SRF desconectado!');
});

srf.on('error', (err) => {
  console.error('🚨 Erro no Drachtio SRF:', err.message || err);
});

// Inicializa Pool de Múltiplas Instâncias FreeSWITCH e o Servidor HTTP/WS
fsPool.start();

// Handler para Originação de Chamadas Ativas (POST /v1/calls)
async function originateOutboundCall(params) {
  if (isShuttingDown || !fsPool.hasHealthyNode()) {
    throw new Error('Serviço indisponível ou sem nós FreeSWITCH saudáveis');
  }

  const tenantId = params.tenantId || 'default';
  const baseTenant = tenantManager.tenants.get(tenantId) || tenantManager.getDefaultTenant();
  const tenant = {
    ...baseTenant,
    ...(params.instructions ? { instructions: params.instructions } : {}),
    ...(params.voice ? { voice: params.voice } : {}),
    ...(params.openaiModel ? { openaiModel: params.openaiModel } : {})
  };

  const slotCheck = tenantManager.tryAcquireSlot(tenant);
  if (!slotCheck.allowed) {
    throw new Error(slotCheck.reason);
  }

  let releaseNodeSlot = null;
  let bridge = null;
  let dialog = null;
  let tenantSlotReleased = false;

  const releaseTenantSlotOnce = () => {
    if (tenantSlotReleased) return;
    tenantSlotReleased = true;
    tenantManager.releaseSlot(tenant);
  };

  try {
    const from = params.from || '1000';
    const to = params.to;
    const customHeaders = params.headers || {};

    const { endpoint, dialog: uacDialog, fsNode, releaseNodeSlot: rSlot } = await fsPool.originateCall(srf, {
      to,
      from,
      headers: customHeaders
    });

    dialog = uacDialog;
    releaseNodeSlot = rSlot;
    const callId = dialog.sip?.callId || `out-${Date.now()}`;

    console.log(
      `[${callId}] 📤 Chamada OUTBOUND conectada de ${from} para ${to} | Tenant: [${tenant.id}] | Nó Mídia: [${fsNode.id}]`
    );

    const sipHeaders = {
      'x-amd-enabled':
        params.amd !== undefined ? String(Boolean(params.amd)) : customHeaders['X-AMD-Enabled'] || 'true',
      'x-stt-enabled':
        params.stt !== undefined ? String(Boolean(params.stt)) : customHeaders['X-STT-Enabled'],
      'x-dtmf-enabled':
        params.dtmf !== undefined ? String(Boolean(params.dtmf)) : customHeaders['X-DTMF-Enabled'],
      'x-bargein-grace-sec':
        params.bargeinGraceSec !== undefined ? String(params.bargeinGraceSec) : customHeaders['X-Bargein-Grace-Sec'],
      'x-tenant-id': tenant.id
    };

    bridge = new OpenAIS2SBridge(tenant, sipHeaders);
    activeBridges.set(callId, bridge);

    let cleanedUp = false;
    const cleanupCall = async (reason = 'normal_hangup') => {
      if (cleanedUp) return;
      cleanedUp = true;
      console.log(`[${callId}] Limpando chamada outbound (Motivo: ${reason})...`);
      activeBridges.delete(callId);
      releaseTenantSlotOnce();
      if (releaseNodeSlot) releaseNodeSlot();
      if (endpoint) {
        try { endpoint.destroy(); } catch {}
      }
      if (dialog) {
        try { dialog.destroy(); } catch {}
      }
      try {
        if (bridge) await bridge.stop();
      } catch {}
    };

    bridge.setCleanupHandler(cleanupCall);

    dialog.on('destroy', async () => {
      console.log(`[${callId}] Chamada outbound encerrada.`);
      await cleanupCall('dialog_destroy');
    });

    bridge.start({ callId, endpoint, dialog, caller: from, called: to }).catch((err) => {
      console.error(`[${callId}] Erro em bridge.start (outbound):`, err.message);
    });

    return {
      ok: true,
      callId,
      channelUuid: getChannelUuid(endpoint),
      tenantId: tenant.id,
      from,
      to,
      mediaNode: fsNode.id,
      amdEnabled: sipHeaders['x-amd-enabled'] === 'true',
      sttEnabled: sipHeaders['x-stt-enabled'] === 'true' || Boolean(tenant.stt?.enabled)
    };
  } catch (err) {
    releaseTenantSlotOnce();
    if (releaseNodeSlot) releaseNodeSlot();
    if (dialog) {
      try {
        dialog.destroy();
      } catch {}
    }
    throw err;
  }
}

mediaServer.setApiHandler(
  createApiRouter({
    activeBridges,
    tenantManager,
    fsPool,
    whisperPool,
    mediaServer,
    originateCallHandler: originateOutboundCall
  })
);

mediaServer.listen().catch(() => {});

// Atendimento de Chamadas SIP (INVITE) com Balanceamento entre Instâncias FreeSWITCH
srf.invite(async (req, res) => {
  if (isShuttingDown || !fsPool.hasHealthyNode()) {
    return res.send(503);
  }

  const callId = getCallId(req);
  const tenant = tenantManager.resolveTenant(req);

  if (!tenant || !tenant.active) {
    console.warn(`[${callId}] Chamada rejeitada: Tenant inativo ou não cadastrado.`);
    return res.send(404);
  }

  // Verifica limite de canais simultâneos e CPS do Tenant
  const slotCheck = tenantManager.tryAcquireSlot(tenant);
  if (!slotCheck.allowed) {
    console.warn(`[${callId}] Chamada recusada para Tenant [${tenant.id}]: ${slotCheck.reason}`);
    return res.send(slotCheck.sipStatus || 486);
  }

  let endpoint;
  let dialog;
  let fsNode;
  let releaseNodeSlot;
  let bridge;
  let tenantSlotReleased = false;

  const releaseTenantSlotOnce = () => {
    if (tenantSlotReleased) return;
    tenantSlotReleased = true;
    tenantManager.releaseSlot(tenant);
  };

  try {
    const caller = req.callingNumber || req.get('From');
    const called = req.calledNumber || req.get('To');

    // Aloca a chamada na instância de FreeSWITCH com menor carga do Pool
    ({ endpoint, dialog, fsNode, releaseNodeSlot } = await fsPool.connectCaller(req, res));
    console.log(
      `[${callId}] 📞 Chamada atendida de ${caller} para ${called} | Tenant: [${tenant.id}] | Nó Mídia: [${fsNode.id}] (Ativas no nó: ${fsNode.activeCalls})`
    );

    const sipHeaders = {
      'x-amd-enabled': req.get('x-amd-enabled') || req.get('X-AMD-Enabled'),
      'x-stt-enabled': req.get('x-stt-enabled') || req.get('X-STT-Enabled'),
      'x-dtmf-enabled': req.get('x-dtmf-enabled') || req.get('X-DTMF-Enabled'),
      'x-bargein-grace-sec': req.get('x-bargein-grace-sec') || req.get('X-Bargein-Grace-Sec'),
      'x-tenant-id': req.get('x-tenant-id') || req.get('X-Tenant-ID')
    };

    bridge = new OpenAIS2SBridge(tenant, sipHeaders);
    activeBridges.set(callId, bridge);

    let cleanedUp = false;
    const cleanupCall = async (reason = 'normal_hangup') => {
      if (cleanedUp) return;
      cleanedUp = true;
      console.log(`[${callId}] Limpando recursos da chamada (Motivo: ${reason})...`);
      activeBridges.delete(callId);
      releaseTenantSlotOnce();
      if (releaseNodeSlot) releaseNodeSlot();
      if (endpoint) {
        try { endpoint.destroy(); } catch {}
      }
      if (dialog) {
        try { dialog.destroy(); } catch {}
      }
      try {
        if (bridge) await bridge.stop();
      } catch {}
    };

    bridge.setCleanupHandler(cleanupCall);

    dialog.on('destroy', async () => {
      console.log(`[${callId}] Chamada encerrada pelo assinante/rede.`);
      await cleanupCall('dialog_destroy');
    });

    await bridge.start({ callId, endpoint, dialog, caller, called });
  } catch (err) {
    console.error(`[${callId}] Erro durante atendimento da chamada:`, err);
    activeBridges.delete(callId);
    releaseTenantSlotOnce();
    if (releaseNodeSlot) releaseNodeSlot();
    try {
      res.send(500);
    } catch {}
    try {
      if (dialog) dialog.destroy();
    } catch {}
    try {
      if (bridge) await bridge.stop();
    } catch {}
  }
});

// Encerramento Gracioso (Graceful Shutdown)
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[SHUTDOWN] Recebido sinal ${signal}. Encerrando graciosamente...`);

  const activeList = Array.from(activeBridges.values());
  console.log(`[SHUTDOWN] Finalizando ${activeList.length} chamada(s) ativa(s)...`);
  for (const bridge of activeList) {
    try {
      bridge.terminateCall('server_shutdown');
    } catch {}
  }
  activeBridges.clear();

  try {
    await mediaServer.close();
  } catch {}

  try {
    await fsPool.stop();
  } catch {}

  try {
    srf.disconnect();
  } catch {}

  console.log('[SHUTDOWN] voice-app finalizado com sucesso.');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  console.error('🚨 [FATAL] uncaughtException interceptada:', err.stack || err);
});

process.on('unhandledRejection', (reason) => {
  console.error('🚨 [WARN] unhandledRejection interceptada:', reason?.stack || reason);
});

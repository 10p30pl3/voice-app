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
const WsMediaBridge = require('./media/ws-media-bridge');
const { mediaServer } = require('./media/ws-media-bridge');
const tenantManager = require('./utils/tenant-manager');
const FreeSwitchPool = require('./utils/freeswitch-pool');
const { WhisperSession } = require('./media/whisper-client');

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
    this.isTerminated = false;

    this.handleEslEvent = this.handleEslEvent.bind(this);
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

      if (body.type === 'response.created' || body.type === 'response.output_item.added') {
        if (!this.isAgentTalking) {
          this.isAgentTalking = true;
          this.mediaBridge.startPlaybackStream();
        }
      } else if (body.type === 'response.cancelled') {
        this.isAgentTalking = false;
        this.mediaBridge.killAudio();
      }

      if (body.type === 'response.output_audio.delta' && body.delta) {
        if (!this.isAgentTalking) {
          this.isAgentTalking = true;
          this.mediaBridge.startPlaybackStream();
        }
        const rawDelta = Buffer.from(body.delta, 'base64');
        const pcm8k = this.useG711 ? mulawToLinear16(rawDelta) : downsample24to8(rawDelta);
        this.mediaBridge.pushAudioChunk(pcm8k);
      }

      if (['response.output_audio.done', 'response.done'].includes(body.type)) {
        if (this.isAgentTalking) {
          this.isAgentTalking = false;
          console.log(`[${this.callId}] 🔊 Fim da resposta da IA.`);
          this.mediaBridge.endPlaybackStream();
        }
      }

      if (body.type === 'input_audio_buffer.speech_started') {
        console.log(`[${this.callId}] 🎤 BARGE-IN: Usuário falou! Interrompendo agente imediatamente...`);
        this.isAgentTalking = false;
        // Purga instantaneamente qualquer áudio acumulado no buffer de playout do mod_audio_fork
        this.mediaBridge.killAudio();
        if (this.openaiSocket && this.openaiSocket.readyState === WebSocket.OPEN) {
          this.openaiSocket.send(JSON.stringify({ type: 'response.cancel' }));
        }
        if (this.endpoint && this.channelUuid) {
          this.endpoint.api(`uuid_audio_fork ${this.channelUuid} stop_play`).catch(() => {});
          this.endpoint.api(`uuid_break ${this.channelUuid} all`).catch(() => {});
        }
      }
    } catch (err) {
      console.error(`[${this.callId}] Erro ao decodificar mensagem OpenAI:`, err.message);
    }
  }

  async start({ callId, endpoint, dialog }) {
    this.callId = callId;
    this.endpoint = endpoint;
    this.dialog = dialog;
    this.channelUuid = getChannelUuid(endpoint);

    if (!this.channelUuid) {
      throw new Error('Não consegui identificar o UUID do canal FreeSWITCH');
    }

    const maxDurationSec = this.tenant.maxDurationSec || 900;
    this.maxDurationTimer = setTimeout(() => {
      console.warn(`[${this.callId}] ⏱️ Limite de duração da chamada atingido (${maxDurationSec}s). Encerrando.`);
      this.terminateCall('max_duration_exceeded');
    }, maxDurationSec * 1000);

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
        console.log(`[${this.callId}] 📝 [STT] "${stt.text}"`);
      });

      this.whisperSession.start();
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

        // Encaminha áudio ao Whisper para AMD e/ou STT (ignorando o tom de calibração 425Hz do Sonar)
        if (this.whisperSession && !this.isToneProbe) {
          this.whisperSession.pushAudio(buffer, 8000);
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

        if (
          !this.isToneProbe &&
          !amdStillDeciding &&
          this.openaiReady &&
          this.openaiSocket &&
          this.openaiSocket.readyState === WebSocket.OPEN
        ) {
          const outboundAudio = this.useG711 ? linear16ToMulaw(buffer) : upsample8to24(buffer);
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

    if (this.tenant.openaiPromptId) {
      sessionUpdate.session.prompt = { id: this.tenant.openaiPromptId };
    } else if (this.tenant.instructions) {
      sessionUpdate.session.instructions = this.tenant.instructions;
      if (this.tenant.voice) {
        sessionUpdate.session.audio.output = {
          ...(sessionUpdate.session.audio.output || {}),
          voice: this.tenant.voice
        };
      }
    }

    this.openaiSocket.send(JSON.stringify(sessionUpdate));

    const responseCreate = {
      type: 'response.create',
      response: {
        instructions: 'Faça uma saudação inicial curta e amigável.'
      }
    };
    this.openaiSocket.send(JSON.stringify(responseCreate));

    // Somente após session.update e response.create liberamos o envio de input_audio_buffer.append
    this.openaiReady = true;

    console.log(
      `[${this.callId}] 🟢 IA configurada (Codec: ${this.useG711 ? 'g711_ulaw' : 'pcm24k'}) e pronta para conversação.`
    );
  }

  terminateCall(reason = 'normal_hangup') {
    if (this.isTerminated) return;
    this.isTerminated = true;

    console.log(`[${this.callId}] Encerrando chamada (Motivo: ${reason})...`);
    if (this.dialog) {
      try {
        this.dialog.destroy();
      } catch {}
      this.dialog = null;
    }
    this.stop().catch(() => {});
  }

  async stop() {
    this.isTerminated = true;

    if (this.maxDurationTimer) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }

    if (this.endpoint && this.endpoint.conn) {
      try {
        this.endpoint.conn.removeListener('esl::event::CUSTOM::*', this.handleEslEvent);
      } catch {}
    }

    if (this.mediaBridge) {
      await this.mediaBridge.stop();
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
      'x-tenant-id': req.get('x-tenant-id') || req.get('X-Tenant-ID')
    };

    bridge = new OpenAIS2SBridge(tenant, sipHeaders);
    activeBridges.set(callId, bridge);

    dialog.on('destroy', async () => {
      console.log(`[${callId}] Chamada encerrada pelo assinante/rede.`);
      activeBridges.delete(callId);
      releaseTenantSlotOnce();
      if (releaseNodeSlot) releaseNodeSlot();
      try {
        if (bridge) await bridge.stop();
      } catch {}
    });

    await bridge.start({ callId, endpoint, dialog });
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

require('dotenv').config({ override: true });
// Voice App - Production-Ready Multi-Tenant Voice Gateway (Drachtio + FreeSWITCH + OpenAI Realtime)

// Override global de logs para incluir HH:MM:SS
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

const DRACHTIO_HOST = process.env.DRACHTIO_HOST || '127.0.0.1';
const DRACHTIO_PORT = parseInt(process.env.DRACHTIO_PORT || '9022', 10);
const DRACHTIO_SECRET = process.env.DRACHTIO_SECRET || 'cymru';

const FREESWITCH_HOST = process.env.FREESWITCH_HOST || '127.0.0.1';
const FREESWITCH_PORT = parseInt(process.env.FREESWITCH_PORT || '8021', 10);
const FREESWITCH_SECRET = process.env.FREESWITCH_SECRET || 'JambonzR0ck$';

const EnergyManager = require('./utils/energy-manager');
const WsMediaBridge = require('./media/ws-media-bridge');
const { mediaServer } = require('./media/ws-media-bridge');
const tenantManager = require('./utils/tenant-manager');

const srf = new Srf();
const mrf = new Mrf(srf);

let mediaserver = null;
let mrfReady = false;
let isConnectingMrf = false;
let attempts = 0;
let isShuttingDown = false;

const activeBridges = new Map(); // callId -> OpenAIS2SBridge

// Configura callback para endpoint /health do mediaServer
mediaServer.setHealthCallback(() => ({
  drachtioConnected: !!srf.connected,
  freeSwitchConnected: mrfReady,
  activeCalls: activeBridges.size,
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

// Helper de upsampling PCM16: 8kHz para 24kHz com Interpolação Linear (Anti-Aliasing)
function upsample8to24(buffer8k) {
  const samplesCount = Math.floor(buffer8k.length / 2);
  if (samplesCount === 0) return Buffer.alloc(0);
  const buffer24k = Buffer.alloc(samplesCount * 6);

  for (let i = 0; i < samplesCount; i++) {
    const s0 = buffer8k.readInt16LE(i * 2);
    const s1 = (i + 1 < samplesCount) ? buffer8k.readInt16LE((i + 1) * 2) : s0;

    const diff = s1 - s0;
    const v0 = s0;
    const v1 = Math.round(s0 + diff * 0.3333);
    const v2 = Math.round(s0 + diff * 0.6667);

    const pos = i * 6;
    buffer24k.writeInt16LE(v0, pos);
    buffer24k.writeInt16LE(v1, pos + 2);
    buffer24k.writeInt16LE(v2, pos + 4);
  }
  return buffer24k;
}

// Helper de downsampling PCM16: 24kHz para 8kHz com filtro Anti-Aliasing (Média Móvel)
function downsample24to8(buffer24k) {
  const samplesCount = Math.floor(buffer24k.length / 2);
  const targetSamplesCount = Math.floor(samplesCount / 3);
  const buffer8k = Buffer.alloc(targetSamplesCount * 2);
  for (let i = 0; i < targetSamplesCount; i++) {
    const offset = i * 6;
    const s1 = buffer24k.readInt16LE(offset);
    const s2 = buffer24k.readInt16LE(offset + 2);
    const s3 = buffer24k.readInt16LE(offset + 4);

    // Média dos 3 samples para evitar distorção metálica (aliasing)
    const avg = Math.round((s1 + s2 + s3) / 3);
    buffer8k.writeInt16LE(avg, i * 2);
  }
  return buffer8k;
}

class OpenAIS2SBridge {
  constructor(tenant) {
    this.tenant = tenant;
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
        fone: { base: 0.45, prefix: 350, silence: 400 },
        viva: { base: 0.45, prefix: 400, silence: 500 }
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

  /**
   * Conecta à OpenAI Realtime API em paralelo imediato (Zero-Wait Handshake)
   */
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
      this.openaiReady = true;
      if (this.openaiReadyResolve) this.openaiReadyResolve();
    });

    this.openaiSocket.on('message', (data) => {
      this.handleOpenAiMessage(data);
    });

    this.openaiSocket.on('close', (code, reason) => {
      console.log(`[${this.callId}] 🔴 WebSocket OpenAI fechado. Código: ${code}, Razão: ${reason.toString()}`);
      this.openaiReady = false;
      // Prevenção de chamadas zumbi: encerra a ligação SIP se a IA desconectar
      if (!this.isTerminated) {
        this.terminateCall('openai_disconnected');
      }
    });

    this.openaiSocket.on('error', (err) => {
      console.error(`[${this.callId}] 🔴 Erro no WebSocket OpenAI:`, err.message);
      if (!this.openaiReady && this.openaiReadyResolve) {
        this.openaiReadyResolve(); // Destrava o await
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

      // Rastreia estado de fala do agente e inicia stream
      if (body.type === 'response.created' || body.type === 'response.output_item.added') {
        if (!this.isAgentTalking) {
          this.isAgentTalking = true;
          this.mediaBridge.startPlaybackStream();
        }
      } else if (body.type === 'response.cancelled') {
        this.isAgentTalking = false;
        this.mediaBridge.endPlaybackStream();
      }

      // Recebe pacotes de áudio de saída e injeta no stream de playback
      if (body.type === 'response.output_audio.delta' && body.delta) {
        if (!this.isAgentTalking) {
          this.isAgentTalking = true;
          this.mediaBridge.startPlaybackStream();
        }
        const pcm24k = Buffer.from(body.delta, 'base64');
        const pcm8k = downsample24to8(pcm24k);
        this.mediaBridge.pushAudioChunk(pcm8k);
      }

      // Fim da fala da IA
      if (['response.output_audio.done', 'response.done'].includes(body.type)) {
        if (this.isAgentTalking) {
          this.isAgentTalking = false;
          console.log(`[${this.callId}] 🔊 Fim da resposta da IA.`);
          this.mediaBridge.endPlaybackStream();
        }
      }

      // Detecção de Barge-In (interrupção pelo usuário)
      if (body.type === 'input_audio_buffer.speech_started') {
        console.log(`[${this.callId}] 🎤 BARGE-IN: Usuário falou! Interrompendo agente...`);
        this.isAgentTalking = false;
        this.mediaBridge.endPlaybackStream();
        if (this.openaiSocket && this.openaiSocket.readyState === WebSocket.OPEN) {
          this.openaiSocket.send(JSON.stringify({ type: 'response.cancel' }));
        }
        if (this.endpoint && this.channelUuid) {
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

    // Trava de segurança financeira: Duração máxima da chamada (ex: 15 min)
    const maxDurationSec = this.tenant.maxDurationSec || 900;
    this.maxDurationTimer = setTimeout(() => {
      console.warn(`[${this.callId}] ⏱️ Limite de duração da chamada atingido (${maxDurationSec}s). Encerrando por segurança.`);
      this.terminateCall('max_duration_exceeded');
    }, maxDurationSec * 1000);

    // 1. Dispara conexão com a OpenAI IMEDIATAMENTE em paralelo
    this.initOpenAiConnection();

    // 2. Limpeza preventiva de sessões anteriores
    console.log(`[${this.callId}] [RESET] Limpando sessões residuais no canal...`);
    this.endpoint.api(`uuid_audio_fork ${this.channelUuid} stop`).catch(() => {});
    await wait(100);

    // 3. Monitoramento de eventos ESL
    if (this.endpoint.conn) {
      try {
        this.endpoint.conn.subscribe('CUSTOM mod_audio_fork::play_audio');
        this.endpoint.conn.on('esl::event::CUSTOM::*', this.handleEslEvent);
      } catch (err) {
        console.error(`[${this.callId}] Erro ao subscrever eventos ESL:`, err.message);
      }
    }

    // Hardware filters FreeSWITCH
    this.endpoint.api(`uuid_setvar ${this.channelUuid} echo_cancellation false`).catch(() => {});
    this.endpoint.api(`uuid_setvar ${this.channelUuid} noise_suppression true`).catch(() => {});

    let vadThreshold = 0.45;
    let prefixPaddingMs = 300;
    let silenceDurationMs = 500;

    // 4. Inicia captura de mídia via WsMediaBridge compartilhado
    console.log(`[${this.callId}] 📡 Iniciando ponte de áudio com mod_audio_fork...`);
    this.energyManager.reset();

    await this.mediaBridge.start({
      callId: this.callId,
      endpoint: this.endpoint,
      onAudio: (base64) => {
        const buffer = Buffer.from(base64, 'base64');

        let isEcoSample = false;
        if (this.calibrationActive && (this.isToneProbe || this.isAgentTalking)) {
          isEcoSample = true;
          this.calibrationSamplesRecv++;
          if (this.calibrationSamplesRecv > 500) {
            this.calibrationActive = false;
          }
        }

        this.energyManager.calculateEnergy(buffer, isEcoSample);

        // Envia áudio capturado para a OpenAI com upsampling linear
        if (this.openaiReady && this.openaiSocket && this.openaiSocket.readyState === WebSocket.OPEN) {
          const upsampledBuffer = upsample8to24(buffer);
          this.openaiSocket.send(
            JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: upsampledBuffer.toString('base64')
            })
          );
        }
      }
    });

    const bargeinLevel = this.tenant.bargeinLevel ?? 3;

    // 5. Calibração acústica (Sonar Mode)
    if (bargeinLevel >= 3) {
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

      console.log(`[${this.callId}] 🎯 SONAR LOCK: Dispositivo ${this.deviceMode.toUpperCase()} | Ambiente ${this.currentProfile} | VAD ${vadThreshold}`);
    } else {
      this.endpoint.play('tone_stream://v=-13;%(500,0,425)').catch(() => {});
      await wait(500);
    }

    // 6. Aguarda o WebSocket da OpenAI (que já foi iniciado no passo 1!)
    if (!this.openaiReady && this.openaiReadyPromise) {
      await withTimeout(this.openaiReadyPromise, 4000).catch((e) => {
        console.warn(`[${this.callId}] Alerta no handshake OpenAI:`, e.message);
      });
    }

    if (!this.openaiSocket || this.openaiSocket.readyState !== WebSocket.OPEN) {
      console.error(`[${this.callId}] 🔴 Falha ao estabelecer conexão com a OpenAI Realtime.`);
      this.terminateCall('openai_connection_failed');
      return;
    }

    // 7. Envia configuração de sessão com parâmetros calibrados
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

    if (this.tenant.openaiPromptId) {
      sessionUpdate.session.prompt = { id: this.tenant.openaiPromptId };
    } else if (this.tenant.instructions) {
      sessionUpdate.session.instructions = this.tenant.instructions;
    }

    if (this.tenant.voice) {
      sessionUpdate.session.voice = this.tenant.voice;
    }

    this.openaiSocket.send(JSON.stringify(sessionUpdate));

    // 8. Dispara saudação inicial
    const responseCreate = {
      type: 'response.create',
      response: {
        instructions: 'Faça uma saudação inicial curta e amigável.'
      }
    };
    this.openaiSocket.send(JSON.stringify(responseCreate));

    console.log(`[${this.callId}] 🟢 IA configurada e pronta para conversação.`);
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

    if (this.openaiSocket) {
      try {
        this.openaiSocket.close();
      } catch {}
      this.openaiSocket = null;
    }
    this.openaiReady = false;
  }
}

// Conexão Drachtio SRF
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
  console.log('✅ Conectado ao Drachtio SRF:', hp);
});

srf.on('disconnect', () => {
  console.error('🚨 Drachtio SRF desconectado!');
});

srf.on('error', (err) => {
  console.error('🚨 Erro no Drachtio SRF:', err.message || err);
});

// Conexão FreeSWITCH ESL com Reconexão Automática
async function connectMrf() {
  if (isConnectingMrf) return;
  isConnectingMrf = true;

  while (isConnectingMrf && !isShuttingDown) {
    attempts += 1;
    console.log(`Tentando conectar ao FreeSWITCH via ESL (tentativa ${attempts})...`);

    try {
      mediaserver = await withTimeout(
        mrf.connect({
          address: FREESWITCH_HOST,
          port: FREESWITCH_PORT,
          secret: FREESWITCH_SECRET
        }),
        15000
      );

      mrfReady = true;
      isConnectingMrf = false;
      attempts = 0;
      console.log('✅ Conectado ao FreeSWITCH via ESL com sucesso!');

      // Reconexão resiliente caso o FreeSWITCH caia ou reinicie
      mediaserver.on('disconnect', () => {
        console.error('🚨 FreeSWITCH ESL desconectado! Acionando reconexão automática...');
        mrfReady = false;
        mediaserver = null;
        connectMrf();
      });

      mediaserver.on('error', (err) => {
        console.error('🚨 Erro na conexão ESL com FreeSWITCH:', err.message || err);
      });

      break;
    } catch (err) {
      console.error('Erro conectando ao FreeSWITCH:', err.message || err);
      await wait(3000);
    }
  }
}
connectMrf();

// Atendimento de Chamadas SIP (INVITE) com Suporte Multi-Tenant
srf.invite(async (req, res) => {
  if (isShuttingDown || !mrfReady || !mediaserver) {
    return res.send(503);
  }

  const callId = getCallId(req);
  const tenant = tenantManager.resolveTenant(req);

  if (!tenant || !tenant.active) {
    console.warn(`[${callId}] Chamada rejeitada: Tenant inativo ou não cadastrado.`);
    return res.send(404);
  }

  let endpoint;
  let dialog;
  let bridge;

  try {
    const caller = req.callingNumber || req.get('From');
    const called = req.calledNumber || req.get('To');
    console.log(`[${callId}] 📞 INVITE recebido de ${caller} para ${called} | Tenant: [${tenant.id}] ${tenant.name}`);

    ({ endpoint, dialog } = await mediaserver.connectCaller(req, res));
    console.log(`[${callId}] Chamada atendida.`);

    bridge = new OpenAIS2SBridge(tenant);
    activeBridges.set(callId, bridge);

    dialog.on('destroy', async () => {
      console.log(`[${callId}] Chamada encerrada pelo assinante/rede.`);
      activeBridges.delete(callId);
      try {
        if (bridge) await bridge.stop();
      } catch {}
    });

    await bridge.start({ callId, endpoint, dialog });
  } catch (err) {
    console.error(`[${callId}] Erro durante atendimento da chamada:`, err);
    activeBridges.delete(callId);
    try { res.send(500); } catch {}
    try { if (dialog) dialog.destroy(); } catch {}
    try { if (bridge) await bridge.stop(); } catch {}
  }
});

// Encerramento Gracioso (Graceful Shutdown)
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[SHUTDOWN] Recebido sinal ${signal}. Encerrando graciosamente...`);

  // 1. Encerra chamadas ativas
  const activeList = Array.from(activeBridges.values());
  console.log(`[SHUTDOWN] Finalizando ${activeList.length} chamada(s) ativa(s)...`);
  for (const bridge of activeList) {
    try {
      bridge.terminateCall('server_shutdown');
    } catch {}
  }
  activeBridges.clear();

  // 2. Fecha servidor de mídia HTTP/WS
  try {
    await mediaServer.close();
  } catch {}

  // 3. Desconecta do Drachtio
  try {
    srf.disconnect();
  } catch {}

  console.log('[SHUTDOWN] voice-app finalizado com sucesso.');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

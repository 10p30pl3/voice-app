require('dotenv').config({ override: true });
// v14.0 macmini 
// OVERRIDE GLOBAL DE LOGS PARA INCLUIR HH:MM:SS
const originalLog = console.log;
const originalError = console.error;
const getTS = () => new Date().toLocaleTimeString('pt-BR', { hour12: false });
console.log = (...args) => originalLog(`[${getTS()}]`, ...args);
console.error = (...args) => originalError(`[${getTS()}]`, ...args);

const Srf = require('drachtio-srf');
const Mrf = require('drachtio-fsmrf');

const DRACHTIO_HOST = process.env.DRACHTIO_HOST || '127.0.0.1';
const DRACHTIO_PORT = parseInt(process.env.DRACHTIO_PORT || '9022', 10);
const DRACHTIO_SECRET = process.env.DRACHTIO_SECRET || 'cymru';

const FREESWITCH_HOST = process.env.FREESWITCH_HOST || '127.0.0.1';
const FREESWITCH_PORT = parseInt(process.env.FREESWITCH_PORT || '8021', 10);
const FREESWITCH_SECRET = process.env.FREESWITCH_SECRET || 'JambonzR0ck$';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-mini';
const OPENAI_PROMPT_ID =
  process.env.OPENAI_PROMPT_ID ||
  'pmpt_68b1a68ef0e8819784ef7056a79c675d088bcfde975cd0dd';

const EnergyManager = require('./utils/energy-manager');
const WsMediaBridge = require('./media/ws-media-bridge');

if (!OPENAI_API_KEY) {
  console.error('faltou OPENAI_API_KEY');
  process.exit(1);
}

const srf = new Srf();
const mrf = new Mrf(srf);

let mediaserver = null;
let mrfReady = false;
let attempts = 0;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timeout apos ${ms}ms`)), ms)
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

class OpenAIS2SBridge {
  constructor() {
    this.endpoint = null;
    this.channelUuid = null;
    this.callId = null;
    this.energyManager = new EnergyManager();
    this.mediaBridge = new WsMediaBridge();
    this.thresholdTimer = null;
    this.baseThreshold = 0.45; // Valor seguro inicial (SILENCE + viva_voz)
    this.currentThreshold = this.baseThreshold;
    this.isAgentTalking = false;
    this.handleEslEvent = this.handleEslEvent.bind(this);

    // NÍVEL 5: Perfis por Ambiente e Dispositivo (viva_voz vs fone)
    this.deviceMode = 'viva_voz'; // Padrão pessimista (assume viva-voz até Fase 1 confirmar)
    this.lastBargeInTime = 0;

    // NÍVEL 5.2: Controle de Calibração Limpa
    this.calibrationActive = true;
    this.calibrationSamplesRecv = 0;
    this.calibrationTicks = 0;

    this.profiles = {
      SILENCE: {
        fone: { base: 0.45, prefix: 350, silence: 400, boost: 0.05 },
        viva: { base: 0.45, prefix: 400, silence: 500, boost: 0.35 }
      },
      OFFICE: {
        fone: { base: 0.55, prefix: 400, silence: 500, boost: 0.05 },
        viva: { base: 0.55, prefix: 500, silence: 600, boost: 0.40 }
      },
      STREET: {
        fone: { base: 0.75, prefix: 500, silence: 600, boost: 0.05 },
        viva: { base: 0.75, prefix: 600, silence: 800, boost: 0.45 }
      },
      TV: {
        fone: { base: 0.95, prefix: 1000, silence: 1200, boost: 0.01 },
        viva: { base: 0.95, prefix: 1200, silence: 1500, boost: 0.02 }
      }
    };
    this.currentProfile = 'SILENCE';
  }

  async start({ callId, endpoint }) {
    this.callId = callId;
    this.endpoint = endpoint;
    this.channelUuid = getChannelUuid(endpoint);

    if (!this.channelUuid) {
      throw new Error('nao consegui descobrir o uuid do canal para uuid_openai_s2s');
    }

    // [v13.0] RESET SEGURO: Limpa sessões prévias para evitar interferência na 2ª/3ª chamada
    console.log(`[${this.callId}] [RESET] Limpando sessões anteriores...`);
    this.endpoint.api(`uuid_audio_fork ${this.channelUuid} stop`).catch(() => { });
    this.endpoint.api(`uuid_openai_s2s ${this.channelUuid} session.delete`).catch(() => { });
    await wait(200);

    // AEC inicia desligado e ANS ativado (Hardware-level)
    this.endpoint.api(`uuid_setvar ${this.channelUuid} echo_cancellation false`).catch(() => { });
    this.endpoint.api(`uuid_setvar ${this.channelUuid} noise_suppression true`).catch(() => { });

    // ==== NÍVEL 3 E 4 (BARGE-IN PROATIVO E ESTADO) ====
    if (this.endpoint.conn) {
      try {
        this.endpoint.conn.subscribe('CUSTOM openai_s2s::server_event');
        this.endpoint.conn.on('esl::event::CUSTOM::*', this.handleEslEvent);
        console.log(`[${this.callId}] Monitoramento de eventos OpenAI ativado (ESL Subscriber).`);
      } catch (err) {
        console.log(`[${this.callId}] Erro ao tentar esl subscribe:`, err.message);
      }
    }

    const connectCmd =
      `uuid_openai_s2s ${this.channelUuid} session.create ` +
      `api.openai.com /v1/realtime?model=${OPENAI_REALTIME_MODEL} bearer ${OPENAI_API_KEY}`;

    console.log(`[${this.callId}] ════════════════════════════════════════════════`);
    console.log(`[${this.callId}] 📞 FASE 0: CONEXÃO - Iniciando base v11.0...`);
    console.log(`[${this.callId}] ════════════════════════════════════════════════`);

    let response = await this.endpoint.api(connectCmd);
    console.log(`[${this.callId}] resposta connect:`, response?.body || response);

    // Se falhar, tentamos o formato JSON como fallback
    if (response?.body?.includes('-ERR') || response?.body === '-ERR no reply') {
      console.log(`[${this.callId}] tentando formato JSON...`);
      const sessionConfig = {
        type: 'session.create',
        model: OPENAI_REALTIME_MODEL || 'gpt-realtime-mini',
        api_key: OPENAI_API_KEY
      };
      const jsonCmd = `uuid_openai_s2s ${this.channelUuid} session.create '${JSON.stringify(sessionConfig)}'`;
      response = await this.endpoint.api(jsonCmd);
      console.log(`[${this.callId}] resposta connect (JSON):`, response?.body || response);
    }

    // Lê o Nível de Barge-in do ambiente
    const bargeinLevel = parseInt(process.env.BARGEIN_LEVEL || '5', 10);

    // [v26.0] Sonar Mode: Latência Zero para Calibração
    let vadThreshold = 0.45;
    let prefixPaddingMs = 300;
    let silenceDurationMs = 500;

    this.isToneProbe = false;

    if (bargeinLevel >= 3) {
      console.log(`[${this.callId}] 📡 SONAR MODE: Iniciando captura acústica instantânea...`);
      this.energyManager.reset(); // [v32.0] Força limpar acumuladores evitando leak
      try {
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
          }
        });
      } catch (err) {
        console.error(`[${this.callId}] Erro ao iniciar captura Sonar:`, err.message);
      }

      // [v28.0] Desativa AEC temporariamente para o 'Sonar' ouvir o eco real (RAW)
      this.endpoint.api(`uuid_setvar ${this.channelUuid} echo_cancellation false`).catch(() => { });

      // [v29.0] Mais tempo de silêncio para estabilizar o audio_fork na rede
      await wait(700);

      // Dispara o 'Sonar' de 700ms (Volume máximo v=0) e marca como Eco
      this.isToneProbe = true;
      this.endpoint.play('tone_stream://v=0;%(700,0,425)').catch(() => { });
      const startSamples = this.energyManager.echoSamplesCount;
      await wait(700);
      this.isToneProbe = false;
      const collected = this.energyManager.echoSamplesCount - startSamples;

      if (collected === 0) {
        console.warn(`[${this.callId}] [⚠️ WARNING] Zero áudio via audio_fork durante Sonar! (A conexão pode estar lenta)`);
      } else {
        console.log(`[${this.callId}] [SONAR-DEBUG] Capturadas ${collected} amostras durante o bíp.`);
      }

      // Executa a calibração com latência zero
      this.deviceMode = this.energyManager.detectDeviceMode(this.callId);

      // [v28.0] Ajuste Inteligente de AEC pós-detecção
      if (this.deviceMode === 'viva_voz') {
        console.log(`[${this.callId}] 🛡️ Ativando AEC para proteção de Viva-voz.`);
        this.endpoint.api(`uuid_setvar ${this.channelUuid} echo_cancellation true`).catch(() => { });
      } else {
        console.log(`[${this.callId}] 🎧 Mantendo AEC desligado para máxima fluidez no Fone.`);
        this.endpoint.api(`uuid_setvar ${this.channelUuid} echo_cancellation false`).catch(() => { });
      }

      const profile = this.energyManager.getClassification();
      this.currentProfile = profile;
      const config = this.profiles[this.currentProfile][this.deviceMode === 'fone_ouvido' ? 'fone' : 'viva'];

      vadThreshold = config.base;
      prefixPaddingMs = config.prefix;
      silenceDurationMs = config.silence;

      console.log(`[${this.callId}] ┌── 🎯 SONAR LOCK (Latência Zero) ────────────`);
      console.log(`[${this.callId}] │ 📱 DISPOSITIVO: ${this.deviceMode.toUpperCase()}`);
      console.log(`[${this.callId}] │ 🏭 AMBIENTE: ${profile} (NF: ${this.energyManager.noiseFloor.toFixed(0)})`);
      console.log(`[${this.callId}] │ 🔒 VAD LOCK: ${config.base} (Pref: ${config.prefix}ms | Sil: ${config.silence}ms)`);
      console.log(`[${this.callId}] └─────────────────────────────────────────────`);

    } else {
      // Caso barge-in desativado, apenas toca o tom e espera
      this.endpoint.play('tone_stream://v=-13;%(1000,0,425)').catch(() => { });
      await wait(1000);
    }

    console.log(`[${this.callId}] Configurando Sessao API. Nível: ${bargeinLevel}`);

    const sessionUpdate = {
      type: 'session.update',
      session: {
        modalities: ['audio', 'text'],
        voice: 'marin',
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        prompt: { id: OPENAI_PROMPT_ID },
        max_response_output_tokens: 4096,
        turn_detection: {
          type: 'server_vad',
          threshold: vadThreshold,
          prefix_padding_ms: prefixPaddingMs,
          silence_duration_ms: silenceDurationMs
        }
      }
    };

    if (bargeinLevel >= 2) {
      sessionUpdate.session.input_audio_transcription = { model: 'whisper-1' };
    }

    const jsonStr = JSON.stringify(sessionUpdate).replace(/\s/g, '');
    const updateCmd = `uuid_openai_s2s ${this.channelUuid} client.event ${jsonStr}`;
    await this.endpoint.api(updateCmd);

    // Trigger de saudação inicial
    const responseCreate = {
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
        instructions: 'Diga: Olá, eu sou seu assistente de voz. Já estou te escutando.'
      }
    };
    const triggerCmd = `uuid_openai_s2s ${this.channelUuid} client.event '${JSON.stringify(responseCreate)}'`;
    await this.endpoint.api(triggerCmd);

    // [v17.4] Aqui a IA já recebeu as configurações finais. Ocorreu zero latência de calibração extra.
    console.log(`[${this.callId}] ════════════════════════════════════════════════`);
    console.log(`[${this.callId}] 🟢 START LISTENING - IA Configurada e Pronta!`);
    console.log(`[${this.callId}] ════════════════════════════════════════════════`);
  }

  // Tratador de eventos seguro para não sujar o EventEmitter global
  handleEslEvent(evt) {
    if (!evt || !evt.getHeader) return;
    const subclass = evt.getHeader('Event-Subclass');
    const eventUuid = evt.getHeader('Unique-ID');
    if (eventUuid && eventUuid !== this.channelUuid) return;

    if (subclass === 'openai_s2s::server_event') {
      try {
        const body = JSON.parse(evt.getBody());

        if (['response.created', 'response.output_item.added', 'response.audio.delta'].includes(body.type)) {
          this.isAgentTalking = true;
        } else if (['response.done', 'response.audio.done', 'response.cancelled'].includes(body.type)) {
          this.isAgentTalking = false;
        }

        if (body.type === 'input_audio_buffer.speech_started') {
          console.log(`[${this.callId}] 🎤 BARGE-IN: Fala detectada! Interrompendo agente...`);
          this.isAgentTalking = false;
          this.endpoint.api(`uuid_openai_s2s ${this.channelUuid} client.event {"type":"response.cancel"}`).catch(() => { });
          this.endpoint.api(`uuid_break ${this.channelUuid} all`).catch(() => { });
        }

      } catch (e) { }
    }
  }

  async stop() {
    if (this.thresholdTimer) clearInterval(this.thresholdTimer);
    if (this.mediaBridge) await this.mediaBridge.stop();

    if (this.endpoint && this.endpoint.conn) {
      this.endpoint.conn.removeListener('esl::event::CUSTOM::*', this.handleEslEvent);
    }

    if (!this.endpoint || !this.channelUuid) return;

    try {
      await this.endpoint.api(`uuid_openai_s2s ${this.channelUuid} session.delete`);
      console.log(`[${this.callId}] stop uuid_openai_s2s encerrado.`);
    } catch (err) {
      console.error(`[${this.callId}] erro stop uuid_openai_s2s:`, err.message || err);
    }
  }
}

srf.connect({
  host: DRACHTIO_HOST,
  port: DRACHTIO_PORT,
  secret: DRACHTIO_SECRET
});

srf.on('connect', (err, hp) => {
  if (err) {
    console.error('erro conectando ao drachtio:', err);
    return;
  }
  console.log('conectado ao drachtio:', hp);
});

srf.use((req, res, next) => {
  next();
});

srf.on('error', (err) => {
  console.error('erro no srf:', err);
});

async function connectMrf() {
  while (true) {
    attempts += 1;
    console.log(`tentando conectar ao FreeSWITCH via ESL (tentativa ${attempts})`);

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
      console.log('conectado ao FreeSWITCH via ESL');
      break;
    } catch (err) {
      console.error('erro conectando ao FreeSWITCH:', err.message || err);
      await wait(3000);
    }
  }
}
connectMrf();

srf.invite(async (req, res) => {
  if (!mrfReady || !mediaserver) {
    return res.send(503);
  }

  let endpoint;
  let dialog;
  let bridge;

  const callId = getCallId(req);

  try {
    console.log(`[${callId}] INVITE recebido de:`, req.callingNumber || req.get('From'));

    ({ endpoint, dialog } = await mediaserver.connectCaller(req, res));
    console.log(`[${callId}] chamada atendida....`);

    bridge = new OpenAIS2SBridge();
    await bridge.start({ callId, endpoint });

    dialog.on('destroy', async () => {
      console.log(`[${callId}] chamada encerrada`);
      try {
        if (bridge) await bridge.stop();
      } catch { }
    });
  } catch (err) {
    console.error(`[${callId}] erro na chamada:`, err);
    try { res.send(500); } catch { }
    try { if (dialog) dialog.destroy(); } catch { }
    try { if (bridge) await bridge.stop(); } catch { }
  }
});

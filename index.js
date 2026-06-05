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

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// Helper para criar cabeçalho WAV para áudio L16 (8kHz, Mono, 16-bit)
function createWavHeader(dataLength) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // Mono
  header.writeUInt32LE(8000, 24); // Sample Rate
  header.writeUInt32LE(16000, 28); // Byte Rate
  header.writeUInt16LE(2, 32); // Block Align
  header.writeUInt16LE(16, 34); // Bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);
  return header;
}

// Helper de upsampling PCM16: 8kHz para 24kHz (Repetição Simples 3x)
function upsample8to24(buffer8k) {
  const samplesCount = buffer8k.length / 2;
  const buffer24k = Buffer.alloc(buffer8k.length * 3);
  for (let i = 0; i < samplesCount; i++) {
    const val = buffer8k.readInt16LE(i * 2);
    const pos = i * 6;
    buffer24k.writeInt16LE(val, pos);
    buffer24k.writeInt16LE(val, pos + 2);
    buffer24k.writeInt16LE(val, pos + 4);
  }
  return buffer24k;
}

// Helper de downsampling PCM16: 24kHz para 8kHz com filtro Anti-Aliasing (Média Móvel)
function downsample24to8(buffer24k) {
  const samplesCount = buffer24k.length / 2;
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

    this.openaiSocket = null;
    this.openaiReady = false;
    this.audioPlaybackBuffer = Buffer.alloc(0);
    this.activeAudioFile = null;
    this.handleEslEvent = this.handleEslEvent.bind(this);
  }

  handleEslEvent(evt) {
    if (!evt || !evt.getHeader) return;
    const subclass = evt.getHeader('Event-Subclass');
    const eventUuid = evt.getHeader('Unique-ID');
    if (eventUuid && eventUuid !== this.channelUuid) return;

    if (subclass === 'mod_audio_fork::play_audio') {
      const file = evt.getHeader('file');
      if (file) {
        console.log(`[${this.callId}] 🔊 Evento play_audio recebido! Tocando arquivo do FreeSWITCH: ${file}`);
        this.endpoint.play(file).catch(e => {
          if (!e.message?.includes('break')) console.error(`[${this.callId}] Erro ao tocar play_audio:`, e.message);
        });
      }
    }

    if (subclass === 'openai_s2s::server_event') {
      // log de eventos internos da session
    }
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

    if (this.endpoint.conn) {
      try {
        this.endpoint.conn.subscribe('CUSTOM openai_s2s::server_event');
        this.endpoint.conn.subscribe('CUSTOM mod_audio_fork::play_audio');
        this.endpoint.conn.on('esl::event::CUSTOM::*', this.handleEslEvent);
        console.log(`[${this.callId}] Monitoramento de eventos ESL ativado.`);
      } catch (err) {
        console.error(`[${this.callId}] Erro ao subscrever eventos ESL:`, err.message);
      }
    }

    // AEC inicia desligado e ANS ativado (Hardware-level)
    this.endpoint.api(`uuid_setvar ${this.channelUuid} echo_cancellation false`).catch(() => { });
    this.endpoint.api(`uuid_setvar ${this.channelUuid} noise_suppression true`).catch(() => { });

    // Lê o Nível de Barge-in do ambiente
    const bargeinLevel = parseInt(process.env.BARGEIN_LEVEL || '5', 10);

    // [v26.0] Sonar Mode: Latência Zero para Calibração
    let vadThreshold = 0.45;
    let prefixPaddingMs = 300;
    let silenceDurationMs = 500;

    this.isToneProbe = false;

    // Inicializa a ponte de mídia sempre, pois o Node fará a ponte de áudio com a OpenAI
    console.log(`[${this.callId}] 📡 SONAR MODE: Iniciando captura acústica instantânea...`);
    this.energyManager.reset(); // Força limpar acumuladores evitando leak
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

          // Se a OpenAI estiver conectada e pronta, faz o upsampling e envia o áudio
          if (this.openaiReady && this.openaiSocket && this.openaiSocket.readyState === WebSocket.OPEN) {
            const upsampledBuffer = upsample8to24(buffer);
            this.openaiSocket.send(JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: upsampledBuffer.toString('base64')
            }));
          }
        }
      });
    } catch (err) {
      console.error(`[${this.callId}] Erro ao iniciar captura Sonar/MediaBridge:`, err.message);
    }

    if (bargeinLevel >= 3) {
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

    console.log(`[${this.callId}] 📞 FASE 0: CONEXÃO - Iniciando ponte Node-OpenAI...`);
    const openaiUrl = `wss://api.openai.com/v1/realtime?model=${OPENAI_REALTIME_MODEL}`;
    
    this.openaiSocket = new WebSocket(openaiUrl, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`
      }
    });

    this.openaiSocket.on('open', () => {
      console.log(`[${this.callId}] 🟢 Conexão com OpenAI Realtime estabelecida com sucesso!`);
      
      const OPENAI_AGENT_INSTRUCTIONS = process.env.OPENAI_AGENT_INSTRUCTIONS || 'Você é um assistente de voz prestativo, ágil e conciso. Fale em português brasileiro de forma amigável.';

      const sessionUpdate = {
        type: 'session.update',
        session: {
          type: 'realtime', // <--- EXIGIDO NO NOVO GA
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

      if (OPENAI_PROMPT_ID) {
        sessionUpdate.session.prompt = { id: OPENAI_PROMPT_ID };
      } else {
        sessionUpdate.session.instructions = OPENAI_AGENT_INSTRUCTIONS;
      }

      // if (bargeinLevel >= 2) {
      //   sessionUpdate.session.input_audio_transcription = { model: 'whisper-1' };
      // }

      this.openaiSocket.send(JSON.stringify(sessionUpdate));

      // Trigger de saudação inicial (deixa o agente saudar naturalmente baseado na instrução da sessão)
      const responseCreate = {
        type: 'response.create',
        response: {
          instructions: 'Faça uma saudação inicial curta e amigável.'
        }
      };
      this.openaiSocket.send(JSON.stringify(responseCreate));

      this.openaiReady = true;

      console.log(`[${this.callId}] ════════════════════════════════════════════════`);
      console.log(`[${this.callId}] 🟢 START LISTENING - IA Configurada e Pronta!`);
      console.log(`[${this.callId}] ════════════════════════════════════════════════`);
    });

    this.openaiSocket.on('message', (data) => {
      try {
        const body = JSON.parse(data.toString());

        if (body.type !== 'response.output_audio.delta' && body.type !== 'input_audio_buffer.committed') {
          console.log(`[${this.callId}] 🔍 [DEBUG OpenAI] Evento Recebido: ${body.type}`);
        }

        if (body.type === 'error') {
          // Ignora erro inofensivo de tentar cancelar uma resposta que já acabou
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

        // Recebe pacotes de áudio de saída e injeta no stream HTTP
        if (body.type === 'response.output_audio.delta' && body.delta) {
          if (!this.isAgentTalking) {
            this.isAgentTalking = true;
            this.mediaBridge.startPlaybackStream();
          }
          const pcm24k = Buffer.from(body.delta, 'base64');
          const pcm8k = downsample24to8(pcm24k);
          this.mediaBridge.pushAudioChunk(pcm8k);
        }

        // Quando o áudio termina, encerra o stream HTTP
        if (['response.output_audio.done', 'response.done'].includes(body.type)) {
          if (this.isAgentTalking) {
            this.isAgentTalking = false;
            console.log(`[${this.callId}] 🔊 Fim da resposta da IA. Fechando stream HTTP...`);
            this.mediaBridge.endPlaybackStream();
          }
        }

        // Monitora Barge-In via OpenAI VAD
        if (body.type === 'input_audio_buffer.speech_started') {
          console.log(`[${this.callId}] 🎤 BARGE-IN: Fala detectada! Interrompendo agente e stream...`);
          this.isAgentTalking = false;
          this.mediaBridge.endPlaybackStream(); // Corta imediatamente a reprodução
          this.openaiSocket.send(JSON.stringify({ type: 'response.cancel' }));
          this.endpoint.api(`uuid_break ${this.channelUuid} all`).catch(() => { });
        }

      } catch (err) {
        console.error(`[${this.callId}] Erro ao decodificar mensagem OpenAI:`, err.message);
      }
    });

    this.openaiSocket.on('close', (code, reason) => {
      console.log(`[${this.callId}] 🔴 WebSocket OpenAI fechado. Código: ${code}, Razão: ${reason.toString()}`);
      this.openaiReady = false;
    });

    this.openaiSocket.on('error', (err) => {
      console.error(`[${this.callId}] 🔴 Erro no WebSocket OpenAI:`, err.message);
    });
  }

  async stop() {
    if (this.endpoint && this.endpoint.conn) {
      try {
        this.endpoint.conn.removeListener('esl::event::CUSTOM::*', this.handleEslEvent);
      } catch (e) { }
    }
    if (this.thresholdTimer) clearInterval(this.thresholdTimer);
    if (this.mediaBridge) await this.mediaBridge.stop();

    if (this.openaiSocket) {
      try {
        this.openaiSocket.close();
      } catch {}
      this.openaiSocket = null;
    }
    this.openaiReady = false;
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

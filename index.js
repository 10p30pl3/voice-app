require('dotenv').config({ override: true });

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
  'pmpt_699c6d29234081909e3ce4c9ac9c32ed051663f2fadd92d8';

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

    // [v11.2] PRE-CLEANUP: Tenta parar sessões anteriores que possam estar zumbis
    console.log(`[${this.callId}] [PRE-CLEANUP] Resetando audio_fork/openai...`);
    this.endpoint.api(`uuid_audio_fork ${this.channelUuid} stop`).catch(() => {});
    this.endpoint.api(`uuid_openai_s2s ${this.channelUuid} session.delete`).catch(() => {});
    await wait(200);

    // ==== NÍVEL 3 E 4 (BARGE-IN PROATIVO E ESTADO) ====
    if (this.endpoint.conn) {
      try {
        this.endpoint.conn.subscribe('CUSTOM openai_s2s::server_event');
        this.endpoint.conn.on('esl::event::CUSTOM::*', this.handleEslEvent);
        console.log(`[${this.callId}] Monitoramento de eventos OpenAI ativado (Safe Listener).`);
      } catch (err) {
        console.log(`[${this.callId}] Erro ao tentar esl subscribe:`, err.message);
      }
    }

    // Algumas versões do mod_openai esperam JSON, outras esperam tokens separados por espaço.
    // Vamos tentar o formato de tokens primeiro, que é mais comum em builds drachtio-freeswitch-mrf.
    const connectCmd =
      `uuid_openai_s2s ${this.channelUuid} session.create ` +
      `api.openai.com /v1/realtime?model=${OPENAI_REALTIME_MODEL} bearer ${OPENAI_API_KEY}`;

    console.log(`[${this.callId}] ════════════════════════════════════════════════`);
    console.log(`[${this.callId}] 📞 FASE 0: CONEXÃO - Iniciando sessão OpenAI S2S...`);
    console.log(`[${this.callId}] ════════════════════════════════════════════════`);

    // AEC e ANS ativados por padrão. Fase 1 pode desligar se detectar fone.
    this.endpoint.api(`uuid_setvar ${this.channelUuid} echo_cancellation true`).catch(() => {});
    this.endpoint.api(`uuid_setvar ${this.channelUuid} noise_suppression true`).catch(() => {});

    let response = await this.endpoint.api(connectCmd);
    console.log(`[${this.callId}] [FASE 0] resposta connect:`, response?.body || response);

    // Se falhar, tentamos o formato JSON como fallback
    if (response?.body?.includes('-ERR') || response?.body === '-ERR no reply') {
      console.log(`[${this.callId}] [FASE 0] formato string falhou, tentando formato JSON...`);
      const sessionConfig = {
        type: 'session.create',
        model: OPENAI_REALTIME_MODEL || 'gpt-realtime-mini',
        api_key: OPENAI_API_KEY
      };
      const jsonCmd = `uuid_openai_s2s ${this.channelUuid} session.create '${JSON.stringify(sessionConfig)}'`;
      response = await this.endpoint.api(jsonCmd);
      console.log(`[${this.callId}] [FASE 0] resposta connect (JSON):`, response?.body || response);
    }

    await wait(3000);

    // Lê o Nível de Barge-in do ambiente (A autocalibração opera no Nível 5)
    const bargeinLevel = parseInt(process.env.BARGEIN_LEVEL || '5', 10);
    
    // Valores iniciais seguros (viva_voz em ambiente silencioso) até a auto-calibração assumir
    const vadThreshold = 0.45;
    const prefixPaddingMs = 300;
    const silenceDurationMs = 500;

    console.log(`[${this.callId}] Configurando Sessao API. Nível de Barge-in: ${bargeinLevel}`);

    // Configuração com propriedades nativas e válidas para a API Realtime da OpenAI
    const sessionUpdate = {
      type: 'session.update',
      session: {
        // OBRIGATÓRIO: A OpenAI precisa saber que deve retornar áudio no formato telefônico G711.
        modalities: ['audio', 'text'],
        voice: 'alloy',
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',

        // Configuração conforme solicitado
        prompt: {
          id: OPENAI_PROMPT_ID
        },

        max_response_output_tokens: 4096,
        turn_detection: {
          type: 'server_vad',
          threshold: vadThreshold,
          prefix_padding_ms: prefixPaddingMs,
          silence_duration_ms: silenceDurationMs
        }
      }
    };

    // Aplica camadas adicionais de robustez acústica (Nível 2)
    if (bargeinLevel >= 2) {
      console.log(`[${this.callId}] Aplicando configs do Nível 2 (Transcrição whisper-1)`);
      sessionUpdate.session.input_audio_transcription = {
        model: 'whisper-1'
      };
      // Nota: Não enviamos 'input_audio_noise_reduction' pois a API costuma rejeitar
      // e o Nível 2 ideal deve tratar o áudio (AGC) antes de chegar na OpenAI.
    }

    // Gera o JSON em string e garante que ZERO espaços vão para o ESL (por garantia extrema)
    const jsonStr = JSON.stringify(sessionUpdate).replace(/\s/g, '');

    const updateCmd = `uuid_openai_s2s ${this.channelUuid} client.event ${jsonStr}`;
    console.log(`[${this.callId}] enviando session.update sem espacos:`, updateCmd);
    response = await this.endpoint.api(updateCmd);
    console.log(`[${this.callId}] resposta session.update:`, response?.body || response);

    // Tentar forçar uma resposta inicial
    const responseCreate = {
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
        instructions: 'Diga: Olá, eu sou seu assistente de voz. Já estou te escutando.'
      }
    };
    const triggerCmd = `uuid_openai_s2s ${this.channelUuid} client.event '${JSON.stringify(responseCreate)}'`;
    console.log(`[${this.callId}] enviando response.create para testar áudio...`);
    await this.endpoint.api(triggerCmd);

    // ==== NÍVEL 3 + THRESHOLD DINÂMICO ====
    if (bargeinLevel >= 3) {
      console.log(`[${this.callId}] Iniciando captura de áudio para Threshold Dinâmico...`);
      try {
        await this.mediaBridge.start({
          callId: this.callId,
          endpoint: this.endpoint,
          onAudio: (base64) => {
            const buffer = Buffer.from(base64, 'base64');
            
            // NÍVEL 5.2: Calibração Limpa (Greeting-Only)
            // Só acumulamos energia de Eco durante as primeiras 300 amostras (aprox 6s)
            // Isso evita que a sua voz no meio da chamada seja confundida com eco de viva-voz.
            let isEcoSample = false;
            if (this.calibrationActive && this.isAgentTalking) {
              isEcoSample = true;
              this.calibrationSamplesRecv++;
              if (this.calibrationSamplesRecv > 300) {
                this.calibrationActive = false;
              }
            }
            
            this.energyManager.calculateEnergy(buffer, isEcoSample);
          }
        });

        // [ESTRATÉGIA v11.2]: Calibração Ordenada (0-5s) + Echo Shield Dinâmico (Restaurado)
        this.thresholdTimer = setInterval(async () => {
          this.calibrationTicks++;

          // 1. WATCHDOG DE CONECTIVIDADE
          if (this.energyManager.samplesCount === 0) {
            console.warn(`[${this.callId}] [⚠️ WARNING] Zero áudio via audio_fork! Confirme firewall/rede.`);
          }

          // 2. FASE DE CALIBRAÇÃO (0-5s)
          if (this.calibrationTicks <= 2) {
            // FASE 1 (2.5s): IDENTIFICAÇÃO DO HARDWARE
            if (this.calibrationTicks === 1) {
              const echoSamples = this.energyManager.echoSamplesCount;
              this.deviceMode = this.energyManager.detectDeviceMode(this.callId);
              console.log(`[${this.callId}] ┌─────────────────────────────────────────────`);
              console.log(`[${this.callId}] │ 📱 FASE 1: DISPOSITIVO = ${this.deviceMode.toUpperCase()}`);
              console.log(`[${this.callId}] │ Amostras de eco capturadas: ${echoSamples}`);
              console.log(`[${this.callId}] └─────────────────────────────────────────────`);
              
              if (this.deviceMode === 'fone_ouvido') {
                console.log(`[${this.callId}] [FASE 1] AEC desativado (fone).`);
                this.endpoint.api(`uuid_setvar ${this.channelUuid} echo_cancellation false`).catch(() => {});
              }
            }

            // FASE 2 (5.0s): MEDIÇÃO DO AMBIENTE + LOCK
            if (this.calibrationTicks === 2) {
              const profile = this.energyManager.getClassification();
              this.currentProfile = profile;
              console.log(`[${this.callId}] ┌─────────────────────────────────────────────`);
              console.log(`[${this.callId}] │ 🏭 FASE 2: AMBIENTE = ${profile} (NF: ${this.energyManager.noiseFloor.toFixed(0)})`);
              console.log(`[${this.callId}] └─────────────────────────────────────────────`);
              console.log(`[${this.callId}] 🔒 CALIBRAÇÃO CONCLUÍDA. Ativando Escudo Dinâmico...`);
              
              // Mudamos o intervalo para 500ms para um Echo Shield ultra-responsivo
              clearInterval(this.thresholdTimer);
              this.startDynamicShield();
            }
          }
        }, 2500);

      } catch (err) {
        console.error(`[${this.callId}] Erro ao iniciar captura de áudio (Nível 3):`, err.message);
      }
    }

  }

  /**
   * ESCUDO DE ECO DINÂMICO (v11.2)
   * Oscila o threshold da OpenAI em tempo real para ignorar o eco do viva-voz.
   */
  startDynamicShield() {
    this.thresholdTimer = setInterval(() => {
      const config = this.profiles[this.currentProfile][this.deviceMode === 'fone_ouvido' ? 'fone' : 'viva'];
      let targetThreshold = config.base;

      // Se o agente está falando e é Viva-voz, aumentamos o threshold (surdez seletiva)
      if (this.isAgentTalking && this.deviceMode === 'viva_voz') {
        targetThreshold = Math.min(0.98, config.base + config.boost);
      }

      // Só envia update se o threshold mudou (evita flood de eventos)
      if (Math.abs(targetThreshold - this.currentThreshold) > 0.05) {
        this.currentThreshold = targetThreshold;
        const modeTag = this.isAgentTalking ? '🤖 ECO-SHIELD ON' : '👤 LISTENING';
        console.log(`[${this.callId}] [VAD] ${this.currentThreshold.toFixed(2)} ${modeTag}`);

        const update = {
          type: 'session.update',
          session: { 
            turn_detection: { 
              type: 'server_vad', 
              threshold: targetThreshold,
              prefix_padding_ms: config.prefix,
              silence_duration_ms: config.silence
            } 
          }
        };
        const json = JSON.stringify(update).replace(/\s/g, '');
        this.endpoint.api(`uuid_openai_s2s ${this.channelUuid} client.event ${json}`).catch(() => {});
      }
    }, 500);
  }

  // Tratador de eventos seguro para não sujar o EventEmitter global
  handleEslEvent(evt) {
    if (!evt || !evt.getHeader) return;
    const subclass = evt.getHeader('Event-Subclass');
    // Para garantir que processamos apenas os eventos DESTA perna da chamada (importante para concorrência)
    const eventUuid = evt.getHeader('Unique-ID');
    if (eventUuid && eventUuid !== this.channelUuid) return;

    if (subclass === 'openai_s2s::server_event') {
      try {
        const body = JSON.parse(evt.getBody());

        // GESTÃO DE ESTADO (Eco-Aware) - Nível 4
        // Marcamos como falando se houver qualquer sinal de criação de resposta ou áudio vindo
        if (['response.created', 'response.output_item.added', 'response.audio.delta'].includes(body.type)) {
          this.isAgentTalking = true;
        } else if (['response.done', 'response.audio.done', 'response.cancelled'].includes(body.type)) {
          this.isAgentTalking = false;
        }

        if (body.type === 'input_audio_buffer.speech_started') {
          console.log(`[${this.callId}] 🎤 BARGE-IN: Fala detectada! Interrompendo agente...`);
          this.lastBargeInTime = Date.now();
          this.isAgentTalking = false; // Reset imediato, confiando nos eventos response.done/cancelled
          
          // 1. Interrupção Lógica (OpenAI)
          this.endpoint.api(`uuid_openai_s2s ${this.channelUuid} client.event {"type":"response.cancel"}`).catch(() => {});
          // 2. Interrupção Física (FreeSWITCH) - Limpa o buffer de saída
          this.endpoint.api(`uuid_break ${this.channelUuid} all`).catch(() => {});
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
      const cmd = `uuid_openai_s2s ${this.channelUuid} session.delete`;
      const response = await this.endpoint.api(cmd);
      console.log(`[${this.callId}] stop uuid_openai_s2s:`, response?.body || response);
    } catch (err) {
      console.error(
        `[${this.callId}] erro stop uuid_openai_s2s:`,
        err.message || err
      );
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

// LOGGER GLOBAL DE REQUISIÇÕES SIP (Para debug de conectividade)
srf.use((req, res, next) => {
  console.log(`[SIP DEBUG] Recebido: ${req.method} de ${req.source_address}:${req.source_port}`);
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
      break; // Sucesso! Sai do loop.
    } catch (err) {
      console.error('erro conectando ao FreeSWITCH:', err.message || err);
      await wait(3000);
    }
  }
}
connectMrf();

srf.invite(async (req, res) => {
  if (!mrfReady || !mediaserver) {
    console.log('FreeSWITCH ainda nao esta pronto');
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

    // Toca um tom de 1000Hz por 3 segundos. Se não ouvir isso, o problema é Rede/FreeSWITCH.
    //await endpoint.play('tone_stream://%(3000,0,1000)');

    //console.log(`[${callId}] Tom finalizado. Iniciando modo openai_s2s...`);

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

    try {
      res.send(500);
    } catch { }

    try {
      if (dialog) dialog.destroy();
    } catch { }

    try {
      if (bridge) await bridge.stop();
    } catch { }
  }
});

require('dotenv').config({ override: true });

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
    this.deviceMode = 'viva_voz'; // Padrão inicial, será calibrado
    
    this.profiles = {
      SILENCE: { 
        fone: { base: 0.35, prefix: 200, silence: 400, boost: 0.05 },
        viva: { base: 0.45, prefix: 300, silence: 500, boost: 0.30 }
      },
      OFFICE: { 
        fone: { base: 0.50, prefix: 300, silence: 500, boost: 0.10 },
        viva: { base: 0.60, prefix: 400, silence: 600, boost: 0.40 }
      },
      STREET: { 
        fone: { base: 0.65, prefix: 400, silence: 600, boost: 0.15 },
        viva: { base: 0.75, prefix: 600, silence: 800, boost: 0.50 }
      },
      TV: { 
        fone: { base: 0.75, prefix: 600, silence: 800, boost: 0.20 },
        viva: { base: 0.85, prefix: 800, silence: 1000, boost: 0.60 }
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

    console.log(`[${this.callId}] iniciando openai_s2s (formato string)...`);

    let response = await this.endpoint.api(connectCmd);
    console.log(`[${this.callId}] resposta connect:`, response?.body || response);

    // Se falhar, tentamos o formato JSON como fallback
    if (response?.body?.includes('-ERR') || response?.body === '-ERR no reply') {
      console.log(`[${this.callId}] formato string falhou, tentando formato JSON...`);
      const sessionConfig = {
        type: 'session.create',
        model: OPENAI_REALTIME_MODEL || 'gpt-realtime-mini',
        api_key: OPENAI_API_KEY
      };
      const jsonCmd = `uuid_openai_s2s ${this.channelUuid} session.create '${JSON.stringify(sessionConfig)}'`;
      response = await this.endpoint.api(jsonCmd);
      console.log(`[${this.callId}] resposta connect (JSON):`, response?.body || response);
    }

    // Aumentado para 5s para garantir que o mod_openai esteja pronto
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
            this.energyManager.calculateEnergy(buffer, this.isAgentTalking);
          }
        });

        let calibrated = false;

        // Loop de ajuste dinâmico: a cada 3 segundos reavalia o ambiente
        this.thresholdTimer = setInterval(async () => {
          
          // 1. Auto-Calibração / Detecção de Dispositivo (Roda apenas uma vez)
          if (!calibrated && this.energyManager.samplesCount > 100) {
            if (this.isAgentTalking) return; 

            calibrated = true;
            this.deviceMode = this.energyManager.detectDeviceMode();
            console.log(`[${this.callId}] [AUTO-CALIBRAÇÃO] Dispositivo detectado: ${this.deviceMode}`);
          }

          // 2. Classificação Ambiental Dinâmica (Roda a cada tick)
          this.currentProfile = this.energyManager.getClassification();
          const profileConfig = this.profiles[this.currentProfile][this.deviceMode.includes('fone') ? 'fone' : 'viva'];
          
          let suggested = profileConfig.base;
          
          // 3. Aplica o "Echo Shield" apenas se o agente estiver falando
          if (this.isAgentTalking) {
            suggested = Math.min(0.98, suggested + profileConfig.boost);
          }

          if (Math.abs(suggested - this.currentThreshold) > 0.05) {
            console.log(`[${this.callId}] Ajuste VAD: ${this.currentThreshold.toFixed(2)} -> ${suggested.toFixed(2)} ${this.isAgentTalking ? '(MODO ECO ATIVO)' : `(${this.currentProfile})`} NF:${this.energyManager.noiseFloor.toFixed(0)}`);
            this.currentThreshold = suggested;
            
            const adaptiveUpdate = {
              type: 'session.update',
              session: { 
                turn_detection: { 
                  type: 'server_vad', 
                  threshold: suggested,
                  prefix_padding_ms: profileConfig.prefix,
                  silence_duration_ms: profileConfig.silence
                } 
              }
            };
            this.endpoint.api(`uuid_openai_s2s ${this.channelUuid} client.event ${JSON.stringify(adaptiveUpdate).replace(/\s/g, '')}`).catch(() => {});
          }
        }, 3000); 

      } catch (err) {
        console.error(`[${this.callId}] Erro ao iniciar captura de áudio (Nível 3):`, err.message);
      }
    }

    console.log(`[${this.callId}] sessao configurada e pronta para conversacao`);
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
          console.log(`[${this.callId}] [BARGE-IN NÍVEL 4] Fala detectada! Interrompendo agente...`);
          
          // 1. Cancela a resposta E limpa o buffer na OpenAI
          const cancelCmd = `uuid_openai_s2s ${this.channelUuid} client.event {"type":"response.cancel"}`;
          const clearCmd = `uuid_openai_s2s ${this.channelUuid} client.event {"type":"input_audio_buffer.clear"}`;
          
          this.endpoint.api(cancelCmd).catch(() => {});
          this.endpoint.api(clearCmd).catch(() => {});

          // 2. Limpa o playback no FreeSWITCH
          this.endpoint.api(`uuid_break ${this.channelUuid} all`).catch(() => {});
          
          // NOTA SÊNIOR: NÃO setamos isAgentTalking = false aqui. 
          // Esperamos o evento 'response.done' da OpenAI para garantir que o eco parou de verdade.
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
  } catch (err) {
    console.error('erro conectando ao FreeSWITCH:', err.message || err);
    await wait(3000);
    connectMrf();
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

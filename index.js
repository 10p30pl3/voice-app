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
  }

  async start({ callId, endpoint }) {
    this.callId = callId;
    this.endpoint = endpoint;
    this.channelUuid = getChannelUuid(endpoint);

    if (!this.channelUuid) {
      throw new Error('nao consegui descobrir o uuid do canal para uuid_openai_s2s');
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
    await wait(5000);

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
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500
        }
      }
    };

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

    console.log(`[${this.callId}] sessao configurada e pronta para conversacao`);
  }

  async stop() {
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
      5000
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

require('dotenv').config();

const Srf = require('drachtio-srf');
const Mrf = require('drachtio-fsmrf');

const DRACHTIO_HOST = process.env.DRACHTIO_HOST || '127.0.0.1';
const DRACHTIO_PORT = parseInt(process.env.DRACHTIO_PORT || '9022', 10);
const DRACHTIO_SECRET = process.env.DRACHTIO_SECRET || 'cymru';

const FREESWITCH_HOST = process.env.FREESWITCH_HOST || '127.0.0.1';
const FREESWITCH_PORT = parseInt(process.env.FREESWITCH_PORT || '8021', 10);
const FREESWITCH_SECRET = process.env.FREESWITCH_SECRET || 'JambonzR0ck$';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-mini';

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

    // 1) abre a conexao websocket do modulo com a OpenAI
    const connectCmd =
      `uuid_openai_s2s ${this.channelUuid} session.create ` +
      `api.openai.com "v1/realtime?model=${OPENAI_REALTIME_MODEL}" bearer ${OPENAI_API_KEY}`;

    console.log(
      `[${this.callId}] openai_s2s connect: ` +
      connectCmd.replace(OPENAI_API_KEY, '***REDACTED***')
    );

    let response = await this.endpoint.api(connectCmd);
    console.log(`[${this.callId}] resposta connect:`, response?.body || response);

    // workaround simples enquanto nao estamos ouvindo openai_s2s::connect
    await wait(4000);

    // 2) primeiro client.event = response.create
    const responseCreateEvent = {
      type: 'response.create',
      response: {
        modalities: ['text', 'audio'],
        instructions:
          'Você é um atendente virtual de suporte. Responda em português do Brasil, de forma objetiva, educada e curta.',
        voice: 'alloy',
        output_audio_format: 'g711_ulaw',
        temperature: 0.8,
        max_output_tokens: 4096
      }
    };

    const responseCreateCmd =
      `uuid_openai_s2s ${this.channelUuid} client.event ` +
      `'${JSON.stringify(responseCreateEvent)}'`;

    console.log(`[${this.callId}] openai_s2s client.event response.create`);
    response = await this.endpoint.api(responseCreateCmd);
    console.log(
      `[${this.callId}] resposta response.create event:`,
      response?.body || response
    );

    await wait(500);

    // 3) depois client.event = session.update
    const sessionUpdateEvent = {
      type: 'session.update',
      session: {
        input_audio_transcription: {
          model: 'whisper-1'
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.8,
          prefix_padding_ms: 300,
          silence_duration_ms: 500
        }
      }
    };

    const updateCmd =
      `uuid_openai_s2s ${this.channelUuid} client.event ` +
      `'${JSON.stringify(sessionUpdateEvent)}'`;

    console.log(`[${this.callId}] openai_s2s client.event session.update`);
    response = await this.endpoint.api(updateCmd);
    console.log(
      `[${this.callId}] resposta session.update event:`,
      response?.body || response
    );
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
    console.log('FreeSWITCH ainda não está pronto');
    return res.send(503);
  }

  let endpoint;
  let dialog;
  let bridge;

  const callId = getCallId(req);

  try {
    console.log(`[${callId}] INVITE recebido de:`, req.callingNumber || req.get('From'));

    ({ endpoint, dialog } = await mediaserver.connectCaller(req, res));
    console.log(`[${callId}] chamada atendida com mídia, modo=openai_s2s`);

    bridge = new OpenAIS2SBridge();
    await bridge.start({ callId, endpoint });

    dialog.on('destroy', async () => {
      console.log(`[${callId}] chamada encerrada`);
      try { bridge && await bridge.stop(); } catch {}
    });
  } catch (err) {
    console.error(`[${callId}] erro na chamada:`, err);

    try { res.send(500); } catch {}
    try { if (dialog) dialog.destroy(); } catch {}
    try { bridge && await bridge.stop(); } catch {}
  }
});

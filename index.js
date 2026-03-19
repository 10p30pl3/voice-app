const Srf = require('drachtio-srf');
const Mrf = require('drachtio-fsmrf');
const OpenAIRealtimeBridge = require('./openai-bridge');
const WsMediaBridge = require('./media/ws-media-bridge');
const RtpMediaBridge = require('./media/rtp-media-bridge');

const MEDIA_MODE = process.env.MEDIA_MODE || 'ws';

const DRACHTIO_HOST = '127.0.0.1';
const DRACHTIO_PORT = 9022;
const DRACHTIO_SECRET = 'cymru';

const FREESWITCH_HOST = '127.0.0.1';
const FREESWITCH_PORT = 8021;
const FREESWITCH_SECRET = 'JambonzR0ck$';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const srf = new Srf();
const mrf = new Mrf(srf);

let mediaserver = null;
let mrfReady = false;

function getMediaBridge() {
  if (MEDIA_MODE === 'rtp') return new RtpMediaBridge();
  return new WsMediaBridge();
}

srf.connect({
  host: DRACHTIO_HOST,
  port: DRACHTIO_PORT,
  secret: DRACHTIO_SECRET
});

srf.on('connect', (err, hp) => {
  if (err) return console.error('erro conectando ao drachtio:', err);
  console.log('conectado ao drachtio:', hp);
});

async function connectMrf() {
  try {
    mediaserver = await mrf.connect({
      address: FREESWITCH_HOST,
      port: FREESWITCH_PORT,
      secret: FREESWITCH_SECRET
    });
    mrfReady = true;
    console.log('conectado ao FreeSWITCH via ESL');
  } catch (err) {
    console.error('erro conectando ao FreeSWITCH:', err.message || err);
    setTimeout(connectMrf, 3000);
  }
}
connectMrf();

srf.invite(async (req, res) => {
  if (!mrfReady) return res.send(503);

  let endpoint, dialog, mediaBridge, rt;
  const callId = req.get('Call-ID') || `call-${Date.now()}`;

  try {
    ({ endpoint, dialog } = await mediaserver.connectCaller(req, res));
    console.log(`[${callId}] chamada atendida com mídia, modo=${MEDIA_MODE}`);

    rt = new OpenAIRealtimeBridge({
      apiKey: OPENAI_API_KEY,
      model: 'gpt-realtime-mini',
      sessionId: callId
    });
    await rt.connect();

    mediaBridge = getMediaBridge();

    await mediaBridge.start({
      callId,
      endpoint,
      onAudio: (base64Chunk) => {
        rt.appendAudio(base64Chunk);
      }
    });

    rt.onAudioDelta = async (base64Audio) => {
      await mediaBridge.play(base64Audio);
    };

    dialog.on('destroy', async () => {
      console.log(`[${callId}] chamada encerrada`);
      try { await mediaBridge.stop(); } catch {}
      try { rt.close(); } catch {}
    });
  } catch (err) {
    console.error(`[${callId}] erro na chamada:`, err);
    try { res.send(500); } catch {}
    try { if (dialog) dialog.destroy(); } catch {}
    try { if (mediaBridge) await mediaBridge.stop(); } catch {}
    try { if (rt) rt.close(); } catch {}
  }
});

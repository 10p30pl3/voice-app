const Srf = require('drachtio-srf');
const Mrf = require('drachtio-fsmrf');

const DRACHTIO_HOST = '127.0.0.1';
const DRACHTIO_PORT = 9022;
const DRACHTIO_SECRET = 'cymru';

const FREESWITCH_HOST = '127.0.0.1';
const FREESWITCH_PORT = 8021;
const FREESWITCH_SECRET = 'JambonzR0ck$';

const srf = new Srf();
const mrf = new Mrf(srf);

let mediaserver = null;
let mrfReady = false;
let attempts = 0;

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

  try {
    console.log('INVITE recebido de:', req.callingNumber || req.get('From'));

    ({ endpoint, dialog } = await mediaserver.connectCaller(req, res));

    console.log('chamada atendida com mídia');

    const filename = `/recordings/call-${Date.now()}.wav`;
    await endpoint.execute('set', 'RECORD_STEREO=false');
    await endpoint.execute('record_session', filename);

    console.log('gravando em:', filename);

    dialog.on('destroy', () => {
      console.log('chamada encerrada');
    });
  } catch (err) {
    console.error('erro na chamada:', err);

    try {
      res.send(500);
    } catch (e) {}

    try {
      if (dialog) dialog.destroy();
    } catch (e) {}
  }
});

const Srf = require('drachtio-srf');
const srf = new Srf();

srf.connect({
  host: 'drachtio',
  port: 9022,
  secret: 'cymru'
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

srf.invite(async (req, res) => {
  console.log('INVITE recebido de:', req.callingNumber || req.get('From'));
  try {
    await res.send(200, {
      headers: {
        'Contact': req.uri
      }
    });
    console.log('chamada atendida');
  } catch (err) {
    console.error('erro ao atender chamada:', err);
  }
});

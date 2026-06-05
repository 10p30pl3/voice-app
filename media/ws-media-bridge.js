require('dotenv').config({ override: true });
const WebSocket = require('ws');
const http = require('http');
const os = require('os');

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

const AUDIO_FORK_WS_HOST = process.env.AUDIO_FORK_WS_HOST || getLocalIp();

class WsMediaBridge {
  constructor() {
    this.server = null;
    this.wss = null;
    this.socket = null;
    this.callId = null;
    this.onAudio = null;
    this.endpoint = null;
    this.channelUuid = null;
    this.stopped = false;
    this.isPlaying = false;
    this.playbackChunkCount = 0;
  }

  async start({ callId, endpoint, onAudio }) {
    this.callId = callId;
    this.onAudio = onAudio;
    this.endpoint = endpoint;

    if (!this.server) {
      this.server = http.createServer((req, res) => {
        res.writeHead(200);
        res.end('ws media bridge ok');
      });
      this.wss = new WebSocket.Server({ server: this.server });

      this.wss.on('connection', (ws, req) => {
        const ip = req.socket.remoteAddress;
        console.log(`[${this.callId}] [WsMediaBridge] Conexão recebida de ${ip}`);
        this.socket = ws;

        ws.on('message', (raw) => {
          if (Buffer.isBuffer(raw)) {
            const base64 = raw.toString('base64');
            this.onAudio && this.onAudio(base64);
            return;
          }

          const s = raw.toString();
          if (s && s.length > 0) {
            // mod_audio_fork normalmente manda binário/base64/json dependendo da config
            try {
              const msg = JSON.parse(s);
              if (msg.audio) this.onAudio && this.onAudio(msg.audio);
            } catch {
              this.onAudio && this.onAudio(Buffer.from(s).toString('base64'));
            }
          }
        });

        ws.on('close', () => {
          console.log(`[${this.callId}] websocket de mídia fechado`);
        });
      });

      // v16.0: Sincronizado para usar apenas o que está no .env (MEDIA_WS_PORT)
      const fixedPort = parseInt(process.env.MEDIA_WS_PORT || '0', 10);
      
      await new Promise((resolve, reject) => {
        this.server.on('error', (err) => {
          console.error(`[${this.callId}] [WsMediaBridge] Erro no servidor HTTP:`, err.message);
          if (err.code === 'EADDRINUSE') {
            console.error(`[${this.callId}] Porta ${fixedPort} já está ocupada!`);
          }
          reject(err);
        });

        this.server.listen(fixedPort, '0.0.0.0', () => {
          this.port = this.server.address().port; 
          console.log(`[${this.callId}] [WsMediaBridge] Servidor ouvindo em 0.0.0.0:${this.port}`);
          resolve();
        });
      });
    }

    this.channelUuid =
      endpoint.uuid ||
      endpoint.id ||
      endpoint.sessionId ||
      endpoint.channelId;

    if (!this.channelUuid) {
      throw new Error('nao consegui descobrir o uuid do canal para uuid_audio_fork');
    }

    const cmd = `uuid_audio_fork ${this.channelUuid} start ws://${AUDIO_FORK_WS_HOST}:${this.port} mono 8000`;
    console.log(`[${this.callId}] iniciando audio_fork na porta aleatoria ${this.port}: ${cmd}`);

    const response = await this.endpoint.api(cmd);
    console.log(`[${this.callId}] resposta uuid_audio_fork:`, response?.body || response);
  }

  startPlaybackStream() {
    if (this.stopped) return;
    this.isPlaying = true;
    this.playbackChunkCount = 0;
    console.log(`[${this.callId}] 🔊 Iniciando playback via WebSocket bidirecional (mod_audio_fork)`);
  }

  pushAudioChunk(chunk) {
    if (this.stopped || !this.isPlaying) return;
    // Envia áudio PCM de volta pelo WebSocket — mod_audio_fork injeta no canal FreeSWITCH
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(chunk);
      this.playbackChunkCount++;
      if (this.playbackChunkCount === 1) {
        console.log(`[${this.callId}] 🔊 Primeiro chunk de áudio enviado via WS (${chunk.length} bytes)`);
      }
    }
  }

  endPlaybackStream() {
    if (this.isPlaying) {
      console.log(`[${this.callId}] 🔇 Playback encerrado (${this.playbackChunkCount} chunks enviados)`);
    }
    this.isPlaying = false;
  }

  async stop() {
    this.stopped = true;

    // 1. Para o playback
    this.isPlaying = false;
    this.endPlaybackStream();

    // 2. Para o audio_fork
    try {
      if (this.endpoint && this.channelUuid) {
        const cmd = `uuid_audio_fork ${this.channelUuid} stop`;
        const response = await this.endpoint.api(cmd);
        console.log(`[${this.callId}] stop uuid_audio_fork:`, response?.body || response);
      }
    } catch (err) {
      console.error(`[${this.callId}] erro stop uuid_audio_fork:`, err.message || err);
    }

    // 4. Fecha WebSocket de mídia
    try { 
      if (this.socket) {
        this.socket.terminate(); 
        this.socket = null;
      }
    } catch {}

    try { 
      if (this.wss) {
        this.wss.clients.forEach(client => client.terminate());
        this.wss.close(); 
        this.wss = null;
      }
    } catch {}

    // 5. Fecha servidor HTTP (agora sem play pendente = sem File Not Found)
    if (this.server) {
      await new Promise((resolve) => {
        this.server.closeAllConnections && this.server.closeAllConnections(); 
        this.server.close(() => {
          console.log(`[${this.callId}] [WsMediaBridge] Servidor de mídia parado.`);
          resolve();
        });
      });
      this.server = null;
    }
  }
}

module.exports = WsMediaBridge;

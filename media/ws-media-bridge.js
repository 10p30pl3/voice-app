require('dotenv').config({ override: true });
const WebSocket = require('ws');
const http = require('http');

const AUDIO_FORK_WS_HOST = process.env.AUDIO_FORK_WS_HOST || '127.0.0.1';

class WsMediaBridge {
  constructor() {
    this.server = null;
    this.wss = null;
    this.socket = null;
    this.callId = null;
    this.onAudio = null;
    this.endpoint = null;
    this.channelUuid = null;
  }

  async start({ callId, endpoint, onAudio }) {
    this.callId = callId;
    this.onAudio = onAudio;
    this.endpoint = endpoint;

    if (!this.server) {
      this.server = http.createServer();
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

  async play(base64Audio) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({
        type: 'play',
        callId: this.callId,
        audio: base64Audio
      }));
    }
  }

  async stop() {
    try {
      if (this.endpoint && this.channelUuid) {
        const cmd = `uuid_audio_fork ${this.channelUuid} stop`;
        const response = await this.endpoint.api(cmd);
        console.log(`[${this.callId}] stop uuid_audio_fork:`, response?.body || response);
      }
    } catch (err) {
      console.error(`[${this.callId}] erro stop uuid_audio_fork:`, err.message || err);
    }

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
    
    if (this.server) {
      await new Promise((resolve) => {
        // Encerra forçadamente todas as conexões HTTP zumbis para liberar a porta IMEDIATAMENTE
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

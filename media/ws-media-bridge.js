const WebSocket = require('ws');
const http = require('http');

const PORT = 8090;

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

      this.wss.on('connection', (ws) => {
        console.log(`[${this.callId}] websocket de mídia conectado`);
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

      await new Promise((resolve) => this.server.listen(this.PORT,'0.0.0.0', resolve));
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
    console.log(`[${this.callId}] iniciando audio_fork: ${cmd}`);

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

    try { this.socket && this.socket.close(); } catch {}
    try { this.wss && this.wss.close(); } catch {}
    try { this.server && this.server.close(); } catch {}

    this.socket = null;
    this.wss = null;
    this.server = null;
  }
}

module.exports = WsMediaBridge;

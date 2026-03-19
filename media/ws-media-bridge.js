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
          // community editions normalmente mandam texto/json/base64;
          // versões mais novas podem mandar binário.
          if (Buffer.isBuffer(raw)) {
            const base64 = raw.toString('base64');
            this.onAudio && this.onAudio(base64);
            return;
          }

          let msg;
          try {
            msg = JSON.parse(raw.toString());
          } catch {
            // fallback: trata como base64 puro
            const s = raw.toString();
            if (s && s.length > 0) this.onAudio && this.onAudio(s);
            return;
          }

          if (msg.callId && msg.callId !== this.callId) return;
          if (msg.audio) this.onAudio && this.onAudio(msg.audio);
        });

        ws.on('close', () => {
          console.log(`[${this.callId}] websocket de mídia fechado`);
        });
      });

      await new Promise((resolve) => this.server.listen(PORT, resolve));
    }

    // tenta descobrir o uuid do canal
    this.channelUuid =
      endpoint.uuid ||
      endpoint.id ||
      endpoint.sessionId ||
      endpoint.channelId;

    if (!this.channelUuid) {
      throw new Error('nao consegui descobrir o uuid do canal para uuid_audio_stream');
    }

    const metadata = JSON.stringify({ callId: this.callId });
    const cmd = `uuid_audio_stream ${this.channelUuid} start ws://127.0.0.1:${PORT}/ws mixed 8k ${metadata}`;

    console.log(`[${this.callId}] iniciando mod_audio_stream: ${cmd}`);

    const response = await this.endpoint.api(cmd);
    console.log(`[${this.callId}] resposta uuid_audio_stream:`, response?.body || response);
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
        const cmd = `uuid_audio_stream ${this.channelUuid} stop`;
        const response = await this.endpoint.api(cmd);
        console.log(`[${this.callId}] stop uuid_audio_stream:`, response?.body || response);
      }
    } catch (err) {
      console.error(`[${this.callId}] erro stop uuid_audio_stream:`, err.message || err);
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

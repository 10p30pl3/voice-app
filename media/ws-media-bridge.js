require('dotenv').config({ override: true });
const WebSocket = require('ws');
const http = require('http');
const os = require('os');
const { URL } = require('url');

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

/**
 * Servidor HTTP/WebSocket Centralizado (Singleton)
 * Roteia chamadas simultâneas sem colisão de portas (evita EADDRINUSE)
 * e disponibiliza endpoint /health para monitoramento e liveness probe.
 */
class WsMediaServer {
  constructor() {
    this.server = null;
    this.wss = null;
    this.port = null;
    this.isListening = false;
    this.listenPromise = null;
    this.sessions = new Map(); // channelUuid -> WsMediaBridge
    this.pendingConnections = new Set(); // sessions aguardando conexão WS
    this.healthCallback = null;
  }

  setHealthCallback(fn) {
    this.healthCallback = fn;
  }

  async listen(requestedPort = null) {
    if (this.isListening) return this.port;
    if (this.listenPromise) return this.listenPromise;

    const targetPort = parseInt(
      requestedPort || process.env.MEDIA_WS_PORT || '8090',
      10
    );

    this.listenPromise = new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        // Endpoint de Health Check
        if (req.url === '/health' || req.url === '/healthz') {
          const extraHealth = this.healthCallback ? this.healthCallback() : {};
          const status = {
            status: 'ok',
            uptime: Math.floor(process.uptime()),
            timestamp: new Date().toISOString(),
            activeCalls: this.sessions.size,
            mediaPort: this.port,
            ...extraHealth
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(status, null, 2));
        }

        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('voice-app media server online');
      });

      this.wss = new WebSocket.Server({ noServer: true });

      // Tratamento de HTTP Upgrade para roteamento de WebSocket
      this.server.on('upgrade', (req, socket, head) => {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.wss.emit('connection', ws, req);
        });
      });

      this.wss.on('connection', (ws, req) => {
        this.handleConnection(ws, req);
      });

      this.server.on('error', (err) => {
        console.error('[WsMediaServer] Erro no servidor HTTP central:', err.message);
        if (err.code === 'EADDRINUSE') {
          console.error(`[WsMediaServer] Porta ${targetPort} já está em uso!`);
        }
        this.listenPromise = null;
        reject(err);
      });

      this.server.listen(targetPort, '0.0.0.0', () => {
        this.port = this.server.address().port;
        this.isListening = true;
        console.log(`[WsMediaServer] 🚀 Servidor Central de Mídia ouvindo em 0.0.0.0:${this.port}`);
        resolve(this.port);
      });
    });

    return this.listenPromise;
  }

  extractChannelUuid(req) {
    try {
      const parsedUrl = new URL(req.url, 'http://localhost');
      // Tenta query param: ?channelUuid=xyz ou ?uuid=xyz
      const queryUuid = parsedUrl.searchParams.get('channelUuid') || parsedUrl.searchParams.get('uuid');
      if (queryUuid && this.sessions.has(queryUuid)) {
        return queryUuid;
      }

      // Tenta path: /media/:uuid ou /:uuid
      const parts = parsedUrl.pathname.split('/').filter(Boolean);
      for (const part of parts) {
        if (this.sessions.has(part)) {
          return part;
        }
      }

      // Se passou apenas /media/uuid ou /uuid direto
      if (parts.length > 0) {
        const lastPart = parts[parts.length - 1];
        if (this.sessions.has(lastPart)) return lastPart;
      }
    } catch (e) {}

    // Fallback de contingência: se há exatamente 1 sessão aguardando conexão
    if (this.pendingConnections.size === 1) {
      const [singleUuid] = this.pendingConnections;
      return singleUuid;
    }

    return null;
  }

  handleConnection(ws, req) {
    const ip = req.socket.remoteAddress;
    const channelUuid = this.extractChannelUuid(req);

    if (!channelUuid || !this.sessions.has(channelUuid)) {
      console.warn(`[WsMediaServer] Conexão WS rejeitada de ${ip} (URL: ${req.url}): canal não encontrado`);
      ws.close(1008, 'Channel not found');
      return;
    }

    const session = this.sessions.get(channelUuid);
    this.pendingConnections.delete(channelUuid);
    session.attachSocket(ws, ip);
  }

  registerSession(channelUuid, session) {
    this.sessions.set(channelUuid, session);
    this.pendingConnections.add(channelUuid);
  }

  unregisterSession(channelUuid) {
    this.sessions.delete(channelUuid);
    this.pendingConnections.delete(channelUuid);
  }

  async close() {
    this.isListening = false;
    this.listenPromise = null;

    for (const session of this.sessions.values()) {
      try { session.stop(); } catch {}
    }
    this.sessions.clear();
    this.pendingConnections.clear();

    if (this.wss) {
      try {
        this.wss.clients.forEach(c => c.terminate());
        this.wss.close();
      } catch {}
      this.wss = null;
    }

    if (this.server) {
      await new Promise(resolve => {
        try {
          this.server.closeAllConnections?.();
          this.server.close(() => resolve());
        } catch {
          resolve();
        }
      });
      this.server = null;
    }
    console.log('[WsMediaServer] Servidor Central de Mídia encerrado.');
  }
}

// Instância compartilhada única (Singleton)
const mediaServerSingleton = new WsMediaServer();

/**
 * Ponte de mídia por chamada (WsMediaBridge)
 */
class WsMediaBridge {
  constructor() {
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

    this.channelUuid =
      endpoint.uuid ||
      endpoint.id ||
      endpoint.sessionId ||
      endpoint.channelId ||
      endpoint.conn?.uuid;

    if (!this.channelUuid) {
      throw new Error('Não consegui descobrir o uuid do canal para uuid_audio_fork');
    }

    // Garante que o servidor central está ouvindo
    const port = await mediaServerSingleton.listen();

    // Registra esta chamada no servidor central
    mediaServerSingleton.registerSession(this.channelUuid, this);

    const wsUrl = `ws://${AUDIO_FORK_WS_HOST}:${port}/media/${this.channelUuid}`;
    const cmd = `uuid_audio_fork ${this.channelUuid} start ${wsUrl} mono 8000`;
    console.log(`[${this.callId}] Iniciando mod_audio_fork na porta compartilhada ${port}: ${cmd}`);

    const response = await this.endpoint.api(cmd);
    console.log(`[${this.callId}] Resposta uuid_audio_fork:`, response?.body || response);
  }

  attachSocket(ws, ip) {
    this.socket = ws;
    console.log(`[${this.callId}] [WsMediaBridge] mod_audio_fork conectado via WS de ${ip} (Canal: ${this.channelUuid})`);

    ws.on('message', (raw) => {
      if (this.stopped) return;

      if (Buffer.isBuffer(raw)) {
        const base64 = raw.toString('base64');
        this.onAudio && this.onAudio(base64);
        return;
      }

      const s = raw.toString();
      if (s && s.length > 0) {
        try {
          const msg = JSON.parse(s);
          if (msg.audio) this.onAudio && this.onAudio(msg.audio);
        } catch {
          this.onAudio && this.onAudio(Buffer.from(s).toString('base64'));
        }
      }
    });

    ws.on('close', () => {
      console.log(`[${this.callId}] WebSocket de mídia desconectado.`);
      this.socket = null;
    });

    ws.on('error', (err) => {
      console.error(`[${this.callId}] Erro no WebSocket de mídia:`, err.message);
    });
  }

  startPlaybackStream() {
    if (this.stopped) return;
    this.isPlaying = true;
    this.playbackChunkCount = 0;
    console.log(`[${this.callId}] 🔊 Iniciando playback via WebSocket bidirecional (mod_audio_fork)`);
  }

  pushAudioChunk(chunk) {
    if (this.stopped || !this.isPlaying) return;
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
    if (this.stopped) return;
    this.stopped = true;

    // 1. Encerra playback
    this.endPlaybackStream();

    // 2. Remove registro no servidor central
    if (this.channelUuid) {
      mediaServerSingleton.unregisterSession(this.channelUuid);
    }

    // 3. Para o audio_fork no FreeSWITCH
    try {
      if (this.endpoint && this.channelUuid) {
        const cmd = `uuid_audio_fork ${this.channelUuid} stop`;
        const response = await this.endpoint.api(cmd);
        console.log(`[${this.callId}] Stop uuid_audio_fork:`, response?.body || response);
      }
    } catch (err) {
      console.error(`[${this.callId}] Erro no stop uuid_audio_fork:`, err.message || err);
    }

    // 4. Fecha socket desta chamada
    try {
      if (this.socket) {
        this.socket.terminate();
        this.socket = null;
      }
    } catch {}
  }
}

module.exports = WsMediaBridge;
module.exports.mediaServer = mediaServerSingleton;

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
const WORKER_ID = parseInt(process.env.NODE_APP_INSTANCE || process.env.WORKER_ID || '0', 10);

/**
 * Servidor HTTP/WebSocket Centralizado por Worker
 * - Suporta múltiplos processos (Multi-Core PM2/Cluster) alocando portas automaticamente (ex: 8090, 8091, 8092...)
 * - Limita maxPayload em 64KB para evitar exaustão de memória (DoS)
 * - Disponibiliza endpoint /health com métricas do worker e do cluster FreeSWITCH
 */
class WsMediaServer {
  constructor() {
    this.server = null;
    this.wss = null;
    this.port = null;
    this.isListening = false;
    this.listenPromise = null;
    this.sessions = new Map(); // channelUuid -> WsMediaBridge
    this.pendingConnections = new Set();
    this.healthCallback = null;
  }

  setHealthCallback(fn) {
    this.healthCallback = fn;
  }

  async listen(requestedPort = null) {
    if (this.isListening) return this.port;
    if (this.listenPromise) return this.listenPromise;

    const basePort = parseInt(requestedPort || process.env.MEDIA_WS_PORT || '8090', 10);
    let candidatePort = basePort > 0 ? basePort + WORKER_ID : 0;

    this.listenPromise = new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        if (req.url === '/health' || req.url === '/healthz') {
          const extraHealth = this.healthCallback ? this.healthCallback() : {};
          const status = {
            status: 'ok',
            workerId: WORKER_ID,
            pid: process.pid,
            uptime: Math.floor(process.uptime()),
            timestamp: new Date().toISOString(),
            activeCallsInWorker: this.sessions.size,
            mediaPort: this.port,
            ...extraHealth
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(status, null, 2));
        }

        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`voice-app media server online (worker ${WORKER_ID})`);
      });

      this.wss = new WebSocket.Server({
        noServer: true,
        maxPayload: 64 * 1024 // Limite de 64KB por frame para proteção de memória
      });

      this.server.on('upgrade', (req, socket, head) => {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.wss.emit('connection', ws, req);
        });
      });

      this.wss.on('connection', (ws, req) => {
        this.handleConnection(ws, req);
      });

      let portRetries = 0;
      const maxPortRetries = 10;

      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE' && portRetries < maxPortRetries && candidatePort > 0) {
          portRetries += 1;
          candidatePort += 1;
          console.warn(`[WsMediaServer] Porta em uso! Tentando próxima porta livre: ${candidatePort}...`);
          setTimeout(() => {
            this.server.listen(candidatePort, '0.0.0.0');
          }, 50);
          return;
        }
        console.error('[WsMediaServer] Erro no servidor HTTP central:', err.message);
        this.listenPromise = null;
        reject(err);
      });

      this.server.listen(candidatePort, '0.0.0.0', () => {
        this.port = this.server.address().port;
        this.isListening = true;
        console.log(`[WsMediaServer] 🚀 Worker #${WORKER_ID} (PID ${process.pid}) ouvindo mídia em 0.0.0.0:${this.port}`);
        resolve(this.port);
      });
    });

    return this.listenPromise;
  }

  extractChannelUuid(req) {
    try {
      const parsedUrl = new URL(req.url, 'http://localhost');
      const queryUuid = parsedUrl.searchParams.get('channelUuid') || parsedUrl.searchParams.get('uuid');
      if (queryUuid && this.sessions.has(queryUuid)) {
        return queryUuid;
      }

      const parts = parsedUrl.pathname.split('/').filter(Boolean);
      for (const part of parts) {
        if (this.sessions.has(part)) {
          return part;
        }
      }

      if (parts.length > 0) {
        const lastPart = parts[parts.length - 1];
        if (this.sessions.has(lastPart)) return lastPart;
        // Se a URL especificou explicitamente /media/<uuid> e o UUID não existe em sessions, não faz fallback
        if (parts[0] === 'media' && parts.length >= 2) {
          return null;
        }
      }
    } catch {}

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
      console.warn(`[WsMediaServer] Conexão WS rejeitada de ${ip} (URL: ${req.url}): canal não registrado`);
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
      try {
        session.stop();
      } catch {}
    }
    this.sessions.clear();
    this.pendingConnections.clear();

    if (this.wss) {
      try {
        this.wss.clients.forEach((c) => c.terminate());
        this.wss.close();
      } catch {}
      this.wss = null;
    }

    if (this.server) {
      await new Promise((resolve) => {
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

const mediaServerSingleton = new WsMediaServer();

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

    const port = await mediaServerSingleton.listen();
    mediaServerSingleton.registerSession(this.channelUuid, this);

    const wsUrl = `ws://${AUDIO_FORK_WS_HOST}:${port}/media/${this.channelUuid}`;
    const cmd = `uuid_audio_fork ${this.channelUuid} start ${wsUrl} mono 8000`;
    console.log(`[${this.callId}] Iniciando mod_audio_fork na porta ${port}: ${cmd}`);

    const response = await this.endpoint.api(cmd);
    console.log(`[${this.callId}] Resposta uuid_audio_fork:`, response?.body || response);
  }

  attachSocket(ws, ip) {
    this.socket = ws;
    console.log(`[${this.callId}] [WsMediaBridge] mod_audio_fork conectado de ${ip} (Canal: ${this.channelUuid})`);

    ws.on('message', (raw) => {
      if (this.stopped) return;

      if (Buffer.isBuffer(raw)) {
        this.onAudio && this.onAudio(raw);
        return;
      }

      const s = raw.toString();
      if (s && s.length > 0) {
        try {
          const msg = JSON.parse(s);
          if (msg.audio) this.onAudio && this.onAudio(Buffer.from(msg.audio, 'base64'));
        } catch {
          this.onAudio && this.onAudio(Buffer.from(s));
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

    this.endPlaybackStream();

    if (this.channelUuid) {
      mediaServerSingleton.unregisterSession(this.channelUuid);
    }

    try {
      if (this.endpoint && this.channelUuid) {
        const cmd = `uuid_audio_fork ${this.channelUuid} stop`;
        const response = await this.endpoint.api(cmd);
        console.log(`[${this.callId}] Stop uuid_audio_fork:`, response?.body || response);
      }
    } catch (err) {
      console.error(`[${this.callId}] Erro no stop uuid_audio_fork:`, err.message || err);
    }

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

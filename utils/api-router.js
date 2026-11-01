const fs = require('fs');
const path = require('path');
const { URL } = require('url');

/**
 * Lê e faz parse seguro do body JSON de uma requisição HTTP (com limite de 256KB)
 */
function readJsonBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    if (req.method === 'GET' || req.method === 'DELETE' || req.method === 'HEAD') {
      return resolve({});
    }
    const chunks = [];
    let total = 0;

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        return reject(new Error('Payload JSON excede limite de 256KB'));
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`JSON inválido: ${err.message}`));
      }
    });

    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key'
  });
  res.end(JSON.stringify(payload, null, 2));
}

/**
 * Catálogo dos principais comandos de mercado disponíveis na API REST (/v1)
 */
const API_COMMANDS_CATALOG = [
  {
    category: 'Observabilidade & Cluster',
    endpoints: [
      { method: 'GET', path: '/health', description: 'Healthcheck do Worker, Drachtio, FreeSWITCH Pool e Tenants' },
      { method: 'GET', path: '/v1/status', description: 'Status detalhado do cluster (FreeSWITCH + Whisper + Chamadas)' },
      { method: 'GET', path: '/v1/cluster/nodes', description: 'Lista nós de mídia FreeSWITCH e nós de IA Whisper' },
      { method: 'GET', path: '/v1/commands', description: 'Catálogo interativo de todas as APIs e comandos de mercado' }
    ]
  },
  {
    category: 'Controle de Chamadas & Disparo Outbound (CPaaS)',
    endpoints: [
      { method: 'GET', path: '/v1/calls', description: 'Lista todas as chamadas ativas em tempo real' },
      { method: 'POST', path: '/v1/calls', description: 'Origina uma chamada ativa (Outbound SIP INVITE) com AMD/STT/IA' },
      { method: 'GET', path: '/v1/calls/:callId', description: 'Detalhes em tempo real da chamada + transcrição parcial' },
      { method: 'DELETE', path: '/v1/calls/:callId', description: 'Encerra a chamada imediatamente (Hangup)' },
      { method: 'POST', path: '/v1/calls/:callId/hangup', description: 'Encerra a chamada com motivo customizado' }
    ]
  },
  {
    category: 'Comandos In-Call em Tempo Real (Voz, IA & Telefonia)',
    endpoints: [
      {
        method: 'POST',
        path: '/v1/calls/:callId/say',
        description: 'Injeta fala ou instrução na sessão OpenAI Realtime (Prompt Injection / Whispering)'
      },
      {
        method: 'POST',
        path: '/v1/calls/:callId/interrupt',
        description: 'Barge-in forçado via API: corta imediatamente a voz da IA (killAudio + response.cancel)'
      },
      {
        method: 'POST',
        path: '/v1/calls/:callId/transfer',
        description: 'Transfere a chamada (Blind Transfer via FreeSWITCH uuid_transfer ou SIP REFER)'
      },
      {
        method: 'POST',
        path: '/v1/calls/:callId/dtmf',
        description: 'Envia tons DTMF na linha (outbound RFC2833) ou simula dígito do usuário (inbound)'
      },
      {
        method: 'POST',
        path: '/v1/calls/:callId/play',
        description: 'Toca arquivo de áudio (.wav) ou tone_stream:// diretamente no canal FreeSWITCH'
      },
      {
        method: 'POST',
        path: '/v1/calls/:callId/mute',
        description: 'Silencia o microfone do canal (Mute)'
      },
      {
        method: 'POST',
        path: '/v1/calls/:callId/unmute',
        description: 'Reativa o microfone do canal (Unmute)'
      },
      {
        method: 'POST',
        path: '/v1/calls/:callId/hold',
        description: 'Coloca a chamada em espera (Hold / Música de Espera)'
      },
      {
        method: 'POST',
        path: '/v1/calls/:callId/unhold',
        description: 'Retoma a chamada em espera (Unhold)'
      },
      {
        method: 'POST',
        path: '/v1/calls/:callId/recording',
        description: 'Inicia, pausa, retoma ou encerra a gravação Estéreo (.wav) + Transcrição (.txt) sob demanda (PCI/LGPD)'
      },
      {
        method: 'GET',
        path: '/v1/calls/:callId/transcript',
        description: 'Obtém a transcrição dialogada em tempo real (Cliente: / Atendente: com Data e Hora)'
      }
    ]
  },
  {
    category: 'Gravações Estéreo & Transcrições Dialogadas (Compliance)',
    endpoints: [
      { method: 'GET', path: '/v1/recordings', description: 'Lista arquivos de gravação (.wav) e transcrição (.txt) salvos' },
      { method: 'GET', path: '/v1/recordings/:baseName/audio', description: 'Download/Stream do arquivo WAV Estéreo 8kHz (L=Cliente, R=Atendente)' },
      { method: 'GET', path: '/v1/recordings/:baseName/transcript', description: 'Retorna a transcrição dialogada com Data/Hora (JSON ou texto)' },
      { method: 'DELETE', path: '/v1/recordings/:baseName', description: 'Exclui gravação e transcrição do disco (Direito ao Esquecimento LGPD)' }
    ]
  },
  {
    category: 'Gestão Multi-Tenant (Clientes, Prompts, Limites & DIDs)',
    endpoints: [
      { method: 'GET', path: '/v1/tenants', description: 'Lista todos os tenants configurados e uso atual de canais' },
      { method: 'GET', path: '/v1/tenants/:id', description: 'Obtém configuração detalhada de um tenant' },
      { method: 'POST', path: '/v1/tenants', description: 'Cria ou atualiza um tenant em tempo real (Hot-Reload)' },
      { method: 'PUT', path: '/v1/tenants/:id', description: 'Atualiza parâmetros de um tenant específico' },
      { method: 'DELETE', path: '/v1/tenants/:id', description: 'Remove um tenant cadastrado' }
    ]
  }
];

function createApiRouter({ activeBridges, tenantManager, fsPool, whisperPool, mediaServer, originateCallHandler }) {
  const defaultRecDir = process.env.RECORDING_DIR || path.join(__dirname, '..', 'recordings');

  return async function handleApiRequest(req, res) {
    if (req.method === 'OPTIONS') {
      sendJson(res, 200, { ok: true });
      return true;
    }

    const parsedUrl = new URL(req.url, 'http://localhost');
    const pathname = parsedUrl.pathname.replace(/\/+$/, '') || '/';

    if (!pathname.startsWith('/v1') && !pathname.startsWith('/api/v1')) {
      return false;
    }

    const cleanPath = pathname.startsWith('/api/v1') ? pathname.slice(4) : pathname;

    // Autenticação opcional por Token (se API_AUTH_TOKEN estiver definido no .env)
    const configuredToken = process.env.API_AUTH_TOKEN;
    if (configuredToken) {
      const authHeader = req.headers['authorization'] || '';
      const apiKeyHeader = req.headers['x-api-key'] || '';
      const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
      if (bearerToken !== configuredToken && apiKeyHeader !== configuredToken) {
        sendJson(res, 401, {
          error: 'unauthorized',
          message: 'Token de API inválido ou ausente (use Authorization: Bearer <token> ou X-API-Key)'
        });
        return true;
      }
    }

    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: 'bad_request', message: err.message });
      return true;
    }

    // -----------------------------------------------------------------------
    // 1. OBSERVABILIDADE, CATÁLOGO & CLUSTER
    // -----------------------------------------------------------------------
    if (req.method === 'GET' && (cleanPath === '/v1' || cleanPath === '/v1/commands' || cleanPath === '/v1/openapi')) {
      sendJson(res, 200, {
        service: 'voice-app-gateway',
        version: '2.0.0',
        commandsCatalog: API_COMMANDS_CATALOG
      });
      return true;
    }

    if (req.method === 'GET' && cleanPath === '/v1/status') {
      const health = mediaServer.getHealthObject();
      sendJson(res, 200, {
        ...health,
        whisperCluster: whisperPool ? whisperPool.getStats() : null,
        activeCallsCount: activeBridges.size
      });
      return true;
    }

    if (req.method === 'GET' && cleanPath === '/v1/cluster/nodes') {
      sendJson(res, 200, {
        freeSwitch: fsPool.getPoolStats(),
        whisper: whisperPool ? whisperPool.getStats() : null
      });
      return true;
    }

    // -----------------------------------------------------------------------
    // 2. LISTAGEM E ORIGINAÇÃO DE CHAMADAS (/v1/calls)
    // -----------------------------------------------------------------------
    if (req.method === 'GET' && cleanPath === '/v1/calls') {
      const calls = [];
      for (const bridge of activeBridges.values()) {
        calls.push(bridge.getCallInfo(false));
      }
      sendJson(res, 200, {
        count: calls.length,
        calls
      });
      return true;
    }

    if (req.method === 'POST' && cleanPath === '/v1/calls') {
      if (!originateCallHandler) {
        sendJson(res, 501, { error: 'not_implemented', message: 'Handler de originação não disponível' });
        return true;
      }
      if (!body.to) {
        sendJson(res, 400, { error: 'validation_error', message: 'O parâmetro "to" (destino SIP/número) é obrigatório' });
        return true;
      }
      try {
        const result = await originateCallHandler(body);
        sendJson(res, 201, result);
      } catch (err) {
        sendJson(res, 502, { error: 'originate_failed', message: err.message });
      }
      return true;
    }

    // -----------------------------------------------------------------------
    // 3. COMANDOS IN-CALL (/v1/calls/:callId/...)
    // -----------------------------------------------------------------------
    const callMatch = cleanPath.match(/^\/v1\/calls\/([^/]+)(?:\/([^/]+))?$/);
    if (callMatch) {
      const callId = decodeURIComponent(callMatch[1]);
      const action = callMatch[2] || null;
      const bridge = activeBridges.get(callId);

      if (!bridge) {
        sendJson(res, 404, { error: 'call_not_found', message: `Chamada ativa não encontrada: ${callId}` });
        return true;
      }

      // GET /v1/calls/:callId
      if (req.method === 'GET' && !action) {
        sendJson(res, 200, bridge.getCallInfo(true));
        return true;
      }

      // DELETE /v1/calls/:callId ou POST /v1/calls/:callId/hangup
      if ((req.method === 'DELETE' && !action) || (req.method === 'POST' && action === 'hangup')) {
        const reason = body.reason || 'api_hangup';
        bridge.terminateCall(reason);
        sendJson(res, 200, { ok: true, callId, command: 'hangup', reason });
        return true;
      }

      // GET /v1/calls/:callId/transcript
      if (req.method === 'GET' && action === 'transcript') {
        const info = bridge.getCallInfo(true);
        sendJson(res, 200, {
          callId,
          sttEnabled: info.sttEnabled,
          recordingActive: info.recordingActive,
          transcriptCount: info.transcript.length,
          transcript: info.transcript,
          formatted: info.transcript.map((t) => t.formatted).join('\n')
        });
        return true;
      }

      // POST /v1/calls/:callId/say (ou /whisper ou /inject)
      if (req.method === 'POST' && (action === 'say' || action === 'whisper' || action === 'inject')) {
        if (!body.text) {
          sendJson(res, 400, { error: 'validation_error', message: 'O campo "text" é obrigatório' });
          return true;
        }
        const resSay = bridge.say(body.text, {
          role: body.role || 'user',
          interrupt: body.interrupt !== false,
          triggerResponse: body.triggerResponse !== false,
          instructions: body.instructions
        });
        sendJson(res, 200, { ok: true, callId, command: 'say', ...resSay });
        return true;
      }

      // POST /v1/calls/:callId/interrupt (ou /barge-in ou /kill-audio)
      if (req.method === 'POST' && (action === 'interrupt' || action === 'barge-in' || action === 'kill-audio')) {
        bridge.interruptAgent();
        sendJson(res, 200, { ok: true, callId, command: 'interrupt' });
        return true;
      }

      // POST /v1/calls/:callId/transfer
      if (req.method === 'POST' && action === 'transfer') {
        const target = body.target || body.to || body.destination;
        if (!target) {
          sendJson(res, 400, { error: 'validation_error', message: 'O campo "target" (destino da transferência) é obrigatório' });
          return true;
        }
        const transferResult = await bridge.transfer(target, {
          mode: body.mode || 'blind',
          dialplan: body.dialplan || 'XML',
          context: body.context || 'default'
        });
        sendJson(res, 200, { ok: true, callId, command: 'transfer', ...transferResult });
        return true;
      }

      // POST /v1/calls/:callId/dtmf
      if (req.method === 'POST' && action === 'dtmf') {
        const digits = String(body.digits || body.dtmf || '').trim();
        if (!digits) {
          sendJson(res, 400, { error: 'validation_error', message: 'O campo "digits" é obrigatório' });
          return true;
        }
        const direction = body.direction || 'outbound'; // 'outbound' (envia RFC2833 na linha) ou 'inbound' (simula usuário para a IA)
        const dtmfRes = await bridge.sendDtmf(digits, direction);
        sendJson(res, 200, { ok: true, callId, command: 'dtmf', ...dtmfRes });
        return true;
      }

      // POST /v1/calls/:callId/play
      if (req.method === 'POST' && action === 'play') {
        if (!body.file) {
          sendJson(res, 400, { error: 'validation_error', message: 'O campo "file" (caminho ou tone_stream://) é obrigatório' });
          return true;
        }
        await bridge.playAudioFile(body.file);
        sendJson(res, 200, { ok: true, callId, command: 'play', file: body.file });
        return true;
      }

      // POST /v1/calls/:callId/mute e /unmute
      if (req.method === 'POST' && (action === 'mute' || action === 'unmute')) {
        const muted = action === 'mute';
        await bridge.setMute(muted);
        sendJson(res, 200, { ok: true, callId, command: action, isMuted: muted });
        return true;
      }

      // POST /v1/calls/:callId/hold e /unhold
      if (req.method === 'POST' && (action === 'hold' || action === 'unhold')) {
        const held = action === 'hold';
        await bridge.setHold(held);
        sendJson(res, 200, { ok: true, callId, command: action, isOnHold: held });
        return true;
      }

      // POST /v1/calls/:callId/recording
      if (req.method === 'POST' && action === 'recording') {
        const recAction = String(body.action || 'start').toLowerCase();
        const recStatus = await bridge.controlRecording(recAction);
        sendJson(res, 200, { ok: true, callId, command: 'recording', ...recStatus });
        return true;
      }

      sendJson(res, 404, { error: 'unknown_call_command', message: `Comando desconhecido para chamada: ${action}` });
      return true;
    }

    // -----------------------------------------------------------------------
    // 4. GRAVAÇÕES ESTÉREO & TRANSCRIÇÕES SALVAS (/v1/recordings)
    // -----------------------------------------------------------------------
    if (req.method === 'GET' && cleanPath === '/v1/recordings') {
      const tenantFilter = parsedUrl.searchParams.get('tenantId');
      const items = [];

      if (fs.existsSync(defaultRecDir)) {
        const files = await fs.promises.readdir(defaultRecDir);
        const wavFiles = files.filter((f) => f.endsWith('.wav')).sort().reverse();

        for (const wavFile of wavFiles) {
          const baseName = wavFile.slice(0, -4);
          if (tenantFilter && !baseName.includes(`_${tenantFilter}_`)) continue;

          const wavPath = path.join(defaultRecDir, wavFile);
          const txtPath = path.join(defaultRecDir, `${baseName}.txt`);
          let stat = null;
          try {
            stat = await fs.promises.stat(wavPath);
          } catch {
            continue;
          }
          const hasTranscript = fs.existsSync(txtPath);

          items.push({
            id: baseName,
            audioFile: wavFile,
            transcriptFile: hasTranscript ? `${baseName}.txt` : null,
            sizeBytes: stat.size,
            createdAt: stat.birthtime || stat.mtime,
            audioUrl: `/v1/recordings/${encodeURIComponent(baseName)}/audio`,
            transcriptUrl: hasTranscript ? `/v1/recordings/${encodeURIComponent(baseName)}/transcript` : null
          });
        }
      }

      sendJson(res, 200, { count: items.length, recordings: items });
      return true;
    }

    const recMatch = cleanPath.match(/^\/v1\/recordings\/([^/]+)(?:\/(audio|transcript))?$/);
    if (recMatch) {
      const rawBase = decodeURIComponent(recMatch[1]);
      // Sanitização anti Path-Traversal
      const safeBase = path.basename(rawBase).replace(/\.(wav|txt)$/i, '');
      const subResource = recMatch[2] || null;
      const wavPath = path.join(defaultRecDir, `${safeBase}.wav`);
      const txtPath = path.join(defaultRecDir, `${safeBase}.txt`);

      if (req.method === 'DELETE' && !subResource) {
        let deletedAny = false;
        if (fs.existsSync(wavPath)) {
          await fs.promises.unlink(wavPath);
          deletedAny = true;
        }
        if (fs.existsSync(txtPath)) {
          await fs.promises.unlink(txtPath);
          deletedAny = true;
        }
        if (!deletedAny) {
          sendJson(res, 404, { error: 'recording_not_found', message: `Gravação não encontrada: ${safeBase}` });
          return true;
        }
        sendJson(res, 200, { ok: true, deleted: safeBase });
        return true;
      }

      if (req.method === 'GET' && subResource === 'audio') {
        if (!fs.existsSync(wavPath)) {
          sendJson(res, 404, { error: 'audio_not_found', message: `Arquivo WAV não encontrado: ${safeBase}.wav` });
          return true;
        }
        const stat = await fs.promises.stat(wavPath);
        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Content-Length': stat.size,
          'Content-Disposition': `inline; filename="${safeBase}.wav"`
        });
        fs.createReadStream(wavPath).pipe(res);
        return true;
      }

      if (req.method === 'GET' && (subResource === 'transcript' || !subResource)) {
        if (!fs.existsSync(txtPath)) {
          sendJson(res, 404, { error: 'transcript_not_found', message: `Transcrição não encontrada: ${safeBase}.txt` });
          return true;
        }
        const content = await fs.promises.readFile(txtPath, 'utf8');
        const format = parsedUrl.searchParams.get('format');
        if (format === 'text' || format === 'txt') {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(content);
          return true;
        }

        const lines = content
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);

        const turns = lines.map((line) => {
          const m = line.match(/^\[([^\]]+)\]\s*(Cliente|Atendente):\s*(.*)$/);
          if (m) {
            return { timestamp: m[1], speaker: m[2], text: m[3], formatted: line };
          }
          return { timestamp: null, speaker: 'Desconhecido', text: line, formatted: line };
        });

        sendJson(res, 200, {
          id: safeBase,
          turnsCount: turns.length,
          turns,
          formatted: content.trim()
        });
        return true;
      }
    }

    // -----------------------------------------------------------------------
    // 5. GESTÃO DE TENANTS (/v1/tenants)
    // -----------------------------------------------------------------------
    if (req.method === 'GET' && cleanPath === '/v1/tenants') {
      sendJson(res, 200, {
        count: tenantManager.tenants.size,
        tenants: tenantManager.listTenants()
      });
      return true;
    }

    if (req.method === 'POST' && cleanPath === '/v1/tenants') {
      try {
        const saved = tenantManager.upsertTenant(body);
        sendJson(res, 201, { ok: true, tenant: saved });
      } catch (err) {
        sendJson(res, 400, { error: 'validation_error', message: err.message });
      }
      return true;
    }

    const tenantMatch = cleanPath.match(/^\/v1\/tenants\/([^/]+)$/);
    if (tenantMatch) {
      const tenantId = decodeURIComponent(tenantMatch[1]);

      if (req.method === 'GET') {
        const t = tenantManager.tenants.get(tenantId);
        if (!t) {
          sendJson(res, 404, { error: 'tenant_not_found', message: `Tenant não encontrado: ${tenantId}` });
          return true;
        }
        sendJson(res, 200, t);
        return true;
      }

      if (req.method === 'PUT') {
        try {
          const saved = tenantManager.upsertTenant({ ...body, id: tenantId });
          sendJson(res, 200, { ok: true, tenant: saved });
        } catch (err) {
          sendJson(res, 400, { error: 'validation_error', message: err.message });
        }
        return true;
      }

      if (req.method === 'DELETE') {
        try {
          const deleted = tenantManager.deleteTenant(tenantId);
          if (!deleted) {
            sendJson(res, 404, { error: 'tenant_not_found', message: `Tenant não encontrado: ${tenantId}` });
            return true;
          }
          sendJson(res, 200, { ok: true, deleted: tenantId });
        } catch (err) {
          sendJson(res, 400, { error: 'validation_error', message: err.message });
        }
        return true;
      }
    }

    sendJson(res, 404, { error: 'not_found', message: `Endpoint não encontrado: ${req.method} ${cleanPath}` });
    return true;
  };
}

module.exports = {
  createApiRouter,
  API_COMMANDS_CATALOG
};

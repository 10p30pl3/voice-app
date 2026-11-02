const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { runAllFeatureDiagnostics, runFeatureDiagnostic } = require('./feature-diagnostic');

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
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
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
      { method: 'GET', path: '/v1/features', description: 'Painel e status detalhado de todas as 14 features de voz ativas no Gateway' },
      { method: 'POST', path: '/v1/features/test', description: 'Executa bateria de testes diagnósticos das 14 features de voz e retorna resultados e latência' },
      { method: 'POST', path: '/v1/features/:id/test', description: 'Executa teste diagnóstico de uma feature específica' },
      { method: 'POST', path: '/v1/features/crosstalk/mode', description: 'Alterna em tempo real o filtro de voz de fundo (atual/dsp, wespeaker, ecapa ou none)' },
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
      { method: 'DELETE', path: '/v1/recordings/:baseName', description: 'Exclui gravação e transcrição do disco (Direito ao Esquecimento LGPD)' },
      { method: 'POST', path: '/v1/recordings/batch-delete', description: 'Exclui múltiplas gravações e transcrições em lote (payload: { ids: ["..."] })' }
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
  const dashboardHtmlPath = path.join(__dirname, '..', 'public', 'dashboard.html');
  let lastDiagnosticsResult = null;

  function getVoiceFeaturesStatus() {
    const tenant = tenantManager ? tenantManager.getDefaultTenant() : {};
    const sttEnabled = tenant.stt?.enabled ?? (process.env.STT_DEFAULT_ENABLED === 'true');
    const amdEnabled = tenant.amd?.enabled ?? (process.env.AMD_DEFAULT_ENABLED === 'true');
    const amdMode = tenant.amd?.mode || process.env.AMD_DEFAULT_MODE || 'active';
    const bargeinLevel = tenant.bargeinLevel ?? parseInt(process.env.BARGEIN_LEVEL || '3', 10);
    const bargeinGraceSec = Number(tenant.bargeinGraceSec ?? process.env.BARGEIN_GRACE_SEC ?? 8);
    const codec = tenant.audioCodec || process.env.AUDIO_CODEC_MODE || 'g711_ulaw';
    const maxSec = tenant.maxDurationSec || parseInt(process.env.MAX_CALL_DURATION_SEC || '180', 10);
    const dtmfEnabled = tenant.dtmf?.enabled ?? (process.env.DTMF_DEFAULT_ENABLED !== 'false');
    const dtmfDebounce = tenant.dtmf?.debounceMs || parseInt(process.env.DTMF_DEBOUNCE_MS || '1200', 10);
    const crosstalkMode = String(
      (tenant.crosstalkFilter && tenant.crosstalkFilter.mode) ||
      tenant.crosstalkMode ||
      process.env.CROSSTALK_FILTER_MODE ||
      'atual'
    ).toLowerCase();
    const crosstalkRatio = Number(
      (tenant.crosstalkFilter && tenant.crosstalkFilter.ratio) ||
      tenant.crosstalkRatio ||
      process.env.CROSSTALK_RATIO ||
      0.45
    );

    return [
      {
        id: 'aec',
        name: 'Cancelamento de Eco (AEC Dinâmico)',
        icon: '🛡️',
        category: 'DSP & Acústica',
        active: true,
        badge: 'ATIVO (SONAR)',
        mode: 'Sonda 425Hz na Conexão',
        detail: 'Sonda acústica calibrada em 425Hz nos primeiros 700ms. Identifica fone de ouvido vs viva-voz e chaveia o AEC dinâmico no FreeSWITCH sob demanda (economia de ~30% de CPU).',
        parameters: {
          sondaFrequencia: '425Hz',
          duracaoSonda: '700ms',
          dispositivoPadrao: 'Viva-voz (AEC On) / Fone (AEC Off)',
          economiaCpu: '~30% em Fone'
        }
      },
      {
        id: 'noise',
        name: 'Medição de Ruído & VAD Dinâmico',
        icon: '📊',
        category: 'DSP & Acústica',
        active: true,
        badge: 'ATIVO (4 PERFIS)',
        mode: 'EnergyManager RMS em Tempo Real',
        detail: 'Calcula energia RMS contínua e classifica em 4 perfis acústicos (SILENCE, OFFICE, STREET, TV). Readequa dinamicamente VAD (0.38 a 0.95), prefix padding e silêncio.',
        parameters: {
          perfisDisponiveis: 'SILENCE, OFFICE, STREET, TV',
          faixaVad: '0.38 - 0.95',
          janelaPcm: '20ms (160 samples)',
          ajusteSilencio: '350ms - 1500ms'
        }
      },
      {
        id: 'bargein',
        name: 'Barge-In Ultrarrápido & Buffer Purge',
        icon: '⚡',
        category: 'Interação em Tempo Real',
        active: bargeinLevel > 0,
        badge: `NÍVEL ${bargeinLevel} (ATIVO)`,
        mode: 'Corte Imediato & Limpeza de Playout',
        detail: 'Corta instantaneamente a voz da IA ao detectar fala do cliente. Envia response.cancel para a OpenAI e executa mod_audio_fork stop_play e uuid_break para silêncio imediato (<15ms).',
        parameters: {
          tempoReacao: '<15ms',
          nivelBargein: bargeinLevel,
          purgaPlayout: 'Total (mod_audio_fork)',
          cancelamentoOpenAi: 'Imediato'
        }
      },
      {
        id: 'bargein_grace',
        name: 'Período de Graça de Barge-In (Ignorar Pedido na Saudação)',
        icon: '⏳',
        category: 'Interação em Tempo Real',
        active: bargeinGraceSec > 0,
        badge: bargeinGraceSec > 0 ? `${bargeinGraceSec} SEGUNDOS` : 'DESATIVADO',
        mode: `Ignora Pedidos nos Primeiros ${bargeinGraceSec}s`,
        detail: 'Durante os primeiros N segundos (saudação inicial da IA), qualquer pedido ou fala do cliente é completamente ignorado e não é processado pela IA, descartando ruídos de linha, saudações precoces e evitando respostas indevidas.',
        parameters: {
          periodoGraça: `${bargeinGraceSec}s`,
          protecaoSaudacao: 'Ativa (pedidos do cliente ignorados e buffer limpo)',
          liberacaoAutomatica: `Aos ${bargeinGraceSec}s de chamada`,
          configuravel: 'Tenant, Header SIP (X-Bargein-Grace-Sec) ou Env'
        }
      },
      {
        id: 'crosstalk_filter',
        name: 'Filtro de Vozes de Fundo (DSP Atual / YIN F0)',
        icon: '🛡️',
        category: 'DSP & Acústica',
        active: ['atual', 'dsp'].includes(crosstalkMode),
        badge: ['atual', 'dsp'].includes(crosstalkMode) ? `ATIVO (GATE ${Math.round(crosstalkRatio * 100)}%)` : 'DESATIVADO',
        mode: 'Calibração Adaptativa + Gate YIN F0',
        detail: 'Mede continuamente o volume real e a frequência fundamental (F0) do interlocutor principal. Descarta vozes secundárias e conversas de fundo através de gate espectral e proximidade.',
        parameters: {
          sensibilidadeFundo: `${Math.round(crosstalkRatio * 100)}% do volume do usuário`,
          algoritmo: 'YIN CMNDF (80Hz - 350Hz) + RMS Adaptativo',
          hangover: '300ms',
          camadaProtecao: 'Gate Local + VAD OpenAI Calibrado'
        }
      },
      {
        id: 'wespeaker',
        name: 'Biometria Vocal WeSpeaker (CAM++ ONNX)',
        icon: '🧬',
        category: 'IA & Biometria Vocal',
        active: crosstalkMode === 'wespeaker',
        badge: crosstalkMode === 'wespeaker' ? 'ATIVO (CAM++)' : 'DISPONÍVEL',
        mode: 'Embeddings 512-dim + Similaridade Cosseno',
        detail: 'Deep learning speaker verification baseado em CAM++ (WeSpeaker). Extrai embeddings vocais de 512 dimensões nos primeiros 1.5s do usuário principal e bloqueia vozes secundárias com threshold configurável.',
        parameters: {
          modelo: 'CAM++ (campplus.onnx)',
          threshold: '0.65',
          latenciaInferencia: '~9ms CPU',
          autoEnrollment: '1.5s de fala inicial'
        }
      },
      {
        id: 'ecapa',
        name: 'Biometria Vocal ECAPA-TDNN (SpeechBrain ONNX)',
        icon: '🧠',
        category: 'IA & Biometria Vocal',
        active: crosstalkMode === 'ecapa',
        badge: crosstalkMode === 'ecapa' ? 'ATIVO (ECAPA-TDNN)' : 'DISPONÍVEL',
        mode: 'Embeddings 512-dim ECAPA-TDNN',
        detail: 'Arquitetura neural ECAPA-TDNN com squeeze-and-excitation e multi-layer feature aggregation para identificação e isolamento contínuo da voz do cliente.',
        parameters: {
          modelo: 'ECAPA-TDNN 512 (ecapa512.onnx)',
          threshold: '0.60',
          latenciaInferencia: '~8ms CPU',
          autoEnrollment: '1.5s de fala inicial'
        }
      },
      {
        id: 'codec',
        name: 'Codec Nativo G.711 μ-law (PCMU)',
        icon: '🎵',
        category: 'Mídia & Codecs',
        active: codec === 'g711_ulaw',
        badge: codec.toUpperCase(),
        mode: 'Nativo 8kHz / Fallback 24kHz FIR',
        detail: 'Áudio digital negociado em G.711 μ-law nativo com OpenAI Realtime, eliminando transcodificação. Fallback automático para Linear PCM 24kHz com filtro FIR anti-aliasing de 7 taps.',
        parameters: {
          taxaAmostragem: '8.000 Hz',
          bitsPorSample: '8-bit μ-law (PCMU)',
          fallback: 'Linear PCM 24kHz (FIR 7 taps)',
          latencia: 'Ultra Baixa'
        }
      },
      {
        id: 'recording',
        name: 'Gravação Estéreo Dual-Stream (Compliance)',
        icon: '🎙️',
        category: 'Compliance & Auditoria',
        active: sttEnabled,
        badge: sttEnabled ? 'ESTÉREO 8kHz' : 'SOB DEMANDA',
        mode: 'Canal L: Cliente | Canal R: Atendente',
        detail: 'Isolamento estéreo completo das pernas de áudio em formato WAV 8kHz (Canal 1: Cliente / Canal 2: Atendente IA). Ativação sob demanda ou atrelada ao STT, com controle de pausa/retomada PCI/LGPD.',
        parameters: {
          formato: 'WAV Linear PCM 8kHz',
          canais: '2 (L: Cliente, R: IA)',
          vinculadoStt: true,
          controlesInCall: 'Start, Pause, Resume, Stop'
        }
      },
      {
        id: 'stt',
        name: 'Transcrição em Tempo Real & Redação LGPD',
        icon: '📝',
        category: 'IA & Reconhecimento',
        active: sttEnabled,
        badge: sttEnabled ? 'WHISPER LOCAL' : 'INATIVO',
        mode: 'Docker Whisper (:8082) + Regex PII',
        detail: 'Transcrição dialogada com timestamp e divisão [Cliente / Atendente]. Redator PII regex integrado que mascara automaticamente CPFs, cartões de crédito e dados sensíveis em conformidade com a LGPD.',
        parameters: {
          engine: 'faster-whisper (Docker :8082)',
          redacaoPii: 'Ativa (CPF, Cartão, Telefone)',
          formato: '[Data Hora] Cliente / Atendente',
          failOpen: 'Fallback para Humano'
        }
      },
      {
        id: 'safety',
        name: 'Mecanismo de Segurança (Hard Cap)',
        icon: '⏱️',
        category: 'Proteção & Custos',
        active: maxSec > 0,
        badge: `${Math.round(maxSec / 60)} MINUTOS`,
        mode: `Aviso aos ${maxSec - 10}s + Corte aos ${maxSec}s`,
        detail: 'Proteção incondicional contra sessões abertas e cobrança indevida na OpenAI. Emite aviso sonoro/verbal claro ao interlocutor 10s antes do encerramento forçado da chamada.',
        parameters: {
          limiteMaximo: `${maxSec}s (${Math.round(maxSec / 60)} min)`,
          avisoPrevio: `${maxSec - 10}s`,
          toleranciaFala: '1.5s após conclusão',
          acaoForcada: 'Desligamento imediato e liberação de canais'
        }
      },
      {
        id: 'amd',
        name: 'Detecção de Caixa Postal (AMD Inteligente)',
        icon: '🤖',
        category: 'Telefonia Inteligente',
        active: amdEnabled,
        badge: amdEnabled ? `AMD [${amdMode.toUpperCase()}]` : 'DISPONÍVEL (OUTBOUND)',
        mode: amdEnabled ? `Modo ${amdMode}` : 'Habilitável via SIP Header',
        detail: 'Classificador de 6 cenários (Humano, Caixa Postal, Operadora, Silêncio, Ruído, Interrupção). No modo ativo, derruba chamadas não-humanas em menos de 2s com zero consumo de tokens OpenAI.',
        parameters: {
          cenarios: 'Humano, Caixa Postal, Operadora, Silêncio',
          modoPadrao: amdMode,
          ativacaoOutbound: 'Header X-AMD-Enabled: true'
        }
      },
      {
        id: 'dtmf',
        name: 'Captura & Injeção DTMF (RFC2833)',
        icon: '🔢',
        category: 'Telefonia & Sinalização',
        active: dtmfEnabled,
        badge: 'RFC2833 COM DEBOUNCE',
        mode: `Buffer In-Call (${dtmfDebounce}ms)`,
        detail: 'Captura tons DTMF do telefone do cliente com debounce agregador e tecla de terminação "#". Permite interrupção (barge-in) e injeção de dígitos via API para sistemas legados.',
        parameters: {
          debounce: `${dtmfDebounce}ms`,
          terminador: '#',
          bargeInDtmf: 'Ativo',
          direcoes: 'Inbound & Outbound'
        }
      },
      {
        id: 'cpaas',
        name: 'Controles In-Call CPaaS (/v1)',
        icon: '🎛️',
        category: 'Controle de Chamadas',
        active: true,
        badge: 'REST API ATIVA',
        mode: 'Say, Interrupt, Transfer, Hold, Mute, Rec',
        detail: 'APIs REST completas de mercado para controle e supervisão de chamadas em tempo real: injeção de voz (say/whisper), corte de fala, transferência cega/assistida, espera e gravação.',
        parameters: {
          padrao: 'REST JSON (/v1/calls/:callId/...)',
          comandos: 'say, interrupt, transfer, dtmf, play, mute, hold, recording, hangup',
          documentacao: 'Catálogo Interativo (/v1/commands)'
        }
      }
    ];
  }

  return async function handleApiRequest(req, res) {
    if (req.method === 'OPTIONS') {
      sendJson(res, 200, { ok: true });
      return true;
    }

    const parsedUrl = new URL(req.url, 'http://localhost');
    const pathname = parsedUrl.pathname.replace(/\/+$/, '') || '/';

    // Rota do Front-End de Acompanhamento em Tempo Real (Dashboard)
    if ((req.method === 'GET' || req.method === 'HEAD') && (pathname === '/' || pathname === '/dashboard' || pathname === '/ui')) {
      try {
        if (fs.existsSync(dashboardHtmlPath)) {
          const html = await fs.promises.readFile(dashboardHtmlPath, 'utf8');
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': Buffer.byteLength(html),
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
          });
          if (req.method === 'HEAD') {
            res.end();
          } else {
            res.end(html);
          }
          return true;
        }
      } catch (err) {
        console.error('[Dashboard] Erro ao carregar dashboard.html:', err.message);
      }
    }

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
      const features = getVoiceFeaturesStatus();
      sendJson(res, 200, {
        ...health,
        whisperCluster: whisperPool ? whisperPool.getStats() : null,
        activeCallsCount: activeBridges.size,
        voiceFeaturesCount: features.length,
        voiceFeaturesActiveCount: features.filter((f) => f.active).length,
        voiceFeatures: features
      });
      return true;
    }

    // Bateria de Diagnóstico em Tempo Real de Todas as Features (/v1/features/test)
    if ((req.method === 'GET' || req.method === 'POST') && (cleanPath === '/v1/features/test' || cleanPath === '/v1/features/diagnostics')) {
      const diag = await runAllFeatureDiagnostics({
        tenantManager,
        fsPool,
        whisperPool,
        activeBridges,
        recordingsDir: defaultRecDir
      });
      lastDiagnosticsResult = diag;
      const features = getVoiceFeaturesStatus();
      const resultMap = new Map(diag.results.map((r) => [r.id, r]));
      const enrichedFeatures = features.map((f) => ({
        ...f,
        test: resultMap.get(f.id) || null
      }));

      sendJson(res, 200, {
        ok: diag.ok,
        total: diag.total,
        passed: diag.passed,
        failed: diag.failed,
        totalDurationMs: diag.totalDurationMs,
        testedAt: diag.testedAt,
        features: enrichedFeatures,
        results: diag.results
      });
      return true;
    }

    // Diagnóstico de uma feature específica (/v1/features/:id/test)
    const singleFeatureTestMatch = cleanPath.match(/^\/v1\/features\/([a-zA-Z0-9_-]+)\/test$/);
    if ((req.method === 'GET' || req.method === 'POST') && singleFeatureTestMatch) {
      const featureId = singleFeatureTestMatch[1];
      const result = await runFeatureDiagnostic(featureId, {
        tenantManager,
        fsPool,
        whisperPool,
        activeBridges,
        recordingsDir: defaultRecDir
      });
      sendJson(res, result.passed ? 200 : 500, {
        ok: result.passed,
        featureId,
        test: result
      });
      return true;
    }

    // Alternar o Modo do Filtro de Voz de Fundo / Biometria em Tempo Real (/v1/features/crosstalk/mode)
    if ((req.method === 'POST' || req.method === 'PUT') && (cleanPath === '/v1/features/crosstalk/mode' || cleanPath === '/v1/features/crosstalk-mode')) {
      const mode = String(body.mode || '').toLowerCase().trim();
      const validModes = ['atual', 'dsp', 'wespeaker', 'ecapa', 'none'];
      if (!validModes.includes(mode)) {
        sendJson(res, 400, {
          error: 'validation_error',
          message: `Modo inválido '${mode}'. Modos aceitos: ${validModes.join(', ')}`
        });
        return true;
      }

      const tenantId = body.tenantId || 'default';
      const targetTenant = tenantManager.tenants.get(tenantId) || tenantManager.getDefaultTenant();
      const updatedTenant = tenantManager.upsertTenant({
        ...targetTenant,
        id: tenantId,
        crosstalkFilter: {
          ...(targetTenant.crosstalkFilter || {}),
          mode,
          ...(body.ratio !== undefined ? { ratio: Number(body.ratio) } : {}),
          ...(body.threshold !== undefined ? { threshold: Number(body.threshold) } : {})
        }
      });

      if (tenantId === 'default') {
        process.env.CROSSTALK_FILTER_MODE = mode;
      }

      sendJson(res, 200, {
        ok: true,
        tenantId,
        mode,
        crosstalkFilter: updatedTenant.crosstalkFilter,
        message: `Filtro de voz de fundo alterado para '${mode}' (${tenantId}) com sucesso!`
      });
      return true;
    }

    if (req.method === 'GET' && (cleanPath === '/v1/features/crosstalk/mode' || cleanPath === '/v1/features/crosstalk-mode')) {
      const tenantId = parsedUrl.searchParams.get('tenantId') || 'default';
      const targetTenant = tenantManager.tenants.get(tenantId) || tenantManager.getDefaultTenant();
      const mode = (targetTenant.crosstalkFilter && targetTenant.crosstalkFilter.mode) || process.env.CROSSTALK_FILTER_MODE || 'atual';
      sendJson(res, 200, {
        ok: true,
        tenantId,
        mode,
        crosstalkFilter: targetTenant.crosstalkFilter || { mode }
      });
      return true;
    }

    if (req.method === 'GET' && cleanPath === '/v1/features') {
      const shouldRunTest = parsedUrl.searchParams.get('test') === 'true';
      if (shouldRunTest) {
        const diag = await runAllFeatureDiagnostics({
          tenantManager,
          fsPool,
          whisperPool,
          activeBridges,
          recordingsDir: defaultRecDir
        });
        lastDiagnosticsResult = diag;
      }

      const features = getVoiceFeaturesStatus();
      const resultMap = lastDiagnosticsResult ? new Map(lastDiagnosticsResult.results.map((r) => [r.id, r])) : null;
      const enrichedFeatures = features.map((f) => ({
        ...f,
        test: resultMap ? (resultMap.get(f.id) || null) : null
      }));

      sendJson(res, 200, {
        ok: true,
        count: enrichedFeatures.length,
        activeCount: enrichedFeatures.filter((f) => f.active).length,
        testedAt: lastDiagnosticsResult?.testedAt || null,
        totalDurationMs: lastDiagnosticsResult?.totalDurationMs || null,
        features: enrichedFeatures
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
        if ((req.method === 'DELETE' && !action) || (req.method === 'POST' && action === 'hangup')) {
          activeBridges.delete(callId);
          sendJson(res, 200, { ok: true, callId, command: 'hangup', reason: 'already_terminated' });
          return true;
        }
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
        activeBridges.delete(callId);
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

    // 4.1 Exclusão em Lote de Gravações (/v1/recordings/batch-delete ou DELETE /v1/recordings)
    if (
      (req.method === 'POST' && (cleanPath === '/v1/recordings/batch-delete' || cleanPath === '/v1/recordings/delete')) ||
      (req.method === 'DELETE' && cleanPath === '/v1/recordings')
    ) {
      const rawIds = Array.isArray(body.ids)
        ? body.ids
        : Array.isArray(body.recordings)
        ? body.recordings
        : [];
      if (rawIds.length === 0) {
        sendJson(res, 400, {
          error: 'invalid_payload',
          message: 'Nenhuma gravação informada para exclusão (esperado array "ids")'
        });
        return true;
      }

      const deleted = [];
      const notFound = [];
      const errors = [];

      for (const item of rawIds) {
        try {
          const safeBase = path.basename(String(item)).replace(/\.(wav|txt)$/i, '');
          const wavPath = path.join(defaultRecDir, `${safeBase}.wav`);
          const txtPath = path.join(defaultRecDir, `${safeBase}.txt`);
          let deletedAny = false;

          if (fs.existsSync(wavPath)) {
            await fs.promises.unlink(wavPath);
            deletedAny = true;
          }
          if (fs.existsSync(txtPath)) {
            await fs.promises.unlink(txtPath);
            deletedAny = true;
          }

          if (deletedAny) {
            deleted.push(safeBase);
          } else {
            notFound.push(safeBase);
          }
        } catch (err) {
          errors.push({ id: item, error: err.message });
        }
      }

      sendJson(res, 200, {
        ok: true,
        deletedCount: deleted.length,
        deleted,
        notFoundCount: notFound.length,
        notFound,
        errorCount: errors.length,
        errors
      });
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

const fs = require('fs');
const path = require('path');

class TenantManager {
  constructor(configPath = null) {
    this.configPath = configPath || path.join(__dirname, '..', 'config', 'tenants.json');
    this.tenants = new Map();
    this.activeCallsPerTenant = new Map(); // tenantId -> count
    this.cpsWindows = new Map(); // tenantId -> { second: number, count: number }
    this.load();
    this.setupHotReload();
  }

  getDefaultTenant() {
    return {
      id: 'default',
      name: 'Default Tenant',
      dids: ['*'],
      active: true,
      openaiApiKey: process.env.OPENAI_API_KEY,
      openaiModel: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-mini',
      openaiPromptId:
        process.env.OPENAI_PROMPT_ID || 'pmpt_68b1a68ef0e8819784ef7056a79c675d088bcfde975cd0dd',
      instructions:
        process.env.OPENAI_AGENT_INSTRUCTIONS ||
        'Você é um assistente de voz prestativo, ágil e conciso. Fale em português brasileiro de forma amigável.',
      voice: process.env.OPENAI_VOICE || 'alloy',
      audioCodec: process.env.AUDIO_CODEC_MODE || 'g711_ulaw', // 'g711_ulaw' (telefonia cristalina nativa) ou 'pcm24k'
      maxDurationSec: parseInt(process.env.MAX_CALL_DURATION_SEC || '180', 10),
      maxConcurrentCalls: parseInt(process.env.MAX_CONCURRENT_CALLS_PER_TENANT || '200', 10),
      maxCallsPerSecond: parseInt(process.env.MAX_CPS_PER_TENANT || '30', 10),
      bargeinLevel: parseInt(process.env.BARGEIN_LEVEL || '3', 10),
      bargeinGraceSec: parseInt(process.env.BARGEIN_GRACE_SEC || '8', 10),
      crosstalkFilter: {
        mode: process.env.CROSSTALK_FILTER_MODE || 'atual', // 'atual', 'wespeaker', 'ecapa', 'none'
        ratio: parseFloat(process.env.CROSSTALK_RATIO || '0.45'),
        threshold: parseFloat(process.env.SPEAKER_VERIFIER_THRESHOLD || '0.65')
      },
      amd: {
        enabled: process.env.AMD_DEFAULT_ENABLED === 'true',
        mode: process.env.AMD_DEFAULT_MODE || 'active'
      },
      stt: {
        enabled: process.env.STT_DEFAULT_ENABLED === 'true'
      },
      dtmf: {
        enabled: process.env.DTMF_DEFAULT_ENABLED !== 'false',
        debounceMs: parseInt(process.env.DTMF_DEBOUNCE_MS || '1200', 10)
      },
      recordingDir: process.env.RECORDING_DIR || null
    };
  }

  load() {
    this.tenants.clear();
    const defaultTenant = this.getDefaultTenant();
    this.tenants.set('default', defaultTenant);

    if (fs.existsSync(this.configPath)) {
      try {
        const raw = fs.readFileSync(this.configPath, 'utf8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          for (const item of list) {
            if (item && item.id) {
              this.tenants.set(item.id, {
                ...defaultTenant,
                ...item,
                crosstalkFilter: {
                  ...defaultTenant.crosstalkFilter,
                  ...(item.crosstalkFilter || {})
                },
                amd: {
                  ...defaultTenant.amd,
                  ...(item.amd || {})
                },
                stt: {
                  ...defaultTenant.stt,
                  ...(item.stt || {})
                },
                dtmf: {
                  ...defaultTenant.dtmf,
                  ...(item.dtmf || {})
                },
                active: item.active !== false
              });
            }
          }
          console.log(`[TenantManager] Carregados ${list.length} clientes/tenants de ${this.configPath}`);
        }
      } catch (err) {
        console.error(`[TenantManager] Erro ao ler ${this.configPath}:`, err.message);
      }
    } else {
      console.log(`[TenantManager] Operando com tenant padrão (.env)`);
    }
  }

  setupHotReload() {
    try {
      fs.watchFile(this.configPath, { persistent: false, interval: 5000 }, (curr, prev) => {
        if (curr.mtimeMs !== prev.mtimeMs) {
          console.log(`[TenantManager] 🔄 Alteração detectada em ${this.configPath}. Recarregando...`);
          this.load();
        }
      });
    } catch {}
  }

  resolveTenant(req) {
    const defaultTenant = this.tenants.get('default') || this.getDefaultTenant();
    if (!req) return defaultTenant;

    const headerTenantId = req.get('X-Tenant-ID') || req.get('x-tenant-id');
    if (headerTenantId) {
      if (this.tenants.has(headerTenantId)) {
        return this.tenants.get(headerTenantId);
      }
      console.warn(`[TenantManager] X-Tenant-ID desconhecido: ${headerTenantId}`);
      return null;
    }

    const calledNumber = req.calledNumber || this.extractCalledNumber(req);
    if (calledNumber) {
      for (const tenant of this.tenants.values()) {
        if (!tenant.active || tenant.id === 'default') continue;
        if (Array.isArray(tenant.dids)) {
          for (const did of tenant.dids) {
            if (did === calledNumber || (typeof did === 'string' && calledNumber.endsWith(did))) {
              return tenant;
            }
          }
        }
      }
    }

    return defaultTenant;
  }

  /**
   * Verifica limites de canais simultâneos (maxConcurrentCalls) e CPS (maxCallsPerSecond) do Tenant
   * @returns {{ allowed: boolean, reason?: string, sipStatus?: number }}
   */
  tryAcquireSlot(tenant) {
    const tenantId = tenant.id || 'default';
    const currentCalls = this.activeCallsPerTenant.get(tenantId) || 0;
    const maxCalls = tenant.maxConcurrentCalls || 200;

    if (currentCalls >= maxCalls) {
      return {
        allowed: false,
        reason: `Limite de chamadas simultâneas atingido (${currentCalls}/${maxCalls})`,
        sipStatus: 486 // Busy Here
      };
    }

    // Controle de CPS (Calls Per Second)
    const nowSec = Math.floor(Date.now() / 1000);
    const maxCps = tenant.maxCallsPerSecond || 30;
    let cpsState = this.cpsWindows.get(tenantId);
    if (!cpsState || cpsState.second !== nowSec) {
      cpsState = { second: nowSec, count: 0 };
      this.cpsWindows.set(tenantId, cpsState);
    }

    if (cpsState.count >= maxCps) {
      return {
        allowed: false,
        reason: `Limite de CPS excedido (${cpsState.count}/${maxCps} chamadas/s)`,
        sipStatus: 503 // Service Unavailable
      };
    }

    cpsState.count += 1;
    this.activeCallsPerTenant.set(tenantId, currentCalls + 1);
    return { allowed: true };
  }

  releaseSlot(tenant) {
    const tenantId = tenant?.id || 'default';
    const current = this.activeCallsPerTenant.get(tenantId) || 0;
    if (current <= 1) {
      this.activeCallsPerTenant.delete(tenantId);
    } else {
      this.activeCallsPerTenant.set(tenantId, current - 1);
    }
  }

  getTenantStats() {
    const stats = {};
    for (const [id, count] of this.activeCallsPerTenant.entries()) {
      stats[id] = count;
    }
    return stats;
  }

  listTenants() {
    const result = [];
    for (const [id, t] of this.tenants.entries()) {
      const maskedKey = t.openaiApiKey
        ? `${t.openaiApiKey.slice(0, 7)}...${t.openaiApiKey.slice(-4)}`
        : null;
      result.push({
        ...t,
        openaiApiKey: maskedKey,
        activeCalls: this.activeCallsPerTenant.get(id) || 0
      });
    }
    return result;
  }

  upsertTenant(data) {
    if (!data || !data.id) {
      throw new Error('O campo "id" do tenant é obrigatório');
    }
    const defaultTenant = this.getDefaultTenant();
    const existing = this.tenants.get(data.id) || defaultTenant;
    const merged = {
      ...defaultTenant,
      ...existing,
      ...data,
      crosstalkFilter: {
        ...defaultTenant.crosstalkFilter,
        ...(existing.crosstalkFilter || {}),
        ...(data.crosstalkFilter || {})
      },
      amd: {
        ...defaultTenant.amd,
        ...(existing.amd || {}),
        ...(data.amd || {})
      },
      stt: {
        ...defaultTenant.stt,
        ...(existing.stt || {}),
        ...(data.stt || {})
      },
      dtmf: {
        ...defaultTenant.dtmf,
        ...(existing.dtmf || {}),
        ...(data.dtmf || {})
      },
      active: data.active !== undefined ? Boolean(data.active) : existing.active !== false
    };
    this.tenants.set(data.id, merged);
    this.persistToDisk();
    return merged;
  }

  deleteTenant(id) {
    if (!id || id === 'default') {
      throw new Error('Não é permitido remover o tenant default');
    }
    const deleted = this.tenants.delete(id);
    if (deleted) {
      this.persistToDisk();
    }
    return deleted;
  }

  persistToDisk() {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const list = [];
      for (const [id, t] of this.tenants.entries()) {
        list.push(t);
      }
      fs.writeFileSync(this.configPath, JSON.stringify(list, null, 2), 'utf8');
    } catch (err) {
      console.warn(`[TenantManager] Aviso: não foi possível persistir tenants em disco:`, err.message);
    }
  }

  extractCalledNumber(req) {
    try {
      const toHeader = req.get('To');
      if (toHeader) {
        const match = toHeader.match(/sip:([^@]+)@/);
        if (match) return match[1];
      }
    } catch {}
    return null;
  }
}

module.exports = new TenantManager();

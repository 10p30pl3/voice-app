const fs = require('fs');
const path = require('path');

class TenantManager {
  constructor(configPath = null) {
    this.configPath = configPath || path.join(__dirname, '..', 'config', 'tenants.json');
    this.tenants = new Map();
    this.reloadTimer = null;
    this.load();
  }

  getDefaultTenant() {
    return {
      id: 'default',
      name: 'Default Tenant',
      dids: ['*'],
      active: true,
      openaiApiKey: process.env.OPENAI_API_KEY,
      openaiModel: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-mini',
      openaiPromptId: process.env.OPENAI_PROMPT_ID || null,
      instructions: process.env.OPENAI_AGENT_INSTRUCTIONS || 'Você é um assistente de voz prestativo, ágil e conciso. Fale em português brasileiro de forma amigável.',
      voice: process.env.OPENAI_VOICE || 'alloy',
      maxDurationSec: parseInt(process.env.MAX_CALL_DURATION_SEC || '900', 10),
      bargeinLevel: parseInt(process.env.BARGEIN_LEVEL || '3', 10)
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
      console.log(`[TenantManager] Arquivo tenants.json não encontrado. Operando com tenant padrão (.env)`);
    }
  }

  /**
   * Identifica o cliente correspondente à chamada
   * @param {Object} req - Objeto de requisição SIP (drachtio-srf)
   * @returns {Object} Configuração do Tenant
   */
  resolveTenant(req) {
    const defaultTenant = this.tenants.get('default') || this.getDefaultTenant();
    if (!req) return defaultTenant;

    // 1. Prioridade: Header SIP customizado (ex: X-Tenant-ID)
    const headerTenantId = req.get('X-Tenant-ID') || req.get('x-tenant-id');
    if (headerTenantId && this.tenants.has(headerTenantId)) {
      const t = this.tenants.get(headerTenantId);
      if (t.active) return t;
    }

    // 2. Prioridade: Número discado (DID)
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

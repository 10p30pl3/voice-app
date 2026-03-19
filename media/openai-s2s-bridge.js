class OpenAIS2SBridge {
  constructor() {
    this.endpoint = null;
    this.channelUuid = null;
    this.callId = null;
  }

  async start({ callId, endpoint }) {
    this.callId = callId;
    this.endpoint = endpoint;
    this.channelUuid =
      endpoint.uuid ||
      endpoint.id ||
      endpoint.sessionId ||
      endpoint.channelId;

    if (!this.channelUuid) {
      throw new Error('nao consegui descobrir o uuid do canal para uuid_openai_s2s');
    }

    const payload = {
      type: 'session.create',
      api_key: process.env.OPENAI_API_KEY,
      model: 'gpt-realtime-mini'
    };

    const cmd = `uuid_openai_s2s ${this.channelUuid} session.create '${JSON.stringify(payload)}'`;
    console.log(`[${this.callId}] iniciando openai_s2s: ${cmd}`);

    const response = await this.endpoint.api(cmd);
    console.log(`[${this.callId}] resposta uuid_openai_s2s:`, response?.body || response);
  }

  async stop() {
    if (!this.endpoint || !this.channelUuid) return;

    const payload = { type: 'session.delete' };
    const cmd = `uuid_openai_s2s ${this.channelUuid} session.delete '${JSON.stringify(payload)}'`;

    const response = await this.endpoint.api(cmd);
    console.log(`[${this.callId}] stop uuid_openai_s2s:`, response?.body || response);
  }

  async play() {}
}

module.exports = OpenAIS2SBridge;

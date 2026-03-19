const WebSocket = require('ws');

class OpenAIRealtimeBridge {
  constructor({ apiKey, model = 'gpt-realtime-mini', sessionId }) {
    this.apiKey = apiKey;
    this.model = model;
    this.sessionId = sessionId;
    this.ws = null;
    this.ready = false;
    this.onAudioDelta = null;
    this.onEvent = null;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(
        `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.model)}`,
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'OpenAI-Beta': 'realtime=v1'
          }
        }
      );

      this.ws.on('open', () => {
        console.log(`[${this.sessionId}] websocket OpenAI aberto`);

        this._send({
          type: 'session.update',
          session: {
            modalities: ['audio', 'text'],
            voice: 'alloy',
            input_audio_format: 'g711_ulaw',
            output_audio_format: 'g711_ulaw',
            turn_detection: {
              type: 'server_vad',
              create_response: false,
              interrupt_response: false,
              silence_duration_ms: 800
            },
            instructions:
              'Você é um atendente virtual de suporte. Responda em português do Brasil, de forma objetiva, educada e curta.'
          }
        });
      });

      this.ws.on('message', (raw) => {
        let evt;
        try {
          evt = JSON.parse(raw.toString());
        } catch (err) {
          console.error(`[${this.sessionId}] erro parse realtime:`, err);
          return;
        }

        this.onEvent && this.onEvent(evt);

        if (evt.type === 'session.updated') {
          this.ready = true;
          console.log(`[${this.sessionId}] sessao OpenAI Realtime pronta`);
          resolve();
          return;
        }

        if (evt.type === 'conversation.item.input_audio_transcription.completed') {
          console.log(`[${this.sessionId}] transcript: ${evt.transcript}`);
          return;
        }

        if (evt.type === 'response.created') {
          console.log(`[${this.sessionId}] response.created`);
          return;
        }

        if (evt.type === 'response.output_audio.delta' && evt.delta) {
          console.log(
            `[${this.sessionId}] response.output_audio.delta tamanho=${evt.delta.length}`
          );
          this.onAudioDelta && this.onAudioDelta(evt.delta);
          return;
        }

        if (evt.type === 'response.output_audio.done') {
          console.log(`[${this.sessionId}] response.output_audio.done`);
          return;
        }

        if (evt.type === 'response.done') {
          console.log(`[${this.sessionId}] response.done`);
          return;
        }

        if (evt.type === 'error') {
          console.error(`[${this.sessionId}] erro realtime:`, JSON.stringify(evt));
        }
      });

      this.ws.on('error', (err) => {
        this.ready = false;
        reject(err);
      });

      this.ws.on('close', () => {
        this.ready = false;
        console.log(`[${this.sessionId}] OpenAI Realtime desconectado`);
      });
    });
  }

  appendAudio(base64Audio) {
    if (!this.ws || !this.ready) return;

    this._send({
      type: 'input_audio_buffer.append',
      audio: base64Audio
    });
  }

  commitAudio() {
    if (!this.ws || !this.ready) return;

    this._send({
      type: 'input_audio_buffer.commit'
    });
  }

  createResponse() {
    if (!this.ws || !this.ready) return;

    this._send({
      type: 'response.create',
      response: {
        modalities: ['audio', 'text']
      }
    });
  }

  close() {
    if (this.ws) this.ws.close();
  }

  _send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(obj));
  }
}

module.exports = OpenAIRealtimeBridge;

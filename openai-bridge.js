const WebSocket = require('ws');

class OpenAIRealtimeBridge {
  constructor({ apiKey, model = 'gpt-realtime-mini' }) {
    this.apiKey = apiKey;
    this.model = model;
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
        this._send({
          type: 'session.update',
          session: {
            modalities: ['audio', 'text'],
            voice: 'alloy',
            input_audio_format: 'g711_ulaw',
            output_audio_format: 'g711_ulaw',
            turn_detection: { type: 'server_vad' },
            instructions:
              'Você é um atendente de suporte objetivo, educado e breve. Responda em português do Brasil.'
          }
        });
      });

      this.ws.on('message', (raw) => {
        let evt;
        try {
          evt = JSON.parse(raw.toString());
        } catch (err) {
          console.error('erro parse realtime:', err);
          return;
        }

        this.onEvent && this.onEvent(evt);

        if (evt.type === 'session.updated') {
          this.ready = true;
          resolve();
          return;
        }

        if (evt.type === 'response.output_audio.delta' && evt.delta) {
          this.onAudioDelta && this.onAudioDelta(evt.delta);
          return;
        }

        if (evt.type === 'error') {
          console.error('erro realtime:', evt);
        }
      });

      this.ws.on('error', (err) => {
        this.ready = false;
        reject(err);
      });

      this.ws.on('close', () => {
        this.ready = false;
        console.log('OpenAI Realtime desconectado');
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

  close() {
    if (this.ws) this.ws.close();
  }

  _send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(obj));
  }
}

module.exports = OpenAIRealtimeBridge;

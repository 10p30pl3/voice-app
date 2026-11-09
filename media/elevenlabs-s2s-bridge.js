const WebSocket = require('ws');
const { EventEmitter } = require('events');
const WsMediaBridge = require('./ws-media-bridge');
const { WhisperSession } = require('./whisper-client');
const { CallRecorder } = require('../utils/call-recorder');
const EnergyManager = require('../utils/energy-manager');
const CrosstalkFilter = require('../utils/crosstalk-filter');
const FrameVad = require('../utils/frame-vad');
const aiProviderManager = require('../utils/ai-provider-manager');
const aiCostTracker = require('../utils/ai-cost-tracker');

function upsample8to16(buffer8k) {
  if (!buffer8k || buffer8k.length < 2) return Buffer.alloc(0);
  const samplesCount = buffer8k.length >> 1;
  const buffer16k = Buffer.allocUnsafe(samplesCount * 4);

  for (let i = 0; i < samplesCount; i++) {
    const s0 = buffer8k.readInt16LE(i * 2);
    const s1 = i + 1 < samplesCount ? buffer8k.readInt16LE((i + 1) * 2) : s0;
    const mid = (s0 + s1) >> 1;
    const pos = i * 4;
    buffer16k.writeInt16LE(s0, pos);
    buffer16k.writeInt16LE(mid, pos + 2);
  }
  return buffer16k;
}

function downsample16to8(buffer16k) {
  if (!buffer16k || buffer16k.length < 4) return Buffer.alloc(0);
  const samplesCount = buffer16k.length >> 1;
  const targetSamplesCount = samplesCount >> 1;
  const buffer8k = Buffer.allocUnsafe(targetSamplesCount * 2);

  for (let i = 0; i < targetSamplesCount; i++) {
    const s0 = buffer16k.readInt16LE(i * 4);
    const s1 = buffer16k.readInt16LE(i * 4 + 2);
    const avg = (s0 + s1) >> 1;
    buffer8k.writeInt16LE(avg, i * 2);
  }
  return buffer8k;
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(promise, ms, errorMsg = 'Timeout') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(errorMsg)), ms))
  ]);
}

function getChannelUuid(endpoint) {
  if (!endpoint) return null;
  if (endpoint.uuid) return endpoint.uuid;
  if (endpoint.channelUuid) return endpoint.channelUuid;
  if (endpoint.dialog?.sip?.callId) return endpoint.dialog.sip.callId;
  return null;
}

class ElevenLabsS2SBridge extends EventEmitter {
  constructor(tenant, sipHeaders = {}) {
    super();
    this.tenant = tenant;
    this.sipHeaders = sipHeaders;
    this.whisperSession = null;
    const provider = aiProviderManager.get('elevenlabs');
    const codec = provider?.audioCodec || tenant.audioCodec || process.env.AUDIO_CODEC_MODE || 'g711_ulaw';
    this.useG711 = codec === 'g711_ulaw';
    this.endpoint = null;
    this.dialog = null;
    this.channelUuid = null;
    this.callId = null;
    this.energyManager = new EnergyManager();
    this.mediaBridge = new WsMediaBridge();

    this.baseThreshold = 0.45;
    this.isAgentTalking = false;
    this.calibrationActive = true;
    this.deviceMode = 'viva_voz';
    this.currentProfile = 'SILENCE';
    this.lastSpeakerScore = null;
    this.isSecondaryVoiceBlocked = false;

    this.crosstalkRatio = parseFloat(tenant.crosstalkFilter?.ratio || process.env.CROSSTALK_RATIO || 0.45);
    const headerCrosstalk = sipHeaders['x-crosstalk-mode'] || sipHeaders['X-Crosstalk-Mode'];
    this.crosstalkMode = (headerCrosstalk || tenant.crosstalkFilter?.mode || 'atual').toLowerCase();
    this.isDspFilterActive = this.crosstalkMode === 'atual' || this.crosstalkMode === 'dsp';
    this.isNeuralFilterActive = this.crosstalkMode === 'wespeaker' || this.crosstalkMode === 'ecapa';
    this.crosstalkFilter = this.isDspFilterActive
      ? new CrosstalkFilter({ ratio: this.crosstalkRatio, hangoverMs: 400 })
      : null;

    const frameVadMinRms = Number(tenant.bargeinMinRms || process.env.BARGEIN_MIN_RMS || 800);
    const frameVadAttack = Number(tenant.bargeinAttackFrames || process.env.BARGEIN_ATTACK_FRAMES || 8);
    this.frameVad = this.isDspFilterActive
      ? null
      : new FrameVad({ minRms: frameVadMinRms, attackFrames: frameVadAttack, noiseRatio: 2.8 });

    this.isToneProbe = false;
    this.isSafetyExpiring = false;
    this.isMuted = false;
    this.isOnHold = false;
    this.maxDurationTimer = null;
    this.warningDurationTimer = null;
    this.isTerminated = false;
    this.recorder = null;
    this.transcriptLog = [];
    this.lastTurn = null;

    this.agentAudioFormat = 'pcm_8000';
    this.userInputAudioFormat = 'pcm_8000';
    this.conversationId = null;

    this.elevenSocket = null;
    this.elevenReady = false;
    this.elevenReadyPromise = null;
    this.elevenReadyResolve = null;

    this.cleanupHandler = null;

    this.elevenReadyPromise = new Promise((resolve) => {
      this.elevenReadyResolve = resolve;
    });

    this.handleEslEvent = this.handleEslEvent.bind(this);
    this.handleDtmf = this.handleDtmf.bind(this);
  }

  setCleanupHandler(fn) {
    this.cleanupHandler = fn;
  }

  safeApi(cmd) {
    if (!this.endpoint || typeof this.endpoint.api !== 'function' || this.isTerminated) {
      return Promise.resolve(null);
    }
    return this.endpoint.api(cmd).catch(() => null);
  }

  getCredentials() {
    const rawProv = aiProviderManager.getRaw('elevenlabs') || {};
    const apiKey = (this.tenant.elevenlabsApiKey || rawProv.apiKey || process.env.ELEVENLABS_API_KEY || '').trim();
    const agentId = (this.tenant.elevenlabsAgentId || rawProv.agentId || process.env.ELEVENLABS_AGENT_ID || '').trim();
    const voiceId = (this.tenant.elevenlabsVoiceId || rawProv.defaultVoice || 'Rachel').trim();
    const model = (this.tenant.elevenlabsModel || rawProv.defaultModel || 'eleven_turbo_v2_5').trim();

    return { apiKey, agentId, voiceId, model };
  }

  initElevenLabsConnection() {
    if (this.elevenSocket || this.isTerminated) return;

    const { apiKey, agentId } = this.getCredentials();

    if (!apiKey) {
      console.warn(`[${this.callId}] ⚠️ Chave API da ElevenLabs não configurada. Verifique em Provedor de IA & Custos.`);
      return;
    }

    if (!agentId) {
      console.warn(`[${this.callId}] ⚠️ ElevenLabs Agent ID não informado para o tenant "${this.tenant.id}".`);
      return;
    }

    // ElevenLabs Conversational AI WebSocket
    const wsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(agentId)}`;

    console.log(`[${this.callId}] 🔌 Conectando ao ElevenLabs STS (Agent: ${agentId})...`);

    try {
      this.elevenSocket = new WebSocket(wsUrl, {
        headers: {
          'xi-api-key': apiKey
        }
      });

      this.elevenSocket.on('open', () => {
        console.log(`[${this.callId}] 🟢 Conectado ao ElevenLabs Conversational AI com sucesso!`);
        this.elevenReady = true;

        // Inicia a conversação enviando conversation_initiation_client_data para acionar a primeira fala do agente
        try {
          const initPayload = { type: 'conversation_initiation_client_data' };
          this.elevenSocket.send(JSON.stringify(initPayload));
          console.log(`[${this.callId}] 📤 Enviado conversation_initiation_client_data para acionar saudação inicial.`);
        } catch (err) {
          console.warn(`[${this.callId}] Erro ao enviar conversation_initiation_client_data:`, err.message);
        }

        if (this.elevenReadyResolve) {
          this.elevenReadyResolve();
          this.elevenReadyResolve = null;
        }
      });

      this.elevenSocket.on('message', (raw) => {
        this.handleElevenMessage(raw);
      });

      this.elevenSocket.on('error', (err) => {
        console.error(`[${this.callId}] 🔴 Erro no WebSocket da ElevenLabs:`, err.message);
      });

      this.elevenSocket.on('close', (code, reason) => {
        console.log(`[${this.callId}] 🔴 WebSocket ElevenLabs fechado. Código: ${code}, Razão: ${reason || 'N/A'}`);
        this.elevenReady = false;
      });
    } catch (err) {
      console.error(`[${this.callId}] Falha ao iniciar WebSocket ElevenLabs:`, err.message);
    }
  }

  handleElevenMessage(data) {
    try {
      const msg = JSON.parse(data.toString());

      // 0. Metadados de inicialização da conversa (detecta taxas de amostragem)
      if (msg.type === 'conversation_initiation_metadata' && msg.conversation_initiation_metadata_event) {
        const meta = msg.conversation_initiation_metadata_event;
        this.agentAudioFormat = meta.agent_output_audio_format || 'pcm_8000';
        this.userInputAudioFormat = meta.user_input_audio_format || 'pcm_8000';
        this.conversationId = meta.conversation_id;
        console.log(
          `[${this.callId}] 🟢 Metadados ElevenLabs: ConvID [${this.conversationId}] | Áudio Agente: [${this.agentAudioFormat}] | Entrada: [${this.userInputAudioFormat}]`
        );
      }

      // 1. Áudio do Agente da ElevenLabs para tocar no FreeSWITCH
      if (msg.audio_event && msg.audio_event.audio_base_64) {
        if (!this.isAgentTalking) {
          this.isAgentTalking = true;
          this.mediaBridge.startPlaybackStream();
        }
        if (this.agentSilenceTimer) {
          clearTimeout(this.agentSilenceTimer);
        }
        this.agentSilenceTimer = setTimeout(() => {
          this.isAgentTalking = false;
          if (this.mediaBridge) {
            this.mediaBridge.endPlaybackStream();
          }
        }, 800);

        const rawAudioBuf = Buffer.from(msg.audio_event.audio_base_64, 'base64');
        const pcm8k = (this.agentAudioFormat === 'pcm_8000')
          ? rawAudioBuf
          : downsample16to8(rawAudioBuf);

        // Gravação Stereo (Right=Atendente)
        if (this.recorder && !this.isToneProbe) {
          this.recorder.writeAgentChunk(pcm8k);
        }

        if (this.mediaBridge && !this.isTerminated) {
          this.mediaBridge.pushAudioChunk(pcm8k);
        }
      }

      // 2. Transcrição do Cliente (User Speech)
      if (msg.user_transcription_event && msg.user_transcription_event.user_transcript) {
        const text = msg.user_transcription_event.user_transcript.trim();
        if (text) {
          this.recordTranscriptTurn('Cliente', text);
        }
      }

      // 3. Resposta textual do Agente da ElevenLabs
      if (msg.agent_response_event && msg.agent_response_event.agent_response) {
        const text = msg.agent_response_event.agent_response.trim();
        if (text) {
          this.recordTranscriptTurn('Atendente', text);
        }
      }

      // 4. Interrupção disparada pelo servidor ElevenLabs (Barge-In)
      if (msg.interruption_event) {
        console.log(`[${this.callId}] ⚡ Interrupção recebida da ElevenLabs.`);
        this.interruptAgent();
      }

      // 5. Metadados de conversa ou ping
      if (msg.type === 'ping') {
        if (this.elevenSocket?.readyState === WebSocket.OPEN) {
          this.elevenSocket.send(JSON.stringify({ type: 'pong', event_id: msg.ping_event?.event_id }));
        }
      }
    } catch (err) {
      console.warn(`[${this.callId}] Erro ao processar mensagem ElevenLabs:`, err.message);
    }
  }

  interruptAgent() {
    this.isAgentTalking = false;
    if (this.agentSilenceTimer) {
      clearTimeout(this.agentSilenceTimer);
      this.agentSilenceTimer = null;
    }
    if (this.mediaBridge) {
      this.mediaBridge.killAudio();
    }
    if (this.channelUuid) {
      this.safeApi(`uuid_audio_fork ${this.channelUuid} stop_play`);
      this.safeApi(`uuid_break ${this.channelUuid} all`);
    }
    return true;
  }

  triggerBargeIn(source = 'local_vad') {
    if (!this.isAgentTalking) return false;
    console.log(`[${this.callId}] ⚡ Barge-in detectado (${source})! Interrompendo fala do agente ElevenLabs.`);
    this.interruptAgent();

    if (this.elevenSocket && this.elevenSocket.readyState === WebSocket.OPEN) {
      try {
        this.elevenSocket.send(JSON.stringify({ type: 'user_interruption' }));
      } catch {}
    }
    return true;
  }

  recordTranscriptTurn(speaker, text) {
    const cleanText = String(text || '').trim();
    if (!cleanText) return null;

    const now = Date.now();
    if (
      this.lastTurn &&
      this.lastTurn.speaker === speaker &&
      this.lastTurn.text === cleanText &&
      now - this.lastTurn.time < 3500
    ) {
      return this.lastTurn.entry || null;
    }

    const date = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timestamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

    let turnEntry = {
      timestamp,
      speaker,
      text: cleanText,
      formatted: `[${timestamp}] ${speaker}: ${cleanText}`
    };

    if (this.recorder && !this.recorder.isStopped && !this.recorder.isPaused) {
      const recEntry = this.recorder.addTranscript(speaker, cleanText);
      if (recEntry) {
        turnEntry = recEntry;
      }
    }

    this.transcriptLog.push(turnEntry);
    this.lastTurn = { speaker, text: cleanText, time: now, entry: turnEntry };
    console.log(`[${this.callId}] 📝 ${turnEntry.formatted}`);

    return turnEntry;
  }

  async start({ callId, endpoint, dialog, caller = null, called = null }) {
    this.callId = callId;
    this.endpoint = endpoint;
    this.dialog = dialog;
    this.caller = caller;
    this.called = called;
    this.startedAt = new Date();
    this.channelUuid = getChannelUuid(endpoint);

    if (!this.channelUuid) {
      throw new Error('Não consegui identificar o UUID do canal FreeSWITCH');
    }

    const { model, voiceId } = this.getCredentials();
    console.log(
      `[${this.callId}] 🎙️ [ELEVENLABS STS] Inicializando chamada | Voz: [${voiceId}] | Modelo: [${model}] | Canal: [${this.channelUuid}]`
    );

    this.maxDurationSec = Number(this.tenant.maxDurationSec || process.env.MAX_CALL_DURATION_SEC || 180);

    this.maxDurationTimer = setTimeout(() => {
      console.warn(`[${this.callId}] 🛑 Limite rígido atingido (${this.maxDurationSec}s). Encerrando chamada.`);
      this.terminateCall('safety_limit_3_minutes');
    }, this.maxDurationSec * 1000);

    const sipAmdHeader = this.sipHeaders['x-amd-enabled'] || this.sipHeaders['X-AMD-Enabled'];
    this.isAmdEnabled =
      sipAmdHeader !== undefined
        ? String(sipAmdHeader).toLowerCase() === 'true'
        : Boolean(this.tenant.amd?.enabled);

    const sipSttHeader = this.sipHeaders['x-stt-enabled'] || this.sipHeaders['X-STT-Enabled'];
    this.isSttEnabled =
      sipSttHeader !== undefined
        ? String(sipSttHeader).toLowerCase() === 'true'
        : this.tenant.stt?.enabled !== false;

    // 1. AMD com Whisper Local (somente se habilitado)
    if (this.isAmdEnabled) {
      this.whisperSession = new WhisperSession({
        callId: this.callId,
        channelUuid: this.channelUuid,
        tenant: this.tenant,
        sipHeaders: this.sipHeaders
      });

      const isActiveAmd = this.whisperSession.amdMode === 'active';
      if (!isActiveAmd) {
        this.initElevenLabsConnection();
      }

      this.whisperSession.on('decision', (decision) => {
        if (['caixa_postal', 'operadora', 'silencio'].includes(decision.label)) {
          if (this.whisperSession?.amdMode === 'active' || this.tenant.amd?.mode === 'active') {
            console.log(`[${this.callId}] 🤖 AMD [ACTIVE]: Detectada ${decision.label.toUpperCase()}. Encerrando.`);
            this.terminateCall(`amd_${decision.label}`);
          }
        }
      });

      this.whisperSession.start();
    } else {
      this.initElevenLabsConnection();
    }

    // 2. Gravação Dual-Stream Stereo (.wav)
    if (this.isSttEnabled) {
      this.recorder = new CallRecorder({
        callId: this.callId,
        tenantId: this.tenant.id,
        recordingDir: this.tenant.recordingDir
      });
      this.mediaBridge.setRecorder(this.recorder);
      await this.recorder.start();
    }

    // 2.1 DTMF
    const dtmfHeader = this.sipHeaders['x-dtmf-enabled'];
    const isDtmfEnabled =
      dtmfHeader !== undefined
        ? String(dtmfHeader).toLowerCase() !== 'false'
        : this.tenant.dtmf?.enabled !== false;

    if (isDtmfEnabled && this.endpoint && typeof this.endpoint.on === 'function') {
      this.endpoint.on('dtmf', this.handleDtmf);
    }

    // 3. Limpeza de sessões residuais
    this.safeApi(`uuid_audio_fork ${this.channelUuid} stop`);
    await wait(100);
    if (this.isTerminated || !this.endpoint) return;

    if (this.endpoint.conn) {
      try {
        this.endpoint.conn.subscribe('CUSTOM mod_audio_fork::play_audio');
        this.endpoint.conn.on('esl::event::CUSTOM::*', this.handleEslEvent);
      } catch (err) {
        console.error(`[${this.callId}] Erro ao subscrever ESL:`, err.message);
      }
    }

    this.safeApi(`uuid_setvar ${this.channelUuid} echo_cancellation false`);
    this.safeApi(`uuid_setvar ${this.channelUuid} noise_suppression true`);

    // Inicia MediaBridge
    await this.mediaBridge.start({
      callId: this.callId,
      endpoint: this.endpoint,
      dialog: this.dialog,
      onAudio: (buffer) => {
        if (this.isTerminated || this.isMuted || this.isOnHold) return;

        // Gravação Stereo (Left=Cliente)
        if (this.recorder && !this.isToneProbe) {
          this.recorder.writeUserChunk(buffer);
        }

        // Análise de energia acústica
        if (this.calibrationActive) {
          let isEcoSample = false;
          if (this.isToneProbe || this.isAgentTalking) {
            isEcoSample = true;
            this.calibrationSamplesRecv = (this.calibrationSamplesRecv || 0) + 1;
            if (this.calibrationSamplesRecv > 500) {
              this.calibrationActive = false;
            }
          }
          this.energyManager.calculateEnergy(buffer, isEcoSample);
        }

        // Filtro de crosstalk
        let effectiveBuffer = buffer;
        if (this.isDspFilterActive && this.crosstalkFilter) {
          const isPrimaryVoice = this.crosstalkFilter.process(buffer);
          effectiveBuffer = isPrimaryVoice ? buffer : Buffer.alloc(buffer.length);
        }

        // Barge-in local
        if (this.isAgentTalking && effectiveBuffer && effectiveBuffer.length >= 160) {
          const isActivelySpeaking = this.crosstalkFilter
            ? this.crosstalkFilter.isActivelySpeaking()
            : (this.frameVad ? this.frameVad.process(effectiveBuffer) : false);
          if (isActivelySpeaking) {
            this.triggerBargeIn(this.isDspFilterActive ? 'frame_vad_dsp' : 'local_vad');
          }
        }

        // Whisper local para AMD
        if (this.whisperSession && this.isAmdEnabled && !this.whisperSession.decisionReceived && !this.isToneProbe) {
          this.whisperSession.pushAudio(buffer, 8000);
        }

        // Envio de áudio para a ElevenLabs (adaptativo: 8kHz ou 16kHz conforme metadados)
        if (this.elevenReady && this.elevenSocket && this.elevenSocket.readyState === WebSocket.OPEN && !this.isToneProbe) {
          const outBuffer = (this.userInputAudioFormat === 'pcm_8000')
            ? effectiveBuffer
            : upsample8to16(effectiveBuffer);

          this.elevenSocket.send(
            JSON.stringify({
              user_audio_chunk: outBuffer.toString('base64')
            })
          );
        }
      }
    });

    if (this.isTerminated) return;

    // 4. Aguarda AMD se necessário
    if (this.isAmdEnabled && this.whisperSession) {
      console.log(`[${this.callId}] 🕵️ Aguardando análise AMD...`);
      await this.whisperSession.waitForDecision();
      if (this.isTerminated) return;
    }

    // Connect confirmado: desliga Whisper local
    if (this.whisperSession) {
      console.log(`[${this.callId}] 🔌 Connect confirmado. Desligando Whisper local.`);
      this.whisperSession.stop();
      this.whisperSession = null;
    }

    if (!this.elevenSocket) {
      this.initElevenLabsConnection();
    }

    if (this.elevenReadyPromise) {
      await withTimeout(this.elevenReadyPromise, 4000).catch((e) => {
        console.warn(`[${this.callId}] Alerta conexão ElevenLabs:`, e.message);
      });
    }

    console.log(`[${this.callId}] 🟢 ElevenLabs STS pronto para conversação.`);
  }

  handleEslEvent(evt) {
    if (!evt || !evt.getHeader) return;
    const subclass = evt.getHeader('Event-Subclass');
    const eventUuid = evt.getHeader('Unique-ID');
    if (eventUuid && eventUuid !== this.channelUuid) return;

    if (subclass === 'mod_audio_fork::play_audio') {
      const action = evt.getHeader('action');
      if (action === 'play_stop' || action === 'stop') {
        this.isAgentTalking = false;
      }
    }
  }

  handleDtmf(digit) {
    const rawDigit = typeof digit === 'string' ? digit : digit?.digit || digit?.dtmf;
    if (!rawDigit) return;
    console.log(`[${this.callId}] 🔢 [DTMF] Dígito recebido: "${rawDigit}"`);
    this.recordTranscriptTurn('Cliente', `[Dígito DTMF: ${rawDigit}]`);
    if (this.elevenSocket && this.elevenSocket.readyState === WebSocket.OPEN) {
      try {
        this.elevenSocket.send(
          JSON.stringify({
            type: 'user_message',
            text: `[O usuário discou o dígito DTMF ${rawDigit}]`
          })
        );
      } catch {}
    }
  }

  async say(text, options = {}) {
    if (!text || this.isTerminated) return;
    console.log(`[${this.callId}] 📢 say() em ElevenLabs STS: "${text}"`);
    this.recordTranscriptTurn('Atendente', text);
    if (this.elevenSocket && this.elevenSocket.readyState === WebSocket.OPEN) {
      try {
        this.elevenSocket.send(
          JSON.stringify({
            type: 'user_message',
            text: String(text)
          })
        );
      } catch (err) {
        console.warn(`[${this.callId}] Erro ao enviar user_message ElevenLabs:`, err.message);
      }
    }
  }

  mute(muted = true) {
    this.isMuted = Boolean(muted);
    return { ok: true, isMuted: this.isMuted };
  }

  hold(onHold = true) {
    this.isOnHold = Boolean(onHold);
    if (this.isOnHold) {
      this.interruptAgent();
    }
    return { ok: true, isOnHold: this.isOnHold };
  }

  async transfer(target, options = {}) {
    if (!target) throw new Error('Destino obrigatório');
    const cleanTarget = String(target).trim();
    const dialplan = options.dialplan || 'XML';
    const context = options.context || 'default';

    await this.safeApi(`uuid_transfer ${this.channelUuid} ${cleanTarget} ${dialplan} ${context}`);
    this.terminateCall('transferred');
    return { ok: true, target: cleanTarget };
  }

  sendDtmf(digits) {
    const clean = String(digits || '').replace(/[^0-9*#ABCD]/gi, '');
    if (!clean) return { ok: false, error: 'no_digits' };
    this.safeApi(`uuid_send_dtmf ${this.channelUuid} ${clean}`);
    return { ok: true, digits: clean };
  }

  getCallInfo(includeTranscript = false) {
    const durationSec = this.startedAt ? Math.floor((Date.now() - this.startedAt.getTime()) / 1000) : 0;
    const lastTurnEntry = this.transcriptLog.length > 0 ? this.transcriptLog[this.transcriptLog.length - 1] : null;

    const info = {
      callId: this.callId,
      channelUuid: this.channelUuid,
      tenantId: this.tenant.id,
      direction: 'inbound',
      caller: this.caller || 'Desc',
      called: this.called || '9000',
      durationSec,
      stsEngine: 'elevenlabs',
      codec: 'g711_ulaw',
      deviceMode: this.deviceMode,
      noiseProfile: this.currentProfile,
      isAgentTalking: this.isAgentTalking,
      isMuted: this.isMuted,
      isOnHold: this.isOnHold,
      openaiConnected: false,
      elevenConnected: this.elevenReady,
      amdEnabled: Boolean(this.isAmdEnabled),
      sttEnabled: Boolean(this.isSttEnabled),
      recordingActive: !!(this.recorder && this.recorder.isStarted && !this.recorder.isStopped && !this.recorder.isPaused),
      recordingFile: this.recorder ? this.recorder.fileName : null,
      transcriptFile: this.recorder ? this.recorder.transcriptFileName : null,
      transcriptTurnsCount: this.transcriptLog.length,
      lastTranscript: lastTurnEntry
    };

    if (includeTranscript) {
      info.transcript = this.transcriptLog;
    }
    return info;
  }

  terminateCall(reason = 'normal_hangup') {
    if (this.isTerminated) return;
    this.isTerminated = true;

    if (this.dialog) {
      try { this.dialog.destroy(); } catch {}
      this.dialog = null;
    }
    if (this.endpoint) {
      try { this.endpoint.destroy(); } catch {}
      this.endpoint = null;
    }
    this.stop().catch(() => {});
    if (this.cleanupHandler) {
      const cb = this.cleanupHandler;
      this.cleanupHandler = null;
      try { cb(reason); } catch {}
    }
  }

  async stop() {
    this.isTerminated = true;

    if (this.agentSilenceTimer) {
      clearTimeout(this.agentSilenceTimer);
      this.agentSilenceTimer = null;
    }

    if (this.maxDurationTimer) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }

    // Registra custos no AiCostTracker
    try {
      const durationSec = this.startedAt ? Math.max(1, Math.floor((Date.now() - this.startedAt.getTime()) / 1000)) : 0;
      const { model } = this.getCredentials();
      aiCostTracker.recordUsage({
        callId: this.callId,
        tenantId: this.tenant.id,
        provider: 'elevenlabs',
        model,
        usage: { durationSec, totalTokens: durationSec * 50 }
      });
    } catch {}

    if (this.whisperSession) {
      this.whisperSession.stop();
      this.whisperSession = null;
    }

    if (this.recorder) {
      await this.recorder.stop();
      this.recorder = null;
    }

    if (this.mediaBridge) {
      await this.mediaBridge.stop();
    }

    if (this.elevenSocket) {
      try {
        this.elevenSocket.close();
      } catch {}
      this.elevenSocket = null;
    }
    this.elevenReady = false;
  }
}

module.exports = ElevenLabsS2SBridge;

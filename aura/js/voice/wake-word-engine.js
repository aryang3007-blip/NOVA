/**
 * AURA :: WakeWordEngine
 * ----------------------
 * Wraps Picovoice Porcupine Web SDK for continuous, low-power wake-word
 * detection. Falls back gracefully to browser STT scanning if Porcupine
 * is unavailable or not configured.
 *
 * ARCHITECTURE
 * ─────────────
 *   getUserMedia (own stream)
 *       ↓
 *   AudioContext → ScriptProcessor → PCM frames → Porcupine WASM engine
 *       ↓ wake detected
 *   bus.emit(EV.WAKE_WORD)           ← main.js hands off to SpeechInput
 *       ↓ (after command recognised)
 *   engine.resume()                  ← back to listening
 *
 * REQUIREMENTS
 * ─────────────
 * • serve.py must send:
 *     Cross-Origin-Opener-Policy: same-origin
 *     Cross-Origin-Embedder-Policy: require-corp
 *   (already done in this session's serve.py edits)
 *
 * • A free Picovoice access key from https://console.picovoice.ai/
 *   goes in Settings → Voice → Picovoice Key.
 *
 * • Built-in keywords (no training): porcupine, alexa, computer,
 *   hey google, hey siri, jarvis, ok google, picovoice, bumblebee
 *
 * • Custom "AURA" / "Hey AURA" keywords need a .ppn model trained for
 *   the "Web (WASM)" platform at the Picovoice Console.
 *
 * FALLBACK
 * ─────────
 *   When engine === 'browser' or Porcupine fails to load, falls back to
 *   the existing SpeechInput wake-word scanning. Both paths emit the same
 *   EV.WAKE_WORD event, so the rest of main.js is unchanged.
 *
 * PYTHON DELEGATION
 * ─────────────────
 *   When engine === 'python', the local Python voice service owns the mic
 *   and this class only polls /api/voice/events (see
 *   startLocalServiceListener) plus probePythonService() for liveness.
 *   decideWakeEngine() below is the single routing truth table shared by
 *   main.js and the tests.
 */

import { bus, EV } from '../core/bus.js';
import { config } from '../core/config.js';

// ── Porcupine CDN (npm ESM via cdn.jsdelivr.net) ────────────────────────────
// We load the Porcupine *worker* build, which runs WASM in a Worker thread so
// it never blocks the main thread. The URL is pinned to a stable minor.
const PORCUPINE_CDN =
  'https://cdn.jsdelivr.net/npm/@picovoice/porcupine-web@3.0/dist/esm/index.js';

// PCM frame size expected by Porcupine (512 samples @ 16 kHz = 32 ms)
const PORCUPINE_FRAME = 512;

// ── State ────────────────────────────────────────────────────────────────────
const STATE = Object.freeze({
  IDLE:      'idle',
  LOADING:   'loading',
  LISTENING: 'listening',
  DETECTED:  'detected',
  ERROR:     'error',
  DESTROYED: 'destroyed',
});

export class WakeWordEngine {
  constructor() {
    /** @type {string} */
    this._state = STATE.IDLE;
    /** @type {any} Porcupine handle from SDK */
    this._porcupine = null;
    /** @type {AudioContext|null} */
    this._ctx = null;
    /** @type {ScriptProcessorNode|null} */
    this._processor = null;
    /** @type {MediaStream|null} */
    this._stream = null;
    /** @type {MediaStreamAudioSourceNode|null} */
    this._source = null;
    /** @type {boolean} */
    this._sdkLoaded = false;
    /** @type {boolean} */
    this._active = false;

    // Down-sample buffer (16-bit PCM) for Porcupine
    this._buffer = new Int16Array(PORCUPINE_FRAME);
    this._bufferIdx = 0;
    this._sampleRatio = 1;   // filled when AudioContext is created

    /** @type {boolean} True while wake is delegated to the Python service. */
    this._pythonMode = false;

    // Start background event listener for Python local wake service
    this.startLocalServiceListener();
  }

  /**
   * Start polling local Python voice service wake events (/api/voice/events).
   */
  startLocalServiceListener() {
    if (this._pollingLocal) return;
    this._pollingLocal = true;

    const poll = async () => {
      if (!this._pollingLocal) return;
      try {
        const resp = await fetch('/api/voice/events', { cache: 'no-store' });
        if (resp.ok) {
          const data = await resp.json();
          if (data?.ok && data.event && data.event.type === 'wake_detected') {
            bus.emit(EV.WAKE_WORD, {
              text: data.event.phrase,
              command: data.event.transcript || data.event.command || '',
              matched: data.event.phrase,
              score: data.event.score,
              source: data.event.source || 'python-wake-service'
            });
          }
        }
      } catch (e) {
        // quiet retry on server restart
      }
      if (this._pollingLocal) {
        setTimeout(poll, 600);
      }
    };
    poll();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** True while wake is delegated to the Python voice service. */
  get pythonActive() { return this._pythonMode === true; }

  /**
   * Mark delegation to / from the Python voice service.
   * Python owns the mic in this mode, so entering it pauses any
   * Porcupine listening; leaving it just clears the flag.
   */
  setPythonMode(on) {
    this._pythonMode = !!on;
    if (on) this.pause().catch(() => {});
    return this._pythonMode;
  }

  /**
   * Probe the Python voice service via GET /api/voice/status.
   * Resolves true ONLY on a fresh service heartbeat: the reply must carry
   * the service version stamp + a recent updated_at + a non-error lifecycle
   * state. The server's built-in placeholder status (no service running)
   * has no version stamp, so it honestly reads as "not live".
   * Never throws — false means "fall back to another engine".
   */
  async probePythonService(timeoutMs = 2500) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const resp = await fetch('/api/voice/status', { cache: 'no-store', signal: ctl.signal });
        if (!resp || !resp.ok) return false;
        const data = await resp.json();
        const v = data && data.voice;
        if (!v || typeof v.version !== 'string' || !v.version) return false;
        if (typeof v.updated_at !== 'number') return false;
        if (Date.now() / 1000 - v.updated_at > 60) return false; // stale: 4+ missed beats
        if (/ERROR|OFF|STOPPED|UNAVAILABLE/.test(String(v.status || ''))) return false;
        return true;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }

  /** True when Porcupine's WASM dependencies can run in this context. */
  static isSupported() {
    return typeof SharedArrayBuffer !== 'undefined' &&
           typeof AudioContext !== 'undefined';
  }

  /** @returns {string} current state */
  get state() { return this._state; }
  get isListening() { return this._state === STATE.LISTENING; }

  /**
   * Initialise Porcupine and start listening.
   *
   * @param {object} opts
   * @param {string} opts.accessKey   Picovoice Console access key
   * @param {string} [opts.keyword]   Built-in keyword name (default: 'porcupine')
   * @param {string} [opts.modelUrl]  URL to a custom .ppn model file
   */
  async start({ accessKey, keyword = 'porcupine', modelUrl } = {}) {
    if (this._state === STATE.DESTROYED) return;
    if (this._state === STATE.LISTENING) return;
    if (!accessKey) {
      this._setState(STATE.ERROR, 'No Picovoice access key configured');
      throw new Error('WakeWordEngine: No access key');
    }
    if (!WakeWordEngine.isSupported()) {
      this._setState(STATE.ERROR,
        'SharedArrayBuffer unavailable — the server may be missing COOP/COEP headers');
      throw new Error('WakeWordEngine: SharedArrayBuffer not available');
    }

    this._setState(STATE.LOADING);

    try {
      await this._loadSdk();
      await this._initPorcupine({ accessKey, keyword, modelUrl });
      await this._openMic();
      this._startProcessing();
      this._setState(STATE.LISTENING);
    } catch (err) {
      this._setState(STATE.ERROR, err.message);
      await this._cleanup(false);
      throw err;
    }
  }

  /** Pause detection — mic stays open so resume is instant. */
  async pause() {
    if (!this._active) return;
    this._stopProcessing();
    this._setState(STATE.IDLE, 'paused');
  }

  /** Resume detection after a pause. */
  async resume() {
    if (this._state === STATE.DESTROYED) return;
    if (this._state === STATE.LISTENING) return;
    if (!this._porcupine || !this._stream) {
      // Full restart needed
      const k   = config.get('wakeWord') || 'porcupine';
      const key = config.get('picovoiceKey') || '';
      const url = config.get('wakeWordModelUrl') || undefined;
      return this.start({ accessKey: key, keyword: k, modelUrl: url });
    }
    this._startProcessing();
    this._setState(STATE.LISTENING);
  }

  /** Full teardown — releases mic and WASM. */
  async destroy() {
    this._setState(STATE.DESTROYED);
    await this._cleanup(true);
  }

  // ── Private: SDK loading ────────────────────────────────────────────────────

  async _loadSdk() {
    if (this._sdkLoaded) return;
    try {
      const mod = await import(/* @vite-ignore */ PORCUPINE_CDN);
      WakeWordEngine._sdk = mod;
      this._sdkLoaded = true;
    } catch (err) {
      throw new Error(
        `Porcupine SDK failed to load from CDN: ${err.message}. ` +
        'Check your internet connection or switch to browser wake-word mode.'
      );
    }
  }

  // ── Private: Porcupine init ─────────────────────────────────────────────────

  async _initPorcupine({ accessKey, keyword, modelUrl }) {
    const sdk = WakeWordEngine._sdk;
    if (!sdk) throw new Error('Porcupine SDK not loaded');

    const { PorcupineWorker, BuiltInKeyword } = sdk;
    if (!PorcupineWorker) throw new Error('PorcupineWorker not found in SDK');

    const builtinNames = Object.keys(BuiltInKeyword || {}).map(k => k.toLowerCase());

    let kwSpec;
    if (modelUrl) {
      // Custom .ppn model trained at console.picovoice.ai
      kwSpec = {
        custom: {
          base64:     null,
          publicPath: modelUrl,
          label:      keyword || 'custom',
        },
        sensitivity: 0.65,
      };
    } else if (builtinNames.includes(keyword.toLowerCase())) {
      const builtinKey = Object.keys(BuiltInKeyword || {})
        .find(k => k.toLowerCase() === keyword.toLowerCase());
      kwSpec = { builtin: BuiltInKeyword[builtinKey], sensitivity: 0.65 };
    } else {
      console.warn(
        `[WakeWordEngine] Keyword "${keyword}" not found in built-ins.`,
        'Available:', builtinNames.join(', '),
        '\nFalling back to "porcupine". Train a custom model at console.picovoice.ai'
      );
      kwSpec = { builtin: BuiltInKeyword.PORCUPINE, sensitivity: 0.65 };
    }

    this._porcupine = await PorcupineWorker.create(
      accessKey,
      [kwSpec],
      (detection) => {
        if (detection && this._state === STATE.LISTENING) {
          this._onWakeDetected(detection);
        }
      }
    );
  }

  // ── Private: microphone ────────────────────────────────────────────────────

  async _openMic() {
    if (this._stream) return;
    this._stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount:     1,
        sampleRate:       { ideal: 16000 },
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
  }

  _startProcessing() {
    if (this._active) return;
    if (!this._stream || !this._porcupine) return;

    const nativeRate = this._stream.getAudioTracks()[0]
      ?.getSettings()?.sampleRate || 44100;

    this._ctx = new AudioContext({ sampleRate: nativeRate });
    this._sampleRatio = nativeRate / 16000;

    this._source = this._ctx.createMediaStreamSource(this._stream);

    // Compute buffer size: enough to hold one Porcupine frame at native rate
    const bufSize = Math.ceil(PORCUPINE_FRAME * this._sampleRatio) * 4;
    const validSizes = [256, 512, 1024, 2048, 4096, 8192, 16384];
    const procSize = validSizes.find(s => s >= bufSize) || 4096;

    this._processor = this._ctx.createScriptProcessor(procSize, 1, 1);
    this._processor.onaudioprocess = (ev) => this._processAudio(ev);
    this._source.connect(this._processor);
    this._processor.connect(this._ctx.destination);
    this._active = true;
  }

  _stopProcessing() {
    if (!this._active) return;
    try {
      if (this._processor) {
        this._processor.disconnect();
        this._processor.onaudioprocess = null;
        this._processor = null;
      }
      if (this._source) {
        this._source.disconnect();
        this._source = null;
      }
      if (this._ctx) {
        this._ctx.close().catch(() => {});
        this._ctx = null;
      }
    } catch {}
    this._active = false;
    this._bufferIdx = 0;
  }

  // ── Private: audio processing ──────────────────────────────────────────────

  _processAudio(ev) {
    if (!this._active || !this._porcupine) return;
    const float32 = ev.inputBuffer.getChannelData(0);
    const ratio = this._sampleRatio;

    for (let i = 0; i < float32.length; i++) {
      if (Math.round(i) % Math.round(ratio) !== 0) continue;
      const s = float32[i];
      this._buffer[this._bufferIdx++] = Math.max(-32768, Math.min(32767,
        s < 0 ? s * 32768 : s * 32767
      ));
      if (this._bufferIdx >= PORCUPINE_FRAME) {
        this._bufferIdx = 0;
        try {
          if (this._porcupine.process) this._porcupine.process(this._buffer);
        } catch {}
      }
    }
  }

  // ── Private: detection ─────────────────────────────────────────────────────

  _onWakeDetected(detection) {
    this._setState(STATE.DETECTED, `keyword index ${detection.index ?? 0}`);
    this._stopProcessing();

    bus.emit(EV.WAKE_WORD, {
      source:  'porcupine',
      keyword: detection.label ?? 'detected',
      index:   detection.index ?? 0,
    });

    // Auto-resume after the command cycle ends
    const off = bus.on(EV.STT_END, () => {
      off();
      setTimeout(() => this.resume(), 400);
    });
  }

  // ── Private: state management ──────────────────────────────────────────────

  _setState(newState, reason) {
    if (this._state === newState) return;
    const prev = this._state;
    this._state = newState;
    console.info(`[WakeWordEngine] ${prev} → ${newState}` + (reason ? ` (${reason})` : ''));
    bus.emit(EV.WAKE_ENGINE_STATE, { state: newState, prev, reason, engine: 'porcupine' });
  }

  // ── Private: cleanup ────────────────────────────────────────────────────────

  async _cleanup(releaseMic) {
    this._stopProcessing();
    if (releaseMic && this._stream) {
      this._stream.getTracks().forEach(t => t.stop());
      this._stream = null;
    }
    if (this._porcupine) {
      try { this._porcupine.release?.(); } catch {}
      try { this._porcupine.terminate?.(); } catch {}
      this._porcupine = null;
    }
  }
}

// Shared SDK reference across instances (loaded once, reused)
WakeWordEngine._sdk = null;

/**
 * Single routing truth table for wake engines.
 * main.js consults this (via live probes) before starting anything.
 *
 * @param {object} facts
 * @param {string} facts.engine configured engine: 'python'|'porcupine'|'browser'|'off'
 * @param {boolean} facts.pythonLive probePythonService() result
 * @param {boolean} facts.hasKey Picovoice access key configured
 * @param {boolean} facts.porcupineOk WakeWordEngine.isSupported() result
 * @returns {'python'|'porcupine'|'browser'|'off'} the engine to actually use
 */
export function decideWakeEngine({ engine = 'browser', pythonLive = false, hasKey = false, porcupineOk = false } = {}) {
  if (engine === 'off') return 'off';
  if (engine === 'python') return pythonLive ? 'python' : 'browser';
  if (engine === 'porcupine') return (hasKey && porcupineOk) ? 'porcupine' : 'browser';
  return 'browser'; // 'browser' + anything unknown fails soft to scanning
}

export default WakeWordEngine;

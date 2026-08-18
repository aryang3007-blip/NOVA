/**
 * AURA :: Hardware Abstraction Layer — Provider Interfaces
 * ---------------------------------------------------------
 * Every hardware capability is reached through one of these interfaces.
 * The AI and UI layers NEVER call `getUserMedia`, `speechSynthesis`,
 * `AudioContext` or `navigator.xr` directly — they go through a provider.
 *
 * That indirection buys three things:
 *   1. Mock providers, so the app runs and tests headlessly with no hardware.
 *   2. Platform providers (Windows/native) can be swapped in with zero
 *      changes to callers.
 *   3. One place to enforce permissions and log access.
 *
 * Providers report `available` honestly. Nothing here fakes success.
 *
 * @module runtime/hardware/providers
 */

/**
 * @typedef {Object} ProviderStatus
 * @property {string}  id
 * @property {string}  kind          'camera' | 'microphone' | 'audio' | 'gpu' | 'sensor' | 'xr'
 * @property {boolean} available
 * @property {boolean} active
 * @property {string}  implementation 'browser' | 'mock' | 'native'
 * @property {?string} reason        why unavailable, when applicable
 */

/** Base class. Subclasses must set `kind` and implement `probe()`. */
export class HardwareProvider {
  /** @param {{id:string, kind:string, implementation?:string}} opts */
  constructor({ id, kind, implementation = 'mock' }) {
    this.id = id;
    this.kind = kind;
    this.implementation = implementation;
    this.available = false;
    this.active = false;
    this.reason = null;
    this._probed = false;
  }

  /**
   * Detect whether this provider can work here. Must never throw.
   * @returns {Promise<boolean>}
   */
  async probe() {
    this._probed = true;
    this.available = false;
    this.reason = 'probe() not implemented';
    return false;
  }

  /** @returns {Promise<ProviderStatus>} */
  async status() {
    if (!this._probed) await this.probe();
    return {
      id: this.id, kind: this.kind, available: this.available,
      active: this.active, implementation: this.implementation, reason: this.reason,
    };
  }

  /** @param {any} [_opts] @returns {Promise<any>} */
  async start(_opts) { throw new Error(`${this.id}: start() not implemented`); }
  async stop() { this.active = false; }
  async dispose() { await this.stop(); }
}

/* ══════════════════════════════════════════════════════════════════════
   CAMERA
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Video input. Implementations: BrowserCameraProvider, MockCameraProvider.
 * TODO(windows): NativeCameraProvider via Media Foundation for
 *   multi-camera enumeration and hardware controls (exposure, zoom) that
 *   getUserMedia does not expose.
 */
export class CameraProvider extends HardwareProvider {
  constructor(opts = {}) { super({ kind: 'camera', id: 'camera', ...opts }); }
  /** @param {any} [_constraints] @returns {Promise<any>} */
  async start(_constraints) { throw new Error('CameraProvider.start() not implemented'); }
  /** @returns {Promise<Array<{id:string,label:string}>>} */
  async listDevices() { return []; }
  /** @returns {?MediaStream} */
  getStream() { return null; }
}

export class BrowserCameraProvider extends CameraProvider {
  constructor() { super({ id: 'camera.browser', implementation: 'browser' }); this.stream = null; }

  async probe() {
    this._probed = true;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      this.available = false; this.reason = 'navigator.mediaDevices.getUserMedia is unavailable';
      return false;
    }
    const secure = typeof window !== 'undefined' &&
      (window.isSecureContext || ['localhost', '127.0.0.1'].includes(location.hostname));
    if (!secure) {
      this.available = false;
      this.reason = 'Camera needs a secure context (https:// or localhost)';
      return false;
    }
    this.available = true; this.reason = null;
    return true;
  }

  async start(constraints = { video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } }) {
    if (!this.available && !(await this.probe())) throw new Error(this.reason || 'Camera unavailable');
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.active = true;
    return this.stream;
  }

  async stop() {
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.active = false;
  }

  getStream() { return this.stream; }

  async listDevices() {
    try {
      const d = await navigator.mediaDevices.enumerateDevices();
      return d.filter(x => x.kind === 'videoinput').map(x => ({ id: x.deviceId, label: x.label || 'Camera' }));
    } catch { return []; }
  }
}

/** Headless-safe stand-in. Produces a synthetic canvas stream when asked. */
export class MockCameraProvider extends CameraProvider {
  constructor() { super({ id: 'camera.mock', implementation: 'mock' }); }
  async probe() { this._probed = true; this.available = true; this.reason = 'simulated device'; return true; }
  async start() {
    this.active = true;
    // A real MediaStream is only creatable in a DOM; return null elsewhere.
    if (typeof document === 'undefined') return null;
    const c = document.createElement('canvas');
    c.width = 640; c.height = 480;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#08131f'; ctx.fillRect(0, 0, 640, 480);
    return c.captureStream ? c.captureStream(1) : null;
  }
  async listDevices() { return [{ id: 'mock-cam', label: 'Simulated Camera' }]; }
}

/* ══════════════════════════════════════════════════════════════════════
   MICROPHONE
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Audio input + speech recognition capability reporting.
 * TODO(windows): NativeMicrophoneProvider using WASAPI for loopback capture
 *   and always-on wake-word detection without keeping a browser tab focused.
 */
export class MicrophoneProvider extends HardwareProvider {
  constructor(opts = {}) { super({ kind: 'microphone', id: 'microphone', ...opts }); }
  async requestPermission() { return false; }
  /** @returns {Promise<Array<{id:string,label:string}>>} */
  async listDevices() { return []; }
  /** Does this environment support speech-to-text? */
  get speechRecognitionAvailable() { return false; }
}

export class BrowserMicrophoneProvider extends MicrophoneProvider {
  constructor() { super({ id: 'microphone.browser', implementation: 'browser' }); this.stream = null; }

  async probe() {
    this._probed = true;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      this.available = false; this.reason = 'No microphone API in this environment';
      return false;
    }
    const secure = typeof window !== 'undefined' &&
      (window.isSecureContext || ['localhost', '127.0.0.1'].includes(location.hostname));
    if (!secure) { this.available = false; this.reason = 'Microphone needs https:// or localhost'; return false; }
    this.available = true; this.reason = null;
    return true;
  }

  get speechRecognitionAvailable() {
    return typeof window !== 'undefined' &&
      !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  /**
   * Chrome does not reliably show the mic prompt for SpeechRecognition alone,
   * so we open a short-lived getUserMedia stream to force it.
   */
  async requestPermission() {
    if (!this.available && !(await this.probe())) return false;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach(t => t.stop());
      return true;
    } catch { return false; }
  }

  /** @param {any} [constraints] */
  async start(constraints = { audio: true }) {
    if (!this.available && !(await this.probe())) throw new Error(this.reason || 'Microphone unavailable');
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.active = true;
    return this.stream;
  }

  async stop() { this.stream?.getTracks().forEach(t => t.stop()); this.stream = null; this.active = false; }

  async listDevices() {
    try {
      const d = await navigator.mediaDevices.enumerateDevices();
      return d.filter(x => x.kind === 'audioinput').map(x => ({ id: x.deviceId, label: x.label || 'Microphone' }));
    } catch { return []; }
  }
}

export class MockMicrophoneProvider extends MicrophoneProvider {
  constructor() { super({ id: 'microphone.mock', implementation: 'mock' }); }
  async probe() { this._probed = true; this.available = true; this.reason = 'simulated device'; return true; }
  async requestPermission() { return true; }
  async start() { this.active = true; return null; }
  async listDevices() { return [{ id: 'mock-mic', label: 'Simulated Microphone' }]; }
}

/* ══════════════════════════════════════════════════════════════════════
   AUDIO OUTPUT
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Speaker / synthesis output.
 * TODO(windows): NativeAudioProvider for per-app volume via the Windows
 *   audio session API, and system-wide TTS voices beyond the browser set.
 */
export class AudioProvider extends HardwareProvider {
  constructor(opts = {}) { super({ kind: 'audio', id: 'audio', ...opts }); }
  /** @returns {Promise<AudioContext|null>} */
  async getContext() { return null; }
  /** @returns {Array<{name:string,lang:string}>} */
  listVoices() { return []; }
  get synthesisAvailable() { return false; }
}

export class BrowserAudioProvider extends AudioProvider {
  constructor() { super({ id: 'audio.browser', implementation: 'browser' }); this.ctx = null; }

  async probe() {
    this._probed = true;
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) { this.available = false; this.reason = 'Web Audio API unavailable'; return false; }
    this.available = true; this.reason = null;
    return true;
  }

  get synthesisAvailable() { return typeof window !== 'undefined' && 'speechSynthesis' in window; }

  async getContext() {
    if (!this.available && !(await this.probe())) return null;
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch {} }
    this.active = this.ctx.state === 'running';
    return this.ctx;
  }

  listVoices() {
    if (!this.synthesisAvailable) return [];
    return (window.speechSynthesis.getVoices() || [])
      .map(v => ({ name: v.name, lang: v.lang, default: v.default, local: v.localService }));
  }

  async stop() { try { await this.ctx?.close(); } catch {} this.ctx = null; this.active = false; }
}

export class MockAudioProvider extends AudioProvider {
  constructor() { super({ id: 'audio.mock', implementation: 'mock' }); }
  async probe() { this._probed = true; this.available = true; this.reason = 'simulated output'; return true; }
  async getContext() { return null; }
  listVoices() { return [{ name: 'Simulated Voice', lang: 'en-US' }]; }
}

/* ══════════════════════════════════════════════════════════════════════
   GPU
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Reports acceleration capability so the avatar/vision layers can pick a
 * quality tier instead of guessing.
 * TODO(windows): query DXGI adapters for real VRAM and vendor info; expose
 *   CUDA/DirectML availability for local model inference.
 */
export class GPUProvider extends HardwareProvider {
  constructor(opts = {}) { super({ kind: 'gpu', id: 'gpu', ...opts }); this.info = null; }
  /** @returns {Promise<{webgl:boolean, webgpu:boolean, renderer:?string, tier:string}>} */
  async capabilities() { return { webgl: false, webgpu: false, renderer: null, tier: 'none' }; }
}

export class BrowserGPUProvider extends GPUProvider {
  constructor() { super({ id: 'gpu.browser', implementation: 'browser' }); }

  async probe() {
    this._probed = true;
    const caps = await this.capabilities();
    this.available = caps.webgl || caps.webgpu;
    this.reason = this.available ? null : 'No WebGL or WebGPU context could be created';
    return this.available;
  }

  async capabilities() {
    if (this.info) return this.info;
    let webgl = false, renderer = null, webgpu = false;
    try {
      if (typeof document !== 'undefined') {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl2') || c.getContext('webgl');
        if (gl) {
          webgl = true;
          const dbg = gl.getExtension('WEBGL_debug_renderer_info');
          renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
        }
      }
    } catch {}
    try { webgpu = typeof navigator !== 'undefined' && !!navigator.gpu; } catch {}

    // Software rasterisers report themselves; treat them as a low tier so the
    // renderer drops quality instead of stuttering.
    const soft = /swiftshader|llvmpipe|software|microsoft basic/i.test(renderer || '');
    const tier = !webgl ? 'none' : soft ? 'low' : webgpu ? 'high' : 'medium';
    this.info = { webgl, webgpu, renderer, tier, software: soft };
    return this.info;
  }
}

export class MockGPUProvider extends GPUProvider {
  constructor() { super({ id: 'gpu.mock', implementation: 'mock' }); }
  async probe() { this._probed = true; this.available = false; this.reason = 'no GPU in this environment'; return false; }
  async capabilities() { return { webgl: false, webgpu: false, renderer: 'mock', tier: 'none', software: true }; }
}

/* ══════════════════════════════════════════════════════════════════════
   SENSORS  /  XR
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Motion + environment sensors.
 * TODO(windows): read laptop sensors (ambient light, lid state, battery)
 *   through the Windows.Devices.Sensors API in the native companion.
 */
export class SensorProvider extends HardwareProvider {
  constructor(opts = {}) { super({ kind: 'sensor', id: 'sensor', ...opts }); }
  /** @returns {Promise<string[]>} sensor ids present */
  async listSensors() { return []; }
  /** @returns {Promise<object|null>} */
  async read(_sensorId) { return null; }
}

export class BrowserSensorProvider extends SensorProvider {
  constructor() { super({ id: 'sensor.browser', implementation: 'browser' }); }

  async probe() {
    this._probed = true;
    const list = await this.listSensors();
    this.available = list.length > 0;
    this.reason = this.available ? null : 'No sensor APIs exposed by this browser';
    return this.available;
  }

  async listSensors() {
    const out = [];
    if (typeof window === 'undefined') return out;
    if ('DeviceOrientationEvent' in window) out.push('orientation');
    if ('DeviceMotionEvent' in window) out.push('motion');
    if (typeof navigator !== 'undefined' && 'getBattery' in navigator) out.push('battery');
    if (typeof navigator !== 'undefined' && 'connection' in navigator) out.push('network');
    return out;
  }

  async read(sensorId) {
    try {
      if (sensorId === 'battery' && navigator.getBattery) {
        const b = await navigator.getBattery();
        return { level: b.level, charging: b.charging };
      }
      if (sensorId === 'network' && navigator.connection) {
        const c = navigator.connection;
        return { effectiveType: c.effectiveType, downlink: c.downlink, rtt: c.rtt };
      }
    } catch {}
    return null;
  }
}

export class MockSensorProvider extends SensorProvider {
  constructor() { super({ id: 'sensor.mock', implementation: 'mock' }); }
  async probe() { this._probed = true; this.available = false; this.reason = 'no sensors in this environment'; return false; }
}

/**
 * AR / VR devices.
 * TODO(windows): OpenXR runtime detection for tethered headsets; the browser
 *   only exposes WebXR, which desktop Chrome does not implement for AR.
 */
export class XRProvider extends HardwareProvider {
  constructor(opts = {}) { super({ kind: 'xr', id: 'xr', ...opts }); }
  /** @returns {Promise<{immersiveAR:boolean, immersiveVR:boolean, reason:?string}>} */
  async capabilities() { return { immersiveAR: false, immersiveVR: false, reason: 'not implemented' }; }
}

export class BrowserXRProvider extends XRProvider {
  constructor() { super({ id: 'xr.browser', implementation: 'browser' }); }
  async probe() {
    this._probed = true;
    const c = await this.capabilities();
    this.available = c.immersiveAR || c.immersiveVR;
    this.reason = this.available ? null : c.reason;
    return this.available;
  }
  async capabilities() {
    if (typeof navigator === 'undefined' || !navigator.xr?.isSessionSupported) {
      return { immersiveAR: false, immersiveVR: false, reason: 'navigator.xr unavailable' };
    }
    let ar = false, vr = false;
    try { ar = await navigator.xr.isSessionSupported('immersive-ar'); } catch {}
    try { vr = await navigator.xr.isSessionSupported('immersive-vr'); } catch {}
    return { immersiveAR: ar, immersiveVR: vr, reason: (ar || vr) ? null : 'No immersive session type supported' };
  }
}

export class MockXRProvider extends XRProvider {
  constructor() { super({ id: 'xr.mock', implementation: 'mock' }); }
  async probe() { this._probed = true; this.available = false; this.reason = 'no XR device'; return false; }
}

export default {
  HardwareProvider,
  CameraProvider, BrowserCameraProvider, MockCameraProvider,
  MicrophoneProvider, BrowserMicrophoneProvider, MockMicrophoneProvider,
  AudioProvider, BrowserAudioProvider, MockAudioProvider,
  GPUProvider, BrowserGPUProvider, MockGPUProvider,
  SensorProvider, BrowserSensorProvider, MockSensorProvider,
  XRProvider, BrowserXRProvider, MockXRProvider,
};

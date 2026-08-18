/**
 * AURA :: Hardware Registry & Device Manager
 * ------------------------------------------
 * `HardwareRegistry` owns provider selection: for each capability it probes
 * the candidates in priority order (native → browser → mock) and keeps the
 * first that works. Callers ask for a *capability*, never a concrete class.
 *
 * `DeviceManager` is the friendly façade the rest of AURA uses.
 *
 * @module runtime/hardware/registry
 */

import {
  BrowserCameraProvider, MockCameraProvider,
  BrowserMicrophoneProvider, MockMicrophoneProvider,
  BrowserAudioProvider, MockAudioProvider,
  BrowserGPUProvider, MockGPUProvider,
  BrowserSensorProvider, MockSensorProvider,
  BrowserXRProvider, MockXRProvider,
} from './providers.js';

export const CAPABILITIES = ['camera', 'microphone', 'audio', 'gpu', 'sensor', 'xr'];

export class HardwareRegistry {
  /** @param {{logger?:Function}} opts */
  constructor({ logger = null } = {}) {
    this.log = logger || (() => {});
    /** @type {Map<string, Array<object>>} capability → candidate providers */
    this.candidates = new Map();
    /** @type {Map<string, object>} capability → selected provider */
    this.selected = new Map();
    this.initialized = false;
    this._registerDefaults();
  }

  _registerDefaults() {
    // Order matters: first that probes true wins.
    // TODO(windows): unshift Native*Provider instances here once the desktop
    //   companion exists, so native wins over the browser implementation.
    this.register('camera', new BrowserCameraProvider());
    this.register('camera', new MockCameraProvider());

    this.register('microphone', new BrowserMicrophoneProvider());
    this.register('microphone', new MockMicrophoneProvider());

    this.register('audio', new BrowserAudioProvider());
    this.register('audio', new MockAudioProvider());

    this.register('gpu', new BrowserGPUProvider());
    this.register('gpu', new MockGPUProvider());

    this.register('sensor', new BrowserSensorProvider());
    this.register('sensor', new MockSensorProvider());

    this.register('xr', new BrowserXRProvider());
    this.register('xr', new MockXRProvider());
  }

  /**
   * Add a provider candidate.
   * @param {string} capability
   * @param {object} provider
   * @param {{priority?:boolean}} [opts] priority=true puts it first
   */
  register(capability, provider, { priority = false } = {}) {
    if (!this.candidates.has(capability)) this.candidates.set(capability, []);
    const list = this.candidates.get(capability);
    priority ? list.unshift(provider) : list.push(provider);
    return this;
  }

  /** Probe every capability and pick a winner for each. */
  async initialize() {
    for (const cap of this.candidates.keys()) {
      let chosen = null;
      for (const p of this.candidates.get(cap)) {
        let ok = false;
        try { ok = await p.probe(); } catch (e) { p.reason = e.message; }
        if (ok) { chosen = p; break; }
      }
      // Nothing probed true → keep the last (mock) so calls never crash.
      if (!chosen) chosen = this.candidates.get(cap).at(-1);
      this.selected.set(cap, chosen);
      this.log(`hardware: ${cap} → ${chosen.id} (${chosen.available ? 'available' : chosen.reason})`);
    }
    this.initialized = true;
    return this.status();
  }

  /** @returns {object|null} the active provider for a capability */
  get(capability) { return this.selected.get(capability) || null; }

  /** Is this capability genuinely usable (not just mocked)? */
  isAvailable(capability) {
    const p = this.selected.get(capability);
    return !!p && p.available && p.implementation !== 'mock';
  }

  async status() {
    const out = {};
    for (const [cap, p] of this.selected) out[cap] = await p.status();
    return out;
  }

  /** Compact summary for the diagnostics panel. */
  summary() {
    const rows = [];
    for (const [cap, p] of this.selected) {
      rows.push({
        capability: cap, provider: p.id, implementation: p.implementation,
        available: p.available, active: p.active, reason: p.reason,
      });
    }
    return rows;
  }

  async disposeAll() {
    for (const p of this.selected.values()) { try { await p.dispose(); } catch {} }
  }
}

/**
 * Friendly façade. This is what modules import — they never touch providers
 * or raw browser APIs directly.
 */
export class DeviceManager {
  /** @param {{registry?:HardwareRegistry, permissions?:object, bus?:object}} opts */
  constructor({ registry = null, permissions = null, bus = null } = {}) {
    this.registry = registry || new HardwareRegistry();
    this.permissions = permissions;
    this.bus = bus;
  }

  async initialize() {
    const st = await this.registry.initialize();
    this.bus?.emit('hardware:ready', this.registry.summary());
    return st;
  }

  /**
   * Permission gate. When a PermissionManager is attached, hardware access
   * is checked exactly like a desktop action.
   * @returns {{allowed:boolean, reason?:string}}
   */
  _checkPermission(permId) {
    if (!this.permissions || !permId) return { allowed: true };
    return this.permissions.check(permId, { actionName: `hardware:${permId}` });
  }

  /* ── camera ── */
  get camera() { return this.registry.get('camera'); }
  async startCamera(constraints) {
    const chk = this._checkPermission('camera');
    if (!chk.allowed) return { ok: false, reason: chk.reason };
    try {
      const stream = await this.camera.start(constraints);
      this.bus?.emit('hardware:camera-started', { provider: this.camera.id });
      return { ok: true, stream, simulated: this.camera.implementation === 'mock' };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }
  async stopCamera() { await this.camera?.stop(); this.bus?.emit('hardware:camera-stopped', {}); }

  /* ── microphone ── */
  get microphone() { return this.registry.get('microphone'); }
  async requestMicPermission() {
    const chk = this._checkPermission('microphone');
    if (!chk.allowed) return false;
    return this.microphone.requestPermission();
  }
  get speechRecognitionAvailable() { return !!this.microphone?.speechRecognitionAvailable; }

  /* ── audio ── */
  get audio() { return this.registry.get('audio'); }
  async audioContext() { return this.audio?.getContext() ?? null; }
  listVoices() { return this.audio?.listVoices() ?? []; }

  /* ── gpu ── */
  get gpu() { return this.registry.get('gpu'); }
  async gpuCapabilities() { return this.gpu?.capabilities() ?? { tier: 'none' }; }
  /** Suggested render quality based on real GPU capability. */
  async recommendedQuality() {
    const c = await this.gpuCapabilities();
    return c.tier === 'high' ? 'high' : c.tier === 'medium' ? 'medium' : 'low';
  }

  /* ── sensors / xr ── */
  get sensors() { return this.registry.get('sensor'); }
  get xr() { return this.registry.get('xr'); }
  async xrCapabilities() { return this.xr?.capabilities() ?? { immersiveAR: false, immersiveVR: false }; }

  summary() { return this.registry.summary(); }
  async status() { return this.registry.status(); }
}

export default DeviceManager;

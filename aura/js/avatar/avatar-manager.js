/**
 * AURA :: Avatar Manager
 * ======================
 * Owns the AnimationEngine and the currently active AvatarProvider, and runs
 * the single render loop that connects them:
 *
 *     rAF ─▶ engine.update(dt) ─▶ pose ─▶ provider.applyPose(pose)
 *
 * Because the engine is provider-independent, switching avatars mid-session
 * preserves the entire performance: the same lip-sync, the same blink timing,
 * the same wave-back. Nothing about the AI, voice or vision systems changes.
 *
 * FALLBACK POLICY: if a provider fails to initialise we fall back to the
 * built-in one and report why, rather than leaving a blank stage.
 *
 * @module avatar/avatar-manager
 */

import { AnimationEngine } from './animation-engine.js';
import { getProviderClass, DEFAULT_PROVIDER, probeProviders } from './providers/index.js';
import { bus, EV } from '../core/bus.js';
import { state } from '../core/state.js';
import { config } from '../core/config.js';

export class AvatarManager {
  /** @param {HTMLElement} container */
  constructor(container) {
    this.container = container;
    this.engine = new AnimationEngine();
    /** @type {import('./providers/base.js').AvatarProvider|null} */
    this.provider = null;
    this.providerId = null;
    this._raf = null;
    this._last = 0;
    this._frames = 0;
    this._fpsT = 0;
    this.fps = 0;
    this.lastError = null;
  }

  /**
   * Start with the configured provider, falling back to built-in.
   * @returns {Promise<{ok:boolean, provider:string, fellBack:boolean, reason?:string}>}
   */
  async initialize() {
    const want = config.get('avatarProvider') || DEFAULT_PROVIDER;
    const res = await this.use(want, this._optionsFor(want), { silent: true });
    if (!res.ok && want !== DEFAULT_PROVIDER) {
      const fb = await this.use(DEFAULT_PROVIDER, {}, { silent: true });
      return { ok: fb.ok, provider: DEFAULT_PROVIDER, fellBack: true, reason: res.reason };
    }
    return { ok: res.ok, provider: this.providerId, fellBack: false, reason: res.reason };
  }

  /** Stored options for a provider (model URL, imported file handle, …). */
  _optionsFor(id) {
    if (id === 'readyplayerme') return { url: config.get('avatarRpmUrl') || '' };
    if (id === 'gltf') {
      const blob = this._importedBlob || null;
      return { blob, url: blob ? undefined : (config.get('avatarModelUrl') || ''),
               name: config.get('avatarModelName') || 'imported model' };
    }
    return {};
  }

  /**
   * Switch to a provider. Safe to call repeatedly.
   * @param {string} id
   * @param {object} [options]
   * @param {{silent?:boolean}} [flags]
   */
  async use(id, options = {}, { silent = false } = {}) {
    const Cls = getProviderClass(id);
    if (!Cls) return { ok: false, reason: `Unknown avatar provider "${id}".` };

    const avail = await Cls.isAvailable();
    if (!avail.ok) {
      this.lastError = avail.reason;
      if (!silent) bus.emit(EV.UI_TOAST, { type: 'warn', text: `${Cls.label}: ${avail.reason}` });
      return { ok: false, reason: avail.reason };
    }

    this._stopLoop();
    if (this.provider) {
      try { this.provider.dispose(); } catch {}
      this.provider = null;
    }
    this.container.innerHTML = '';

    const next = new Cls(this.container, options);
    let ok = false;
    try { ok = await next.init(); } catch (e) { next.failureReason = e.message; }

    if (!ok) {
      this.lastError = next.failureReason || 'initialisation failed';
      try { next.dispose(); } catch {}
      if (!silent) {
        bus.emit(EV.UI_TOAST, { type: 'error', text: `${Cls.label} failed: ${this.lastError}` });
      }
      return { ok: false, reason: this.lastError };
    }

    this.provider = next;
    this.providerId = id;
    this.lastError = null;
    config.set('avatarProvider', id);
    // The performance carries across the swap, but start from a clean pose.
    this.engine.reset();
    state.set({ avatarProvider: id, avatarMode: id === 'builtin' ? 'body' : id });
    bus.emit('avatar:provider-changed', { provider: id, label: Cls.label });
    this._startLoop();
    return { ok: true, provider: id };
  }

  /**
   * Import a local .glb/.vrm file and switch to it.
   * @param {File} file
   * @param {{onProgress?:Function}} [opts] receives {step, message} per stage
   */
  async importModel(file, { onProgress = null } = {}) {
    if (!file) return { ok: false, reason: 'No file given.' };
    const name = file.name || 'model';
    if (!/\.(glb|gltf|vrm)$/i.test(name)) {
      return { ok: false, reason: 'Use a .glb, .gltf or .vrm file.' };
    }
    const MAX = 80 * 1024 * 1024;
    if (file.size > MAX) {
      return { ok: false, reason: `That file is ${(file.size / 1048576).toFixed(0)} MB — the limit is 80 MB.` };
    }
    this._importedBlob = file;
    config.set({ avatarModelName: name });
    onProgress?.({ step: 'start', message: `Importing ${name}…` });
    const r = await this.use('gltf', { blob: file, name, onProgress });
    if (!r.ok) {
      this._importedBlob = null;
      onProgress?.({ step: 'error', message: `✗ ${r.reason}` });
    }
    // Keep the talkback reachable after the provider swap (e.g. settings UI).
    this.lastImportLog = /** @type {any} */ (this.provider)?.importLog || [];
    return r;
  }

  /** Connect a Ready Player Me avatar by URL/ID. */
  async useReadyPlayerMe(url) {
    const r = await this.use('readyplayerme', { url });
    if (r.ok) config.set({ avatarRpmUrl: String(url || '').trim() });
    return r;
  }

  /* ── render loop ──────────────────────────────────────────────────── */

  _startLoop() {
    if (this._raf) return;
    this._last = performance.now();
    const tick = (now) => {
      this._raf = requestAnimationFrame(tick);
      const dt = Math.min((now - this._last) / 1000, 0.1);
      this._last = now;

      // Skip work entirely when the stage is hidden — this is the difference
      // between a background tab costing 0% and costing a full render.
      if (document.hidden || !this.provider) return;

      const pose = this.engine.update(dt);
      try { this.provider.applyPose(pose); }
      catch (e) {
        console.error('[avatar] provider render failed', e);
        this._stopLoop();
        bus.emit(EV.UI_TOAST, { type: 'error', text: `Avatar stopped: ${e.message}` });
        return;
      }

      this._frames++;
      this._fpsT += dt;
      if (this._fpsT >= 1) {
        this.fps = Math.round(this._frames / this._fpsT);
        this._frames = 0; this._fpsT = 0;
        // `fps` is the key the HUD readout watches (state.watch('fps')).
        // Publishing only `avatarFps` silently blanked the FPS counter.
        state.set({ fps: this.fps, avatarFps: this.fps });
      }
    };
    this._raf = requestAnimationFrame(tick);
  }

  _stopLoop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  /* ── passthrough API (kept identical to the old avatar objects) ─────
     Anything that used to talk to `app.avatar` — plugins, the AR module,
     gesture bindings, the test suite — keeps working unchanged. The manager
     forwards state to the engine and rig to whichever provider is active. */

  /**
   * Tell the renderer what the AGENT is doing, if it can show it.
   *
   * Only the Sphere provider implements `setAgentState`; the humanoid ignores
   * it. Returning false rather than throwing means callers never have to know
   * which provider is active — they just report the truth and the renderer
   * uses it if it can.
   *
   * @param {'idle'|'listening'|'thinking'|'planning'|'executing'|'success'|'error'|'connecting'|'connected'} state
   * @returns {boolean} whether the active provider consumed it
   */
  setAgentState(state) {
    const p = /** @type {any} */ (this.provider);
    if (!p || typeof p.setAgentState !== 'function') return false;
    this.agentState = state;
    return !!p.setAgentState(state);
  }

  /** The last agent state pushed to the renderer. */
  getAgentState() {
    const p = /** @type {any} */ (this.provider);
    return typeof p?.getAgentState === 'function' ? p.getAgentState() : (this.agentState || 'idle');
  }

  /** Bones of the active rig, when the provider exposes one. */
  get bones() { return /** @type {any} */ (this.provider)?.body?.bones
                    || /** @type {any} */ (this.provider)?.bones || {}; }
  /** Live gesture impulses (owned by the engine, not the renderer). */
  get impulse() { return this.engine.impulse; }
  get emotion() { return this.engine.emotionName; }
  get emoCur() { return this.engine.emotion; }
  // Writable: the AR module and tests set `avatar.speaking` directly, and a
  // getter-only property would silently swallow that in strict mode.
  get speaking() { return this.engine.speaking; }
  set speaking(v) { this.engine.speaking = !!v; }
  get visemeQueue() { return this.engine.visemeQueue; }
  /**
   * Eyelid state, as a live view onto the engine.
   *
   * Returns a proxy-ish object rather than the rig's own blink record, because
   * the engine owns blink timing now. Writing `blink.next = 0` must therefore
   * reach the ENGINE — otherwise "force a blink" silently does nothing, which
   * is exactly what the browser test caught.
   */
  get blink() {
    const eng = this.engine;
    return {
      get closed() { return eng.blink; },
      set closed(v) { eng.blink = v; },
      get phase() { return eng._blinkPhase; },
      set phase(v) { eng._blinkPhase = v; },
      get t() { return eng._blinkT; },
      set t(v) { eng._blinkT = v; },
      get next() { return eng._nextBlink; },
      set next(v) { eng._nextBlink = v; },
    };
  }
  get time() { return this.engine.time; }
  get energy() { return this.engine.energy; }
  get gaze() { return this.engine.gaze; }
  get rings() { return /** @type {any} */ (this.provider)?.body?.rings; }
  get parts() { return /** @type {any} */ (this.provider)?.body?.parts || {}; }
  get ok() { return !!this.provider?.initialized; }
  /** True when the active provider is the full-body built-in rig. */
  get isBody() { return !!(/** @type {any} */ (this.provider)?.body?.isBody); }
  get garments() { return /** @type {any} */ (this.provider)?.body?.garments || []; }
  get outfit() { return /** @type {any} */ (this.provider)?.body?.outfit; }
  get palette() { return /** @type {any} */ (this.provider)?.body?.palette; }
  get accessory() { return /** @type {any} */ (this.provider)?.body?.accessory; }
  get accessories() { return /** @type {any} */ (this.provider)?.body?.accessories || []; }
  /** Mouth shape of the active rig (w/h/curve) — driven from engine.mouthOpen. */
  get mouth() { return /** @type {any} */ (this.provider)?.body?.mouth
                    || { w: 1, h: this.engine.mouthOpen, curve: this.engine.emotion.mouthCurve }; }
  get scene() { return /** @type {any} */ (this.provider)?.body?.scene
                    || /** @type {any} */ (this.provider)?.scene; }
  get camera() { return /** @type {any} */ (this.provider)?.body?.camera
                     || /** @type {any} */ (this.provider)?.camera; }
  get renderer() { return /** @type {any} */ (this.provider)?.body?.renderer
                       || /** @type {any} */ (this.provider)?.renderer; }

  /**
   * Advance one frame manually. Used by tests and by the AR module, which
   * drives rendering itself.
   */
  update(dt = 0.016) {
    const pose = this.engine.update(dt);
    this.provider?.applyPose(pose);
    return pose;
  }

  setEmotion(name, hold) { return this.engine.setEmotion(name, hold); }
  reactToGesture(g) { return this.engine.reactToGesture(g); }
  pushVisemes(v) { return this.engine.pushVisemes(v); }
  lookAt(x, y) { return this.engine.lookAt(x, y); }
  applyOutfit(o, p) { return this.provider?.applyOutfit?.(o, p) ?? false; }
  applyAccessory(a) { return this.provider?.applyAccessory?.(a) ?? false; }
  applyHair(h, c) { return /** @type {any} */ (this.provider)?.applyHair?.(h, c) ?? false; }
  applyBodyType(t) { return /** @type {any} */ (this.provider)?.applyBodyType?.(t) ?? false; }

  /**
   * Scale the avatar's overall height. 1 = as authored.
   * Works on every provider because each exposes a single root Object3D.
   * @param {number} v 0.6 .. 1.6
   * @returns {boolean} true when a provider actually applied it
   */
  setHeight(v) {
    const n = Math.max(0.6, Math.min(1.6, Number(v) || 1));
    config.set('avatarHeight', n);
    return /** @type {any} */ (this.provider)?.setHeight?.(n) ?? false;
  }

  getHeight() { return Number(config.get('avatarHeight')) || 1; }
  setQuality(l) { return this.provider?.setQuality?.(l) ?? false; }
  resize() { this.provider?.resize?.(); }

  /** State for the Avatar Manager settings page. */
  async status() {
    return {
      active: this.providerId,
      fps: this.fps,
      error: this.lastError,
      providers: await probeProviders(),
      detail: this.provider?.describe?.() || null,
    };
  }

  dispose() {
    this._stopLoop();
    try { this.provider?.dispose(); } catch {}
    this.provider = null;
    this.engine.dispose();
  }
}

export default AvatarManager;

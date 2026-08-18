/**
 * AURA :: Sphere Avatar Provider
 * ==============================
 * A glowing golden energy sphere that IS the agent — not decoration.
 *
 * WHY A PROVIDER AND NOT A NEW WIDGET
 * -----------------------------------
 * The Avatar Provider contract already delivers a full pose every frame
 * (emotion, speaking, listening, energy, impulses, breath). Implementing the
 * sphere as a provider means it inherits the entire existing performance —
 * wave-back, TTS mouth energy, emotion changes — with no new event wiring, and
 * the humanoid remains selectable. Adding a 4th provider changes no other file
 * except the registry.
 *
 * WHY CANVAS 2D AND NOT WebGL
 * ---------------------------
 * This machine renders WebGL through SwiftShader (software), where MediaPipe
 * measured 760 ms/frame before we moved it to CPU. A 2D canvas with additive
 * compositing is dramatically cheaper here and looks the same for line-and-
 * particle art. It also means the sphere works with zero shader compilation,
 * on any browser, with no vendor/model download.
 *
 * AGENT STATE DRIVES THE VISUAL
 * -----------------------------
 * `setAgentState()` is called by the app from real events — not a timer, not a
 * random loop. idle · listening · thinking · planning · executing · success ·
 * error · connecting · connected. Each state changes rotation speed, particle
 * count, colour temperature and core intensity, so what you see is what the
 * agent is actually doing.
 *
 * PERFORMANCE
 * -----------
 * Particle count auto-tunes from measured frame time (see `_autoTune`), so a
 * weak machine degrades smoothly instead of stuttering. `prefers-reduced-
 * motion` and AURA's own Reduce Motion setting collapse it to a calm static
 * render with no orbital animation.
 *
 * @module avatar/providers/sphere
 */

import { AvatarProvider } from './base.js';

/**
 * Per-state visual parameters. Everything the sphere does is a blend toward
 * one of these, so adding a state is a data change, not a code change.
 * @type {Record<string, {spin:number, coreGlow:number, particleMul:number,
 *   waveAmp:number, hueShift:number, jitter:number, scan:number, label:string}>}
 */
export const SPHERE_STATES = {
  idle:       { spin: 0.10, coreGlow: 0.55, particleMul: 1.00, waveAmp: 0.30, hueShift: 0,   jitter: 0.00, scan: 0,   label: 'Idle' },
  listening:  { spin: 0.16, coreGlow: 0.95, particleMul: 1.35, waveAmp: 1.00, hueShift: 6,   jitter: 0.05, scan: 0,   label: 'Listening' },
  thinking:   { spin: 0.42, coreGlow: 0.80, particleMul: 1.15, waveAmp: 0.55, hueShift: -6,  jitter: 0.22, scan: 0,   label: 'Thinking' },
  planning:   { spin: 0.28, coreGlow: 0.75, particleMul: 1.20, waveAmp: 0.40, hueShift: -12, jitter: 0.06, scan: 0.4, label: 'Planning' },
  executing:  { spin: 0.62, coreGlow: 1.00, particleMul: 1.30, waveAmp: 0.70, hueShift: -18, jitter: 0.10, scan: 0,   label: 'Executing' },
  success:    { spin: 0.20, coreGlow: 1.60, particleMul: 1.45, waveAmp: 0.90, hueShift: 10,  jitter: 0.00, scan: 0,   label: 'Success' },
  error:      { spin: 0.14, coreGlow: 0.90, particleMul: 0.85, waveAmp: 1.20, hueShift: -46, jitter: 0.55, scan: 0,   label: 'Error' },
  connecting: { spin: 0.34, coreGlow: 0.85, particleMul: 1.10, waveAmp: 0.50, hueShift: -4,  jitter: 0.04, scan: 1.0, label: 'Connecting' },
  connected:  { spin: 0.22, coreGlow: 1.45, particleMul: 1.40, waveAmp: 0.80, hueShift: 8,   jitter: 0.00, scan: 0,   label: 'Connected' },
};

/** States that are a momentary flash, and what they fall back to. */
const TRANSIENT = { success: 1500, error: 2600, connected: 2000 };

/** Quality tiers: particle budget per tier. */
const QUALITY = { low: 260, medium: 620, high: 1100 };

export class SphereAvatarProvider extends AvatarProvider {
  static get id() { return 'sphere'; }
  static get label() { return 'AI Sphere (gold)'; }
  static get description() {
    return 'A golden energy sphere that reacts to what the agent is actually '
         + 'doing — listening, thinking, planning, executing. Canvas-rendered, '
         + 'works offline, cheap on a weak GPU.';
  }

  static get capabilities() {
    return {
      lipSync: true,      // the core pulses with speech energy
      blink: false,       // no eyes
      emotions: true,     // colour temperature shifts with emotion
      gestures: true,     // impulses become shockwaves
      customise: true,    // accent colour follows the theme
      offline: true,
    };
  }

  static async isAvailable() {
    if (typeof document === 'undefined') return { ok: false, reason: 'No DOM.' };
    const c = document.createElement('canvas');
    return c.getContext && c.getContext('2d')
      ? { ok: true }
      : { ok: false, reason: 'This browser has no 2D canvas context.' };
  }

  constructor(container, options = {}) {
    super(container, options);
    this.canvas = null;
    this.ctx = null;
    this.dpr = 1;
    this.w = 0; this.h = 0;

    /** @type {string} */
    this.agentState = 'idle';
    this._stateAt = 0;
    this._revertTo = 'idle';
    /** Smoothly interpolated visual params, so state changes never snap. */
    this._cur = { ...SPHERE_STATES.idle };

    this.rot = 0;
    this.time = 0;
    /** @type {Array<{lat:number, lon:number, r:number, speed:number, size:number}>} */
    this.particles = [];
    /** @type {Array<{at:number, strength:number}>} */
    this.shockwaves = [];
    this.quality = 'high';
    this.budget = QUALITY.high;

    // Frame-time samples for auto-tuning.
    this._frames = [];
    this._tuned = false;
    this.reducedMotion = false;

    this.accent = '#f5b23c';
    this.accent2 = '#ff8a3c';

    // Interactive 3D mouse roll & tilt state
    this.mouseTiltX = 0;
    this.mouseTiltY = 0;
    this.targetTiltX = 0;
    this.targetTiltY = 0;
    this.isHovered = false;
    this._onMouseMove = null;
    this._onMouseLeave = null;
  }

  async init() {
    try {
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'sphere-canvas';
      this.canvas.setAttribute('aria-hidden', 'true');
      Object.assign(this.canvas.style, {
        position: 'absolute', inset: '0', width: '100%', height: '100%',
        display: 'block',
      });
      this.container.appendChild(this.canvas);
      this.ctx = this.canvas.getContext('2d', { alpha: true });
      if (!this.ctx) { this.failureReason = 'No 2D context.'; return false; }

      // Mouse interaction for interactive 3D roll & tilt
      this._onMouseMove = (e) => {
        if (!this.container) return;
        const rect = this.container.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dx = (e.clientX - cx) / Math.max(1, rect.width / 2);
        const dy = (e.clientY - cy) / Math.max(1, rect.height / 2);
        if (Math.abs(dx) <= 2.5 && Math.abs(dy) <= 2.5) {
          this.targetTiltY = Math.max(-1.2, Math.min(1.2, dx * 0.9));
          this.targetTiltX = Math.max(-1.2, Math.min(1.2, -dy * 0.9));
          this.isHovered = true;
        } else {
          this.targetTiltX = 0;
          this.targetTiltY = 0;
          this.isHovered = false;
        }
      };
      this._onMouseLeave = () => {
        this.targetTiltX = 0;
        this.targetTiltY = 0;
        this.isHovered = false;
      };
      window.addEventListener('mousemove', this._onMouseMove);
      this.container.addEventListener('mouseleave', this._onMouseLeave);

      this._readTheme();
      this._readMotionPreference();
      this.resize();
      this._seed(this.budget);

      // BUG: init() can run before the container has been laid out, so the
      // first measurement was 0x0 (clamped to 1x1) and every frame afterwards
      // drew a 1px sphere stretched across the stage. Nothing re-measured
      // because the manager only calls resize() on window resize.
      // A ResizeObserver fixes it at the source: the canvas tracks the host
      // whenever it changes, including the very first layout pass.
      if (typeof ResizeObserver !== 'undefined') {
        this._ro = new ResizeObserver(() => this.resize());
        this._ro.observe(this.container);
      } else {
        // Fallback for environments without ResizeObserver.
        requestAnimationFrame(() => this.resize());
      }

      this.initialized = true;
      return true;
    } catch (e) {
      this.failureReason = e?.message || String(e);
      return false;
    }
  }

  /** Pull the accent from the live theme so the sphere always matches. */
  _readTheme() {
    try {
      const cs = getComputedStyle(document.documentElement);
      const a = cs.getPropertyValue('--accent').trim();
      const b = cs.getPropertyValue('--accent-2').trim();
      if (a) this.accent = a;
      if (b) this.accent2 = b;
    } catch { /* defaults stand */ }
  }

  _readMotionPreference() {
    try {
      this.reducedMotion = window.matchMedia
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch { this.reducedMotion = false; }
  }

  /** Honour AURA's own Reduce Motion setting as well as the OS one. */
  setReducedMotion(on) { this.reducedMotion = !!on; }

  /**
   * Drive the sphere from real agent activity.
   * @param {string} state one of SPHERE_STATES
   */
  setAgentState(state) {
    if (!SPHERE_STATES[state]) return false;
    // A transient state remembers what to fall back to, so a success pulse
    // during execution returns to executing, not to idle.
    if (!TRANSIENT[state]) this._revertTo = state;
    this.agentState = state;
    this._stateAt = this.time;
    if (state === 'success' || state === 'connected') {
      this.shockwaves.push({ at: this.time, strength: 1 });
    }
    return true;
  }

  /** @returns {string} */
  getAgentState() { return this.agentState; }

  setQuality(level) {
    if (!QUALITY[level]) return false;
    this.quality = level;
    this.budget = QUALITY[level];
    this._seed(this.budget);
    this._tuned = true;           // an explicit choice disables auto-tuning
    return true;
  }

  /** Rebuild the particle field. */
  _seed(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      // Even distribution over the sphere: acos gives equal-area latitudes,
      // so particles do not bunch at the poles the way naive random does.
      out.push({
        lat: Math.acos(2 * Math.random() - 1),
        lon: Math.random() * Math.PI * 2,
        r: 0.82 + Math.random() * 0.2,
        speed: 0.35 + Math.random() * 1.1,
        size: Math.random() < 0.08 ? 1.9 : 0.85 + Math.random() * 0.7,
      });
    }
    this.particles = out;
  }

  resize() {
    if (!this.canvas) return;
    const r = this.container.getBoundingClientRect();
    // A zero measurement means "not laid out yet". Clamping it to 1px is what
    // produced a 1x1 canvas stretched over the whole stage; skipping instead
    // leaves the last good size until the ResizeObserver reports a real one.
    if (r.width < 2 || r.height < 2) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.round(r.width);
    this.h = Math.round(r.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  /**
   * Lower the particle budget if we are missing frame budget.
   * Measured, not guessed: a weak machine finds its own level.
   */
  _autoTune(dt) {
    if (this._tuned || this._frames.length > 200) return;
    this._frames.push(dt);
    if (this._frames.length < 90) return;
    const avg = this._frames.reduce((a, b) => a + b, 0) / this._frames.length;
    this._frames.length = 0;
    if (avg > 0.033 && this.budget > QUALITY.low) {           // under 30fps
      this.budget = this.budget > QUALITY.medium ? QUALITY.medium : QUALITY.low;
      this.quality = this.budget === QUALITY.medium ? 'medium' : 'low';
      this._seed(this.budget);
    } else if (avg < 0.014 && this.budget < QUALITY.high) {   // comfortably 60fps+
      this.budget = QUALITY.high; this.quality = 'high';
      this._seed(this.budget);
    }
  }

  /**
   * Render one frame.
   * @param {import('../animation-engine.js').AvatarPose} pose
   */
  applyPose(pose) {
    if (!this.initialized || !this.ctx) return;
    const dt = Math.min(pose?.dt ?? 0.016, 0.1);
    this.time = pose?.t ?? (this.time + dt);
    this._autoTune(dt);

    // Speech and listening from the engine override an idle agent state, so
    // the sphere reacts to the microphone with no extra wiring.
    let want = this.agentState;
    if (TRANSIENT[want] && (this.time - this._stateAt) * 1000 > TRANSIENT[want]) {
      want = this.agentState = this._revertTo;
    }
    if (want === 'idle') {
      if (pose?.listening) want = 'listening';
      else if (pose?.speaking) want = 'executing';
    }
    const target = SPHERE_STATES[want] || SPHERE_STATES.idle;

    // Ease toward the target so state changes read as a transition.
    const k = this.reducedMotion ? 1 : Math.min(1, dt * 3.2);
    for (const key of Object.keys(target)) {
      if (typeof target[key] !== 'number') continue;
      this._cur[key] = (this._cur[key] ?? target[key])
        + (target[key] - (this._cur[key] ?? target[key])) * k;
    }

    if (!this.reducedMotion) this.rot += dt * this._cur.spin;

    // Smooth damp 3D mouse tilt
    const tiltDamp = Math.min(1, dt * 10);
    this.mouseTiltX += (this.targetTiltX - this.mouseTiltX) * tiltDamp;
    this.mouseTiltY += (this.targetTiltY - this.mouseTiltY) * tiltDamp;

    this._draw(pose, want);
  }

  /** Parse "#rrggbb" once per frame — cheap and avoids a colour lib. */
  _rgb(hex) {
    const h = String(hex || '').replace('#', '');
    const n = h.length === 3
      ? h.split('').map(c => parseInt(c + c, 16))
      : [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    return n.some(Number.isNaN) ? [245, 178, 60] : n;
  }

  _draw(pose, stateName) {
    const ctx = this.ctx;
    const W = this.w, H = this.h;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const cx = W / 2, cy = H / 2;
    const R = Math.min(W, H) * 0.30;
    const cur = this._cur;
    const energy = Math.max(pose?.energy ?? 0, pose?.mouthOpen ?? 0);

    let [ar, ag, ab] = this._rgb(this.accent);
    let [a2r, a2g, a2b] = this._rgb(this.accent2);
    // hueShift is applied as a channel tilt: negative = hotter/redder, positive = brighter/yellower.
    const hs = cur.hueShift;
    ar = Math.max(0, Math.min(255, ar + (hs < 0 ? 15 : 0)));
    ag = Math.max(0, Math.min(255, ag + hs));
    ab = Math.max(0, Math.min(255, ab + hs * 2.2));
    const A = (a) => `rgba(${ar|0},${ag|0},${ab|0},${a})`;
    const A2 = (a) => `rgba(${a2r|0},${a2g|0},${a2b|0},${a})`;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';   // additive = real glow

    /* ── outer atmosphere & coronal flares ────────────────────────── */
    const haloRadius = R * (2.1 + Math.sin(this.time * 1.8) * 0.12 + energy * 0.4);
    const halo = ctx.createRadialGradient(cx, cy, R * 0.05, cx, cy, haloRadius);
    halo.addColorStop(0, `rgba(255, 235, 170, ${Math.min(0.9, 0.28 * cur.coreGlow)})`);
    halo.addColorStop(0.3, A(0.18 * cur.coreGlow));
    halo.addColorStop(0.65, A2(0.08 * cur.coreGlow));
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, W, H);

    /* ── orbital rings ────────────────────────────────────────────── */
    const rings = this.quality === 'low' ? 4 : 7;
    ctx.lineWidth = 1.2;
    for (let i = 0; i < rings; i++) {
      const p = i / rings;
      const tilt = (this.rot + this.mouseTiltY * 0.8) * (0.5 + p * 0.8) + p * Math.PI + this.mouseTiltX * 0.4;
      const ry = R * (0.28 + p * 0.65) * Math.abs(Math.cos(tilt));
      ctx.strokeStyle = i % 2 === 0 ? A(0.12 + 0.18 * cur.coreGlow * (1 - p * 0.4)) : A2(0.10 + 0.15 * cur.coreGlow);
      ctx.beginPath();
      ctx.ellipse(cx, cy, R * (0.92 + p * 0.22), Math.max(1.2, ry), tilt * 0.4 + this.mouseTiltY * 0.2, 0, Math.PI * 2);
      ctx.stroke();
    }

    /* ── horizontal energy bands: the "voice" of the sphere ───────── */
    const bands = this.quality === 'low' ? 6 : 12;
    for (let i = 0; i < bands; i++) {
      const f = (i / (bands - 1)) * 2 - 1;                 // -1 .. 1
      const yy = cy + f * R * 0.88;
      const halfW = Math.sqrt(Math.max(0, 1 - f * f)) * R;
      const wobble = this.reducedMotion ? 0
        : Math.sin(this.time * (1.8 + i * 0.25) + i) * 3.2
          * cur.waveAmp * (0.45 + energy * 2.0);
      ctx.strokeStyle = i % 3 === 0 ? A2(0.12 + 0.25 * cur.coreGlow) : A(0.08 + 0.22 * cur.coreGlow * (1 - Math.abs(f) * 0.5));
      ctx.lineWidth = i % 2 === 0 ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(cx - halfW, yy + wobble + this.mouseTiltX * 12);
      ctx.quadraticCurveTo(cx + this.mouseTiltY * 15, yy - wobble * 1.8, cx + halfW, yy + wobble - this.mouseTiltX * 12);
      ctx.stroke();
    }

    /* ── particle shell ───────────────────────────────────────────── */
    const jitter = this.reducedMotion ? 0 : cur.jitter;
    const pr = Math.min(1.6, cur.particleMul);
    const count = Math.floor(this.particles.length * Math.min(1, pr));
    const tx = this.mouseTiltX;
    const ty = this.mouseTiltY;
    const cosX = Math.cos(tx), sinX = Math.sin(tx);
    for (let i = 0; i < count; i++) {
      const p = this.particles[i];
      const lon = p.lon + (this.reducedMotion ? 0 : (this.rot + ty * 0.6) * p.speed);
      const sl = Math.sin(p.lat), cl = Math.cos(p.lat);
      let x3 = sl * Math.cos(lon), y3 = cl, z3 = sl * Math.sin(lon);
      if (Math.abs(tx) > 0.001) {
        const ny = y3 * cosX - z3 * sinX;
        const nz = y3 * sinX + z3 * cosX;
        y3 = ny; z3 = nz;
      }
      const depth = (z3 + 1) / 2;
      let rr = p.r * R;
      if (jitter) rr += Math.sin(this.time * 6 + i) * jitter * 8;
      const x = cx + x3 * rr;
      const y = cy + y3 * rr * 0.98;
      const a = (0.12 + depth * 0.70) * cur.coreGlow;
      ctx.fillStyle = i % 4 === 0 ? A2(Math.min(0.95, a * 1.2)) : A(Math.min(0.9, a));
      const s = p.size * (0.65 + depth * 1.0);
      ctx.fillRect(x - s / 2, y - s / 2, s, s);
    }

    /* ── scanning sweep (connecting / planning) ───────────────────── */
    if (cur.scan > 0.02 && !this.reducedMotion) {
      const sweep = ((this.time * 0.6) % 1) * 2 - 1;
      const sy = cy + sweep * R;
      const g = ctx.createLinearGradient(0, sy - 30, 0, sy + 30);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.5, A(0.35 * cur.scan));
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(cx - R * 1.2, sy - 30, R * 2.4, 60);
    }

    /* ── shockwaves from gesture impulses and success ─────────────── */
    const imp = pose?.impulse || {};
    for (const k2 of Object.keys(imp)) {
      if (imp[k2] > 0.85) this.shockwaves.push({ at: this.time, strength: imp[k2] });
    }
    this.shockwaves = this.shockwaves.filter(s => this.time - s.at < 1.1);
    for (const s of this.shockwaves) {
      const age = (this.time - s.at) / 1.1;
      ctx.strokeStyle = A2((1 - age) * 0.7 * s.strength);
      ctx.lineWidth = 2.5 * (1 - age) + 0.5;
      ctx.beginPath();
      ctx.arc(cx, cy, R * (0.9 + age * 1.6), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.lineWidth = 1;

    /* ── dual-layer core ──────────────────────────────────────────── */
    const pulse = this.reducedMotion ? 1
      : 1 + Math.sin(this.time * 2.2) * 0.06 + energy * 0.40;
    const coreR = R * 0.32 * pulse;
    const core = ctx.createRadialGradient(cx + this.mouseTiltY * 12, cy - this.mouseTiltX * 12, 0, cx + this.mouseTiltY * 12, cy - this.mouseTiltX * 12, coreR);
    core.addColorStop(0, `rgba(255,255,255,${Math.min(1.0, 0.85 * cur.coreGlow)})`);
    core.addColorStop(0.25, `rgba(255,240,200,${Math.min(0.9, 0.65 * cur.coreGlow)})`);
    core.addColorStop(0.6, A(0.55 * cur.coreGlow));
    core.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(cx + this.mouseTiltY * 12, cy - this.mouseTiltX * 12, coreR, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  dispose() {
    if (this._onMouseMove) window.removeEventListener('mousemove', this._onMouseMove);
    if (this._onMouseLeave && this.container) this.container.removeEventListener('mouseleave', this._onMouseLeave);
    try { this._ro?.disconnect(); } catch { /* nothing observing */ }
    this._ro = null;
    try { this.canvas?.remove(); } catch { /* already gone */ }
    this.canvas = null;
    this.ctx = null;
    this.particles = [];
    this.shockwaves = [];
    this.initialized = false;
  }

  /** Extra detail for the Avatar Manager. */
  describe() {
    const base = super.describe();
    return {
      ...base,
      detail: `${this.particles.length} particles · ${this.quality} quality · `
            + `state: ${SPHERE_STATES[this.agentState]?.label || this.agentState}`,
    };
  }
}

export default SphereAvatarProvider;

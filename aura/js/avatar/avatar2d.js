/**
 * AURA :: 2D Canvas Avatar (fallback + low-power mode)
 * ----------------------------------------------------
 * Used when WebGL is unavailable or the user picks "2D" in settings.
 * Implements the SAME animation contract as Avatar3D: blink, idle,
 * lip-sync from viseme events, emotion poses, gesture reactions.
 */

import { bus, EV } from '../core/bus.js';
import { state } from '../core/state.js';

const EMO = {
  neutral:   { brow: 0, browTilt: 0, eye: 1, curve: 0 },
  happy:     { brow: 3, browTilt: 0, eye: 0.88, curve: 12 },
  excited:   { brow: 6, browTilt: 0, eye: 1.15, curve: 16 },
  confident: { brow: 2, browTilt: 4, eye: 0.95, curve: 6 },
  focused:   { brow: -4, browTilt: 0, eye: 0.82, curve: -2 },
  confused:  { brow: 2, browTilt: 9, eye: 1.05, curve: -4 },
  sad:       { brow: 5, browTilt: -8, eye: 0.9, curve: -11 },
  angry:     { brow: -8, browTilt: 10, eye: 0.85, curve: -8 },
  surprised: { brow: 9, browTilt: 0, eye: 1.3, curve: 3 },
  listening: { brow: 4, browTilt: 2, eye: 1.1, curve: 3 },
};

const VIS = {
  sil: [0.9, 0.05], MBP: [0.85, 0.04], FV: [1.0, 0.18], S: [0.8, 0.2],
  L: [0.95, 0.34], K: [1.0, 0.42], E: [1.15, 0.5], AI: [1.05, 0.9],
  O: [0.66, 0.8], U: [0.55, 0.5],
};

const lerp = (a, b, t) => a + (b - a) * t;
const damp = (a, b, l, dt) => lerp(a, b, 1 - Math.exp(-l * dt));

export class Avatar2D {
  constructor(container) {
    this.container = container;
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'width:100%;height:100%;display:block;';
    this.ctx = this.canvas.getContext('2d');
    this.ok = false;
    this.time = 0;
    this.enabled = true;

    this.blink = { closed: 0, phase: 'open', t: 0, next: 2.5 };
    this.emotion = 'neutral';
    this.cur = { ...EMO.neutral };
    this.target = { ...EMO.neutral };
    this.mouth = { w: 0.9, h: 0.05, tw: 0.9, th: 0.05 };
    this.queue = [];
    this.speaking = false;
    this.gaze = { x: 0, y: 0, tx: 0, ty: 0, next: 2 };
    this._mouseGaze = { x: 0, y: 0, active: false };
    if (typeof window !== 'undefined') {
      window.addEventListener('mousemove', (e) => {
        const cx = window.innerWidth / 2;
        const cy = window.innerHeight / 2;
        const nx = (e.clientX - cx) / cx;
        const ny = (e.clientY - cy) / cy;
        this._mouseGaze.x = Math.max(-1, Math.min(1, nx));
        this._mouseGaze.y = Math.max(-1, Math.min(1, ny));
        this._mouseGaze.active = true;
      });
    }
    this.impulse = { nod: 0, tilt: 0, pulse: 0, shake: 0 };
    this.energy = 0.35;
    this._listeners = [];
    this._raf = null;
  }

  async init() {
    this.container.appendChild(this.canvas);
    this.resize();
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this._wire();
    this.ok = true;
    this.lastT = performance.now();
    this._loop();
    return true;
  }

  _wire() {
    const add = (e, f) => this._listeners.push(bus.on(e, f));
    add(EV.TTS_START, () => { this.speaking = true; this.energy = 1; });
    add(EV.TTS_END, () => { this.speaking = false; this.queue.length = 0; });
    add(EV.TTS_INTERRUPT, () => { this.speaking = false; this.queue.length = 0; this.impulse.shake = 0.6; });
    add(EV.TTS_VISEME, ({ visemes }) => this.push(visemes));
    add(EV.AVATAR_EMOTION, ({ emotion }) => this.setEmotion(emotion));
    add(EV.AI_STREAM_START, () => { this.energy = 0.9; this.setEmotion('focused', 900); });
    add(EV.AI_STREAM_END, () => { this.energy = 0.5; });
    add(EV.STT_START, () => { this.setEmotion('listening'); this.energy = 0.8; });
    add(EV.GESTURE, ({ gesture }) => this.reactToGesture(gesture));
  }

  setEmotion(name, hold = 0) {
    const e = EMO[name] ? name : 'neutral';
    this.emotion = e;
    this.target = { ...EMO[e] };
    state.set({ avatarEmotion: e });
    if (hold) {
      clearTimeout(this._t);
      this._t = setTimeout(() => { if (this.emotion === e) { this.emotion = 'neutral'; this.target = { ...EMO.neutral }; } }, hold);
    }
  }

  reactToGesture(g) {
    const map = {
      wave: () => { this.impulse.nod = 1; this.setEmotion('happy', 3000); },
      thumbs_up: () => { this.impulse.nod = 1; this.setEmotion('confident', 2500); },
      thumbs_down: () => { this.impulse.shake = 1; this.setEmotion('sad', 2500); },
      peace: () => { this.impulse.tilt = 1; this.setEmotion('excited', 2500); },
      open_palm: () => { this.impulse.pulse = 1; this.setEmotion('listening', 3000); },
      pointing: () => { this.impulse.tilt = 0.6; this.setEmotion('focused', 2200); },
      fist: () => { this.impulse.pulse = 0.8; this.setEmotion('confident', 2000); },
      ok: () => { this.impulse.nod = 0.8; this.setEmotion('happy', 2200); },
      rock: () => { this.impulse.tilt = 1; this.setEmotion('excited', 2400); },
    };
    (map[g] || (() => { this.impulse.pulse = 0.4; }))();
  }

  push(visemes) {
    if (!visemes?.length) return;
    const now = performance.now();
    for (const v of visemes) this.queue.push({ at: now + v.t, v: v.viseme });
    if (this.queue.length > 90) this.queue.splice(0, this.queue.length - 90);
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.container.clientWidth || 400;
    const h = this.container.clientHeight || 400;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w; this.h = h;
  }

  update(dt) {
    this.time += dt;
    for (const k of Object.keys(this.target)) this.cur[k] = damp(this.cur[k], this.target[k], 6, dt);

    const b = this.blink;
    b.t += dt;
    if (b.phase === 'open' && b.t >= b.next) { b.phase = 'closing'; b.t = 0; }
    else if (b.phase === 'closing') { b.closed = Math.min(1, b.closed + dt * 16); if (b.closed >= 1) b.phase = 'opening'; }
    else if (b.phase === 'opening') {
      b.closed = Math.max(0, b.closed - dt * 9);
      if (b.closed <= 0) { b.phase = 'open'; b.t = 0; b.next = Math.random() < 0.13 ? 0.22 : 2 + Math.random() * 5; }
    }

    const now = performance.now();
    let applied = null;
    while (this.queue.length && this.queue[0].at <= now) applied = this.queue.shift();
    if (applied) { const s = VIS[applied.v] || VIS.sil; this.mouth.tw = s[0]; this.mouth.th = s[1]; }
    if (!this.speaking && !this.queue.length) { this.mouth.tw = 0.9; this.mouth.th = 0.05; }
    const l = this.speaking ? 22 : 8;
    this.mouth.w = damp(this.mouth.w, this.mouth.tw, l, dt);
    this.mouth.h = damp(this.mouth.h, this.mouth.th, l, dt);

    // ── gaze tracking: follow mouse pointer or natural saccades
    if (this._mouseGaze?.active) {
      this.gaze.tx = this._mouseGaze.x * 0.8;
      this.gaze.ty = this._mouseGaze.y * 0.6;
    } else {
      this.gaze.next -= dt;
      if (this.gaze.next <= 0) {
        this.gaze.tx = (Math.random() - 0.5) * 0.5;
        this.gaze.ty = (Math.random() - 0.5) * 0.3;
        this.gaze.next = 0.8 + Math.random() * 2.6;
      }
    }
    this.gaze.x = damp(this.gaze.x, this.gaze.tx, 14, dt);
    this.gaze.y = damp(this.gaze.y, this.gaze.ty, 14, dt);

    for (const k of Object.keys(this.impulse)) this.impulse[k] = Math.max(0, this.impulse[k] - dt * 1.7);
    this.energy = damp(this.energy, this.speaking ? 1 : 0.35, 2.2, dt);
  }

  draw() {
    const ctx = this.ctx, W = this.w, H = this.h, t = this.time;
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2;
    const cy = H / 2 + Math.sin(t * 1.15) * 4;
    const R = Math.min(W, H) * 0.29 * (1 + this.impulse.pulse * 0.05);

    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#22d3ee';
    const accent2 = getComputedStyle(document.documentElement).getPropertyValue('--accent-2').trim() || '#a855f7';

    const tilt = this.impulse.tilt * Math.sin(this.impulse.tilt * Math.PI * 2) * 0.3
      + Math.sin(t * 0.42) * 0.03;
    const nod = Math.sin(this.impulse.nod * Math.PI * 2.6) * 0.34 * this.impulse.nod;

    ctx.save();
    ctx.translate(cx, cy + nod * 14);
    ctx.rotate(tilt);

    // orbit rings
    for (let i = 0; i < 3; i++) {
      ctx.save();
      ctx.rotate(t * (0.3 - i * 0.12) + i);
      ctx.strokeStyle = i === 1 ? accent2 : accent;
      ctx.globalAlpha = (0.32 - i * 0.07) * (0.6 + this.energy * 0.7);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.ellipse(0, 0, R * (1.42 + i * 0.2), R * (0.42 + i * 0.16), 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // orbiting nodes
    for (let i = 0; i < 12; i++) {
      const a = t * (0.3 + (i % 4) * 0.1) + (i / 12) * Math.PI * 2;
      const rr = R * (1.45 + (i % 3) * 0.18);
      ctx.beginPath();
      ctx.fillStyle = i % 3 === 0 ? accent2 : accent;
      ctx.globalAlpha = 0.35 + Math.abs(Math.sin(t * 2 + i)) * 0.5;
      ctx.arc(Math.cos(a) * rr, Math.sin(a) * rr * 0.45, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // head glow
    const grad = ctx.createRadialGradient(0, 0, R * 0.2, 0, 0, R * 1.5);
    grad.addColorStop(0, hexA(accent, 0.3 + this.energy * 0.22));
    grad.addColorStop(0.6, hexA(accent, 0.08));
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, R * 1.5, 0, Math.PI * 2);
    ctx.fill();

    // head shell
    ctx.save();
    ctx.shadowColor = accent;
    ctx.shadowBlur = 26;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2.4;
    ctx.fillStyle = 'rgba(6,32,52,0.55)';
    ctx.beginPath();
    ctx.ellipse(0, 0, R * 0.9, R * 1.1, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // wireframe latitude lines
    ctx.strokeStyle = hexA(accent, 0.2);
    ctx.lineWidth = 1;
    for (let i = 1; i < 6; i++) {
      const yy = -R * 1.1 + (R * 2.2 * i) / 6;
      const rw = Math.sqrt(Math.max(0, 1 - Math.pow(yy / (R * 1.1), 2))) * R * 0.9;
      ctx.beginPath();
      ctx.ellipse(0, yy, rw, rw * 0.16, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    // scan line
    const scanY = ((t * 0.42) % 2.4 - 1.2) * R;
    ctx.strokeStyle = hexA('#7ef0ff', 0.12 + this.energy * 0.24);
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(-R * 0.9, scanY);
    ctx.lineTo(R * 0.9, scanY);
    ctx.stroke();

    // eyes
    const eyeY = -R * 0.14;
    const eyeDX = R * 0.36;
    const open = Math.max(0.03, (1 - this.blink.closed) * this.cur.eye);
    for (const side of [-1, 1]) {
      const ex = side * eyeDX;
      ctx.save();
      ctx.shadowColor = accent;
      ctx.shadowBlur = 16;
      // socket
      ctx.fillStyle = 'rgba(2,18,30,0.9)';
      ctx.beginPath();
      ctx.ellipse(ex, eyeY, R * 0.19, R * 0.19 * open, 0, 0, Math.PI * 2);
      ctx.fill();
      // iris
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.95;
      ctx.beginPath();
      ctx.ellipse(ex + this.gaze.x * R * 0.05, eyeY + this.gaze.y * R * 0.04, R * 0.13, R * 0.13 * open, 0, 0, Math.PI * 2);
      ctx.fill();
      // pupil
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.ellipse(ex + this.gaze.x * R * 0.07, eyeY + this.gaze.y * R * 0.055, R * 0.055 * (0.7 + this.energy * 0.5), R * 0.055 * open, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      // halo
      ctx.strokeStyle = hexA(accent, 0.2 + this.energy * 0.4);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(ex, eyeY, R * 0.22 * (1 + this.impulse.pulse * 0.2), R * 0.22 * open, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    // brows
    ctx.strokeStyle = accent;
    ctx.lineWidth = 3.2;
    ctx.lineCap = 'round';
    for (const side of [-1, 1]) {
      const ex = side * eyeDX;
      const by = eyeY - R * 0.32 - this.cur.brow * (R * 0.012);
      const tiltB = (this.cur.browTilt * side) * 0.012;
      ctx.beginPath();
      ctx.moveTo(ex - R * 0.16, by + tiltB * R);
      ctx.lineTo(ex + R * 0.16, by - tiltB * R);
      ctx.stroke();
    }

    // mouth
    const my = R * 0.46;
    const mw = R * 0.34 * this.mouth.w;
    const mh = R * 0.34 * this.mouth.h;
    ctx.save();
    ctx.shadowColor = accent;
    ctx.shadowBlur = 14;
    ctx.fillStyle = 'rgba(0,16,26,0.85)';
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    if (mh < R * 0.05) {
      // closed: a curved line reflecting emotion
      ctx.moveTo(-mw, my);
      ctx.quadraticCurveTo(0, my + this.cur.curve * R * 0.012, mw, my);
      ctx.stroke();
    } else {
      ctx.ellipse(0, my, mw, mh, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();

    ctx.restore();

    // HUD arc around the head
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = hexA(accent, 0.5);
    ctx.lineWidth = 2;
    const a0 = t * 0.6;
    ctx.beginPath(); ctx.arc(0, 0, R * 1.62, a0, a0 + 1.0); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, R * 1.62, a0 + Math.PI, a0 + Math.PI + 0.6); ctx.stroke();
    ctx.strokeStyle = hexA(accent2, 0.4);
    ctx.beginPath(); ctx.arc(0, 0, R * 1.75, -a0 * 0.7, -a0 * 0.7 + 0.8); ctx.stroke();
    ctx.restore();
  }

  _loop() {
    const step = () => {
      this._raf = requestAnimationFrame(step);
      const now = performance.now();
      let dt = (now - this.lastT) / 1000;
      this.lastT = now;
      if (dt > 0.05) dt = 0.05;
      if (this.enabled && this.ok) { this.update(dt); this.draw(); }
    };
    this._raf = requestAnimationFrame(step);
  }

  setQuality() {}

  dispose() {
    if (this._raf) cancelAnimationFrame(this._raf);
    for (const off of this._listeners) off();
    window.removeEventListener('resize', this._onResize);
    if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    this.ok = false;
  }
}

function hexA(hex, a) {
  const h = hex.replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const n = parseInt(full.slice(0, 6), 16);
  if (Number.isNaN(n)) return `rgba(34,211,238,${a})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export default Avatar2D;

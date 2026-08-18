/**
 * AURA :: Animation Engine
 * ========================
 * The animation system, completely independent of how an avatar is drawn.
 *
 * WHY THIS EXISTS
 * ---------------
 * Lip-sync, blinking, idle motion, emotions, gesture reactions and waving were
 * previously duplicated inside each renderer (avatar-body, avatar3d, avatar2d).
 * Adding a VRM or Ready Player Me avatar would have meant a fourth copy.
 *
 * Now there is exactly one implementation. It owns the *state* of the
 * performance — how open the mouth is, how closed the eyelids are, how far
 * through a wave we are — and hands that state to whichever provider is
 * active. A provider only has to answer: "given this pose, draw yourself."
 *
 *      AnimationEngine  ──pose──▶  AvatarProvider (built-in / VRM / RPM)
 *
 * The engine subscribes to the event bus itself, so a provider never has to
 * know that TTS, vision or the AI exist. Swapping providers cannot break
 * lip-sync, because lip-sync does not live in the provider.
 *
 * @module avatar/animation-engine
 */

import { bus, EV } from '../core/bus.js';
import { state } from '../core/state.js';

/**
 * Emotion targets. Each value is a normalised 0..1 (or -1..1) channel that a
 * provider maps onto its own rig — bone rotations, morph targets, or 2D
 * drawing parameters.
 *
 * @typedef {Object} EmotionPose
 * @property {number} brow      -1 furrowed … +1 raised
 * @property {number} eyeOpen    0 closed … 1 wide
 * @property {number} mouthCurve -1 frown … +1 smile
 * @property {number} posture   -1 slumped … +1 upright
 * @property {number} energy     0 still … 1 animated
 */

/** @type {Record<string, EmotionPose>} */
export const EMOTIONS = {
  neutral:   { brow: 0.00, eyeOpen: 1.00, mouthCurve: 0.05, posture: 0.00, energy: 0.45 },
  happy:     { brow: 0.30, eyeOpen: 0.88, mouthCurve: 0.75, posture: 0.25, energy: 0.75 },
  excited:   { brow: 0.55, eyeOpen: 1.00, mouthCurve: 0.85, posture: 0.45, energy: 1.00 },
  confident: { brow: 0.15, eyeOpen: 0.95, mouthCurve: 0.35, posture: 0.60, energy: 0.65 },
  focused:   { brow: -0.25, eyeOpen: 0.85, mouthCurve: 0.00, posture: 0.30, energy: 0.55 },
  listening: { brow: 0.20, eyeOpen: 1.00, mouthCurve: 0.15, posture: 0.15, energy: 0.60 },
  thinking:  { brow: -0.15, eyeOpen: 0.75, mouthCurve: -0.05, posture: -0.10, energy: 0.35 },
  surprised: { brow: 0.80, eyeOpen: 1.00, mouthCurve: 0.20, posture: 0.20, energy: 0.85 },
  sad:       { brow: -0.40, eyeOpen: 0.70, mouthCurve: -0.55, posture: -0.45, energy: 0.25 },
  concerned: { brow: -0.30, eyeOpen: 0.90, mouthCurve: -0.25, posture: -0.10, energy: 0.40 },
};

/** Gesture impulses a provider can render. 0..1, decaying over time. */
export const IMPULSES = ['nod', 'tilt', 'pulse', 'shake', 'wave', 'point', 'thumb', 'cheer'];

/** How wide the mouth opens for each viseme. Shared by every provider. */
export const VISEME_OPEN = {
  sil: 0, MBP: 0.02, FV: 0.16, S: 0.20, L: 0.30,
  K: 0.36, U: 0.34, E: 0.50, O: 0.66, AI: 0.85,
};

/**
 * Which gesture triggers which impulse + emotion.
 * This is the "wave back when the user waves" mapping, in ONE place, so it
 * works identically for every avatar provider.
 */
export const GESTURE_REACTIONS = {
  wave:        { impulse: 'wave',  emotion: 'happy',     hold: 3400 },
  thumbs_up:   { impulse: 'thumb', emotion: 'confident', hold: 2800 },
  thumbs_down: { impulse: 'shake', emotion: 'sad',       hold: 2600 },
  peace:       { impulse: 'cheer', emotion: 'excited',   hold: 2800 },
  open_palm:   { impulse: 'pulse', emotion: 'listening', hold: 3200 },
  pointing:    { impulse: 'point', emotion: 'focused',   hold: 2400 },
  fist:        { impulse: 'pulse', emotion: 'confident', hold: 2000, strength: 0.8 },
  ok:          { impulse: 'nod',   emotion: 'happy',     hold: 2400, strength: 0.9 },
  rock:        { impulse: 'cheer', emotion: 'excited',   hold: 2600 },
};

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * @typedef {Object} AvatarPose
 * @property {number} t            seconds since start
 * @property {number} dt           delta seconds
 * @property {EmotionPose} emotion current interpolated emotion channels
 * @property {string} emotionName
 * @property {number} mouthOpen    0..1 lip-sync aperture
 * @property {string} viseme       current viseme id
 * @property {number} blink        0 open … 1 fully closed
 * @property {number} breath       -1..1 slow breathing cycle
 * @property {number} sway         -1..1 slow idle sway
 * @property {number} energy       0..1
 * @property {boolean} speaking
 * @property {boolean} listening
 * @property {Record<string, number>} impulse  decaying gesture impulses
 * @property {{x:number, y:number}} gaze       -1..1 look direction
 */

export class AnimationEngine {
  /**
   * @param {{autoWire?:boolean}} [opts] autoWire=false is used by tests so the
   *   engine can be driven deterministically with no event bus traffic.
   */
  constructor({ autoWire = true } = {}) {
    this.time = 0;
    this.emotionName = 'neutral';
    /** @type {EmotionPose} */
    this.emotion = { ...EMOTIONS.neutral };
    /** @type {EmotionPose} */
    this.emotionTarget = { ...EMOTIONS.neutral };
    this._emotionTimer = null;

    this.mouthOpen = 0;
    this.mouthTarget = 0;
    this.viseme = 'sil';
    /** @type {Array<{viseme:string, open:number, start:number, until:number}>} */
    this.visemeQueue = [];

    this.blink = 0;
    this._blinkPhase = 'idle';   // idle | closing | closed | opening
    this._blinkT = 0;
    this._nextBlink = 1.6 + Math.random() * 3.2;

    this.energy = 0.45;
    this.speaking = false;
    this.listening = false;
    this.gaze = { x: 0, y: 0 };
    this._gazeTarget = { x: 0, y: 0 };
    this._nextGaze = 2 + Math.random() * 3;

    /** @type {Record<string, number>} */
    this.impulse = Object.fromEntries(IMPULSES.map(k => [k, 0]));

    /** @type {Array<Function>} */
    this._listeners = [];
    if (autoWire) this.wire();
  }

  /* ── event wiring ─────────────────────────────────────────────────── */

  /**
   * Subscribe to everything the performance reacts to.
   * Providers never do this — that is the whole point.
   */
  wire() {
    if (this._listeners.length) return;
    const add = (e, f) => this._listeners.push(bus.on(e, f));

    add(EV.TTS_START, () => { this.speaking = true; this.energy = 1; });
    add(EV.TTS_END, () => this._stopSpeaking());
    add(EV.TTS_INTERRUPT, () => { this._stopSpeaking(); this.impulse.shake = 0.6; });
    add(EV.TTS_VISEME, ({ visemes }) => this.pushVisemes(visemes));

    add(EV.AVATAR_EMOTION, ({ emotion }) => this.setEmotion(emotion));
    add(EV.AVATAR_REACT, ({ type }) => { if (type in this.impulse) this.impulse[type] = 1; });

    add(EV.AI_STREAM_START, () => { this.energy = 0.9; this.setEmotion('focused', 900); });
    add(EV.AI_STREAM_END, () => { this.energy = 0.5; });

    add(EV.STT_START, () => { this.listening = true; this.setEmotion('listening'); this.energy = 0.8; });
    add(EV.STT_END, () => {
      this.listening = false;
      if (this.emotionName === 'listening') this.setEmotion('neutral');
    });

    // THE WAVE-BACK PATH. One mapping, every provider.
    add(EV.GESTURE, ({ gesture }) => this.reactToGesture(gesture));
  }

  unwire() {
    this._listeners.forEach(off => { try { off(); } catch {} });
    this._listeners = [];
  }

  _stopSpeaking() {
    this.speaking = false;
    this.visemeQueue.length = 0;
    this.viseme = 'sil';
    this.mouthTarget = 0;
  }

  /* ── inputs ───────────────────────────────────────────────────────── */

  /** @param {string} name @param {number} [hold] ms before returning to neutral */
  setEmotion(name, hold = 0) {
    const target = EMOTIONS[name];
    if (!target) return false;
    this.emotionName = name;
    this.emotionTarget = { ...target };
    state.set({ avatarEmotion: name });
    clearTimeout(this._emotionTimer);
    if (hold > 0) {
      this._emotionTimer = setTimeout(() => {
        if (this.emotionName === name) this.setEmotion('neutral');
      }, hold);
    }
    return true;
  }

  /**
   * React to a recognised hand gesture.
   * @param {string} g
   * @returns {boolean} whether a reaction was played
   */
  reactToGesture(g) {
    const r = GESTURE_REACTIONS[g];
    if (!r) { this.impulse.pulse = 0.4; return false; }
    this.impulse[r.impulse] = r.strength ?? 1;
    this.setEmotion(r.emotion, r.hold);
    return true;
  }

  /**
   * Queue timed visemes from the speech system.
   * @param {Array<{viseme:string, t:number, dur:number, open:number}>} vs
   */
  pushVisemes(vs) {
    if (!Array.isArray(vs) || !vs.length) return;
    const now = this.time * 1000;
    for (const v of vs) {
      const start = now + (v.t || 0);
      this.visemeQueue.push({
        viseme: v.viseme,
        open: v.open ?? VISEME_OPEN[v.viseme] ?? 0.4,
        start,                              // when it becomes due
        until: start + (v.dur || 90),       // when it stops being current
      });
    }
    if (this.visemeQueue.length > 64) {
      this.visemeQueue.splice(0, this.visemeQueue.length - 64);
    }
  }

  /** Look toward a point in normalised screen space (-1..1). */
  lookAt(x, y) {
    this._gazeTarget.x = Math.max(-1, Math.min(1, x));
    this._gazeTarget.y = Math.max(-1, Math.min(1, y));
    this._nextGaze = 1.4;
  }

  /* ── the tick ─────────────────────────────────────────────────────── */

  /**
   * Advance the performance and return the pose to draw.
   * Deterministic given (dt) apart from blink/gaze randomness, which is why
   * tests drive it with a fixed dt.
   *
   * @param {number} dt seconds
   * @returns {AvatarPose}
   */
  update(dt) {
    const d = Math.min(Math.max(dt || 0.016, 0), 0.1);   // clamp long frames
    this.time += d;
    const t = this.time;

    // emotion easing
    const k = 1 - Math.pow(0.001, d);
    for (const key of Object.keys(this.emotionTarget)) {
      this.emotion[key] = lerp(this.emotion[key], this.emotionTarget[key], k);
    }

    this._updateVisemes(d);
    this._updateBlink(d);
    this._updateGaze(d);

    // impulse decay — 'wave' lingers a little so the gesture reads clearly
    for (const key of IMPULSES) {
      if (this.impulse[key] <= 0) continue;
      const rate = key === 'wave' ? 0.55 : 0.9;
      this.impulse[key] = Math.max(0, this.impulse[key] - d * rate);
    }

    const energyTarget = this.speaking ? 1 : this.emotion.energy;
    this.energy = lerp(this.energy, energyTarget, 1 - Math.pow(0.02, d));

    return {
      t,
      dt: d,
      emotion: this.emotion,
      emotionName: this.emotionName,
      mouthOpen: this.mouthOpen,
      viseme: this.viseme,
      blink: this.blink,
      breath: Math.sin(t * 1.15),
      sway: Math.sin(t * 0.42),
      energy: this.energy,
      speaking: this.speaking,
      listening: this.listening,
      impulse: this.impulse,
      gaze: this.gaze,
    };
  }

  _updateVisemes(d) {
    const now = this.time * 1000;
    // Apply the viseme that is CURRENTLY due, then discard the ones behind it.
    //
    // The old loop only consumed entries whose `until` had already passed,
    // which meant the newest viseme sat in the queue unplayed until it
    // expired — and on a throttled frame loop (headless, background tab, weak
    // GPU) the engine clock advances slower than wall time, so it could
    // expire before it was ever applied. Net effect: the mouth never moved.
    // Now the head of the queue is applied as soon as its start time is
    // reached, which is what "lip-sync" actually means.
    let applied = null;
    while (this.visemeQueue.length) {
      const head = this.visemeQueue[0];
      if (head.start > now) break;         // not due yet
      applied = this.visemeQueue.shift();
      if (head.until > now) break;         // still on screen — stop here
    }
    if (applied) {
      this.viseme = applied.viseme;
      this.mouthTarget = applied.open;
    }
    if (!this.speaking && !this.visemeQueue.length) this.mouthTarget = 0;
    // Fast attack, slower release reads as speech rather than chewing.
    const rate = this.mouthTarget > this.mouthOpen ? 26 : 14;
    this.mouthOpen = lerp(this.mouthOpen, this.mouthTarget, Math.min(1, d * rate));
  }

  _updateBlink(d) {
    // A real blink: ~40ms closing, ~30ms shut, ~90ms opening.
    switch (this._blinkPhase) {
      case 'idle':
        this._nextBlink -= d;
        if (this._nextBlink <= 0) { this._blinkPhase = 'closing'; this._blinkT = 0; }
        break;
      case 'closing':
        this._blinkT += d;
        this.blink = Math.min(1, this._blinkT / 0.04);
        if (this.blink >= 1) { this._blinkPhase = 'closed'; this._blinkT = 0; }
        break;
      case 'closed':
        this._blinkT += d;
        this.blink = 1;
        if (this._blinkT >= 0.03) { this._blinkPhase = 'opening'; this._blinkT = 0; }
        break;
      case 'opening':
        this._blinkT += d;
        this.blink = Math.max(0, 1 - this._blinkT / 0.09);
        if (this.blink <= 0) {
          this._blinkPhase = 'idle';
          this.blink = 0;
          // Blink more often when alert, less when calm.
          this._nextBlink = 1.4 + Math.random() * (this.energy > 0.7 ? 2.2 : 4.0);
        }
        break;
    }
  }

  _updateGaze(d) {
    this._nextGaze -= d;
    if (this._nextGaze <= 0) {
      this._gazeTarget.x = (Math.random() - 0.5) * 0.7;
      this._gazeTarget.y = (Math.random() - 0.5) * 0.4;
      this._nextGaze = 1.8 + Math.random() * 3.4;
    }
    const k = 1 - Math.pow(0.02, d);
    this.gaze.x = lerp(this.gaze.x, this._gazeTarget.x, k);
    this.gaze.y = lerp(this.gaze.y, this._gazeTarget.y, k);
  }

  /** Reset to a clean neutral state (used when switching providers). */
  reset() {
    this.emotionName = 'neutral';
    this.emotion = { ...EMOTIONS.neutral };
    this.emotionTarget = { ...EMOTIONS.neutral };
    this.visemeQueue.length = 0;
    this.mouthOpen = this.mouthTarget = 0;
    this.viseme = 'sil';
    this.blink = 0;
    this._blinkPhase = 'idle';
    for (const k of IMPULSES) this.impulse[k] = 0;
  }

  dispose() {
    clearTimeout(this._emotionTimer);
    this.unwire();
  }
}

export default AnimationEngine;

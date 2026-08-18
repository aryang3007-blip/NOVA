/**
 * AURA :: Ambient Audio Engine
 * ----------------------------
 * Fully synthesised with the Web Audio API — no audio files to download,
 * nothing to 404. Three layers:
 *
 *   • AMBIENT  — filtered noise bed + slow detuned drones (sci-fi room tone)
 *   • MUSIC    — generative arpeggio on a pentatonic scale, evolving
 *   • UI SFX   — click / confirm / error / boot / gesture blips
 *
 * Browsers require a user gesture before audio can start; AURA calls
 * resume() on first interaction and reports honestly if blocked.
 */

import { config } from '../core/config.js';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.ambientNodes = null;
    this.musicTimer = null;
    this.masterGain = null;
    this.ambientGain = null;
    this.musicGain = null;
    this.sfxGain = null;
    this.blocked = false;
  }

  /** Must be called from a user gesture the first time. */
  async init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch {} }
      return this.ready;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.blocked = true; return false; }
    try {
      this.ctx = new AC();
      if (this.ctx.state === 'suspended') await this.ctx.resume();
    } catch (e) {
      this.blocked = true;
      return false;
    }

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.9;
    this.masterGain.connect(this.ctx.destination);

    this.ambientGain = this.ctx.createGain();
    this.ambientGain.gain.value = 0;
    this.ambientGain.connect(this.masterGain);

    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 0;
    this.musicGain.connect(this.masterGain);

    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = 0.5;
    this.sfxGain.connect(this.masterGain);

    this.ready = true;
    return true;
  }

  get running() { return this.ready && this.ctx.state === 'running'; }

  /* ── ambient bed ─────────────────────────────────────────────────── */

  startAmbient() {
    if (!this.ready || this.ambientNodes) return false;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // pink-ish noise
    const bufferSize = 2 * ctx.sampleRate;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + white * 0.0990460;
      b1 = 0.96300 * b1 + white * 0.2965164;
      b2 = 0.57000 * b2 + white * 1.0526913;
      data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.09;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    noise.loop = true;

    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = 420;
    noiseFilter.Q.value = 0.7;

    // slow filter sweep gives it life
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.035;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 220;
    lfo.connect(lfoGain).connect(noiseFilter.frequency);

    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.5;
    noise.connect(noiseFilter).connect(noiseGain).connect(this.ambientGain);

    // detuned drones
    const drones = [];
    for (const [freq, detune, gain] of [[55, -6, 0.11], [82.4, 4, 0.075], [110, -3, 0.05], [164.8, 7, 0.03]]) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = gain;
      // gentle amplitude drift
      const amp = ctx.createOscillator();
      amp.frequency.value = 0.05 + Math.random() * 0.07;
      const ampG = ctx.createGain();
      ampG.gain.value = gain * 0.45;
      amp.connect(ampG).connect(g.gain);
      osc.connect(g).connect(this.ambientGain);
      osc.start(now); amp.start(now);
      drones.push(osc, amp);
    }

    noise.start(now);
    lfo.start(now);
    this.ambientNodes = { noise, lfo, drones, noiseFilter };

    const vol = Number(config.get('ambientVolume')) || 0.22;
    this.ambientGain.gain.cancelScheduledValues(now);
    this.ambientGain.gain.setValueAtTime(this.ambientGain.gain.value, now);
    this.ambientGain.gain.linearRampToValueAtTime(vol, now + 2.5);
    return true;
  }

  stopAmbient() {
    if (!this.ambientNodes) return;
    const now = this.ctx.currentTime;
    this.ambientGain.gain.cancelScheduledValues(now);
    this.ambientGain.gain.setValueAtTime(this.ambientGain.gain.value, now);
    this.ambientGain.gain.linearRampToValueAtTime(0, now + 1.2);
    const nodes = this.ambientNodes;
    this.ambientNodes = null;
    setTimeout(() => {
      try { nodes.noise.stop(); nodes.lfo.stop(); nodes.drones.forEach(d => d.stop()); } catch {}
    }, 1400);
  }

  setAmbientVolume(v) {
    if (!this.ready) return;
    this.ambientGain.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), this.ctx.currentTime, 0.2);
  }

  /* ── generative music ────────────────────────────────────────────── */

  startMusic() {
    if (!this.ready || this.musicTimer) return false;
    const scale = [0, 3, 5, 7, 10];           // minor pentatonic
    const roots = [220, 246.94, 174.61, 196]; // A3 B3 F3 G3
    let step = 0, chordIdx = 0;

    const vol = Number(config.get('musicVolume')) || 0.14;
    this.musicGain.gain.setTargetAtTime(vol, this.ctx.currentTime, 1.2);

    const playNote = () => {
      if (!this.ctx || !this.musicTimer) return;
      const ctx = this.ctx;
      const now = ctx.currentTime;
      if (step % 8 === 0) chordIdx = (chordIdx + 1) % roots.length;
      const root = roots[chordIdx];
      const semis = scale[Math.floor(Math.random() * scale.length)] + (Math.random() < 0.3 ? 12 : 0);
      const freq = root * Math.pow(2, semis / 12);

      const osc = ctx.createOscillator();
      osc.type = Math.random() < 0.5 ? 'triangle' : 'sine';
      osc.frequency.value = freq;

      const g = ctx.createGain();
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(0.22, now + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0008, now + 1.6);

      const filt = ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = 1800;

      // simple feedback delay for space
      const delay = ctx.createDelay(1.0);
      delay.delayTime.value = 0.34;
      const fb = ctx.createGain();
      fb.gain.value = 0.32;
      delay.connect(fb).connect(delay);
      const wet = ctx.createGain();
      wet.gain.value = 0.35;

      osc.connect(filt).connect(g);
      g.connect(this.musicGain);
      g.connect(delay);
      delay.connect(wet).connect(this.musicGain);

      osc.start(now);
      osc.stop(now + 1.8);
      setTimeout(() => { try { delay.disconnect(); fb.disconnect(); wet.disconnect(); } catch {} }, 2600);
      step++;
    };

    this.musicTimer = setInterval(() => {
      if (Math.random() < 0.72) playNote();
    }, 620);
    playNote();
    return true;
  }

  stopMusic() {
    if (this.musicTimer) { clearInterval(this.musicTimer); this.musicTimer = null; }
    if (this.ready) this.musicGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.4);
  }

  setMusicVolume(v) {
    if (!this.ready) return;
    this.musicGain.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), this.ctx.currentTime, 0.2);
  }

  /* ── UI sound effects ────────────────────────────────────────────── */

  sfx(name = 'click') {
    if (!this.ready || !config.get('uiSounds')) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    /** @param {OscillatorType} type */
    const beep = (freq, dur, type = 'sine', vol = 0.14, delay = 0, sweepTo = null) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now + delay);
      if (sweepTo) osc.frequency.exponentialRampToValueAtTime(sweepTo, now + delay + dur);
      g.gain.setValueAtTime(0, now + delay);
      g.gain.linearRampToValueAtTime(vol, now + delay + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0005, now + delay + dur);
      osc.connect(g).connect(this.sfxGain);
      osc.start(now + delay);
      osc.stop(now + delay + dur + 0.05);
    };

    switch (name) {
      case 'click': beep(1400, 0.05, 'square', 0.06); break;
      case 'hover': beep(2100, 0.03, 'sine', 0.03); break;
      case 'confirm': beep(880, 0.09, 'sine', 0.12); beep(1320, 0.12, 'sine', 0.1, 0.07); break;
      case 'error': beep(220, 0.16, 'sawtooth', 0.1); beep(165, 0.22, 'sawtooth', 0.08, 0.08); break;
      case 'boot':
        [261.6, 329.6, 392, 523.3, 659.3].forEach((f, i) => beep(f, 0.28, 'sine', 0.1, i * 0.085));
        break;
      case 'listen': beep(660, 0.07, 'sine', 0.1); beep(990, 0.1, 'sine', 0.09, 0.06); break;
      case 'gesture': beep(1600, 0.05, 'triangle', 0.09, 0, 2400); break;
      case 'message': beep(1046, 0.06, 'sine', 0.07); break;
      case 'scan': beep(400, 0.35, 'sine', 0.07, 0, 1600); break;
      case 'power-down': [523.3, 392, 329.6, 261.6].forEach((f, i) => beep(f, 0.2, 'sine', 0.09, i * 0.07)); break;
      default: beep(1000, 0.05, 'sine', 0.06);
    }
  }

  /** Apply current config to running layers. */
  sync() {
    if (!this.ready) return;
    if (config.get('ambientSound')) { this.startAmbient(); this.setAmbientVolume(config.get('ambientVolume')); }
    else this.stopAmbient();
    if (config.get('musicEnabled')) { this.startMusic(); this.setMusicVolume(config.get('musicVolume')); }
    else this.stopMusic();
  }

  dispose() {
    this.stopAmbient();
    this.stopMusic();
    try { this.ctx?.close(); } catch {}
    this.ready = false;
  }
}

export default AudioEngine;

/**
 * AURA :: Screen Share  (Copilot-Vision-style screen awareness)
 * -------------------------------------------------------------
 * Lets AURA see a tab, a window, or the whole desktop and answer questions
 * about it — then, optionally, act on it.
 *
 * WHY getDisplayMedia AND NOT A FLOATING OVERLAY
 * ----------------------------------------------
 * A page served from localhost cannot draw itself on top of other
 * applications; only a native process can do that. Rather than fake it, we
 * use the browser's own screen-capture API, which is the real, permissioned
 * way to do this on the web:
 *
 *   - The BROWSER shows the picker. AURA never chooses what to capture.
 *   - You pick: a browser tab, an application window, or an entire screen.
 *   - The browser shows a persistent "sharing" indicator you can always see.
 *   - Stopping is one click, from the browser chrome, at any time.
 *
 * You keep AURA in a second window / second monitor and share the app you
 * are working in. That is the honest local-first equivalent of a hover
 * overlay, and it is strictly safer: the OS mediates it.
 *
 * FRAME RATE — deliberately low
 * -----------------------------
 * A screen is not a video feed; it is mostly static. Capturing at 30 fps
 * would burn CPU on a weak machine for nothing. We request 1 fps from the
 * browser and only PULL a frame when something asks for one. Continuous
 * "watch" mode adds change detection so an idle screen costs almost nothing.
 *
 * @module vision/screen-share
 */

import { bus, EV } from '../core/bus.js';
import { state } from '../core/state.js';

/** Downscale target. Vision models see ~1120px; more is wasted upload. */
const MAX_EDGE = 1280;

/** Cheap perceptual hash grid — 16x16 luma cells. */
const HASH_N = 16;

export class ScreenShare {
  constructor() {
    /** @type {MediaStream|null} */
    this.stream = null;
    /** @type {HTMLVideoElement|null} */
    this.video = null;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

    this.active = false;
    /** Label of what is being shared, as reported by the browser. */
    this.label = '';
    /** 'browser' | 'window' | 'monitor' | 'unknown' */
    this.surface = 'unknown';

    /** Continuous watch mode. */
    this.watching = false;
    this._watchTimer = null;
    this._lastHash = null;
    this._lastChangeAt = 0;
    this.watchIntervalMs = 2000;
    /** Fraction of hash cells that must differ to count as "changed". */
    this.changeThreshold = 0.06;
    this.frames = 0;
    this.changes = 0;
  }

  /** Is screen capture possible in this browser at all? */
  static supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  }

  /**
   * Ask the browser to start sharing. The USER chooses the surface.
   * @returns {Promise<{ok:boolean, message:string, label?:string, surface?:string}>}
   */
  async start() {
    if (!ScreenShare.supported()) {
      return { ok: false, message: 'This browser has no screen-capture API. Chrome, Edge or Firefox on desktop can do it; most mobile browsers cannot.' };
    }
    if (this.active) {
      return { ok: true, message: `Already sharing ${this.label || 'your screen'}.`, label: this.label, surface: this.surface };
    }
    try {
      this.stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 1, max: 5 },   // a screen is nearly static
          width: { max: 1920 },
          height: { max: 1080 },
        },
        audio: false,
      });
    } catch (err) {
      const name = err?.name || '';
      if (name === 'NotAllowedError') {
        return { ok: false, message: 'Screen sharing was cancelled — nothing is being captured.' };
      }
      return { ok: false, message: `Screen sharing failed: ${err?.message || name || err}` };
    }

    const track = this.stream.getVideoTracks()[0];
    const settings = track?.getSettings?.() || {};
    this.label = track?.label || '';
    this.surface = settings.displaySurface || 'unknown';

    // The user can stop sharing from the browser's own UI at any time.
    // Honour that immediately rather than pretending we still have a feed.
    track?.addEventListener('ended', () => this._teardown('stopped from the browser'));

    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    // Give the first frame a moment to arrive.
    await new Promise(r => setTimeout(r, 220));

    this.active = true;
    this.frames = 0;
    this.changes = 0;
    this._lastHash = null;
    state.set({ screenShareActive: true, screenShareLabel: this.label, screenSurface: this.surface });
    bus.emit(EV.LOG, { text: `Screen share started (${this.describeSurface()})`, kind: 'ok' });
    bus.emit('screen:started', { label: this.label, surface: this.surface });
    return { ok: true, message: `Sharing ${this.describeSurface()}.`, label: this.label, surface: this.surface };
  }

  /** Human-readable description of what is shared. */
  describeSurface() {
    const kind = { browser: 'a browser tab', window: 'an application window', monitor: 'an entire screen' }[this.surface]
      || 'a screen surface';
    return this.label ? `${kind} — “${this.label}”` : kind;
  }

  stop() {
    if (!this.active) return { ok: true, message: 'Screen sharing was not on.' };
    this._teardown('stopped');
    return { ok: true, message: 'Screen sharing stopped.' };
  }

  _teardown(reason) {
    this.stopWatching();
    try { this.stream?.getTracks().forEach(t => t.stop()); } catch {}
    this.stream = null;
    if (this.video) { this.video.srcObject = null; this.video = null; }
    this.active = false;
    state.set({ screenShareActive: false, screenShareLabel: '', screenSurface: '' });
    bus.emit(EV.LOG, { text: `Screen share ${reason}.`, kind: 'info' });
    bus.emit('screen:stopped', { reason });
  }

  /**
   * Grab the current frame as a data URL, downscaled.
   * @param {{maxEdge?:number, quality?:number}} [opts]
   * @returns {string|null} `data:image/jpeg;base64,...`
   */
  grab({ maxEdge = MAX_EDGE, quality = 0.82 } = {}) {
    if (!this.active || !this.video) return null;
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    if (!vw || !vh) return null;

    const scale = Math.min(1, maxEdge / Math.max(vw, vh));
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx.drawImage(this.video, 0, 0, w, h);
    this.frames++;
    // JPEG, not PNG: a screenshot PNG is often 2-4 MB, which is slow to
    // base64 and slow to push through Ollama. JPEG at 0.82 is ~150 KB.
    return this.canvas.toDataURL('image/jpeg', quality);
  }

  /**
   * Native pixel size of the shared surface, and the scale factor between
   * the captured frame and real screen coordinates.
   * @returns {{width:number, height:number, capturedWidth:number,
   *            capturedHeight:number, scale:number}|null}
   */
  geometry() {
    if (!this.active || !this.video) return null;
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    if (!vw || !vh) return null;
    const scale = Math.min(1, MAX_EDGE / Math.max(vw, vh));
    return {
      width: vw, height: vh,
      capturedWidth: Math.round(vw * scale),
      capturedHeight: Math.round(vh * scale),
      scale,
    };
  }

  /**
   * Map a coordinate expressed in the CAPTURED image back to real screen
   * pixels. This is what makes "click the Save button" possible: a model
   * points at the downscaled frame, and we translate.
   *
   * IMPORTANT AND HONEST: this is only valid when an entire MONITOR is
   * shared. If you shared a window or a tab, the capture has no fixed
   * relationship to desktop coordinates, so we refuse rather than click
   * somewhere wrong.
   *
   * @param {number} x  in captured-image pixels
   * @param {number} y
   * @returns {{ok:boolean, x?:number, y?:number, message?:string}}
   */
  toScreenPoint(x, y) {
    const g = this.geometry();
    if (!g) return { ok: false, message: 'Nothing is being shared.' };
    if (this.surface !== 'monitor') {
      return {
        ok: false,
        message: `You are sharing ${this.describeSurface()}. Coordinates from a window or tab `
          + 'do not map to desktop pixels, so AURA will not guess where to click. '
          + 'Re-share and choose "Entire Screen" to enable clicking.',
      };
    }
    return {
      ok: true,
      x: Math.round(x / g.scale),
      y: Math.round(y / g.scale),
    };
  }

  /* ── change detection ─────────────────────────────────────────────── */

  /**
   * Cheap perceptual hash of the current frame — a 16x16 luma grid.
   * Comparing these tells us whether the screen actually changed, so watch
   * mode does not re-ask a model about an identical picture.
   * @returns {Uint8Array|null}
   */
  hash() {
    if (!this.active || !this.video) return null;
    const c = document.createElement('canvas');
    c.width = HASH_N; c.height = HASH_N;
    const cx = c.getContext('2d', { willReadFrequently: true });
    if (!cx) return null;
    try { cx.drawImage(this.video, 0, 0, HASH_N, HASH_N); } catch { return null; }
    const d = cx.getImageData(0, 0, HASH_N, HASH_N).data;
    const out = new Uint8Array(HASH_N * HASH_N);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      out[p] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    }
    return out;
  }

  /**
   * Fraction of cells that changed materially since the last check.
   * @returns {number} 0..1
   */
  changeScore() {
    const h = this.hash();
    if (!h) return 0;
    const prev = this._lastHash;
    this._lastHash = h;
    if (!prev) return 1;              // first frame is always "new"
    let diff = 0;
    for (let i = 0; i < h.length; i++) if (Math.abs(h[i] - prev[i]) > 12) diff++;
    return diff / h.length;
  }

  /**
   * Watch the screen and emit `screen:changed` when it actually changes.
   * Nothing is sent anywhere by this method — a listener decides what to do.
   * @param {{intervalMs?:number, threshold?:number}} [opts]
   */
  startWatching({ intervalMs = this.watchIntervalMs, threshold = this.changeThreshold } = {}) {
    if (!this.active) return { ok: false, message: 'Start screen sharing first.' };
    this.stopWatching();
    this.watchIntervalMs = Math.max(500, intervalMs);
    this.changeThreshold = threshold;
    this.watching = true;
    this._lastHash = null;
    this._watchTimer = setInterval(() => {
      if (!this.active) return this.stopWatching();
      const score = this.changeScore();
      if (score >= this.changeThreshold) {
        this.changes++;
        this._lastChangeAt = Date.now();
        bus.emit('screen:changed', { score, at: this._lastChangeAt });
      }
    }, this.watchIntervalMs);
    state.set({ screenWatching: true });
    return { ok: true, message: `Watching the shared screen every ${(this.watchIntervalMs / 1000).toFixed(1)}s.` };
  }

  stopWatching() {
    if (this._watchTimer) clearInterval(this._watchTimer);
    this._watchTimer = null;
    this.watching = false;
    state.set({ screenWatching: false });
  }

  /** Honest status report. */
  status() {
    return {
      supported: ScreenShare.supported(),
      active: this.active,
      label: this.label,
      surface: this.surface,
      description: this.active ? this.describeSurface() : null,
      watching: this.watching,
      intervalMs: this.watchIntervalMs,
      frames: this.frames,
      changes: this.changes,
      geometry: this.geometry(),
      clickable: this.active && this.surface === 'monitor',
    };
  }
}

export const screenShare = new ScreenShare();

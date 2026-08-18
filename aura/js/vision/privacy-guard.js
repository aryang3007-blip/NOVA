/**
 * AURA :: Privacy Guard
 * ---------------------
 * If someone appears behind you, minimise the active window.
 *
 * WHAT THIS IS, ARCHITECTURALLY
 * -----------------------------
 * A small state machine that CONSUMES vision events and PROPOSES a command.
 * It owns no camera, no model, and no OS access:
 *
 *   existing Vision frame ─▶ EV.PRESENCE ─▶ PrivacyGuard ─▶ Runtime Kernel
 *                                                              │
 *                          registry ▸ permission ▸ execute ─────┘
 *
 * It never calls pyautogui, never moves the mouse, never touches a window
 * handle. It emits one registry command and the Runtime decides whether that
 * is allowed. Vision alone can therefore never execute a desktop action.
 *
 * WHY NO LLM, NO SCREENSHOT, NO NETWORK
 * -------------------------------------
 * The reaction has to happen in the time it takes someone to read your
 * screen. A model round-trip is 10-30s on a modest machine — useless here.
 * Everything below is arithmetic on numbers the face detector already
 * produced for the current frame. Marginal cost is effectively zero.
 *
 * WHY IT DOES NOT RESTORE THE WINDOW
 * ----------------------------------
 * Deliberate. If detection blinks for one frame, an auto-restore would
 * re-expose the screen while the person is still standing there. Failing
 * closed is the only defensible behaviour for a privacy feature.
 *
 * @module vision/privacy-guard
 */

import { bus, EV } from '../core/bus.js';
import { state } from '../core/state.js';

/** @enum {string} */
export const GUARD_STATE = {
  DISABLED: 'DISABLED',
  ARMED: 'ARMED',
  MONITORING: 'MONITORING',
  THREAT_DETECTED: 'THREAT_DETECTED',
  ACTION_EXECUTED: 'ACTION_EXECUTED',
  COOLDOWN: 'COOLDOWN',
};

/**
 * Sensitivity presets. `minArea` is the fraction of the camera frame the
 * person must occupy — the only honest proximity proxy a single webcam has.
 * A face filling 4% of frame is roughly "leaning over your shoulder"; 1% is
 * "somewhere in the room".
 */
export const SENSITIVITY = {
  sensitive:    { label: 'Sensitive',    minArea: 0.004, minimumConfidence: 0.55, detectionPersistenceMs: 300,
                  hint: 'Triggers on anyone visible behind you. Most false positives.' },
  balanced:     { label: 'Balanced',     minArea: 0.015, minimumConfidence: 0.70, detectionPersistenceMs: 500,
                  hint: 'Triggers when a person occupies a meaningful part of the frame.' },
  conservative: { label: 'Conservative', minArea: 0.040, minimumConfidence: 0.80, detectionPersistenceMs: 800,
                  hint: 'Only when someone is clearly close. Fewest false triggers. Default.' },
};

export const DEFAULTS = {
  enabled: false,                 // OFF until the user turns it on
  sensitivity: 'conservative',
  detectionPersistenceMs: 800,
  minimumConfidence: 0.80,
  minArea: 0.040,
  cooldownMs: 5000,
  action: 'desktop.minimize_active_window',
  ignoreOwnFaceMs: 1500,          // grace period after arming
  /**
   * REPORTED FAILURE, v0.18: the guard minimised the screen when the USER's
   * own face was the only one in frame. Of course it did — v1 gated purely on
   * "a face big enough", and the biggest face at a laptop is always the owner.
   *
   * Two rules fix it, and both are on by default:
   */
  minFaces: 2,          // a second person must be present, not just you
  neverIfOwnerAlone: true,   // if the only recognised face is enrolled, stand down
};

export class PrivacyGuard {
  /**
   * @param {object} o
   * @param {any} [o.kernel]  RuntimeCore — the ONLY route to the desktop
   * @param {any} [o.config]
   * @param {any} [o.trace]   Trace constructor, for the Developer Console
   */
  constructor({ kernel = null, config = null, trace = null } = {}) {
    this.kernel = kernel;
    this.config = config;
    this.TraceCtor = trace;

    this.state = GUARD_STATE.DISABLED;
    this.opts = { ...DEFAULTS, ...this._fromConfig() };

    /** Event-clock time the current continuous qualifying detection began. */
    this._since = 0;
    /** Wall-clock equivalent, used only for the UI progress readout. */
    this._sinceWall = 0;
    this._lastEvent = null;
    this._cooldownUntil = 0;
    this._armedAt = 0;
    this._bound = false;

    this.stats = { detections: 0, qualified: 0, triggers: 0, suppressed: 0,
                   rejected: 0, vetoed: 0 };
    /** Why the last qualifying detection was stood down, for the UI. */
    this._lastVeto = null;
    /** @type {Array<object>} bounded history for the dev console */
    this.log = [];
  }

  _fromConfig() {
    if (!this.config?.get) return {};
    const out = {};
    for (const k of Object.keys(DEFAULTS)) {
      const v = this.config.get(`pg_${k}`);
      if (v !== undefined && v !== null) out[k] = v;
    }
    return out;
  }

  _save(patch) {
    Object.assign(this.opts, patch);
    if (this.config?.set) {
      for (const [k, v] of Object.entries(patch)) this.config.set(`pg_${k}`, v);
    }
  }

  /* ── lifecycle ────────────────────────────────────────────────────── */

  /** Subscribe once. Idempotent. */
  attach() {
    if (this._bound) return;
    this._bound = true;
    this._onPresence = (e) => this.onPresence(e);
    bus.on(EV.PRESENCE, this._onPresence);
    // If the camera stops, monitoring is meaningless — say so rather than
    // sitting in MONITORING with no input.
    this._onCamStop = () => { if (this.opts.enabled) this._to(GUARD_STATE.ARMED, 'camera off'); };
    bus.on(EV.CAM_STOP, this._onCamStop);
    if (this.opts.enabled) this.enable();
  }

  detach() {
    if (!this._bound) return;
    bus.off(EV.PRESENCE, this._onPresence);
    bus.off(EV.CAM_STOP, this._onCamStop);
    this._bound = false;
    this._to(GUARD_STATE.DISABLED, 'detached');
  }

  enable() {
    this._save({ enabled: true });
    this._armedAt = Date.now();
    this._since = 0;
    this._to(state.get('cameraActive') ? GUARD_STATE.MONITORING : GUARD_STATE.ARMED, 'enabled');
    return this.status();
  }

  disable() {
    this._save({ enabled: false });
    this._since = 0;
    this._cooldownUntil = 0;
    // Must stop IMMEDIATELY — a guard you cannot switch off is a liability.
    this._to(GUARD_STATE.DISABLED, 'disabled by user');
    return this.status();
  }

  toggle() { return this.opts.enabled ? this.disable() : this.enable(); }

  /** @param {string} name one of SENSITIVITY */
  setSensitivity(name) {
    const p = SENSITIVITY[name];
    if (!p) return { ok: false, message: `Unknown sensitivity "${name}".` };
    this._save({ sensitivity: name, minArea: p.minArea,
                 minimumConfidence: p.minimumConfidence,
                 detectionPersistenceMs: p.detectionPersistenceMs });
    return { ok: true, ...p, sensitivity: name };
  }

  configure(patch = {}) {
    const clean = {};
    if (patch.detectionPersistenceMs != null)
      clean.detectionPersistenceMs = clamp(+patch.detectionPersistenceMs, 100, 10000);
    if (patch.minimumConfidence != null)
      clean.minimumConfidence = clamp(+patch.minimumConfidence, 0.1, 1);
    if (patch.minArea != null) clean.minArea = clamp(+patch.minArea, 0.001, 0.9);
    if (patch.cooldownMs != null) clean.cooldownMs = clamp(+patch.cooldownMs, 0, 120000);
    if (patch.minFaces != null) clean.minFaces = Math.round(clamp(+patch.minFaces, 1, 5));
    if (patch.neverIfOwnerAlone != null) clean.neverIfOwnerAlone = !!patch.neverIfOwnerAlone;
    this._save(clean);
    return this.status();
  }

  /* ── the state machine ────────────────────────────────────────────── */

  /**
   * Handle one presence event. Pure arithmetic — no I/O on the hot path.
   * @param {{present:boolean, count:number, confidence:number, area:number,
   *          boundingBox?:object, source?:string, timestamp:number,
   *          faceCount?:number, knownNames?:string[], ownerPresent?:boolean}} e
   */
  onPresence(e) {
    this._lastEvent = e;
    if (!this.opts.enabled) return;                    // TEST 1
    this.stats.detections++;

    /*
     * WALL CLOCK, NOT THE EVENT TIMESTAMP, FOR THE COOLDOWN.
     *
     * Bug found in testing: cooldown was compared against `e.timestamp`.
     * Vision timestamps come from `performance.now()`-style monotonic clocks
     * and can lag, be replayed, or (in a burst) arrive out of order — so a
     * stale event slipped past the cooldown and re-fired the action three
     * times. A privacy feature that re-minimises repeatedly is broken.
     *
     * `now` is the real clock and governs the cooldown. `eventTs` stays for
     * measuring PERSISTENCE, where the frame's own clock is the correct
     * reference because it describes the detection, not the reaction.
     */
    const now = Date.now();
    const eventTs = e.timestamp || now;

    // Cooldown: ignore everything, but keep reporting state honestly.
    if (now < this._cooldownUntil) {
      this.stats.suppressed++;
      if (this.state !== GUARD_STATE.COOLDOWN) this._to(GUARD_STATE.COOLDOWN, 'cooling down');
      return;
    }
    if (this.state === GUARD_STATE.COOLDOWN) this._to(GUARD_STATE.MONITORING, 'cooldown over');
    if (this.state === GUARD_STATE.ARMED && state.get('cameraActive')) {
      this._to(GUARD_STATE.MONITORING, 'camera live');
    }

    // A brief grace period after arming, so your own face while you settle in
    // front of the camera does not immediately fire.
    if (now - this._armedAt < this.opts.ignoreOwnFaceMs) return;

    /*
     * OWNER / HEAD-COUNT GATE — runs BEFORE the confidence and proximity
     * checks, because no threshold tuning can fix "it fired on me".
     *
     *  • minFaces: 2   — one face is you working. Two is someone with you.
     *  • neverIfOwnerAlone — if every recognised face is enrolled and there
     *    are no unknown faces, this is you (or you and a housemate you chose
     *    to enrol). Stand down.
     *
     * An UNKNOWN face still counts toward minFaces, so a stranger leaning in
     * next to you triggers exactly as intended.
     */
    const faceCount = e.faceCount ?? (e.source === 'face' ? e.count : 0) ?? 0;
    const known = Array.isArray(e.knownNames) ? e.knownNames.length : 0;
    const unknown = Math.max(0, faceCount - known);
    let vetoed = null;

    if (e.present && faceCount > 0) {
      if (faceCount < this.opts.minFaces) {
        vetoed = `only ${faceCount} face in frame (need ${this.opts.minFaces})`;
      } else if (this.opts.neverIfOwnerAlone && unknown === 0 && known > 0) {
        vetoed = `all ${known} face(s) recognised (${e.knownNames.join(', ')}) — no stranger present`;
      }
    }
    if (vetoed) {
      this.stats.vetoed++;
      this._lastVeto = vetoed;
      if (this._since) this._to(GUARD_STATE.MONITORING, `stood down: ${vetoed}`);
      this._since = 0;
      return;
    }
    this._lastVeto = null;

    const qualifies = !!e.present
      && (e.confidence ?? 0) >= this.opts.minimumConfidence
      && (e.area ?? 0) >= this.opts.minArea;

    if (!qualifies) {
      // TEST 3 / TEST 7: losing the person resets the timer. It never
      // accumulates across gaps, and it never restores anything.
      if (this._since) this._to(GUARD_STATE.MONITORING, 'detection lost');
      this._since = 0;
      return;
    }

    this.stats.qualified++;
    if (!this._since) {
      this._since = eventTs;
      this._sinceWall = now;
      this._to(GUARD_STATE.THREAT_DETECTED, 'person detected, timing persistence');
      return;
    }

    const persisted = eventTs - this._since;
    if (persisted < this.opts.detectionPersistenceMs) return;   // TEST 3

    // TEST 4 — confirmed.
    this._since = 0;
    this._cooldownUntil = now + this.opts.cooldownMs;           // TEST 5
    this.stats.triggers++;
    this._trigger({ ...e, persisted });
  }

  /**
   * Propose the action. Everything after this line is the Runtime's decision,
   * not ours.
   */
  async _trigger(e) {
    const t = this.TraceCtor ? new this.TraceCtor('Privacy Guard') : null;
    t?.ok('Vision', `${e.source || 'person'} detected · confidence ${(e.confidence ?? 0).toFixed(2)}`);
    t?.ok('Privacy Guard', `persisted ${Math.round(e.persisted)}ms · area ${(e.area * 100).toFixed(1)}% of frame`);
    t?.ok('Head count', `${e.faceCount ?? '?'} face(s) · `
      + `${(e.knownNames || []).length} recognised${(e.knownNames || []).length
          ? ` (${e.knownNames.join(', ')})` : ''} · `
      + `${Math.max(0, (e.faceCount ?? 0) - (e.knownNames?.length || 0))} unknown`);
    t?.info('Threat confirmed', `sensitivity: ${this.opts.sensitivity}`);

    this._to(GUARD_STATE.THREAT_DETECTED, 'threat confirmed');
    bus.emit('privacy:threat', { confidence: e.confidence, area: e.area,
                                 persisted: e.persisted, at: Date.now() });

    if (!this.kernel) {
      t?.fail('Action Manager', 'no runtime kernel wired');
      this._record(e, false, 'no runtime');
      this._to(GUARD_STATE.COOLDOWN, 'no runtime');
      t?.end('fail', 'Privacy Guard could not act.');
      return;
    }

    t?.info('Action Manager', this.opts.action);
    // No `confirm` callback: a privacy reaction that waits for a dialog has
    // already failed. The PERMISSION gate is what authorises this, and the
    // user grants it once, deliberately, in Settings.
    const r = await this.kernel.execute({ command: this.opts.action }, { trace: t });

    if (r.ok) {
      t?.ok('Window Manager', r.result?.summary || 'minimised');
      this._to(GUARD_STATE.ACTION_EXECUTED, 'window minimised');
      this._record(e, true, r.result?.summary || 'minimised');
      t?.end('ok', 'Screen protected.');
      bus.emit('privacy:acted', { ok: true, summary: r.result?.summary });
    } else {
      this.stats.rejected++;
      t?.fail(`Rejected at ${r.stage || 'execute'}`, r.error || 'failed');
      this._record(e, false, r.error || 'failed');
      t?.end('fail', r.error || 'Could not minimise.');
      bus.emit('privacy:acted', { ok: false, error: r.error, stage: r.stage });
    }
    // Enter cooldown either way — a permission failure repeating 30x/second
    // would be worse than the original problem.
    this._to(GUARD_STATE.COOLDOWN, 'cooldown');
    setTimeout(() => {
      if (this.opts.enabled && this.state === GUARD_STATE.COOLDOWN) {
        this._to(GUARD_STATE.MONITORING, 'cooldown elapsed');
      }
    }, this.opts.cooldownMs + 50);
  }

  _record(e, ok, summary) {
    this.log.push({ at: Date.now(), ok, summary,
                    confidence: e.confidence, area: e.area, persisted: e.persisted });
    if (this.log.length > 40) this.log.shift();
  }

  _to(next, reason) {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    state.set({ privacyGuardState: next, privacyGuardArmed: this.opts.enabled });
    bus.emit('privacy:state', { from: prev, to: next, reason, at: Date.now() });
  }

  /** Everything the UI and the Developer Console need. */
  status() {
    const now = Date.now();
    return {
      enabled: this.opts.enabled,
      state: this.state,
      sensitivity: this.opts.sensitivity,
      sensitivityHint: SENSITIVITY[this.opts.sensitivity]?.hint || '',
      detectionPersistenceMs: this.opts.detectionPersistenceMs,
      minimumConfidence: this.opts.minimumConfidence,
      minArea: this.opts.minArea,
      cooldownMs: this.opts.cooldownMs,
      action: this.opts.action,
      cameraActive: !!state.get('cameraActive'),
      inCooldown: now < this._cooldownUntil,
      cooldownRemainingMs: Math.max(0, this._cooldownUntil - now),
      /*
       * Progress toward the persistence threshold. Reported from the EVENT
       * clock when we have a newer event (that is what the decision actually
       * uses), falling back to wall clock so the UI bar keeps advancing
       * between frames. Reporting wall-clock only made this read 0 whenever
       * frames arrived faster than the clock ticked.
       */
      persistingMs: this._since
        ? Math.max(0, Math.max((this._lastEvent?.timestamp || 0) - this._since,
                               Date.now() - this._sinceWall))
        : 0,
      minFaces: this.opts.minFaces,
      neverIfOwnerAlone: this.opts.neverIfOwnerAlone,
      lastVeto: this._lastVeto,
      lastDetection: this._lastEvent
        ? { present: this._lastEvent.present, confidence: this._lastEvent.confidence,
            area: this._lastEvent.area, source: this._lastEvent.source,
            faceCount: this._lastEvent.faceCount ?? 0,
            knownNames: this._lastEvent.knownNames || [],
            unknownFaces: Math.max(0, (this._lastEvent.faceCount ?? 0)
                                      - (this._lastEvent.knownNames?.length || 0)) }
        : null,
      stats: { ...this.stats },
      history: this.log.slice(-10).reverse(),
    };
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo)); }

export default PrivacyGuard;

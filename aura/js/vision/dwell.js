/**
 * AURA :: Dwell-to-click  (spec §4 / §5)
 * ======================================
 * Hold your fingertip still over a target and it clicks. No pinch, no tap, no
 * physical button — the hover itself is the commitment.
 *
 * WHY A STATE MACHINE
 * -------------------
 * A hand is never still. MediaPipe's index tip jitters by 1–3% of frame width
 * even when a person believes they are holding perfectly steady, and it drops
 * frames whenever the CPU is busy. A naive `if (samePlace) counter++` produces
 * two failure modes, both of which make the feature feel broken:
 *
 *   • Fires on a hand that is merely PASSING OVER a button.
 *   • Never fires, because one jittery frame resets the counter to zero.
 *
 * So dwell is modelled explicitly:
 *
 *      IDLE ──pointer appears──> ARMING ──held inside tolerance──> DWELLING
 *        ^                          |                                 |
 *        |                          |  moved beyond cancelRadius      | progress
 *        └───pointer lost───────────┴─────────────────────────────────┤ hits 1.0
 *        ^                                                            v
 *        └──── cooldown ◄──── FIRED ◄──── COMMITTED ◄─────────────────┘
 *
 * KEY DESIGN DECISIONS (each one exists because the naive version fails)
 * ---------------------------------------------------------------------
 *  1. TOLERANCE, NOT EQUALITY. The anchor is a small circle. Movement inside
 *     `holdRadius` does not reset anything; it slides the anchor gently
 *     (exponential smoothing) so slow natural drift is forgiven.
 *
 *  2. GRACE FRAMES. Losing the hand for one or two frames — which MediaPipe
 *     does constantly on a weak CPU — must not cancel a 900 ms dwell. The
 *     pointer is considered "still there" for `graceMs` after the last sample.
 *
 *  3. PROGRESS IS TIME-BASED, NOT FRAME-BASED. On this user's machine the
 *     camera runs anywhere from 8 to 30 fps. Counting frames would make dwell
 *     take 3x longer on a slow machine. Elapsed milliseconds are used, so
 *     1000 ms is 1000 ms regardless of fps.
 *
 *  4. REFRACTORY PERIOD. After firing, the same spot cannot fire again until
 *     the pointer leaves `reFireRadius` or `cooldownMs` passes. Without this a
 *     resting hand machine-guns clicks.
 *
 *  5. THE CLASSIFIER IS SEPARATE (see `classifyTarget`). Dwell decides WHEN,
 *     the Interaction Manager decides WHAT. Keeping them apart means dwell is
 *     testable with zero DOM.
 *
 * This module is pure logic — no DOM, no OS calls, no timers of its own. The
 * caller supplies `now`, which makes every behaviour above deterministically
 * testable in Node.
 *
 * @module vision/dwell
 */

/** @typedef {'IDLE'|'ARMING'|'DWELLING'|'COMMITTED'|'COOLDOWN'} DwellState */

/**
 * Defaults tuned for a 640x480 webcam at arm's length. Radii are in NORMALISED
 * frame units (0..1), so they behave identically at any camera resolution.
 */
export const DWELL_DEFAULTS = {
  /** Total hold required, in ms. 1000 is the sweet spot: long enough not to
   *  misfire while reading the screen, short enough not to feel broken. */
  dwellMs: 1000,
  /** Pointer must survive this long before the ring even appears, so a hand
   *  sweeping across the frame never flashes progress rings behind it. */
  armMs: 180,
  /** Jitter allowance around the anchor. ~2.6% of frame width. */
  holdRadius: 0.026,
  /** Beyond this the user has clearly moved on: cancel immediately. */
  cancelRadius: 0.075,
  /** How fast the anchor follows small drift. 0 = frozen, 1 = no tolerance. */
  anchorEase: 0.14,
  /** Missing pointer samples are forgiven for this long. */
  graceMs: 220,
  /**
   * Absolute floor between two clicks. Deliberately SHORT, because the real
   * protection against repeat clicks is `reFireRadius` plus the cost of a
   * fresh dwell: after firing you must leave the target and hold a new one for
   * a full `dwellMs`. A long cooldown would only punish someone who correctly
   * moved on to a different button.
   */
  cooldownMs: 250,
  /**
   * How far the fingertip must travel from the last click before that spot can
   * fire again. Larger than `cancelRadius`, so escaping a target and coming
   * back is a deliberate act, not jitter.
   */
  reFireRadius: 0.09,
  /** Minimum landmark confidence to count as a real pointer sample. */
  minConfidence: 0.55,
};

/** Clamp helper. */
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * The dwell state machine.
 *
 * Feed it pointer samples with {@link DwellController.update}. It returns the
 * current progress and, on exactly ONE call, `fired: true`.
 */
export class DwellController {
  /** @param {Partial<typeof DWELL_DEFAULTS>} [opts] */
  constructor(opts = {}) {
    this.opts = { ...DWELL_DEFAULTS, ...opts };
    /** @type {DwellState} */
    this.state = 'IDLE';
    /** Anchor the user is dwelling on, in normalised frame units. */
    this.anchor = null;
    /** Most recent raw sample. */
    this.point = null;
    /** 0..1 — drives the progress ring. */
    this.progress = 0;
    /** Wall-clock ms at which the current dwell began. */
    this.startedAt = 0;
    /** Last time a real sample arrived. */
    this.lastSeen = 0;
    /** Where and when the last click happened. */
    this.lastFire = null;
    /** Whether dwell is allowed to run at all. */
    this.enabled = false;
    /** Diagnostics for the UI + tests. */
    this.stats = { fired: 0, cancelled: 0, armed: 0, longestHoldMs: 0 };
    /** Why the last attempt ended, for honest UI copy. */
    this.lastCancelReason = null;
  }

  /** Turn dwell on/off. Turning it off always resets to IDLE. */
  setEnabled(v) {
    this.enabled = !!v;
    if (!this.enabled) this.reset('disabled');
    return this.enabled;
  }

  /** Apply new settings at runtime (from the Settings sliders). */
  configure(patch = {}) {
    Object.assign(this.opts, patch);
    return this.opts;
  }

  /**
   * Abandon the current dwell.
   * @param {string} [reason]
   */
  reset(reason = 'reset') {
    if (this.state === 'DWELLING' || this.state === 'ARMING') {
      this.stats.cancelled++;
      this.lastCancelReason = reason;
    }
    this.state = 'IDLE';
    this.anchor = null;
    this.progress = 0;
    this.startedAt = 0;
    return this;
  }

  /** Euclidean distance between two normalised points. */
  static distance(a, b) {
    if (!a || !b) return Infinity;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /**
   * Advance the machine by one tick.
   *
   * @param {{x:number, y:number, confidence?:number}|null} sample
   *        Normalised fingertip position, or null when no pointer is visible.
   * @param {number} now  Milliseconds (monotonic or wall clock; only deltas
   *        are used, so either works as long as it is consistent).
   * @returns {{state:DwellState, progress:number, fired:boolean,
   *            point:{x:number,y:number}|null, anchor:{x:number,y:number}|null,
   *            reason:string|null, remainingMs:number}}
   */
  update(sample, now) {
    const o = this.opts;
    const nil = () => ({
      state: this.state, progress: this.progress, fired: false,
      point: this.point, anchor: this.anchor,
      reason: this.lastCancelReason, remainingMs: 0,
    });

    if (!this.enabled) {
      if (this.state !== 'IDLE') this.reset('disabled');
      return nil();
    }

    // ── cooldown expiry ────────────────────────────────────────────────
    //
    // BUG #102, caught by tests/test-dwell.mjs: this was `elapsed >= cooldownMs
    // || moved > reFireRadius`. With OR, a hand resting perfectly still on one
    // button fired at 1023ms, 2970ms and 4917ms — three clicks from one intent.
    // The refractory period has to be time AND distance: the finger must
    // actually LEAVE the target (or leave the frame) before that target is
    // armed again. Time alone is never enough.
    if (this.state === 'COOLDOWN' && this.lastFire) {
      const elapsed = now - this.lastFire.at;
      const gone = !sample;
      const moved = gone || DwellController.distance(sample, this.lastFire) > o.reFireRadius;
      if (elapsed >= o.cooldownMs && moved) {
        this.state = 'IDLE';
      } else {
        this.point = sample ? { x: sample.x, y: sample.y } : null;
        return nil();
      }
    }

    // ── no usable sample ───────────────────────────────────────────────
    const usable = sample
      && Number.isFinite(sample.x) && Number.isFinite(sample.y)
      && (sample.confidence == null || sample.confidence >= o.minConfidence);

    if (!usable) {
      // Grace: MediaPipe drops frames. A gap shorter than graceMs is ignored
      // entirely — the dwell keeps accumulating as if the hand were still seen.
      if (this.state === 'ARMING' || this.state === 'DWELLING') {
        if (now - this.lastSeen <= o.graceMs) {
          return this._tick(now, /* held */ true);
        }
        this.reset(sample ? 'low-confidence' : 'pointer-lost');
      }
      this.point = null;
      return nil();
    }

    this.point = { x: sample.x, y: sample.y };
    this.lastSeen = now;

    // ── IDLE → ARMING ──────────────────────────────────────────────────
    if (this.state === 'IDLE') {
      this.state = 'ARMING';
      this.anchor = { x: sample.x, y: sample.y };
      this.startedAt = now;
      this.progress = 0;
      this.lastCancelReason = null;
      this.stats.armed++;
      return nil();
    }

    // ── movement test ──────────────────────────────────────────────────
    const d = DwellController.distance(sample, this.anchor);

    if (d > o.cancelRadius) {
      // Moved decisively: this is a new target, not a cancelled one.
      this.reset('moved');
      this.state = 'ARMING';
      this.anchor = { x: sample.x, y: sample.y };
      this.startedAt = now;
      this.lastCancelReason = null;
      this.stats.armed++;
      return nil();
    }

    if (d > o.holdRadius) {
      // Outside the tolerance circle but inside the cancel radius: the user is
      // wobbling. Do not accumulate, do not cancel — hold the progress steady.
      return { ...nil(), remainingMs: this._remaining(now) };
    }

    // Inside tolerance: ease the anchor toward the finger so slow drift across
    // a large button does not eventually trip cancelRadius.
    this.anchor = {
      x: this.anchor.x + (sample.x - this.anchor.x) * o.anchorEase,
      y: this.anchor.y + (sample.y - this.anchor.y) * o.anchorEase,
    };

    return this._tick(now, true);
  }

  /**
   * Accumulate time and decide whether to fire.
   * @param {number} now
   * @param {boolean} held
   * @returns {{state:DwellState, progress:number, fired:boolean,
   *            point:{x:number,y:number}|null, anchor:{x:number,y:number}|null,
   *            reason:string|null, remainingMs:number}}
   */
  _tick(now, held) {
    const o = this.opts;
    if (!held) return { state: this.state, progress: this.progress, fired: false,
      point: this.point, anchor: this.anchor, reason: this.lastCancelReason, remainingMs: 0 };

    const elapsed = now - this.startedAt;
    if (elapsed > this.stats.longestHoldMs) this.stats.longestHoldMs = elapsed;

    if (this.state === 'ARMING') {
      if (elapsed < o.armMs) {
        return { state: this.state, progress: 0, fired: false, point: this.point,
          anchor: this.anchor, reason: null, remainingMs: o.dwellMs - elapsed };
      }
      this.state = 'DWELLING';
    }

    // Progress covers the span AFTER arming, so the ring starts at a true 0%.
    const span = Math.max(1, o.dwellMs - o.armMs);
    this.progress = clamp01((elapsed - o.armMs) / span);

    if (this.progress >= 1) {
      this.state = 'COMMITTED';
      this.progress = 1;
      this.stats.fired++;
      this.lastFire = { x: this.anchor.x, y: this.anchor.y, at: now };
      /** @type {{state:DwellState, progress:number, fired:boolean,
       *           point:{x:number,y:number}|null, anchor:{x:number,y:number}|null,
       *           reason:string|null, remainingMs:number}} */
      const out = {
        state: 'COMMITTED', progress: 1, fired: true,
        point: this.point, anchor: { ...this.anchor },
        reason: null, remainingMs: 0,
      };
      // Immediately enter cooldown so the very next tick cannot re-fire.
      this.state = 'COOLDOWN';
      this.progress = 0;
      return out;
    }

    return {
      state: this.state, progress: this.progress, fired: false,
      point: this.point, anchor: this.anchor, reason: null,
      remainingMs: Math.max(0, o.dwellMs - elapsed),
    };
  }

  _remaining(now) {
    return Math.max(0, this.opts.dwellMs - (now - this.startedAt));
  }

  /**
   * Quantised progress for the ring: 0, 25, 50, 75, 100.
   * The spec asks for those five stops specifically, and quantising also stops
   * the ring shimmering when progress wobbles by a fraction of a percent.
   * @param {number} p 0..1
   * @returns {0|25|50|75|100}
   */
  static ringOf(p) {
    if (p >= 1) return 100;
    if (p >= 0.75) return 75;
    if (p >= 0.5) return 50;
    if (p >= 0.25) return 25;
    return 0;
  }

  /**
   * Ring value for the CURRENT internal progress.
   *
   * CAUTION: on the tick that fires, `update()` has already zeroed `progress`
   * and moved to COOLDOWN, so this returns 0 even though the user just
   * completed a hold. Anything rendering the moment of the click must use
   * `DwellController.ringOf(result.progress)` on the returned result instead —
   * see InteractionManager.feed(). Getting this wrong made the ring flash 0%
   * at the exact instant it should read a satisfying 100%.
   *
   * @returns {0|25|50|75|100}
   */
  ringPercent() { return DwellController.ringOf(this.progress); }

  /** Snapshot for the UI and the dev console. */
  status() {
    return {
      enabled: this.enabled,
      state: this.state,
      progress: Math.round(this.progress * 100) / 100,
      ring: this.ringPercent(),
      anchor: this.anchor ? { ...this.anchor } : null,
      point: this.point ? { ...this.point } : null,
      lastFire: this.lastFire ? { ...this.lastFire } : null,
      lastCancelReason: this.lastCancelReason,
      stats: { ...this.stats },
      opts: { ...this.opts },
    };
  }
}

/* ════════════════════════ TARGET CLASSIFICATION ════════════════════════ */

/**
 * What a dwell point is pointing AT.
 *
 * `web` — an element inside AURA's own page. Clicking is a real DOM click:
 *         no permission needed, because the user is clicking AURA's own UI
 *         with their hand instead of a mouse.
 *
 * `desktop` — a pixel on the Windows desktop, reachable only through the
 *         shared-screen mapping. Clicking means driving the OS mouse, which
 *         requires the `Vision Mouse Control` permission AND a full-monitor
 *         share (see ScreenShare.toScreenPoint).
 *
 * `none` — nothing actionable is under the pointer.
 *
 * @typedef {'web'|'desktop'|'none'} TargetKind
 */

/** Selectors that count as clickable AURA UI, most specific first. */
export const WEB_TARGET_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input[type="checkbox"]',
  'input[type="radio"]',
  '[role="button"]',
  '.dock-btn',
  '.ward-item',
  '.chip',
  '.mini-btn',
].join(',');

/**
 * Decide what the fingertip is over.
 *
 * Pure function of its inputs — `hit` is injected rather than read from the
 * DOM, so this classifier is fully testable in Node. In the browser the caller
 * passes `document.elementFromPoint`.
 *
 * WHY WEB WINS TIES: if AURA's own window is focused and the finger is over
 * one of its buttons, the user means that button. Falling through to an OS
 * click would click AURA's own window anyway, but without the permission
 * check and without the visual feedback — strictly worse.
 *
 * @param {object} [args]
 * @param {{x:number,y:number}|null} [args.point]  Normalised frame coordinates.
 * @param {(x:number,y:number)=>({matches:(s:string)=>boolean, closest:(s:string)=>any}|null)} [args.hit]
 *        Hit-tester over VIEWPORT pixels.
 * @param {{width:number,height:number}} [args.viewport]
 * @param {boolean} [args.screenShared]   Is a surface being shared at all?
 * @param {boolean} [args.monitorShare]   Is that surface a whole monitor?
 * @param {boolean} [args.mousePermission] Is Vision Mouse Control granted?
 * @param {boolean} [args.mirrored]  Is the camera preview mirrored? (default true)
 * @returns {{kind:TargetKind, element?:any, reason:string,
 *            viewportPoint?:{x:number,y:number}, needsPermission?:boolean}}
 */
export function classifyTarget({
  point = null,
  hit = null,
  viewport = null,
  screenShared = false,
  monitorShare = false,
  mousePermission = false,
  mirrored = true,
} = {}) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return { kind: 'none', reason: 'No pointer.' };
  }

  // The webcam preview is mirrored so it reads like a mirror; the raw landmark
  // x is therefore flipped relative to what the user sees on screen.
  const nx = mirrored ? 1 - point.x : point.x;
  const ny = point.y;

  // ── 1. AURA's own UI ───────────────────────────────────────────────
  if (hit && viewport) {
    const vx = nx * viewport.width;
    const vy = ny * viewport.height;
    const el = hit(vx, vy);
    const target = el && typeof el.closest === 'function'
      ? el.closest(WEB_TARGET_SELECTOR) : null;
    if (target) {
      return {
        kind: 'web', element: target,
        viewportPoint: { x: Math.round(vx), y: Math.round(vy) },
        reason: 'Pointing at a control in AURA\'s own window.',
      };
    }
  }

  // ── 2. The Windows desktop, via the shared screen ──────────────────
  if (screenShared) {
    if (!monitorShare) {
      return {
        kind: 'none',
        reason: 'A window or tab is shared, not a whole monitor, so these '
          + 'coordinates do not map to desktop pixels. Re-share and pick '
          + '"Entire Screen" to click on the desktop.',
      };
    }
    if (!mousePermission) {
      return {
        kind: 'desktop', needsPermission: true,
        reason: 'Vision Mouse Control is not granted. Enable it in '
          + 'Settings \u2192 Desktop \u2192 Permissions to let a dwell become a real click.',
      };
    }
    return {
      kind: 'desktop',
      reason: 'Pointing at the shared desktop.',
    };
  }

  return {
    kind: 'none',
    reason: 'Nothing clickable under the pointer. Point at an AURA control, '
      + 'or share your entire screen to click on the desktop.',
  };
}

export default DwellController;

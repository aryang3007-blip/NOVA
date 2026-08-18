/**
 * AURA :: Interaction Manager  (spec §5)
 * ======================================
 * Turns a completed dwell into an actual click.
 *
 * The split of responsibility, which is the whole point of this file:
 *
 *   DwellController   decides WHEN   (a hold is complete)   — pure logic
 *   classifyTarget()  decides WHAT   (web control vs desktop pixel) — pure
 *   InteractionManager decides HOW   (dispatch, permission, feedback) — impure
 *
 * TWO KINDS OF CLICK, TWO SECURITY STORIES
 * ----------------------------------------
 * `web`     — a control inside AURA's own page. This is dispatched as a real
 *             DOM click. It needs NO permission: the user is clicking AURA's
 *             own UI with their finger rather than a mouse, and a browser page
 *             clicking its own buttons crosses no trust boundary.
 *
 * `desktop` — a pixel on the Windows desktop, reached through the shared-screen
 *             mapping and the pyautogui bridge. This DOES cross a trust
 *             boundary, so it requires:
 *                1. the `Vision Mouse Control` permission, AND
 *                2. a full-monitor share (a tab/window share has no mapping), AND
 *                3. the automation bridge to be armed.
 *             Any one missing and the click is refused OUT LOUD. It is never
 *             silently swallowed and never faked.
 *
 * HONESTY NOTE
 * ------------
 * On this Linux sandbox pyautogui is not installed and there is no display, so
 * `desktop` clicks report the bridge's real refusal rather than pretending.
 * The `web` path is fully functional everywhere, including here, and is
 * verified end-to-end in tests/test-dwell-ui.py by dwelling on a real button
 * and asserting the click handler ran.
 *
 * @module vision/interaction-manager
 */

import { bus } from '../core/bus.js';
import { DwellController, classifyTarget } from './dwell.js';

/** Events this module publishes. */
export const DWELL_EV = {
  PROGRESS: 'dwell:progress',
  FIRED: 'dwell:fired',
  REFUSED: 'dwell:refused',
  STATE: 'dwell:state',
};

export class InteractionManager {
  /**
   * @param {object} opts
   * @param {import('../desktop/permissions.js').PermissionManager} opts.permissions
   * @param {import('./screen-share.js').ScreenShare} [opts.screen]
   * @param {{automationRun?:Function, run?:Function}} [opts.actions]
   *        LocalActions, for desktop clicks.
   * @param {Function} [opts.logger]
   * @param {Document} [opts.doc]
   * @param {Partial<import('./dwell.js').DWELL_DEFAULTS>} [opts.dwell]
   */
  constructor({ permissions, screen = null, actions = null, logger = null,
                doc = null, dwell = {} } = /** @type {any} */ ({})) {
    if (!permissions) throw new Error('InteractionManager requires a PermissionManager');
    this.permissions = permissions;
    this.screen = screen;
    this.actions = actions;
    this.log = logger || (() => {});
    this.doc = doc || (typeof document !== 'undefined' ? document : null);

    this.dwell = new DwellController(dwell);
    /** Last classification, so the UI can colour the ring by target kind. */
    this.target = { kind: 'none', reason: 'Idle.' };
    /** Bounded history for the dev console. */
    this.history = [];
    this.historyLimit = 40;
    /** Set true while a click is being dispatched, to avoid re-entrancy. */
    this._busy = false;

    this._wire();
  }

  /* ── lifecycle ───────────────────────────────────────────────────── */

  _wire() {
    // The pointer stream already exists: vision.js emits it for every frame in
    // which a pointing hand is visible. Dwell rides on it rather than opening
    // its own camera loop, which would double the CPU cost on a weak machine.
    bus.on('gesture:pointer', (p) => this.feed(p));
    // No pointing hand this frame -> feed a null sample so grace/cancel logic
    // in DwellController runs on a real clock rather than stalling.
    bus.on('vision:hands', ({ hands }) => {
      if (!hands || !hands.length) this.feed(null);
    });
    bus.on('vision:camera-stop', () => this.dwell.reset('camera-stopped'));
  }

  /** Enable/disable dwell-to-click. */
  setEnabled(v) {
    const on = this.dwell.setEnabled(v);
    bus.emit(DWELL_EV.STATE, { enabled: on });
    this.log(`Dwell-to-click ${on ? 'enabled' : 'disabled'}`);
    return on;
  }

  get enabled() { return this.dwell.enabled; }

  /** Runtime tuning from the Settings sliders. */
  configure(patch) { return this.dwell.configure(patch); }

  /* ── the per-frame path ──────────────────────────────────────────── */

  /**
   * Feed one pointer sample. Called ~30x/second, so it must stay cheap.
   * @param {{x:number,y:number,confidence?:number}|null} sample
   * @param {number} [now]
   */
  feed(sample, now = Date.now()) {
    if (!this.dwell.enabled) return null;

    const r = this.dwell.update(sample, now);

    // Classify only while something is actually happening. Hit-testing every
    // idle frame would burn CPU for nothing.
    if (r.state === 'ARMING' || r.state === 'DWELLING' || r.fired) {
      this.target = this.classify(r.anchor || r.point);
    } else if (r.state === 'IDLE') {
      this.target = { kind: 'none', reason: 'Idle.' };
    }

    bus.emit(DWELL_EV.PROGRESS, {
      state: r.state,
      progress: r.progress,
      // From the RESULT, not from live internal state: on the firing tick the
      // controller has already reset progress to 0 for the cooldown, so
      // this.dwell.ringPercent() would report 0% at the exact moment the ring
      // should read 100%.
      ring: DwellController.ringOf(r.progress),
      point: r.point,
      anchor: r.anchor,
      target: this.target.kind,
      reason: this.target.reason,
      needsPermission: !!this.target.needsPermission,
    });

    if (r.fired && !this._busy) {
      // Fire-and-forget: the camera loop must not await a bridge round-trip.
      this._busy = true;
      Promise.resolve(this.commit(r.anchor)).finally(() => { this._busy = false; });
    }
    return r;
  }

  /**
   * What is under the fingertip right now?
   * @param {{x:number,y:number}|null} point
   */
  classify(point) {
    const g = this.screen?.geometry?.() || null;
    return classifyTarget({
      point,
      hit: this.doc ? (x, y) => this.doc.elementFromPoint(x, y) : null,
      viewport: (typeof window !== 'undefined')
        ? { width: window.innerWidth, height: window.innerHeight } : null,
      screenShared: !!g,
      monitorShare: this.screen?.surface === 'monitor',
      mousePermission: this.permissions.isGranted('vision_mouse'),
      mirrored: true,
    });
  }

  /**
   * Dispatch the click a completed dwell earned.
   * @param {{x:number,y:number}} anchor Normalised frame coordinates.
   * @returns {Promise<{ok:boolean, kind:string, message:string}>}
   */
  async commit(anchor) {
    const t = this.classify(anchor);
    this.target = t;

    let out;
    if (t.kind === 'web') out = this._clickWeb(t);
    else if (t.kind === 'desktop') out = await this._clickDesktop(t, anchor);
    else out = { ok: false, kind: 'none', message: t.reason };

    this._record({ at: Date.now(), anchor, ...out });
    bus.emit(out.ok ? DWELL_EV.FIRED : DWELL_EV.REFUSED, { ...out, anchor });
    this.log(`Dwell click ${out.ok ? '\u2713' : '\u2717'} ${out.kind}: ${out.message}`);
    return out;
  }

  /**
   * Click a control inside AURA's own window.
   *
   * A synthesised MouseEvent (not `.click()`) so that handlers reading
   * `event.clientX/clientY` — the command palette, the wardrobe swatches —
   * behave exactly as they do under a mouse.
   */
  _clickWeb(t) {
    const el = t.element;
    if (!el || typeof el.dispatchEvent !== 'function') {
      return { ok: false, kind: 'web', message: 'The control vanished before the dwell finished.' };
    }
    const label = (el.getAttribute?.('aria-label')
      || el.title
      || el.textContent?.trim()?.slice(0, 40)
      || el.id
      || el.tagName || 'control').toString().trim();

    const p = t.viewportPoint || { x: 0, y: 0 };
    const opts = {
      bubbles: true, cancelable: true, view: (typeof window !== 'undefined' ? window : null),
      clientX: p.x, clientY: p.y, button: 0, detail: 1,
    };
    try {
      if (typeof el.focus === 'function') el.focus({ preventScroll: true });
      el.dispatchEvent(new MouseEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
      return { ok: true, kind: 'web', message: `Clicked \u201c${label}\u201d.`, label };
    } catch (e) {
      return { ok: false, kind: 'web', message: `Could not click \u201c${label}\u201d: ${e.message}` };
    }
  }

  /**
   * Click a pixel on the real desktop. Three gates, all enforced here.
   */
  async _clickDesktop(t, anchor) {
    if (t.needsPermission || !this.permissions.isGranted('vision_mouse')) {
      return { ok: false, kind: 'desktop', needsPermission: true, message: t.reason };
    }
    if (!this.screen) {
      return { ok: false, kind: 'desktop', message: 'No screen share is active.' };
    }

    const g = this.screen.geometry?.();
    if (!g) return { ok: false, kind: 'desktop', message: 'Nothing is being shared.' };

    // Normalised frame coords -> captured pixels -> desktop pixels. The second
    // hop is ScreenShare's job and refuses on a window/tab share.
    const capX = (1 - anchor.x) * g.capturedWidth;   // preview is mirrored
    const capY = anchor.y * g.capturedHeight;
    const pt = this.screen.toScreenPoint(capX, capY);
    if (!pt.ok) return { ok: false, kind: 'desktop', message: pt.message };

    // LocalActions.automationRun(plan, confirmed) — NOT `.execute(...)`, which
    // does not exist on LocalActions. tsc caught that before it ever ran.
    if (typeof this.actions?.automationRun !== 'function') {
      return { ok: false, kind: 'desktop',
        message: 'The desktop bridge is not connected, so AURA cannot click your screen.' };
    }

    const res = await Promise.resolve(
      this.actions.automationRun([{ op: 'click', x: pt.x, y: pt.y }], true)
    ).catch(e => ({ ok: false, message: String(e?.message || e) }));

    return {
      ok: !!res?.ok, kind: 'desktop', x: pt.x, y: pt.y,
      message: res?.ok
        ? `Clicked the desktop at ${pt.x}, ${pt.y}.`
        : (res?.message || 'The automation bridge refused the click.'),
    };
  }

  _record(entry) {
    this.history.unshift(entry);
    if (this.history.length > this.historyLimit) this.history.pop();
  }

  /** Snapshot for the UI and the dev console. */
  status() {
    return {
      ...this.dwell.status(),
      target: this.target,
      history: this.history.slice(0, 8),
      permission: this.permissions.isGranted('vision_mouse'),
      monitorShare: this.screen?.surface === 'monitor',
      sharing: !!this.screen?.geometry?.(),
    };
  }
}

export default InteractionManager;

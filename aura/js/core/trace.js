/**
 * AURA :: Trace
 * -------------
 * A visible, append-only record of what AURA is ACTUALLY doing during a
 * multi-step operation — every model call, every decision, every coordinate,
 * every refusal, with timings.
 *
 * WHY: `/watch` and `/do` were black boxes. When they misbehaved there was no
 * way to see which stage failed — was the frame captured? did the OCR model
 * reply? what cell did it name? was the click refused? The user asked to see
 * "everything in front of me", and that is the right instinct: an agent that
 * takes actions on your machine must be auditable.
 *
 * Steps stream to the UI as they happen, not in a batch at the end, so a slow
 * stage is visibly slow rather than looking like a hang.
 *
 * @module core/trace
 */

import { bus } from './bus.js';

/** @typedef {'pending'|'ok'|'warn'|'fail'|'info'} TraceState */

export class Trace {
  /**
   * @param {string} title  e.g. "/do save the file"
   */
  constructor(title, { command = '', plan = [] } = {}) {
    this.title = title;
    this.id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    /** @type {Array<{label:string, state:TraceState, detail:string, ms:number, at:number}>} */
    this.steps = [];
    this.startedAt = Date.now();
    this.endedAt = 0;
    this._stepStart = Date.now();

    /* ── task-card fields (spec §17/§19) ───────────────────────────────
       A Trace is already the honest record of what ran. Giving it a PLAN and
       a cancel flag turns it into a task card without inventing a parallel
       system that could disagree with it. Progress is derived from completed
       steps against the plan — never a timer, never a fake animation. */
    /** The user's original words, shown on the card. */
    this.command = command;
    /** @type {string[]} intended steps, declared up front */
    this.plan = Array.isArray(plan) ? plan.slice(0, 20) : [];
    /** @type {boolean} set by cancel(); long loops must check this */
    this.cancelled = false;
    /** @type {Array<{label:string, path?:string, kind?:string}>} */
    this.artifacts = [];

    bus.emit('trace:start', { id: this.id, title, command: this.command, plan: this.plan });
  }

  /**
   * Declare (or replace) the plan after construction — the planner usually
   * only knows the steps after the model has answered.
   * @param {string[]} steps
   */
  setPlan(steps) {
    this.plan = Array.isArray(steps) ? steps.slice(0, 20) : [];
    bus.emit('trace:plan', { id: this.id, plan: this.plan });
    return this.plan;
  }

  /**
   * Fraction complete, 0..1.
   *
   * Derived from real progress: completed steps against the declared plan, or
   * against a conservative estimate when there is no plan. It is deliberately
   * capped below 1 until `end()` — a bar that sits at 100% while work
   * continues is a lie, and that is exactly the "fake progress" the spec
   * forbids.
   */
  get progress() {
    if (this.endedAt) return 1;
    const done = this.steps.filter(s => s.state !== 'pending').length;
    const total = this.plan.length || Math.max(done + 1, 4);
    return Math.min(0.97, done / total);
  }

  /** Record a file the task produced, so the UI can offer to open it. */
  artifact(label, path, kind = 'file') {
    const a = { label, path, kind };
    this.artifacts.push(a);
    bus.emit('trace:artifact', { id: this.id, ...a });
    return a;
  }

  /**
   * Ask the task to stop.
   *
   * Cooperative by design: it sets a flag and announces intent. A native OS
   * call already in flight cannot be interrupted, so the UI shows "Stopping…"
   * until the loop notices. Claiming an instant kill would be dishonest.
   */
  cancel(reason = 'Cancelled by user') {
    if (this.endedAt) return false;
    this.cancelled = true;
    this.step('Cancellation requested', 'warn', reason);
    bus.emit('trace:cancel', { id: this.id, reason });
    return true;
  }

  /**
   * Record a completed step.
   * @param {string} label   short, e.g. "Capture frame"
   * @param {TraceState} state
   * @param {string} [detail] the actual evidence — sizes, model names, coords
   */
  step(label, state = 'ok', detail = '') {
    const now = Date.now();
    const entry = { label, state, detail: String(detail || ''), ms: now - this._stepStart, at: now };
    this._stepStart = now;
    this.steps.push(entry);
    bus.emit('trace:step', { id: this.id, ...entry });
    return entry;
  }

  /** Convenience wrappers. */
  ok(l, d) { return this.step(l, 'ok', d); }
  info(l, d) { return this.step(l, 'info', d); }
  warn(l, d) { return this.step(l, 'warn', d); }
  fail(l, d) { return this.step(l, 'fail', d); }

  /**
   * Time an async stage and record it, propagating any error after logging.
   * @template T
   * @param {string} label
   * @param {() => Promise<T>} fn
   * @param {(v:T)=>string} [describe]
   * @returns {Promise<T>}
   */
  async stage(label, fn, describe) {
    try {
      const v = await fn();
      this.ok(label, describe ? describe(v) : '');
      return v;
    } catch (e) {
      this.fail(label, e?.message || String(e));
      throw e;
    }
  }

  end(state = 'ok', summary = '') {
    this.endedAt = Date.now();
    const total = this.endedAt - this.startedAt;
    // A cancelled task must never report success, whatever the caller passes.
    if (this.cancelled && state === 'ok') state = 'warn';
    bus.emit('trace:end', {
      id: this.id, state, summary, ms: total, steps: this.steps.length,
      cancelled: this.cancelled, artifacts: this.artifacts,
    });
    return { id: this.id, ms: total, steps: this.steps.length, state, summary,
             cancelled: this.cancelled, artifacts: this.artifacts };
  }

  get totalMs() { return (this.endedAt || Date.now()) - this.startedAt; }

  /** Render as markdown, for pasting into a chat message. */
  toMarkdown() {
    const icon = { ok: '✅', warn: '⚠️', fail: '❌', info: '·', pending: '⏳' };
    const lines = this.steps.map(s =>
      `${icon[s.state] || '·'} **${s.label}** — ${s.ms}ms${s.detail ? `\n     ${s.detail}` : ''}`);
    return `**TRACE — ${this.title}** _(${this.totalMs}ms total)_\n\n${lines.join('\n')}`;
  }
}

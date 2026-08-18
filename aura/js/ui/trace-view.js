/**
 * AURA :: Trace view
 * ------------------
 * DOM rendering for `core/trace.js`. Kept separate so the Trace primitive
 * itself stays layer-appropriate: plugins and the AI layer emit traces, and
 * only the UI layer knows how to paint them.
 *
 * @module ui/trace-view
 */

import { bus } from '../core/bus.js';

/**
 * Renders traces into a live panel. Attaches to an element and streams.
 */
export class TraceView {
  /** @param {HTMLElement} mount */
  constructor(mount) {
    this.mount = mount;
    /**
     * The element that is actually shown/hidden. In the main app the log lives
     * inside a `.trace-dock` that must take layout space as a whole (header
     * included); on /screen there is no dock and the log toggles itself.
     * @type {HTMLElement|null}
     */
    this.dock = mount ? (mount.closest('.trace-dock') || mount) : null;
    /** @type {Map<string, HTMLElement>} */
    this.panels = new Map();
    this.max = 6;
    this._wire();
  }

  /** Reveal the dock. Safe to call repeatedly. */
  show() { if (this.dock) this.dock.hidden = false; }

  /** Hide the dock without discarding what it holds. */
  hide() { if (this.dock) this.dock.hidden = true; }

  _wire() {
    bus.on('trace:start', ({ id, title, command, plan }) =>
      this._start(id, title, command, plan));
    bus.on('trace:plan', (e) => this._plan(e));
    bus.on('trace:step', (e) => this._step(e));
    bus.on('trace:artifact', (e) => this._artifact(e));
    bus.on('trace:end', (e) => this._end(e));
  }

  _start(id, title, command = '', plan = []) {
    if (!this.mount) return;
    const el = document.createElement('div');
    el.className = 'trace';
    el.dataset.id = id;
    // Structure = task card (spec §17): head, command echo, plan, progress,
    // live steps, artifacts, actions. Everything below the head starts empty
    // and is filled only by REAL events.
    el.innerHTML = `<div class="trace-head">
        <span class="trace-dot running"></span>
        <span class="trace-title"></span>
        <span class="trace-ms">running…</span>
        <button class="trace-cancel" title="Cancel this task">CANCEL</button>
      </div>
      <div class="trace-cmd" hidden></div>
      <ol class="trace-plan" hidden></ol>
      <div class="trace-bar"><i></i></div>
      <div class="trace-steps"></div>
      <div class="trace-arts" hidden></div>`;
    // textContent, never innerHTML — a trace title can contain user input.
    el.querySelector('.trace-title').textContent = title;
    if (command) {
      const c = /** @type {HTMLElement} */ (el.querySelector('.trace-cmd'));
      c.textContent = command;
      c.hidden = false;
    }
    el.querySelector('.trace-cancel')?.addEventListener('click', () => {
      bus.emit('trace:cancel-request', { id });
      const b = /** @type {HTMLButtonElement} */ (el.querySelector('.trace-cancel'));
      b.textContent = 'STOPPING…';
      b.disabled = true;
    });
    this.mount.prepend(el);
    this.panels.set(id, el);
    if (plan?.length) this._plan({ id, plan });
    while (this.mount.children.length > this.max) this.mount.lastElementChild?.remove();
    this.show();
  }

  /** Render the declared plan, and mark steps done as they complete. */
  _plan({ id, plan }) {
    const el = this.panels.get(id);
    if (!el || !plan?.length) return;
    const ol = /** @type {HTMLElement} */ (el.querySelector('.trace-plan'));
    ol.innerHTML = '';
    for (const step of plan) {
      const li = document.createElement('li');
      li.textContent = String(step);
      ol.appendChild(li);
    }
    ol.hidden = false;
    el.dataset.planCount = String(plan.length);
  }

  /**
   * Progress from REAL completed steps — never a timer.
   * Capped below 100% until the task actually ends, because a bar sitting at
   * 100% while work continues is exactly the fake progress the spec forbids.
   */
  _progress(el, done) {
    const total = Number(el.dataset.planCount || 0) || Math.max(done + 1, 4);
    const pct = Math.min(97, Math.round((done / total) * 100));
    const bar = /** @type {HTMLElement} */ (el.querySelector('.trace-bar i'));
    if (bar) bar.style.width = `${pct}%`;
    // Tick off the matching plan line so the user can see where we are.
    const items = el.querySelectorAll('.trace-plan li');
    items.forEach((li, i) => li.classList.toggle('done', i < done));
    if (items[done]) items[done].classList.add('active');
  }

  _step({ id, label, state, detail, ms }) {
    const el = this.panels.get(id);
    if (!el) return;
    const row = document.createElement('div');
    row.className = `trace-step ${state}`;
    const l = document.createElement('span');
    l.className = 'trace-label';
    l.textContent = label;
    const t = document.createElement('span');
    t.className = 'trace-t';
    t.textContent = `${ms}ms`;
    row.append(l, t);
    if (detail) {
      const d = document.createElement('div');
      d.className = 'trace-detail';
      d.textContent = detail;
      row.appendChild(d);
    }
    el.querySelector('.trace-steps').appendChild(row);
    // Progress is recomputed from the number of REAL steps recorded so far.
    this._progress(el, el.querySelectorAll('.trace-step').length);
  }

  /** A produced file: offer to open it (spec §73). */
  _artifact({ id, label, path, kind }) {
    const el = this.panels.get(id);
    if (!el) return;
    const box = /** @type {HTMLElement} */ (el.querySelector('.trace-arts'));
    const row = document.createElement('div');
    row.className = 'trace-art';
    const ic = document.createElement('span');
    ic.className = 'trace-art-ico';
    ic.textContent = kind === 'pptx' ? '\u{1F4CA}' : kind === 'xlsx' ? '\u{1F4C8}'
      : kind === 'docx' ? '\u{1F4DD}' : kind === 'site' ? '\u{1F310}' : '\u{1F4C4}';
    const name = document.createElement('b');
    name.textContent = label || 'Output';
    const p2 = document.createElement('code');
    p2.textContent = path || '';
    const open = document.createElement('button');
    open.className = 'trace-art-open';
    open.textContent = 'OPEN';
    open.addEventListener('click', () => bus.emit('artifact:open', { path, kind }));
    row.append(ic, name, p2, open);
    box.appendChild(row);
    box.hidden = false;
  }

  _end({ id, state, ms, summary, cancelled }) {
    const el = this.panels.get(id);
    if (!el) return;
    const dot = el.querySelector('.trace-dot');
    dot.className = `trace-dot ${state}`;
    const msEl = el.querySelector('.trace-ms');
    msEl.textContent = `${ms}ms`;
    // Only now may the bar reach 100%, and only if it really succeeded.
    const bar = /** @type {HTMLElement} */ (el.querySelector('.trace-bar i'));
    if (bar) {
      bar.style.width = '100%';
      bar.className = state === 'fail' ? 'fail' : cancelled ? 'warn' : '';
    }
    el.querySelector('.trace-cancel')?.remove();
    el.querySelectorAll('.trace-plan li').forEach(li => {
      li.classList.remove('active');
      if (state !== 'fail' && !cancelled) li.classList.add('done');
    });
    if (summary) {
      const s = document.createElement('div');
      s.className = `trace-summary ${state}`;
      s.textContent = summary;
      el.querySelector('.trace-steps').appendChild(s);
    }
  }

  clear() {
    if (!this.mount) return;
    this.mount.innerHTML = '';
    this.hide();
    this.panels.clear();
  }
}

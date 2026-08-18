/**
 * AURA :: Developer Console
 * -------------------------
 * A live window into what the Runtime is actually doing — every event, every
 * command proposal, every gate decision, every subsystem's state.
 *
 * DESIGN CONSTRAINTS THAT MATTER
 * ------------------------------
 *  • BOUNDED. Streams are capped and the DOM is trimmed. An observability
 *    tool that leaks memory during a long session defeats its own purpose —
 *    this project has already fixed two unbounded-DOM leaks.
 *  • PAUSABLE. You cannot read a stream that is scrolling. Pause freezes the
 *    view without dropping the underlying capture.
 *  • CHEAP WHEN CLOSED. Rendering only happens while the panel is visible.
 *    Events are still captured (that is the point) but nothing touches the
 *    DOM until you look.
 *  • ESCAPED. Everything is textContent or escaped — payloads contain user
 *    input and model output.
 *
 * @module ui/dev-console
 */

import { bus } from '../core/bus.js';

const MAX_EVENTS = 300;
const MAX_LOGS = 300;
const RENDER_MS = 700;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Events we surface, mapped to the pipeline node they light up.
 * @type {Array<[RegExp, string]>}
 */
const NODE_FOR = [
  [/^ai:user-message/, 'user'],
  [/^ai:(stream|provider|model)/, 'intent'],
  [/^runtime:proposed/, 'planner'],
  [/^(screen:|vision:)/, 'vision'],
  [/^runtime:(executed|rejected|journal)/, 'runtime'],
  [/^(action:|desktop:)/, 'desktop'],
  [/^vision:presence/, 'vision'],
  [/^privacy:/, 'runtime'],
];

export class DevConsole {
  /**
   * @param {object} o
   * @param {any} o.kernel   RuntimeCore
   * @param {any} o.world    WorldModel
   * @param {any} o.app      AuraApp (for plugin + memory state)
   */
  constructor({ kernel, world, app }) {
    this.kernel = kernel;
    this.world = world;
    this.app = app;

    /** @type {Array<{event:string, payload:string, at:number}>} */
    this.events = [];
    /** @type {Array<{kind:string, text:string, at:number}>} */
    this.logs = [];
    this.paused = false;
    this.visible = false;
    this.tab = 'overview';
    this._timer = null;
    this._nodeTimers = new Map();

    this._capture();
  }

  /** Subscribe once, at construction, so nothing is missed while closed. */
  _capture() {
    // The bus has no wildcard, so tap emit() directly. This is deliberate:
    // a dev console that only sees events someone remembered to forward is
    // not a dev console.
    const origEmit = bus.emit.bind(bus);
    bus.emit = (event, payload) => {
      try { this._onEvent(event, payload); } catch { /* never break the app */ }
      return origEmit(event, payload);
    };
  }

  _onEvent(event, payload) {
    const name = String(event);
    // Skip our own high-frequency chatter, or the console would trace itself.
    if (name.startsWith('devconsole:')) return;
    let brief = '';
    try {
      brief = payload === undefined ? ''
        : typeof payload === 'object' ? JSON.stringify(payload).slice(0, 220)
        : String(payload).slice(0, 220);
    } catch { brief = '[unserialisable]'; }

    this.events.push({ event: name, payload: brief, at: Date.now() });
    if (this.events.length > MAX_EVENTS) this.events.shift();

    if (name === 'sys:log' && payload?.text) this.log(payload.kind || 'info', payload.text);
    if (name === 'runtime:rejected') this.log('warn', `REJECTED (${payload?.stage}): ${payload?.error}`);
    if (name === 'runtime:executed') {
      this.log(payload?.ok ? 'ok' : 'warn',
        `${payload?.command} → ${payload?.ok ? 'ok' : 'failed'}`);
    }
    if (name === 'ai:user-message') this.log('user', payload?.text || '');
    // Privacy Guard is a security feature; every state change is auditable.
    if (name === 'privacy:state') {
      this.log('info', `PRIVACY GUARD ${payload?.from} → ${payload?.to} (${payload?.reason})`);
    }
    if (name === 'privacy:threat') {
      this.log('warn', `THREAT CONFIRMED · confidence ${(payload?.confidence ?? 0).toFixed(2)}`
        + ` · persisted ${Math.round(payload?.persisted || 0)}ms`
        + ` · area ${((payload?.area || 0) * 100).toFixed(1)}%`);
    }
    if (name === 'privacy:acted') {
      this.log(payload?.ok ? 'ok' : 'fail',
        payload?.ok ? `WINDOW MINIMISED · ${payload.summary || ''}`
                    : `MINIMISE FAILED (${payload?.stage || '?'}) · ${payload?.error || ''}`);
    }

    for (const [rx, node] of NODE_FOR) {
      if (rx.test(name)) { this._pulse(node); break; }
    }
  }

  log(kind, text) {
    this.logs.push({ kind, text: String(text).slice(0, 400), at: Date.now() });
    if (this.logs.length > MAX_LOGS) this.logs.shift();
  }

  /** Light up a node in the pipeline diagram. */
  _pulse(node) {
    if (!this.visible) return;
    const el = document.querySelector(`.dc-node[data-node="${node}"]`);
    if (!el) return;
    el.classList.add('hot');
    clearTimeout(this._nodeTimers.get(node));
    this._nodeTimers.set(node, setTimeout(() => el.classList.remove('hot'), 900));
  }

  /* ── wiring ───────────────────────────────────────────────────────── */

  mount() {
    document.querySelectorAll('.dc-tab').forEach(b => {
      b.addEventListener('click', () => {
        this.tab = /** @type {HTMLElement} */ (b).dataset.dc;
        document.querySelectorAll('.dc-tab').forEach(x => x.classList.toggle('active', x === b));
        document.querySelectorAll('.dc-pane').forEach(p =>
          p.classList.toggle('active', /** @type {HTMLElement} */ (p).dataset.dcpane === this.tab));
        this.render();
      });
    });
    const pause = document.getElementById('dc-pause');
    pause?.addEventListener('click', () => {
      this.paused = !this.paused;
      pause.textContent = this.paused ? '▶' : '⏸';
      pause.classList.toggle('accent', this.paused);
      if (!this.paused) this.render();
    });
    document.getElementById('dc-clear')?.addEventListener('click', () => {
      this.events = []; this.logs = []; this.render();
    });
    document.getElementById('dc-evfilter')?.addEventListener('input', () => this.render());
    document.getElementById('dc-logfilter')?.addEventListener('input', () => this.render());
  }

  show() {
    this.visible = true;
    this.render();
    clearInterval(this._timer);
    this._timer = setInterval(() => { if (!this.paused) this.render(); }, RENDER_MS);
  }

  hide() {
    this.visible = false;
    clearInterval(this._timer);
    this._timer = null;
  }

  /* ── rendering ────────────────────────────────────────────────────── */

  render() {
    if (!this.visible || this.paused) return;
    // Explicit dispatch rather than a computed method name: a string lookup
    // makes these methods look unreferenced to static analysis (and to a
    // human reading the file), which is exactly the kind of thing
    // tests/test-architecture.mjs is meant to catch.
    switch (this.tab) {
      case 'overview': this._renderOverview(); break;
      case 'world':    this._renderWorld();    break;
      case 'commands': this._renderCommands(); break;
      case 'events':   this._renderEvents();   break;
      case 'logs':     this._renderLogs();     break;
      default: break;
    }
  }

  _renderOverview() {
    const el = document.getElementById('dc-overview');
    if (!el) return;
    const k = this.kernel?.status?.() || { stats: {}, journal: [], commands: [] };
    const s = k.stats || {};
    const ai = this.app?.ai || {};
    const plugins = this.app?.pluginsRef?.plugins || null;

    const stat = (label, value, cls = '') =>
      `<div class="dc-stat"><div class="dc-k">${esc(label)}</div>
       <div class="dc-v ${cls}">${esc(value)}</div></div>`;

    const ready = (k.commands || []).filter(c => c.ready).length;
    el.innerHTML =
      `<div class="dc-stats">
         ${stat('PROPOSED', s.proposed ?? 0)}
         ${stat('EXECUTED', s.executed ?? 0, 'ok')}
         ${stat('REJECTED', s.rejected ?? 0, (s.rejected ? 'warn' : ''))}
         ${stat('FAILED', s.failed ?? 0, (s.failed ? 'bad' : ''))}
         ${stat('COMMANDS READY', `${ready}/${(k.commands || []).length}`)}
         ${stat('EVENTS SEEN', this.events.length)}
       </div>
       <h4 class="dc-h">AI</h4>
       <div class="dc-kv">
         ${row('Provider', ai.resolvedProvider || '—')}
         ${row('Model', ai.resolvedModel || '—')}
         ${row('Streaming', ai.streaming ? 'yes' : 'no')}
         ${row('Memory turns', ai.memory?.all?.().length ?? '—')}
       </div>
       ${this._privacyBlock()}
       <h4 class="dc-h">Recent dispatches</h4>
       <div class="dc-stream">${
         (k.journal || []).slice(0, 12).map(j =>
           `<div class="dc-row ${j.ok ? 'ok' : 'bad'}">
              <span class="dc-t">${time(j.at)}</span>
              <span class="dc-cmd">${esc(j.command)}</span>
              <span class="dc-stage">${esc(j.stage)}</span>
              <span class="dc-sum">${esc(j.summary || '')}</span>
              <span class="dc-ms">${j.ms ?? 0}ms</span>
            </div>`).join('') || '<div class="dc-empty">Nothing dispatched yet.</div>'
       }</div>`;
  }

  /**
   * Privacy Guard pipeline, rendered as the chain it actually is so a trigger
   * can be debugged: which stage fired, with what numbers.
   */
  _privacyBlock() {
    const pg = this.app?.privacyGuard;
    if (!pg) return '';
    const s = pg.status();
    const d = s.lastDetection;
    const stage = (label, val, on) =>
      `<div class="dc-pair"><span>${on ? '▸ ' : '  '}${esc(label)}</span>
       <span>${esc(val)}</span></div>`;
    return `<h4 class="dc-h">Privacy Guard</h4>
      <div class="dc-kv">
        ${stage('VISION', d?.present
            ? `person (${d.source}) · conf ${(d.confidence ?? 0).toFixed(2)}`
            : 'no person', !!d?.present)}
        ${stage('PRIVACY GUARD', s.enabled
            ? `${s.state} · persisted ${Math.round(s.persistingMs)}ms / ${s.detectionPersistenceMs}ms`
            : 'disabled', s.enabled)}
        ${stage('THRESHOLDS', `conf ≥ ${s.minimumConfidence.toFixed(2)} · area ≥ ${(s.minArea * 100).toFixed(1)}%`, false)}
        ${stage('ACTION MANAGER', s.action, s.state === 'ACTION_EXECUTED')}
        ${stage('COOLDOWN', s.inCooldown
            ? `${(s.cooldownRemainingMs / 1000).toFixed(1)}s remaining` : 'ready', s.inCooldown)}
        ${stage('COUNTS', `${s.stats.detections} seen · ${s.stats.qualified} qualified · `
            + `${s.stats.triggers} triggered · ${s.stats.suppressed} suppressed`, false)}
      </div>`;
  }

  _renderWorld() {
    const el = document.getElementById('dc-world');
    if (!el) return;
    const w = this.world?.snapshot?.();
    if (!w) { el.innerHTML = '<div class="dc-empty">No world model.</div>'; return; }
    const age = (ms) => (ms === Infinity || ms == null) ? 'never' : `${Math.round(ms / 1000)}s ago`;
    el.innerHTML =
      `<h4 class="dc-h">Applications</h4>
       <div class="dc-kv">
         ${row('Known', `${w.apps.count} (${age(w.apps.age)})`)}
         ${row('Running', w.processes.available
             ? (w.processes.running.join(', ') || 'none detected') : 'unknown — psutil missing')}
         ${row('Running data', `${age(w.processes.age)}${w.processes.fresh ? ' · fresh' : ' · stale'}`)}
       </div>
       <h4 class="dc-h">Screen</h4>
       <div class="dc-kv">
         ${row('Geometry', w.geometry ? `${w.geometry.width}×${w.geometry.height}` : '—')}
         ${row('Last seen', `${age(w.screen.age)}${w.screen.fresh ? ' · fresh' : ' · stale'}`)}
         ${row('Active app', w.screen.activeApp || '—')}
       </div>
       ${w.screen.text ? `<div class="dc-pre">${esc(w.screen.text.slice(0, 800))}</div>` : ''}
       <h4 class="dc-h">Action history</h4>
       <div class="dc-stream">${
         (w.actions || []).slice().reverse().map(a =>
           `<div class="dc-row ${a.ok ? 'ok' : 'bad'}">
              <span class="dc-t">${time(a.at)}</span>
              <span class="dc-cmd">${esc(a.command)}</span>
              <span class="dc-sum">${esc(a.summary)}</span>
            </div>`).join('') || '<div class="dc-empty">No actions yet.</div>'
       }</div>`;
  }

  _renderCommands() {
    const el = document.getElementById('dc-commands');
    if (!el) return;
    const cmds = this.kernel?.availability?.() || [];
    /** @type {Record<string, any[]>} */
    const groups = {};
    for (const c of cmds) (groups[c.name.split('.')[0]] ||= []).push(c);
    el.innerHTML = Object.entries(groups).map(([domain, list]) =>
      `<h4 class="dc-h">${esc(domain)}</h4>
       <div class="dc-stream">${list.map(c =>
        `<div class="dc-row ${c.ready ? 'ok' : 'warn'}">
           <span class="dc-cmd">${esc(c.name)}</span>
           <span class="dc-stage risk-${esc(c.risk)}">${esc(c.risk)}</span>
           <span class="dc-sum">${c.ready ? 'ready' : esc(c.reasons.join('; '))}</span>
         </div>`).join('')}</div>`).join('');
  }

  _renderEvents() {
    const el = document.getElementById('dc-events');
    if (!el) return;
    const q = (/** @type {HTMLInputElement} */ (document.getElementById('dc-evfilter'))?.value || '')
      .toLowerCase();
    const rows = this.events.filter(e =>
      !q || e.event.toLowerCase().includes(q) || e.payload.toLowerCase().includes(q));
    el.innerHTML = rows.slice(-120).reverse().map(e =>
      `<div class="dc-row">
         <span class="dc-t">${time(e.at)}</span>
         <span class="dc-cmd">${esc(e.event)}</span>
         <span class="dc-sum">${esc(e.payload)}</span>
       </div>`).join('') || '<div class="dc-empty">No events match.</div>';
  }

  _renderLogs() {
    const el = document.getElementById('dc-logs');
    if (!el) return;
    const q = (/** @type {HTMLInputElement} */ (document.getElementById('dc-logfilter'))?.value || '')
      .toLowerCase();
    const rows = this.logs.filter(l => !q || l.text.toLowerCase().includes(q));
    el.innerHTML = rows.slice(-120).reverse().map(l =>
      `<div class="dc-row ${esc(l.kind)}">
         <span class="dc-t">${time(l.at)}</span>
         <span class="dc-stage">${esc(l.kind)}</span>
         <span class="dc-sum">${esc(l.text)}</span>
       </div>`).join('') || '<div class="dc-empty">No logs match.</div>';
  }
}

function row(k, v) {
  return `<div class="dc-pair"><span>${esc(k)}</span><span>${esc(v)}</span></div>`;
}
function time(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
       + `:${String(d.getSeconds()).padStart(2, '0')}`;
}

export default DevConsole;

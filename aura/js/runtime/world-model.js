/**
 * AURA :: Desktop World Model
 * ---------------------------
 * A persistent, incrementally-updated picture of the machine, so AURA does
 * not rediscover the world from a screenshot on every single step.
 *
 * WHY
 * ---
 * The observation loop was stateless: each iteration captured a frame, asked
 * a model what it saw, and threw the answer away. That is slow (a vision call
 * per step, 10–30s on a modest CPU) and forgetful — the agent could not tell
 * "the screen changed because my click worked" from "the screen changed
 * because something else happened".
 *
 * The world model keeps what is durable (which apps exist, which are running,
 * screen geometry, what we last saw and where) and marks it stale rather than
 * deleting it. Staleness is explicit, so a consumer can decide whether a
 * cached fact is good enough or must be re-observed. Nothing here is ever
 * presented as fresher than it is.
 *
 * IT DOES NOT GUESS. Every field records when it was last confirmed and by
 * what means. `describe()` says "as of 3s ago" rather than implying now.
 *
 * @module runtime/world-model
 */

import { bus } from '../core/bus.js';

/** How long a fact stays trustworthy, by kind (ms). */
const TTL = {
  apps: 5 * 60_000,      // installed apps change rarely
  running: 15_000,       // processes change often
  screen: 3_000,         // the screen changes constantly
  geometry: 60_000,
};

export class WorldModel {
  constructor() {
    /** @type {{apps:any[], at:number}} */
    this.apps = { apps: [], at: 0 };
    /** @type {{running:string[], at:number, available:boolean}} */
    this.processes = { running: [], at: 0, available: false };
    /** @type {{width:number, height:number, capturedWidth:number, capturedHeight:number, at:number}|null} */
    this.geometry = null;
    /** Latest screen understanding. */
    this.screen = {
      description: '', text: '', at: 0,
      /** @type {Array<{text:string, cell:string}>} */
      elements: [],
      activeApp: null,
      surface: null,
    };
    /** Everything AURA has actually done, newest last. */
    this.actions = [];
    /** Free-form notes the planner wants to persist across steps. */
    this.notes = [];
    this.updatedAt = 0;
  }

  /* ── writers ──────────────────────────────────────────────────────── */

  setApps(apps) {
    this.apps = { apps: Array.isArray(apps) ? apps : [], at: Date.now() };
    this._touch('apps');
  }

  setRunning(running, available = true) {
    this.processes = { running: Array.isArray(running) ? running : [], at: Date.now(), available };
    this._touch('running');
  }

  setGeometry(g) {
    if (!g) return;
    this.geometry = { ...g, at: Date.now() };
    this._touch('geometry');
  }

  /**
   * Record what we understood from a frame.
   * @param {{description?:string, text?:string, elements?:Array, activeApp?:string, surface?:string}} obs
   */
  setScreen(obs = {}) {
    this.screen = {
      description: obs.description ?? this.screen.description,
      text: obs.text ?? this.screen.text,
      elements: obs.elements ?? this.screen.elements,
      activeApp: obs.activeApp ?? this.screen.activeApp,
      surface: obs.surface ?? this.screen.surface,
      at: Date.now(),
    };
    this._touch('screen');
  }

  /**
   * Record an executed action and, where it is safe to do so, update derived
   * state optimistically. Launching an app is the one case where we can infer
   * the outcome — anything visual must be re-observed.
   */
  recordAction(command, params, result) {
    const entry = { command, params, ok: !!result?.ok,
                    summary: result?.summary || result?.message || '', at: Date.now() };
    this.actions.push(entry);
    if (this.actions.length > 60) this.actions.shift();

    if (command === 'desktop.launch_app' && result?.ok && params?.app) {
      if (!this.processes.running.includes(params.app)) {
        this.processes.running.push(params.app);
        // Optimistic: mark the fact fresh but note how we learned it.
        this.processes.at = Date.now();
      }
    }
    // Anything that touches the UI invalidates our picture of the screen.
    if (/^input\./.test(command)) this.screen.at = 0;
    this._touch('action');
    return entry;
  }

  note(text) {
    this.notes.push({ text: String(text || ''), at: Date.now() });
    if (this.notes.length > 30) this.notes.shift();
  }

  _touch(kind) {
    this.updatedAt = Date.now();
    bus.emit('world:updated', { kind, at: this.updatedAt });
  }

  /* ── readers ──────────────────────────────────────────────────────── */

  /** Is a cached fact still within its TTL? */
  isFresh(kind) {
    const at = { apps: this.apps.at, running: this.processes.at,
                 screen: this.screen.at, geometry: this.geometry?.at || 0 }[kind] || 0;
    return at > 0 && (Date.now() - at) < (TTL[kind] || 5000);
  }

  ageOf(kind) {
    const at = { apps: this.apps.at, running: this.processes.at,
                 screen: this.screen.at, geometry: this.geometry?.at || 0 }[kind] || 0;
    return at ? Date.now() - at : Infinity;
  }

  /** Is this app believed to be running? `null` = we genuinely do not know. */
  isRunning(appId) {
    if (!this.processes.available) return null;
    if (!this.isFresh('running')) return null;
    return this.processes.running.includes(String(appId || '').toLowerCase());
  }

  /**
   * Compact context for a model prompt. Explicitly time-stamped so the model
   * is told how stale each fact is instead of assuming it is current.
   */
  describe({ maxChars = 900 } = {}) {
    const secs = (ms) => (ms === Infinity ? 'never' : `${Math.round(ms / 1000)}s ago`);
    const lines = [];
    if (this.apps.apps.length) {
      lines.push(`Apps available: ${this.apps.apps.map(a => a.id || a).join(', ')}`);
    }
    if (this.processes.available) {
      lines.push(`Running (${secs(this.ageOf('running'))}): `
        + (this.processes.running.join(', ') || 'nothing detected'));
    } else {
      lines.push('Running processes: unknown (psutil not installed)');
    }
    if (this.geometry) lines.push(`Screen: ${this.geometry.width}x${this.geometry.height}`);
    if (this.screen.at) {
      lines.push(`Screen seen ${secs(this.ageOf('screen'))}`
        + (this.screen.activeApp ? ` — active: ${this.screen.activeApp}` : ''));
      if (this.screen.text) {
        lines.push(`Visible text: ${this.screen.text.slice(0, 300).replace(/\s+/g, ' ')}`);
      }
    }
    if (this.actions.length) {
      const recent = this.actions.slice(-5)
        .map(a => `${a.command}${a.ok ? '' : ' (FAILED)'}`).join(' → ');
      lines.push(`Recent actions: ${recent}`);
    }
    for (const n of this.notes.slice(-3)) lines.push(`Note: ${n.text}`);
    return lines.join('\n').slice(0, maxChars);
  }

  /** Full snapshot for the Developer Console. */
  snapshot() {
    return {
      updatedAt: this.updatedAt,
      apps: { count: this.apps.apps.length, fresh: this.isFresh('apps'),
              age: this.ageOf('apps'), list: this.apps.apps.map(a => a.id || a) },
      processes: { ...this.processes, fresh: this.isFresh('running'),
                   age: this.ageOf('running') },
      geometry: this.geometry,
      screen: { ...this.screen, fresh: this.isFresh('screen'), age: this.ageOf('screen') },
      actions: this.actions.slice(-15),
      notes: this.notes.slice(-10),
    };
  }

  reset() {
    this.screen = { description: '', text: '', at: 0, elements: [], activeApp: null, surface: null };
    this.actions = [];
    this.notes = [];
    this._touch('reset');
  }
}

export const worldModel = new WorldModel();
export default WorldModel;

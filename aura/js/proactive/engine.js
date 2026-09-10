/**
 * NOVA :: Proactive Engine
 * ========================
 * Event-driven nudges that make NOVA feel like an assistant instead of a
 * chatbot: long tasks finishing, failures worth knowing about, connectivity
 * changes, low battery.
 *
 * Hard rule: the engine NEVER acts silently. It emits PROACTIVE_NOTIFY
 * (toast in the UI, optionally spoken); acting stays with the user.
 * Permission-controlled: master toggle + per-rule toggles + per-rule
 * cooldowns, all in Settings → Interface.
 *
 * Sources (all real signals, no polling hacks except battery):
 *   AGENT_STATE 'executing'/'succeeded'/'failed'  task lifecycle
 *   window online/offline                          connectivity
 *   navigator.getBattery (guarded)                 battery level
 *
 * @module proactive/engine
 */

const RULES = ['longTask', 'taskFailed', 'backOnline', 'lowBattery'];

export class ProactiveEngine {
  /**
   * @param {object} deps
   * @param {any} deps.bus bus on which AGENT_STATE arrives / PROACTIVE_NOTIFY leaves
   * @param {any} deps.EV event-name catalog
   * @param {any} deps.config config.get(...)
   * @param {() => number} [deps.clock] ms clock (injectable for tests)
   * @param {() => Promise<{level:number,charging:boolean}|null>} [deps.battery]
   */
  constructor({ bus, EV, config, clock = () => Date.now(), battery = null } = {}) {
    this.bus = bus;
    this.EV = EV;
    this.config = config;
    this._clock = clock;
    this._batteryImpl = battery || defaultBatteryProbe;
    this._tasks = new Map();      // taskId -> startedAt ms
    this._lastFired = new Map();  // rule -> ms
    this._wasOffline = null;      // null = baseline not taken yet
    this._batteryNotified = false;
    this._onAgentState = (e) => this.handleAgentState(e || {});
    this._started = false;
  }

  start() {
    if (this._started || !this.bus) return this;
    this._started = true;
    this.bus.on(this.EV.AGENT_STATE, this._onAgentState);
    return this;
  }

  stop() {
    if (!this._started || !this.bus) return this;
    this._started = false;
    if (typeof this.bus.off === 'function') this.bus.off(this.EV.AGENT_STATE, this._onAgentState);
    return this;
  }

  // ── task lifecycle ──────────────────────────────────────────────────

  handleAgentState({ state, taskId, steps = 0, message = '' } = {}) {
    const now = this._clock();
    if (state === 'executing' && taskId && !this._tasks.has(taskId)) {
      this._tasks.set(taskId, now);
      return;
    }
    if ((state === 'succeeded' || state === 'failed') && taskId) {
      const started = this._tasks.get(taskId);
      this._tasks.delete(taskId);
      const secs = started != null ? Math.max(0, Math.round((now - started) / 1000)) : 0;
      if (state === 'failed') {
        this._fire('taskFailed', 'Task failed',
          `${steps ? `after ${steps} steps: ` : ''}${message || 'unknown error'}`.trim(),
          { speak: true });
        return;
      }
      const longSec = Number(this.config?.get?.('proactiveLongTaskSec') ?? 60);
      if (secs >= longSec) {
        this._fire('longTask', `Task finished in ${fmtDur(secs)}`,
          `${steps ? `${steps} steps. ` : ''}${truncate(message || 'done', 140)}`,
          { speak: false });
      }
      return;
    }
    // idle / cancelled / planning-without-id: user-driven or untracked — silent.
    if ((state === 'idle' || state === 'cancelled') && taskId) this._tasks.delete(taskId);
  }

  // ── connectivity ────────────────────────────────────────────────────

  handleOnlineStatus(online) {
    const off = online === false;
    if (this._wasOffline === null) { this._wasOffline = off; return; } // baseline
    const was = this._wasOffline;
    this._wasOffline = off;
    if (was && !off) {
      this._fire('backOnline', 'Back online',
        'Connection restored — cloud providers are reachable again.',
        { speak: false });
    }
  }

  // ── battery ─────────────────────────────────────────────────────────

  async pollBattery() {
    let b = null;
    try {
      b = await this._batteryImpl();
    } catch { b = null; }
    if (!b || typeof b.level !== 'number') return; // API missing — stay silent
    const pct = Math.round(b.level * 100);
    const thr = Number(this.config?.get?.('proactiveBatteryPct') ?? 20);
    if (b.charging || pct > thr + 10) { this._batteryNotified = false; return; }
    if (pct <= thr && !this._batteryNotified) {
      this._batteryNotified = true;
      this._fire('lowBattery', `Battery at ${pct}%`,
        'Consider plugging in or enabling battery saver.', { speak: true });
    }
  }

  // ── gating + emit ───────────────────────────────────────────────────

  _ruleOn(rule) {
    if (this.config?.get?.('proactiveEnabled') === false) return false;
    const rules = this.config?.get?.('proactiveRules');
    if (rules && typeof rules === 'object' && rules[rule] === false) return false;
    return true;
  }

  _fire(rule, title, text, { speak = false } = {}) {
    if (!RULES.includes(rule) || !this._ruleOn(rule)) return false;
    const now = this._clock();
    const coolMs = Number(this.config?.get?.('proactiveCooldownSec') ?? 300) * 1000;
    if (now - (this._lastFired.get(rule) || 0) < coolMs) return false;
    this._lastFired.set(rule, now);
    this.bus?.emit?.(this.EV.PROACTIVE_NOTIFY, { rule, title, text, speak });
    return true;
  }
}

export function fmtDur(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

export function truncate(s, n) {
  const t = String(s || '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

async function defaultBatteryProbe() {
  try {
    const nav = globalThis.navigator;
    const b = await nav?.getBattery?.();
    if (!b) return null;
    return { level: Number(b.level), charging: b.charging === true };
  } catch {
    return null;
  }
}

export default ProactiveEngine;

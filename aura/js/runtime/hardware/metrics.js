/**
 * AURA :: System Metrics Providers
 * --------------------------------
 * Honest system telemetry.
 *
 * THE CONSTRAINT: browsers cannot read system CPU load or real RAM usage.
 * `performance.memory` is the JS heap, not the machine. Anything claiming
 * otherwise in a web app is invented. So this module has two tiers:
 *
 *   HostMetricsProvider     — real CPU/RAM/GPU/disk via serve.py + psutil
 *   BrowserMetricsProvider  — only what the browser genuinely exposes
 *                             (cores, device memory bucket, JS heap,
 *                              battery, network, render FPS)
 *
 * Every metric carries `available` and, when false, a `reason`. The UI renders
 * "Unavailable — awaiting local runtime provider" instead of a fake number.
 *
 * @module runtime/hardware/metrics
 */

/**
 * @typedef {Object} Metric
 * @property {boolean}  available
 * @property {?number}  value      0-100 for percentages
 * @property {?string}  display    pre-formatted label
 * @property {?string}  detail     secondary line
 * @property {?string}  reason     why unavailable
 * @property {string}   source     'host' | 'browser' | 'none'
 */

const UNAVAILABLE = (reason) => ({
  available: false, value: null, display: null, detail: null,
  reason: reason || 'Unavailable — awaiting local runtime provider', source: 'none',
});

export class MetricsProvider {
  constructor({ id = 'metrics', source = 'none' } = {}) {
    this.id = id;
    this.source = source;
    this.available = false;
    this.lastSample = null;
    this.lastError = null;
  }
  async probe() { return false; }
  /** @returns {Promise<Record<string, Metric>>} */
  async sample() { return {}; }
}

/* ══════════════════════════════════════════════════════════════════════
   HOST PROVIDER — real numbers via serve.py
   ══════════════════════════════════════════════════════════════════════ */

export class HostMetricsProvider extends MetricsProvider {
  constructor({ endpoint = '/api/metrics' } = {}) {
    super({ id: 'metrics.host', source: 'host' });
    this.endpoint = endpoint;
    this.psutil = false;
  }

  async probe() {
    try {
      const r = await fetch(this.endpoint, { cache: 'no-store' });
      if (!r.ok) { this.available = false; return false; }
      const j = await r.json();
      this.available = !!j.ok;
      this.psutil = !!j.psutil;
      this.lastError = j.reason || null;
      return this.available;
    } catch (e) {
      this.available = false;
      this.lastError = 'AURA local server not running';
      return false;
    }
  }

  async sample() {
    try {
      const r = await fetch(this.endpoint, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (!j.ok) return this._degraded(j.reason);

      /** @type {Record<string, Metric>} */
      const out = {};
      const m = (v, display, detail) => ({
        available: v !== null && v !== undefined,
        value: v ?? null, display: display ?? null, detail: detail ?? null,
        reason: null, source: 'host',
      });

      out.cpu = j.cpu?.percent != null
        ? m(j.cpu.percent, `${j.cpu.percent.toFixed(0)}%`,
            `${j.cpu.cores} cores${j.cpu.freq ? ` · ${(j.cpu.freq / 1000).toFixed(1)} GHz` : ''}`)
        : UNAVAILABLE('CPU sampling unavailable on this host');

      out.ram = j.memory?.percent != null
        ? m(j.memory.percent, `${j.memory.percent.toFixed(0)}%`,
            `${fmtGB(j.memory.used)} / ${fmtGB(j.memory.total)}`)
        : UNAVAILABLE('Memory sampling unavailable');

      out.disk = j.disk?.percent != null
        ? m(j.disk.percent, `${j.disk.percent.toFixed(0)}%`,
            `${fmtGB(j.disk.free)} free of ${fmtGB(j.disk.total)}`)
        : UNAVAILABLE('Disk sampling unavailable');

      out.gpu = j.gpu?.available
        ? m(j.gpu.percent ?? null,
            j.gpu.percent != null ? `${j.gpu.percent.toFixed(0)}%` : j.gpu.name || 'present',
            j.gpu.name || null)
        : UNAVAILABLE(j.gpu?.reason || 'No GPU telemetry — needs vendor tooling (nvidia-smi)');

      out.processes = j.processes != null ? m(null, String(j.processes), 'running') : UNAVAILABLE();
      out.uptime = j.uptime != null ? m(null, fmtDuration(j.uptime), 'host uptime') : UNAVAILABLE();
      out.platform = m(null, j.platform || 'unknown', j.release || null);

      this.lastSample = out;
      return out;
    } catch (e) {
      return this._degraded(e.message);
    }
  }

  _degraded(reason) {
    const r = reason || 'Host metrics unavailable';
    return { cpu: UNAVAILABLE(r), ram: UNAVAILABLE(r), disk: UNAVAILABLE(r), gpu: UNAVAILABLE(r) };
  }
}

/* ══════════════════════════════════════════════════════════════════════
   BROWSER PROVIDER — only what is genuinely exposed
   ══════════════════════════════════════════════════════════════════════ */

export class BrowserMetricsProvider extends MetricsProvider {
  constructor() { super({ id: 'metrics.browser', source: 'browser' }); }

  async probe() { this.available = typeof navigator !== 'undefined'; return this.available; }

  async sample() {
    /** @type {Record<string, Metric>} */
    const out = {};
    const m = (v, display, detail) => ({
      available: true, value: v ?? null, display, detail: detail ?? null,
      reason: null, source: 'browser',
    });

    // Real system CPU load is not exposed to any browser. Say so plainly.
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : null;
    out.cpu = UNAVAILABLE(
      cores ? `Browsers cannot read CPU load (${cores} cores detected) — awaiting local runtime provider`
            : 'Browsers cannot read CPU load — awaiting local runtime provider');

    // JS heap is Chrome-only and is NOT system RAM — labelled accordingly.
    const pm = typeof performance !== 'undefined' && performance.memory;
    if (pm && pm.jsHeapSizeLimit) {
      const pct = (pm.usedJSHeapSize / pm.jsHeapSizeLimit) * 100;
      out.ram = m(pct, `${pct.toFixed(0)}%`,
        `JS heap ${fmtMB(pm.usedJSHeapSize)} / ${fmtMB(pm.jsHeapSizeLimit)} (not system RAM)`);
    } else {
      const dm = typeof navigator !== 'undefined' ? navigator.deviceMemory : null;
      out.ram = UNAVAILABLE(
        dm ? `System RAM not exposed (device reports ~${dm} GB) — awaiting local runtime provider`
           : 'System RAM not exposed to browsers — awaiting local runtime provider');
    }

    out.disk = UNAVAILABLE('Disk usage not exposed to browsers — awaiting local runtime provider');
    out.gpu = UNAVAILABLE('GPU load not exposed to browsers — awaiting local runtime provider');
    out.platform = m(null, detectPlatform(), cores ? `${cores} logical cores` : null);

    // Genuinely available browser telemetry:
    try {
      if (typeof navigator !== 'undefined' && navigator.getBattery) {
        const b = await navigator.getBattery();
        out.battery = m(b.level * 100, `${Math.round(b.level * 100)}%`, b.charging ? 'charging' : 'on battery');
      }
    } catch { /* not fatal */ }

    try {
      const c = typeof navigator !== 'undefined' && navigator.connection;
      if (c) out.network = m(null, c.effectiveType || 'online', c.downlink ? `${c.downlink} Mbps · ${c.rtt}ms RTT` : null);
    } catch {}

    this.lastSample = out;
    return out;
  }
}

/* ══════════════════════════════════════════════════════════════════════
   MANAGER
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Chooses the best provider, merges browser-only extras (battery/network)
 * into host samples, and polls on an interval.
 */
export class MetricsManager {
  /** @param {{bus?:object, intervalMs?:number}} opts */
  constructor({ bus = null, intervalMs = 2000 } = {}) {
    this.bus = bus;
    this.intervalMs = intervalMs;
    this.host = new HostMetricsProvider();
    this.browser = new BrowserMetricsProvider();
    this.provider = this.browser;
    this.timer = null;
    /** @type {Record<string, Metric>} */
    this.latest = {};
    /** Rolling history for sparklines — real samples only. */
    this.history = { cpu: [], ram: [], gpu: [] };
    this.historyLimit = 40;
  }

  async initialize() {
    const hostUp = await this.host.probe();
    this.provider = hostUp ? this.host : this.browser;
    await this.browser.probe();
    await this.refresh();
    return { source: this.provider.source, psutil: this.host.psutil };
  }

  async refresh() {
    const base = await this.provider.sample();
    // Battery/network only exist browser-side; merge them in either way.
    if (this.provider === this.host) {
      const b = await this.browser.sample();
      if (b.battery) base.battery = b.battery;
      if (b.network) base.network = b.network;
    }
    this.latest = base;
    for (const k of ['cpu', 'ram', 'gpu']) {
      if (base[k]?.available && typeof base[k].value === 'number') {
        this.history[k].push(base[k].value);
        if (this.history[k].length > this.historyLimit) this.history[k].shift();
      }
    }
    this.bus?.emit('metrics:sample', { metrics: base, source: this.provider.source });
    return base;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.refresh().catch(() => {}), this.intervalMs);
  }

  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  get sourceLabel() {
    if (this.provider === this.host) return this.host.psutil ? 'local runtime (psutil)' : 'local runtime';
    return 'browser (limited)';
  }
}

/* ── helpers ─────────────────────────────────────────────────────────── */

function fmtGB(bytes) {
  if (bytes == null) return '—';
  return `${(bytes / 1e9).toFixed(1)} GB`;
}
function fmtMB(bytes) {
  if (bytes == null) return '—';
  return `${(bytes / 1e6).toFixed(0)} MB`;
}
function fmtDuration(sec) {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
function detectPlatform() {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent || '';
  if (/Windows NT 10/.test(ua)) return 'Windows';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Mac OS X/.test(ua)) return 'macOS';
  if (/Android/.test(ua)) return 'Android';
  if (/iPhone|iPad/.test(ua)) return 'iOS';
  if (/Linux/.test(ua)) return 'Linux';
  return 'unknown';
}

export default MetricsManager;

/**
 * AURA :: Local Runtime Layer
 * ---------------------------
 * The single boundary between AURA and the machine.
 *
 *        ┌─────────────────────────────┐
 *        │  AI LAYER                   │  reasoning, prompts, tool choice
 *        └──────────────┬──────────────┘
 *                       │  tool calls only
 *        ┌──────────────▼──────────────┐
 *        │  ACTION / TOOL LAYER        │  schema + permissions + audit
 *        └──────────────┬──────────────┘
 *                       │  runtime API only
 *        ┌──────────────▼──────────────┐
 *        │  LOCAL RUNTIME LAYER  (this)│  desktop · hardware · services
 *        └──────────────┬──────────────┘
 *                       │
 *        ┌──────────────▼──────────────┐
 *        │  OPERATING SYSTEM           │
 *        └─────────────────────────────┘
 *
 * Rules enforced here:
 *   • The UI and AI never import OS-facing code directly.
 *   • This layer knows nothing about prompts, models or conversation.
 *   • Every capability reports availability honestly; nothing fakes success.
 *
 * Because it has no AI dependency, a future Electron/Tauri/native host can
 * replace the transport underneath without touching anything above.
 *
 * @module runtime/local-runtime
 */

import { DeviceManager, HardwareRegistry } from './hardware/registry.js';
import { DesktopFramework } from '../desktop/index.js';
import { localActions } from '../actions/local-actions.js';

/**
 * @typedef {Object} RuntimeStatus
 * @property {boolean} initialized
 * @property {string}  transport    'native' | 'bridge' | 'browser'
 * @property {?string} platform
 * @property {boolean} simulated
 * @property {object}  capabilities desktop + hardware + services
 * @property {object}  permissions  granted/total summary
 * @property {object[]} plugins     desktop plugin descriptors
 * @property {object}  apps         application database stats
 */

export const TRANSPORT = { NATIVE: 'native', BRIDGE: 'bridge', BROWSER: 'browser' };

export class LocalRuntime {
  /** @param {{bus?:object, logger?:Function, storage?:Storage}} opts */
  constructor({ bus = null, logger = null, storage = null } = {}) {
    this.bus = bus;
    this.log = logger || (() => {});
    this.initialized = false;
    this.transport = TRANSPORT.BROWSER;
    this.platform = null;

    // ── sub-systems
    /** Desktop actions, permissions, app database, plugins. */
    this.desktop = new DesktopFramework({ bus, bridge: localActions, logger: this.log, storage });
    /** Hardware providers (camera, mic, audio, gpu, sensors, xr). */
    this.hardware = new HardwareRegistry({ logger: this.log });
    this.devices = new DeviceManager({
      registry: this.hardware,
      permissions: this.desktop.permissions,
      bus,
    });
    /** Local network services (Ollama proxy, fetch proxy). */
    this.services = new LocalServices({ bus, logger: this.log });

    /** Shared permission manager — one source of truth for the whole layer. */
    this.permissions = this.desktop.permissions;
  }

  async initialize() {
    // Bridge probe first: it determines the transport tier.
    await localActions.init();
    this.transport = localActions.available ? TRANSPORT.BRIDGE : TRANSPORT.BROWSER;
    this.platform = localActions.os || null;

    // TODO(windows): probe the native companion here and set
    //   this.transport = TRANSPORT.NATIVE when present. The native host
    //   supersedes the bridge for close/enumerate/input automation.

    const [desktopStatus] = await Promise.all([
      this.desktop.initialize(),
      this.devices.initialize(),
      this.services.probe(),
    ]);

    if (desktopStatus.platform && desktopStatus.platform !== 'unknown') {
      this.platform = desktopStatus.platform;
    }

    this.initialized = true;
    this.bus?.emit('runtime:ready', this.status());
    this.log(`Local runtime: ${this.transport} transport, platform=${this.platform || 'unknown'}`);
    return this.status();
  }

  /* ── unified capability view ─────────────────────────────────────── */

  /** @returns {RuntimeStatus} */
  status() {
    const d = this.desktop.status();
    return {
      initialized: this.initialized,
      transport: this.transport,
      platform: this.platform,
      simulated: d.simulated,
      capabilities: {
        desktop: d.capabilities,
        hardware: Object.fromEntries(this.hardware.summary().map(h => [h.capability, h.available])),
        services: this.services.summary(),
      },
      permissions: d.permissions,
      plugins: d.plugins,
      apps: d.apps,
    };
  }

  /**
   * The ONLY entry point the action layer uses to reach the OS.
   * Delegates to the desktop framework, which enforces permissions.
   */
  execute(request, meta) {
    if (!this.initialized) {
      return Promise.resolve({ ok: false, code: 'not_ready', message: 'Local runtime is still starting.' });
    }
    return this.desktop.execute(request, meta);
  }

  /** Description for the AI prompt — capability facts only, no prompt text. */
  describeCapabilities() {
    const s = this.status();
    const hw = Object.entries(s.capabilities.hardware)
      .filter(([, v]) => v).map(([k]) => k);
    return {
      transport: s.transport,
      platform: s.platform,
      simulated: s.simulated,
      hardwareAvailable: hw,
      desktopActions: this.desktop.actions.listActions().map(a => a.id),
    };
  }

  async dispose() {
    await this.hardware.disposeAll();
    this.initialized = false;
  }
}

/* ══════════════════════════════════════════════════════════════════════
   LOCAL SERVICES
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Machine-local network services exposed by `serve.py`.
 *
 * Ollama is reached through `/api/ollama/*` rather than `localhost:11434`
 * directly: the page origin (`:8000`) differs from Ollama's port, so a direct
 * browser fetch triggers a CORS preflight that a stock Ollama rejects.
 * Proxying keeps it same-origin and needs zero user configuration.
 */
export class LocalServices {
  constructor({ bus = null, logger = null } = {}) {
    this.bus = bus;
    this.log = logger || (() => {});
    this.services = {
      ollama: { available: false, endpoint: '/api/ollama', models: [], reason: null },
      fetchProxy: { available: false, endpoint: '/api/fetch', reason: null },
      actionBridge: { available: false, endpoint: '/api/action', reason: null },
    };
  }

  async probe() {
    // Host server present at all?
    let hostUp = false;
    try {
      const r = await fetch('/api/status', { cache: 'no-store' });
      hostUp = r.ok;
      if (r.ok) {
        const j = await r.json();
        this.services.actionBridge.available = !!j.actionsEnabled;
        this.services.actionBridge.reason = j.actionsEnabled ? null : 'start serve.py with --allow-actions';
      }
    } catch {
      const why = 'AURA local server not detected (serve.py is not running)';
      for (const k of Object.keys(this.services)) this.services[k].reason = why;
      return this.summary();
    }

    if (hostUp) {
      this.services.fetchProxy.available = true;
      try {
        const r = await fetch('/api/ollama/status', { cache: 'no-store' });
        const j = await r.json();
        this.services.ollama.available = !!j.running;
        this.services.ollama.models = (j.models || []).map(m => m.name);
        this.services.ollama.reason = j.running ? null : (j.reason || 'Ollama is not running');
      } catch (e) {
        this.services.ollama.reason = e.message;
      }
    }
    this.bus?.emit('runtime:services', this.summary());
    return this.summary();
  }

  summary() {
    return Object.fromEntries(Object.entries(this.services).map(([k, v]) => [k, {
      available: v.available, endpoint: v.endpoint, reason: v.reason,
      ...(v.models ? { models: v.models.length } : {}),
    }]));
  }

  isAvailable(name) { return !!this.services[name]?.available; }
}

export default LocalRuntime;

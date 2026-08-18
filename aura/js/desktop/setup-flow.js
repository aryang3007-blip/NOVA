/**
 * AURA :: First-Run Desktop Setup Flow
 * ------------------------------------
 * ARCHITECTURE ONLY — this defines the state machine and contracts for
 * onboarding desktop integration. The Windows scanner it orchestrates is
 * deliberately NOT implemented; step 3 calls
 * `AppLauncher.scanInstalledApps()`, which currently reports "needs the
 * native companion".
 *
 * Flow:
 *   detect_host → choose_permissions → scan_apps → review → complete
 *
 * Each step is pure state + validation, so the UI can render it and tests
 * can drive it without a browser.
 */

import { PermissionManager, PERMISSIONS } from './permissions.js';

export const STEPS = [
  {
    id: 'detect_host',
    title: 'Detect Host Environment',
    description: 'Check whether AURA is running locally with a desktop host process.',
    canSkip: false,
  },
  {
    id: 'choose_permissions',
    title: 'Grant Permissions',
    description: 'Choose what AURA is allowed to do on this machine. Everything is denied by default.',
    canSkip: false,
  },
  {
    id: 'scan_apps',
    title: 'Scan Installed Applications',
    description: 'Discover installed apps so AURA can launch them by name.',
    canSkip: true,
    requiresNative: true,
  },
  {
    id: 'review',
    title: 'Review',
    description: 'Confirm what AURA can and cannot do.',
    canSkip: false,
  },
  {
    id: 'complete',
    title: 'Ready',
    description: 'Desktop integration configured.',
    canSkip: false,
  },
];

const LS_KEY = 'aura.desktop.setup.v1';

export class DesktopSetupFlow {
  /**
   * @param {{permissions:PermissionManager, launcher:object, storage?:Storage, bus?:object}} opts
   */
  constructor({ permissions, launcher, storage = null, bus = null }) {
    this.permissions = permissions;
    this.launcher = launcher;
    this.bus = bus;
    this.storage = storage || (typeof localStorage !== 'undefined' ? localStorage : null);

    this.stepIndex = 0;
    this.state = {
      host: null,            // result of detect_host
      chosenPermissions: [],
      scanResult: null,
      completedAt: null,
      skipped: [],
    };
    this.load();
  }

  get currentStep() { return STEPS[this.stepIndex]; }
  get isComplete() { return !!this.state.completedAt; }
  get progress() { return Math.round((this.stepIndex / (STEPS.length - 1)) * 100); }

  /** Has the user ever finished (or explicitly dismissed) desktop setup? */
  static needed(storage = null) {
    const st = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!st) return true;
    try { return !JSON.parse(st.getItem(LS_KEY) || '{}').completedAt; }
    catch { return true; }
  }

  /* ── step 1: detect the host ──────────────────────────────────────── */

  /**
   * Work out what AURA can actually do in this environment.
   * @returns {Promise<object>}
   */
  async detectHost() {
    const st = this.launcher.status ? this.launcher.status() : {};
    const init = await this.launcher.initialize();

    const host = {
      backend: init.backend,
      platform: init.platform,
      capabilities: this.launcher.capabilities,
      isLocal: init.backend !== 'mock',
      hasNative: init.backend === 'native',
      secureContext: typeof window !== 'undefined' ? !!window.isSecureContext : false,
      message: init.message,
      // Honest verdict shown to the user.
      verdict:
        init.backend === 'native' ? 'full'
        : init.backend === 'bridge' ? 'partial'
        : 'simulated',
    };
    this.state.host = host;
    this.save();
    this.bus?.emit('desktop:setup-step', { step: 'detect_host', host });
    return host;
  }

  /** Human-readable explanation of what the detected host allows. */
  hostSummary() {
    const h = this.state.host;
    if (!h) return 'Host not detected yet.';
    if (h.verdict === 'full') {
      return `Native desktop companion detected on ${h.platform}. All desktop features are available.`;
    }
    if (h.verdict === 'partial') {
      return `Local bridge detected on ${h.platform}. AURA can launch apps, open URLs, control media and take screenshots. ` +
             `Closing apps, file system, terminal and input automation need the native companion.`;
    }
    return 'No desktop host process detected — AURA is running in the browser only. ' +
           'Desktop actions will be simulated. Run AURA locally with `python3 serve.py --allow-actions` to enable real control.';
  }

  /* ── step 2: permissions ──────────────────────────────────────────── */

  /**
   * Permissions worth offering, annotated with whether this host can honour them.
   */
  permissionOptions() {
    const caps = this.state.host?.capabilities || {};
    const isLocal = !!this.state.host?.isLocal;
    return Object.values(PERMISSIONS).map(p => ({
      ...p,
      granted: this.permissions.isGranted(p.id),
      usableNow: !p.requiresNative || isLocal,
      note: p.requiresNative && !isLocal
        ? 'Needs a local host process — you can grant it now and it will activate later.'
        : null,
    }));
  }

  applyPermissions(ids) {
    this.permissions.revokeAll('setup');
    this.permissions.grantMany(ids || [], 'setup');
    this.state.chosenPermissions = [...(ids || [])];
    this.save();
    this.bus?.emit('desktop:setup-step', { step: 'choose_permissions', granted: ids });
    return this.permissions.summary();
  }

  applyRecommended() { return this.applyPermissions(PermissionManager.recommended()); }

  /* ── step 3: scan (architecture only) ─────────────────────────────── */

  /**
   * Trigger the application scan.
   * The scanner itself is NOT implemented — this wires up the contract,
   * progress plumbing and result handling so only the native side is missing.
   *
   * @param {(p:{phase:string,label:string,percent:number,found:number})=>void} [onProgress]
   */
  async runScan(onProgress) {
    const phases = this.launcher.constructor.SCAN_PHASES || [];
    const result = await this.launcher.scanInstalledApps((ev) => {
      const idx = phases.findIndex(p => p.id === ev.phase);
      onProgress?.({
        phase: ev.phase,
        label: phases[idx]?.label || ev.phase,
        percent: ev.percent ?? (idx >= 0 ? Math.round((idx / phases.length) * 100) : 0),
        found: ev.found || 0,
      });
    });

    this.state.scanResult = result;
    this.save();
    this.bus?.emit('desktop:setup-step', { step: 'scan_apps', result });
    return result;
  }

  /** What a real scan will do, for display before it exists. */
  scanPlan() {
    return {
      available: !!this.state.host?.hasNative,
      phases: this.launcher.constructor.SCAN_PHASES || [],
      reason: this.state.host?.hasNative ? null
        : 'The scanner runs inside the native desktop companion, which is not installed yet. ' +
          'AURA will use its built-in application catalogue until then.',
    };
  }

  /* ── navigation ───────────────────────────────────────────────────── */

  next() {
    if (this.stepIndex < STEPS.length - 1) this.stepIndex++;
    this.save();
    return this.currentStep;
  }

  back() {
    if (this.stepIndex > 0) this.stepIndex--;
    this.save();
    return this.currentStep;
  }

  skip() {
    const s = this.currentStep;
    if (!s.canSkip) return { ok: false, message: `"${s.title}" cannot be skipped.` };
    this.state.skipped.push(s.id);
    return { ok: true, step: this.next() };
  }

  goTo(stepId) {
    const i = STEPS.findIndex(s => s.id === stepId);
    if (i >= 0) { this.stepIndex = i; this.save(); }
    return this.currentStep;
  }

  complete() {
    this.state.completedAt = Date.now();
    this.stepIndex = STEPS.length - 1;
    this.save();
    this.bus?.emit('desktop:setup-complete', { state: this.state });
    return this.summary();
  }

  reset() {
    this.stepIndex = 0;
    this.state = { host: null, chosenPermissions: [], scanResult: null, completedAt: null, skipped: [] };
    try { this.storage?.removeItem(LS_KEY); } catch {}
    return this.currentStep;
  }

  summary() {
    return {
      complete: this.isComplete,
      completedAt: this.state.completedAt,
      host: this.state.host,
      hostSummary: this.hostSummary(),
      permissions: this.permissions.summary(),
      granted: this.permissions.list().filter(p => p.granted).map(p => p.label),
      scan: this.state.scanResult,
      skipped: this.state.skipped,
    };
  }

  /* ── persistence ──────────────────────────────────────────────────── */

  save() {
    if (!this.storage) return false;
    try {
      this.storage.setItem(LS_KEY, JSON.stringify({ stepIndex: this.stepIndex, ...this.state }));
      return true;
    } catch { return false; }
  }

  load() {
    if (!this.storage) return false;
    try {
      const d = JSON.parse(this.storage.getItem(LS_KEY) || '{}');
      if (!d || typeof d !== 'object') return false;
      this.stepIndex = Number.isInteger(d.stepIndex) ? d.stepIndex : 0;
      this.state = {
        host: d.host || null,
        chosenPermissions: d.chosenPermissions || [],
        scanResult: d.scanResult || null,
        completedAt: d.completedAt || null,
        skipped: d.skipped || [],
      };
      return true;
    } catch { return false; }
  }
}

export default DesktopSetupFlow;

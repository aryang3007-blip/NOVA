/**
 * AURA :: Runtime Core
 * --------------------
 * The single place where a command becomes an effect on the machine.
 *
 * THE RULE THIS FILE ENFORCES
 * ---------------------------
 * The AI proposes. The Runtime disposes. A model can emit any text it likes;
 * nothing reaches the operating system unless it passes, in order:
 *
 *   1. REGISTRY  — is this a real command with valid parameters?
 *   2. PERMISSION— has the user granted this capability?
 *   3. PRECONDITION — is a screen actually shared, if the command needs one?
 *   4. CONFIRMATION — has the user approved this specific action?
 *   5. EXECUTOR  — the subsystem that owns this domain performs it.
 *
 * Skipping a stage is not possible from outside: `execute()` is the only
 * entry point, and each stage is a hard return, not a warning.
 *
 * This does NOT replace the existing safety layers in `automation.py` and the
 * Action Manager — those still run server-side, where the browser cannot
 * influence them. This is a client-side gate in front of them, so a bad model
 * proposal is rejected before it ever becomes a request.
 *
 * @module runtime/runtime-core
 */

import { bus } from '../core/bus.js';
import { validate, RISK, COMMANDS } from './command-registry.js';
import { worldModel } from './world-model.js';

/** Stages, in order. Emitted on the bus so the dev console can show them. */
export const STAGE = ['registry', 'permission', 'precondition', 'confirm', 'execute'];

export class RuntimeCore {
  /**
   * @param {object} [o]
   * @param {any} [o.permissions]  PermissionRegistry
   * @param {any} [o.actions]    localActions bridge
   * @param {any} [o.screen]     ScreenShare
   * @param {any} [o.agent]      ScreenAgent (for cell→point)
   * @param {any} [o.cursor]     ScreenCursor
   * @param {any} [o.memory]     memory manager
   * @param {any} [o.ai]         AIEngine
   */
  constructor({ permissions = null, actions = null, screen = null, agent = null,
                cursor = null, memory = null, ai = null } = {}) {
    this.permissions = permissions;
    this.actions = actions;
    this.screen = screen;
    this.agent = agent;
    this.cursor = cursor;
    this.memory = memory;
    this.ai = ai;
    this.world = worldModel;

    /** Every dispatch, for the Developer Console. */
    this.journal = [];
    this.maxJournal = 200;
    /** Commands currently in flight. */
    this.inFlight = new Set();
    this.stats = { proposed: 0, rejected: 0, executed: 0, failed: 0 };

    /** @type {Record<string, (params:object, ctx:object)=>Promise<any>>} */
    this.executors = {};
    this._registerExecutors();
  }

  /* ── the one entry point ──────────────────────────────────────────── */

  /**
   * @param {object} proposal   whatever the AI produced
   * @param {object} [opts]
   * @param {(spec:object, params:object)=>Promise<boolean>} [opts.confirm]
   * @param {any}  [opts.trace]
   * @param {boolean} [opts.dryRun]  validate + check gates, execute nothing
   * @returns {Promise<{ok:boolean, command?:string, stage:string, result?:any,
   *                    error?:string, dryRun?:boolean}>}
   */
  async execute(proposal, { confirm = null, trace = null, dryRun = false } = {}) {
    this.stats.proposed++;
    const started = Date.now();

    // ── 1. REGISTRY
    const v = validate(proposal);
    if (!v.ok) return this._reject('registry', v.error, { proposal, started, trace });
    const { command, spec, params, why } = v;
    bus.emit('runtime:proposed', { command, params, why });

    // ── 2. PERMISSION
    if (spec.permission && this.permissions) {
      const granted = this.permissions.isGranted?.(spec.permission)
                   ?? this.permissions.granted?.(spec.permission);
      if (!granted) {
        return this._reject('permission',
          `"${command}" needs the "${spec.permission}" permission. `
          + 'Grant it in Settings → Desktop → Permissions.',
          { command, params, started, trace });
      }
    }

    // ── 3. PRECONDITION
    if (spec.needsScreen && !this.screen?.active) {
      return this._reject('precondition',
        `"${command}" needs a shared screen. Run /watch first.`,
        { command, params, started, trace });
    }

    // ── 4. CONFIRMATION — anything that changes the machine.
    const needsConfirm = !spec.readOnly && spec.risk !== RISK.SAFE;
    if (needsConfirm && confirm && !dryRun) {
      const approved = await confirm(spec, params);
      if (!approved) {
        return this._reject('confirm', 'You declined this action.',
          { command, params, started, trace });
      }
    }

    if (dryRun) {
      return { ok: true, command, stage: 'confirm', dryRun: true,
               result: { summary: `would run ${command}` } };
    }

    // ── 5. EXECUTE
    const exec = this.executors[command];
    if (!exec) {
      return this._reject('execute', `No executor registered for "${command}".`,
        { command, params, started, trace });
    }
    this.inFlight.add(command);
    try {
      const result = await exec(params, { spec, why });
      const ok = result?.ok !== false;
      ok ? this.stats.executed++ : this.stats.failed++;
      this.world.recordAction(command, params, result);
      this._journal({ command, params, why, stage: 'execute', ok,
                      summary: result?.summary || result?.message || '',
                      ms: Date.now() - started });
      trace?.[ok ? 'ok' : 'warn'](command, result?.summary || result?.message || '');
      bus.emit('runtime:executed', { command, params, ok, result });
      return { ok, command, stage: 'execute', result };
    } catch (err) {
      this.stats.failed++;
      const msg = err?.message || String(err);
      this._journal({ command, params, stage: 'execute', ok: false, summary: msg,
                      ms: Date.now() - started });
      trace?.fail(command, msg);
      return { ok: false, command, stage: 'execute', error: msg };
    } finally {
      this.inFlight.delete(command);
    }
  }

  /**
   * @param {string} stage
   * @param {string} error
   * @param {{command?:string, params?:object, proposal?:any, started?:number, trace?:any}} [ctx]
   */
  _reject(stage, error, { command, params, proposal, started, trace } = {}) {
    this.stats.rejected++;
    this._journal({ command: command || String(proposal?.command || proposal?.action || '?'),
                    params, stage, ok: false, summary: error,
                    ms: started ? Date.now() - started : 0 });
    trace?.warn(`Rejected at ${stage}`, error);
    bus.emit('runtime:rejected', { stage, command, error });
    return { ok: false, stage, error, command };
  }

  /** @param {object} entry */
  _journal(entry) {
    this.journal.push({ ...entry, at: Date.now() });
    if (this.journal.length > this.maxJournal) this.journal.shift();
    bus.emit('runtime:journal', entry);
  }

  /* ── executors: one per domain, thin wrappers over existing subsystems ── */

  _registerExecutors() {
    const A = () => this.actions;

    /* desktop */
    this.executors['desktop.launch_app'] = async (p) => {
      const r = await A().openApp(p.app, p.arg);
      return { ok: !!r.ok, summary: r.message || `opened ${p.app}` };
    };
    this.executors['desktop.list_apps'] = async () => {
      const apps = A()?.installedApps?.() || [];
      this.world.setApps(apps);
      return { ok: true, summary: `${apps.length} apps`, apps };
    };
    this.executors['desktop.running_apps'] = async () => {
      const r = await A().run('running_apps', {});
      this.world.setRunning(r.running || [], !!r.available);
      return { ok: !!r.ok, summary: (r.running || []).join(', ') || 'none detected', ...r };
    };
    this.executors['desktop.screenshot'] = async () => {
      const r = await A().screenshot();
      return { ok: !!r.ok, summary: r.message || '' };
    };

    /* input — all go through the automation pipeline, which re-validates */
    const auto = async (steps, summary) => {
      const r = await A().automationRun(steps, true);
      return { ok: !!r.ok, summary: r.ok ? summary : (r.message || 'failed') };
    };
    this.executors['input.click'] = async (p) => {
      const pt = this.agent?.cellToPoint(p.cell);
      if (!pt?.ok) return { ok: false, summary: pt?.message || 'bad cell' };
      if (pt.clickable === false) return { ok: false, summary: pt.reason || 'not clickable' };
      this.cursor?.moveTo(pt.frameX, pt.frameY, { label: p.target || p.cell, mode: 'acting' });
      const op = p.button === 'right' ? 'right_click'
               : p.button === 'double' ? 'double_click' : 'click';
      return auto([{ op, x: pt.x, y: pt.y }],
                  `clicked ${p.target || p.cell} at (${pt.x}, ${pt.y})`);
    };
    this.executors['input.move'] = async (p) => {
      const pt = this.agent?.cellToPoint(p.cell);
      if (!pt?.ok) return { ok: false, summary: pt?.message || 'bad cell' };
      this.cursor?.moveTo(pt.frameX, pt.frameY, { label: p.cell, mode: 'found' });
      if (pt.clickable === false) return { ok: true, summary: `reticle on ${p.cell}` };
      return auto([{ op: 'move', x: pt.x, y: pt.y }], `moved to ${p.cell}`);
    };
    this.executors['input.type'] = (p) =>
      auto([{ op: 'type', text: p.text }], `typed "${String(p.text).slice(0, 40)}"`);
    this.executors['input.hotkey'] = (p) =>
      auto([{ op: 'hotkey', keys: p.keys }], `pressed ${p.keys}`);
    this.executors['input.press'] = (p) =>
      auto([{ op: 'press', key: p.key }], `pressed ${p.key}`);
    this.executors['input.scroll'] = (p) =>
      auto([{ op: 'scroll', amount: p.amount ?? 3 }], 'scrolled');

    /* paired devices — routed through the gateway, never executed here */
    const toDevice = async (action, params, device) => {
      const r = await A().run('device_send', { device: device || 'phone', action, params });
      return { ok: !!r.ok, summary: r.message || '' };
    };
    this.executors['device.open_url'] = async (p) => {
      /*
       * "Open YouTube on my laptop" must NOT go to the gateway — it is this
       * machine. Resolve that here so the user can say either and get the
       * right thing.
       */
      const d = String(p.device || 'phone').toLowerCase();
      if (/laptop|windows|host|desktop|pc|computer|here/.test(d)) {
        const r = await A().run('open_url', { url: p.url });
        return { ok: !!r.ok, summary: r.message || `opened ${p.url} here` };
      }
      return toDevice('open_url', { url: p.url }, p.device);
    };
    this.executors['device.notify'] = (p) =>
      toDevice('show_notification', { title: p.title, body: p.body }, p.device);
    this.executors['device.vibrate'] = (p) => toDevice('vibrate', {}, p.device);
    this.executors['device.list'] = async () => {
      const r = await A().run('device_list', {});
      const n = (r.devices || []).length;
      return { ok: true, summary: n ? `${r.connected}/${n} connected` : 'no devices paired',
               ...r };
    };

    /* window management — the OS API, never synthetic clicks */
    this.executors['desktop.minimize_active_window'] = async () => {
      const r = await A().run('window_minimize_active', {});
      return { ok: !!r.ok, summary: r.message || 'minimised', title: r.title };
    };
    this.executors['desktop.active_window'] = async () => {
      const r = await A().run('window_active', {});
      return { ok: !!r.ok, summary: r.ok ? (r.title || String(r.windowId)) : r.message, ...r };
    };

    /* overlay — the REAL reticle, drawn on the desktop by a native process */
    this.executors['overlay.show'] = async (p) => {
      const r = await A().overlayShow(p.x, p.y, { label: p.label });
      return { ok: !!r.ok, summary: r.message || `reticle at (${p.x}, ${p.y})` };
    };
    this.executors['overlay.hide'] = async () => {
      const r = await A().overlayHide();
      return { ok: !!r.ok, summary: r.message || 'hidden' };
    };

    /* virtual desktops */
    this.executors['vdesk.setup'] = async () => {
      const r = await A().vdeskSetup();
      return { ok: !!r.ok, summary: r.message || '' };
    };
    this.executors['vdesk.go_aura'] = async () => {
      const r = await A().vdeskGoAura();
      return { ok: !!r.ok, summary: r.message || '' };
    };
    this.executors['vdesk.go_home'] = async () => {
      const r = await A().vdeskGoHome();
      return { ok: !!r.ok, summary: r.message || '' };
    };

    /* vision */
    this.executors['vision.describe'] = async () => {
      const r = await this.agent?.transcribe(this.screen?.grab());
      if (r?.ok) this.world.setScreen({ text: r.text, description: r.text });
      return { ok: !!r?.ok, summary: r?.ok ? `${r.text.length} chars` : (r?.message || 'failed'),
               text: r?.text };
    };
    this.executors['vision.read_text'] = this.executors['vision.describe'];
    this.executors['vision.locate'] = async (p) => {
      const r = await this.agent?.locate(p.target);
      return { ok: !!r?.ok, summary: r?.message || '', ...r };
    };

    /* browser */
    this.executors['browser.open_url'] = async (p) => {
      const r = await A().run('open_url', { url: p.url });
      return { ok: !!r.ok, summary: r.message || `opened ${p.url}` };
    };
    this.executors['browser.search'] = async (p) => {
      const r = await A().run('web_search', { query: p.query });
      return { ok: !!r.ok, summary: r.message || `searched "${p.query}"`, ...r };
    };

    /* filesystem */
    this.executors['filesystem.read'] = async (p) => {
      const r = await A().run('read_file', { path: p.path });
      return { ok: !!r.ok, summary: r.message || 'read', ...r };
    };
    this.executors['filesystem.write'] = async (p) => {
      const r = await A().run('write_file', { path: p.path, content: p.content });
      return { ok: !!r.ok, summary: r.message || 'written' };
    };
    this.executors['filesystem.search'] = async (p) => {
      const r = await A().run('search_files', { query: p.query });
      return { ok: !!r.ok, summary: r.message || '', ...r };
    };

    /* memory */
    this.executors['memory.store'] = async (p) => {
      await this.memory?.remember?.(p.text);
      return { ok: true, summary: `remembered "${String(p.text).slice(0, 40)}"` };
    };
    this.executors['memory.search'] = async (p) => {
      const hits = await this.memory?.search?.(p.query);
      return { ok: true, summary: `${hits?.length || 0} matches`, hits };
    };

    /* media */
    this.executors['media.play'] = async () => {
      const r = await A().run('media', { key: 'playpause' });
      return { ok: !!r.ok, summary: r.message || 'play/pause' };
    };
    this.executors['media.pause'] = this.executors['media.play'];
    this.executors['media.volume'] = async (p) => {
      const r = await A().run('volume', { level: p.level });
      return { ok: !!r.ok, summary: r.message || `volume ${p.level}` };
    };

    /* clipboard */
    this.executors['clipboard.read'] = async () => {
      const r = await A().clipboardRead();
      return { ok: !!r.ok, summary: r.text ? `${r.text.length} chars` : (r.message || ''), ...r };
    };
    this.executors['clipboard.write'] = async (p) => {
      const r = await A().clipboardWrite(p.text);
      return { ok: !!r.ok, summary: r.message || 'copied' };
    };

    /* terminal + power */
    this.executors['terminal.run'] = async (p) => {
      const r = await A().run('terminal', { command: p.command });
      return { ok: !!r.ok, summary: r.message || r.output || '', ...r };
    };
    this.executors['power.shutdown'] = async () => {
      const r = await A().run('power', { mode: 'shutdown' });
      return { ok: !!r.ok, summary: r.message || '' };
    };
    this.executors['power.restart'] = async () => {
      const r = await A().run('power', { mode: 'restart' });
      return { ok: !!r.ok, summary: r.message || '' };
    };

    /* flow — handled by the Runtime itself, never touches the OS */
    this.executors['flow.wait'] = async (p) => {
      const s = Math.max(0.1, Math.min(5, Number(p.seconds) || 1));
      await new Promise(r => setTimeout(r, s * 1000));
      return { ok: true, summary: `waited ${s}s` };
    };
    this.executors['flow.observe'] = async () => {
      this.world.screen.at = 0;             // force a re-read next time
      return { ok: true, summary: 'will look again' };
    };
    this.executors['flow.done'] = async (p) => ({ ok: true, done: true,
      summary: p.reason || 'task complete' });
    this.executors['flow.fail'] = async (p) => ({ ok: false, fail: true,
      summary: p.reason || 'cannot continue' });
  }

  /** Which commands can actually run right now, and why not. */
  availability() {
    return Object.values(COMMANDS).map(spec => {
      const reasons = [];
      if (spec.permission && this.permissions
          && !(this.permissions.isGranted?.(spec.permission))) {
        reasons.push(`needs "${spec.permission}"`);
      }
      if (spec.needsScreen && !this.screen?.active) reasons.push('needs a shared screen');
      if (!this.executors[spec.name]) reasons.push('no executor');
      return { name: spec.name, risk: spec.risk, ready: reasons.length === 0, reasons };
    });
  }

  status() {
    return {
      stats: { ...this.stats },
      inFlight: Array.from(this.inFlight),
      journal: this.journal.slice(-30).reverse(),
      world: this.world.snapshot(),
      commands: this.availability(),
    };
  }
}

export default RuntimeCore;

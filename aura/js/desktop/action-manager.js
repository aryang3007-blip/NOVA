/**
 * AURA :: Action Manager
 * ----------------------
 * The ONLY path between the AI and the operating system.
 *
 *      AI  ──emits──▶  { action:"launch_app", target:"WhatsApp" }
 *                            │
 *                     ActionManager
 *                            │  1. schema validation
 *                            │  2. permission check
 *                            │  3. rate limit
 *                            │  4. confirmation gate (high-risk)
 *                            │  5. dispatch to a registered plugin
 *                            ▼
 *                      Desktop Plugin ──▶ OS
 *
 * The AI never touches the OS. It cannot invent an action type that isn't
 * registered, cannot bypass a permission, and cannot pass a payload that
 * fails schema validation. Every attempt — allowed or denied — is audited.
 */

import { PERMISSIONS } from './permissions.js';

/**
 * @typedef {Object} ActionRequest
 * @property {string} action    registered action id, e.g. 'launch_app'
 * @property {string} [target]  primary operand
 * @property {Object} [params]  extra parameters
 */

/**
 * @typedef {Object} ActionResult
 * @property {boolean} ok
 * @property {string}  message      human-readable, safe to speak aloud
 * @property {string}  [code]       machine-readable failure code
 * @property {boolean} [simulated]
 * @property {boolean} [needsConfirmation]
 * @property {string}  [confirmToken]     token echoed back to confirm()
 * @property {string}  [permission]       permission id that blocked it
 * @property {string}  [permissionLabel]  human-readable permission name
 * @property {string}  [fixHint]          where the user can grant it
 */

export const DENY = {
  UNKNOWN_ACTION: 'unknown_action',
  BAD_PAYLOAD: 'bad_payload',
  NO_PERMISSION: 'no_permission',
  NO_HANDLER: 'no_handler',
  RATE_LIMITED: 'rate_limited',
  NEEDS_CONFIRMATION: 'needs_confirmation',
  DISABLED: 'disabled',
  HANDLER_ERROR: 'handler_error',
};

export class ActionManager {
  /**
   * @param {{permissions:import('./permissions.js').PermissionManager, bus?:object, logger?:Function}} opts
   */
  constructor({ permissions, bus = null, logger = null } = /** @type {any} */ ({})) {
    if (!permissions) throw new Error('ActionManager requires a PermissionManager');
    this.permissions = permissions;
    this.bus = bus;
    this.log = logger || (() => {});
    this.enabled = true;

    /** @type {Map<string, object>} action id → descriptor */
    this.actions = new Map();
    /** @type {Map<string, object>} plugin id → plugin */
    this.plugins = new Map();

    /** Audit trail. Bounded so it can't grow unbounded in a long session. */
    this.audit = [];
    this.auditLimit = 300;

    /** Simple token bucket per action id. */
    this._calls = new Map();
    this.rateLimit = { windowMs: 10_000, max: 12 };

    /** Pending high-risk confirmations, keyed by token. */
    this.pending = new Map();
  }

  /* ══════════════════════════════════════════════════════════════════
     REGISTRATION
     ══════════════════════════════════════════════════════════════════ */

  /**
   * Register a desktop plugin. Its `actions` become dispatchable.
   *
   * Plugin shape:
   *   {
   *     id, name, description, icon,
   *     permissions: ['launch_apps'],        // everything it may need
   *     available: () => boolean,            // is the backend present?
   *     setup: async (ctx) => {},
   *     actions: {
   *       launch_app: {
   *         permission: 'launch_apps',
   *         description: 'Open an application',
   *         schema: { target: { type:'string', required:true, maxLength:80 } },
   *         confirm: false,
   *         run: async (payload, ctx) => ActionResult,
   *       },
   *     },
   *   }
   */
  registerPlugin(plugin) {
    if (!plugin?.id) throw new Error('Desktop plugin requires an id');
    this.plugins.set(plugin.id, plugin);

    for (const [actionId, def] of Object.entries(plugin.actions || {})) {
      if (this.actions.has(actionId)) {
        this.log(`[action-manager] "${actionId}" re-registered by ${plugin.id}`);
      }
      if (def.permission && !PERMISSIONS[def.permission]) {
        throw new Error(`Action "${actionId}" references unknown permission "${def.permission}"`);
      }
      this.actions.set(actionId, { ...def, id: actionId, pluginId: plugin.id });
    }

    try { plugin.setup?.(this.ctx); } catch (e) { this.log(`[action-manager] setup failed for ${plugin.id}: ${e.message}`); }
    this.bus?.emit('desktop:plugin-registered', { id: plugin.id, name: plugin.name });
    return this;
  }

  setContext(ctx) { this.ctx = { ...(this.ctx || {}), ...ctx }; }

  unregisterPlugin(id) {
    const p = this.plugins.get(id);
    if (!p) return false;
    for (const actionId of Object.keys(p.actions || {})) {
      if (this.actions.get(actionId)?.pluginId === id) this.actions.delete(actionId);
    }
    this.plugins.delete(id);
    return true;
  }

  listActions() {
    return Array.from(this.actions.values()).map(a => ({
      id: a.id, plugin: a.pluginId, permission: a.permission,
      description: a.description, confirm: !!a.confirm,
      schema: a.schema || {},
    }));
  }

  listPlugins() {
    return Array.from(this.plugins.values()).map(p => {
      let available = false;
      try { available = p.available ? !!p.available(this.ctx) : true; } catch {}
      return {
        id: p.id, name: p.name, description: p.description, icon: p.icon || '🔌',
        permissions: p.permissions || [],
        actions: Object.keys(p.actions || {}),
        available,
        status: available ? 'ready' : (p.plannedStatus || 'unavailable'),
      };
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     VALIDATION
     ══════════════════════════════════════════════════════════════════ */

  /**
   * Validate a payload against a tiny declarative schema.
   * Deliberately strict: unknown keys are dropped, not passed through.
   * @returns {{ok:boolean, value?:object, error?:string}}
   */
  static validate(schema, payload) {
    const out = {};
    const src = payload || {};
    for (const [key, rule] of Object.entries(schema || {})) {
      const v = src[key];
      if (v === undefined || v === null || v === '') {
        if (rule.required) return { ok: false, error: `Missing required field "${key}".` };
        if (rule.default !== undefined) out[key] = rule.default;
        continue;
      }
      const type = rule.type || 'string';
      if (type === 'string') {
        if (typeof v !== 'string') return { ok: false, error: `"${key}" must be a string.` };
        if (rule.maxLength && v.length > rule.maxLength) return { ok: false, error: `"${key}" is too long (max ${rule.maxLength}).` };
        if (rule.pattern && !new RegExp(rule.pattern).test(v)) return { ok: false, error: `"${key}" has an invalid format.` };
        if (rule.enum && !rule.enum.includes(v)) return { ok: false, error: `"${key}" must be one of: ${rule.enum.join(', ')}.` };
        out[key] = v.trim();
      } else if (type === 'number') {
        const n = Number(v);
        if (!Number.isFinite(n)) return { ok: false, error: `"${key}" must be a number.` };
        if (rule.min !== undefined && n < rule.min) return { ok: false, error: `"${key}" must be ≥ ${rule.min}.` };
        if (rule.max !== undefined && n > rule.max) return { ok: false, error: `"${key}" must be ≤ ${rule.max}.` };
        out[key] = n;
      } else if (type === 'boolean') {
        out[key] = Boolean(v);
      } else if (type === 'array') {
        if (!Array.isArray(v)) return { ok: false, error: `"${key}" must be an array.` };
        if (rule.maxItems && v.length > rule.maxItems) return { ok: false, error: `"${key}" has too many items.` };
        out[key] = v;
      } else {
        out[key] = v;
      }
    }
    return { ok: true, value: out };
  }

  /* ══════════════════════════════════════════════════════════════════
     DISPATCH
     ══════════════════════════════════════════════════════════════════ */

  /**
   * Execute a structured action from the AI.
   * @param {ActionRequest} request
   * @param {{source?:string, confirmToken?:string}} [meta]
   * @returns {Promise<ActionResult>}
   */
  async execute(request, meta = {}) {
    const started = Date.now();
    const source = meta.source || 'ai';
    const actionId = String(request?.action || '').trim();

    const deny = (code, message, extra = {}) => {
      const r = { ok: false, code, message, ...extra };
      this._audit({ actionId, source, allowed: false, code, message, ms: Date.now() - started });
      this.bus?.emit('desktop:action-denied', { action: actionId, code, message });
      return r;
    };

    if (!this.enabled) {
      return deny(DENY.DISABLED, 'Desktop integration is turned off. Enable it in Settings → Desktop.');
    }
    if (!actionId) {
      return deny(DENY.BAD_PAYLOAD, 'No action specified.');
    }

    // ── 1. known action?
    const def = this.actions.get(actionId);
    if (!def) {
      const known = Array.from(this.actions.keys()).slice(0, 8).join(', ');
      return deny(DENY.UNKNOWN_ACTION,
        `"${actionId}" is not a registered action. Known actions: ${known}.`);
    }

    // ── 2. schema
    const payload = { target: request.target, ...(request.params || {}) };
    const v = ActionManager.validate(def.schema, payload);
    if (!v.ok) return deny(DENY.BAD_PAYLOAD, v.error);

    // ── 3. permission
    if (def.permission) {
      const check = this.permissions.check(def.permission, { actionName: actionId });
      if (!check.allowed) {
        return deny(DENY.NO_PERMISSION, check.reason, {
          permission: def.permission,
          permissionLabel: PERMISSIONS[def.permission]?.label,
          fixHint: 'Settings → Desktop → Permissions',
        });
      }
    }

    // ── 4. rate limit
    if (!this._rateOk(actionId)) {
      return deny(DENY.RATE_LIMITED,
        `Too many "${actionId}" requests in a short window. Slow down.`);
    }

    // ── 5. confirmation for destructive actions
    //
    // SECURITY: compare tokens explicitly. An earlier version tested
    //   meta.confirmToken !== this.pending.get(actionId)?.token
    // which is `undefined !== undefined` → false when nothing is pending, so
    // destructive actions ran WITHOUT confirmation. Caught by test.
    // A confirmation is satisfied only when a non-empty token matches a
    // currently-pending token for this exact action.
    const pendingToken = this.pending.get(actionId)?.token;
    const confirmSatisfied =
      typeof meta.confirmToken === 'string' && meta.confirmToken.length > 0 &&
      typeof pendingToken === 'string' && meta.confirmToken === pendingToken;

    if (def.confirm && !confirmSatisfied) {
      const token = Math.random().toString(36).slice(2, 10);
      this.pending.set(actionId, { token, request, at: Date.now() });
      setTimeout(() => {
        if (this.pending.get(actionId)?.token === token) this.pending.delete(actionId);
      }, 30_000);
      this._audit({ actionId, source, allowed: false, code: DENY.NEEDS_CONFIRMATION, ms: Date.now() - started });
      this.bus?.emit('desktop:confirm-required', { action: actionId, token, request });
      return {
        ok: false, code: DENY.NEEDS_CONFIRMATION, needsConfirmation: true, confirmToken: token,
        message: def.confirmMessage || `This will ${def.description || actionId}. Confirm to proceed.`,
      };
    }
    this.pending.delete(actionId);

    // ── 6. run
    try {
      const result = await def.run(v.value, this.ctx || {});
      const out = {
        ok: !!result?.ok,
        message: result?.message || (result?.ok ? 'Done.' : 'Action failed.'),
        ...result,
      };
      this._audit({
        actionId, source, allowed: true, ok: out.ok,
        simulated: !!out.simulated, message: out.message, ms: Date.now() - started,
      });
      this.bus?.emit('desktop:action-executed', { action: actionId, request: v.value, result: out });
      return out;
    } catch (e) {
      this.log(`[action-manager] "${actionId}" threw: ${e.message}`);
      return deny(DENY.HANDLER_ERROR, `Action failed: ${e.message}`);
    }
  }

  /** Approve a pending confirmation and run it. */
  async confirm(actionId, token) {
    const p = this.pending.get(actionId);
    if (!p || p.token !== token) {
      return { ok: false, code: DENY.BAD_PAYLOAD, message: 'That confirmation has expired.' };
    }
    return this.execute(p.request, { source: 'user-confirm', confirmToken: token });
  }

  cancelConfirm(actionId) { return this.pending.delete(actionId); }

  /**
   * Run several actions in order, stopping at the first failure.
   * Useful for AI-generated multi-step plans.
   */
  async executeBatch(requests, meta = {}) {
    const results = [];
    for (const r of requests || []) {
      const res = await this.execute(r, meta);
      results.push({ request: r, result: res });
      if (!res.ok) break;
    }
    return { ok: results.every(x => x.result.ok), results };
  }

  _rateOk(actionId) {
    const now = Date.now();
    const arr = (this._calls.get(actionId) || []).filter(t => now - t < this.rateLimit.windowMs);
    if (arr.length >= this.rateLimit.max) { this._calls.set(actionId, arr); return false; }
    arr.push(now);
    this._calls.set(actionId, arr);
    return true;
  }

  _audit(entry) {
    this.audit.push({ t: Date.now(), ...entry });
    if (this.audit.length > this.auditLimit) this.audit.shift();
  }

  recentAudit(n = 25) { return this.audit.slice(-n).reverse(); }

  /**
   * Compact capability description for the AI's system prompt, so the model
   * knows exactly which actions exist and which are currently permitted.
   */
  describeForAI() {
    const rows = this.listActions().map(a => {
      const granted = !a.permission || this.permissions.isGranted(a.permission);
      const fields = Object.entries(a.schema || {})
        .map(([k, r]) => `${k}${r.required ? '' : '?'}`).join(', ');
      return `- ${a.id}(${fields}) — ${a.description}${granted ? '' : ' [PERMISSION NOT GRANTED]'}`;
    });
    if (!rows.length) return 'No desktop actions are registered.';
    return `Desktop actions you may request (emit JSON, never shell commands):\n${rows.join('\n')}`;
  }

  status() {
    return {
      enabled: this.enabled,
      actions: this.actions.size,
      plugins: this.plugins.size,
      pluginsAvailable: this.listPlugins().filter(p => p.available).length,
      permissions: this.permissions.summary(),
      auditEntries: this.audit.length,
    };
  }
}

export default ActionManager;

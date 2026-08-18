/**
 * AURA :: App Launcher Service
 * ----------------------------
 * The abstraction the Action Manager calls to start/stop applications.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │ STATUS: INTERFACE + MOCK ONLY.                                   │
 * │ No Windows-specific code lives here yet — see the TODO blocks.   │
 * │ Every method already returns the FINAL response shape, so the    │
 * │ rest of AURA is written against the real contract today.         │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * Three backends are planned; the service picks the best available:
 *   1. 'native'  — a future local companion (full control: launch + close + enumerate)
 *   2. 'bridge'  — the existing serve.py bridge (launch + URI open; no enumeration)
 *   3. 'mock'    — no host process; simulates and clearly says so
 */

import { AppDatabase } from './app-database.js';

/**
 * @typedef {Object} LaunchResult
 * @property {boolean}  ok
 * @property {string}   message
 * @property {boolean} [simulated]      true when no host process is present
 * @property {object}  [app]            the resolved AppRecord
 * @property {string}  [method]         'binary' | 'uri' | 'web' | 'mock'
 * @property {string[]} [suggestions]   near-miss names when lookup failed
 * @property {boolean} [needsNative]    requires the native companion
 * @property {boolean} [notImplemented] stub awaiting platform work
 * @property {boolean} [fallback]       a web equivalent was opened instead
 * @property {string}  [reasonedBy]     'system core' | 'ollama:<model>'
 * @property {string}  [url]            the web equivalent that was opened
 * @property {?string} [suggestedUrl]   proposed but not opened
 */

export const BACKEND = { NATIVE: 'native', BRIDGE: 'bridge', MOCK: 'mock' };

/**
 * OFFLINE REASONING TABLE — the System Core's knowledge of web equivalents.
 *
 * Consulted before Ollama so the common case is instant and works with no
 * model installed. Ollama is only asked about things that aren't here, which
 * keeps a slow local model off the critical path.
 *
 * Keep this current: it is the difference between "can't do that" and
 * actually completing the user's intent.
 */
export const WEB_EQUIVALENTS = {
  whatsapp:   { url: 'https://web.whatsapp.com',        label: 'WhatsApp Web' },
  spotify:    { url: 'https://open.spotify.com',        label: 'Spotify Web Player' },
  discord:    { url: 'https://discord.com/app',         label: 'Discord Web' },
  telegram:   { url: 'https://web.telegram.org',        label: 'Telegram Web' },
  slack:      { url: 'https://app.slack.com/client',    label: 'Slack Web' },
  teams:      { url: 'https://teams.microsoft.com',     label: 'Microsoft Teams' },
  zoom:       { url: 'https://app.zoom.us/wc',          label: 'Zoom Web' },
  skype:      { url: 'https://web.skype.com',           label: 'Skype Web' },
  outlook:    { url: 'https://outlook.live.com',        label: 'Outlook Web' },
  gmail:      { url: 'https://mail.google.com',         label: 'Gmail' },
  notion:     { url: 'https://www.notion.so',           label: 'Notion' },
  figma:      { url: 'https://www.figma.com/files',     label: 'Figma' },
  trello:     { url: 'https://trello.com',              label: 'Trello' },
  github:     { url: 'https://github.com',              label: 'GitHub' },
  gitlab:     { url: 'https://gitlab.com',              label: 'GitLab' },
  youtube:    { url: 'https://www.youtube.com',         label: 'YouTube' },
  netflix:    { url: 'https://www.netflix.com',         label: 'Netflix' },
  twitch:     { url: 'https://www.twitch.tv',           label: 'Twitch' },
  instagram:  { url: 'https://www.instagram.com',       label: 'Instagram' },
  twitter:    { url: 'https://twitter.com',             label: 'X / Twitter' },
  x:          { url: 'https://x.com',                   label: 'X' },
  reddit:     { url: 'https://www.reddit.com',          label: 'Reddit' },
  linkedin:   { url: 'https://www.linkedin.com',        label: 'LinkedIn' },
  messenger:  { url: 'https://www.messenger.com',       label: 'Messenger' },
  drive:      { url: 'https://drive.google.com',        label: 'Google Drive' },
  docs:       { url: 'https://docs.google.com',         label: 'Google Docs' },
  sheets:     { url: 'https://sheets.google.com',       label: 'Google Sheets' },
  maps:       { url: 'https://maps.google.com',         label: 'Google Maps' },
  photoshop:  { url: 'https://www.adobe.com/products/photoshop.html', label: 'Photoshop (info)' },
  canva:      { url: 'https://www.canva.com',           label: 'Canva' },
  chatgpt:    { url: 'https://chat.openai.com',         label: 'ChatGPT' },
  claude:     { url: 'https://claude.ai',               label: 'Claude' },
  vscode:     { url: 'https://vscode.dev',              label: 'VS Code for the Web' },
  'vs code':  { url: 'https://vscode.dev',              label: 'VS Code for the Web' },
  excel:      { url: 'https://www.office.com/launch/excel', label: 'Excel Online' },
  word:       { url: 'https://www.office.com/launch/word',  label: 'Word Online' },
  powerpoint: { url: 'https://www.office.com/launch/powerpoint', label: 'PowerPoint Online' },
  onedrive:   { url: 'https://onedrive.live.com',       label: 'OneDrive' },
  dropbox:    { url: 'https://www.dropbox.com/home',    label: 'Dropbox' },
};

export class AppLauncher {
  /**
   * @param {{db?:AppDatabase, bridge?:object, logger?:Function}} opts
   */
  constructor({ db = null, bridge = null, logger = null } = {}) {
    this.db = db || new AppDatabase();
    this.bridge = bridge;            // LocalActions instance, if present
    this.log = logger || (() => {});
    this.backend = BACKEND.MOCK;
    this.platform = 'unknown';
    this.ready = false;
    /** @type {Map<string, {pid:?number, startedAt:number}>} */
    this.running = new Map();        // tracked launches (best-effort)
  }

  /* ══════════════════════════════════════════════════════════════════
     LIFECYCLE
     ══════════════════════════════════════════════════════════════════ */

  /**
   * Detect the best available backend and prepare the service.
   * Safe to call repeatedly.
   * @returns {Promise<{ok:boolean, backend:string, platform:string, message:string}>}
   */
  async initialize() {
    // ── 1. Native companion (not built yet)
    // TODO(local): probe a local companion process, e.g.
    //   GET http://127.0.0.1:<port>/native/status  →  { platform, version }
    //   If reachable, set this.backend = BACKEND.NATIVE and use it for
    //   launchApp/closeApp/getInstalledApps.
    const native = await this._probeNative();
    if (native.ok) {
      this.backend = BACKEND.NATIVE;
      this.platform = native.platform;
      this.ready = true;
      this.log(`AppLauncher: native backend (${native.platform})`);
      return { ok: true, backend: this.backend, platform: this.platform,
               message: `Native desktop backend online (${native.platform}).` };
    }

    // ── 2. serve.py bridge — real today, but limited
    if (this.bridge?.available) {
      this.backend = BACKEND.BRIDGE;
      this.platform = this.bridge.os || 'unknown';
      this.ready = true;
      this.log(`AppLauncher: bridge backend (${this.platform})`);
      return { ok: true, backend: this.backend, platform: this.platform,
               message: `Local bridge online (${this.platform}). Launch supported; close and enumeration need the native companion.` };
    }

    // ── 3. Mock
    this.backend = BACKEND.MOCK;
    this.platform = this._guessPlatform();
    this.ready = true;
    this.log('AppLauncher: mock backend (no host process)');
    return { ok: true, backend: this.backend, platform: this.platform,
             message: 'Running in simulation mode — no host process is available, so launches are mocked.' };
  }

  /** @private Probe for a future native companion. Always false for now. */
  async _probeNative() {
    // TODO(local): implement when the native companion exists.
    //   try {
    //     const r = await fetch('http://127.0.0.1:8777/native/status', {signal: timeout(1000)});
    //     if (r.ok) return { ok:true, ...(await r.json()) };
    //   } catch {}
    return { ok: false, platform: null };
  }

  /** @private Best-effort platform guess from the user agent. */
  _guessPlatform() {
    if (typeof navigator === 'undefined') return 'unknown';
    const ua = navigator.userAgent || '';
    if (/Windows/i.test(ua)) return 'win32';
    if (/Mac OS X|Macintosh/i.test(ua)) return 'darwin';
    if (/Linux|X11/i.test(ua)) return 'linux';
    return 'unknown';
  }

  get capabilities() {
    return {
      launch:    this.backend !== BACKEND.MOCK,
      close:     this.backend === BACKEND.NATIVE,
      enumerate: this.backend === BACKEND.NATIVE,
      icons:     this.backend === BACKEND.NATIVE,
      scan:      this.backend === BACKEND.NATIVE,
      simulated: this.backend === BACKEND.MOCK,
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     LAUNCH
     ══════════════════════════════════════════════════════════════════ */

  /**
   * Launch an application by name, alias or id.
   * @param {string} target
   * @param {{args?:string[], allowWebFallback?:boolean}} [opts]
   * @returns {Promise<LaunchResult>}
   */
  async launchApp(target, opts = {}) {
    if (!this.ready) await this.initialize();

    const app = this.db.resolve(target);
    if (!app) {
      // Unknown app: don't dead-end. Reason about the best alternative.
      const near = this.db.search(target, { limit: 3 }).map(a => a.name);
      const plan = await this.reasonFallback(target, { near });
      if (plan.action === 'open_web' && plan.url && this.bridge?.available) {
        const res = await this.bridge.openUrl(plan.url);
        if (res.ok) {
          return { ...res, fallback: true, reasonedBy: plan.by, url: plan.url,
                   message: `${target} isn't installed — opened ${plan.label || plan.url} instead. (${plan.by})` };
        }
      }
      return {
        ok: false,
        message: plan.message ||
          (`I don't have "${target}" in the application database.` +
           (near.length ? ` Did you mean: ${near.join(', ')}?` : '')),
        suggestions: near,
        reasonedBy: plan.by,
        suggestedUrl: plan.url || null,
      };
    }

    switch (this.backend) {
      case BACKEND.NATIVE:
        // TODO(local): POST to the native companion:
        //   { action:'launch', id: app.id, path: app.executablePath, args: opts.args }
        //   Capture the returned pid into this.running for closeApp().
        return this._notImplemented('launchApp/native', app);

      case BACKEND.BRIDGE: {
        // Real path available today via serve.py.
        const res = await this.bridge.openApp(app.id);
        if (res.ok) {
          this.db.recordLaunch(app.id);
          this.running.set(app.id, { pid: null, startedAt: Date.now() });
        }
        return { ...res, app, method: res.method || 'bridge' };
      }

      default: {
        // Mock: succeed *visibly as a simulation* so flows can be exercised.
        this.db.recordLaunch(app.id);
        this.running.set(app.id, { pid: null, startedAt: Date.now() });
        return {
          ok: true, simulated: true, app, method: 'mock',
          message: `[SIMULATED] Would launch ${app.name}. ` +
                   `Run AURA locally with the desktop host to make this real.`,
        };
      }
    }
  }

  /**
   * Close a running application.
   * @param {string} target
   * @param {{force?:boolean}} [opts]
   * @returns {Promise<LaunchResult>}
   */
  async closeApp(target, opts = {}) {
    if (!this.ready) await this.initialize();

    const app = this.db.resolve(target);
    if (!app) return { ok: false, message: `Unknown application "${target}".` };

    switch (this.backend) {
      case BACKEND.NATIVE:
        // TODO(local): graceful close first (WM_CLOSE / SIGTERM), then force
        //   if opts.force. On Windows this is taskkill /IM <exe> [/F];
        //   prefer the tracked pid over the image name when available.
        return this._notImplemented('closeApp/native', app);

      case BACKEND.BRIDGE:
        // The current bridge can launch but not terminate — say so honestly
        // rather than pretending.
        return {
          ok: false, app,
          message: `Closing apps needs the native desktop companion. The current bridge can launch ${app.name} but not close it.`,
          needsNative: true,
        };

      default:
        this.running.delete(app.id);
        return {
          ok: true, simulated: true, app, method: 'mock',
          message: `[SIMULATED] Would close ${app.name}.`,
        };
    }
  }

  /* ══════════════════════════════════════════════════════════════════
     DISCOVERY
     ══════════════════════════════════════════════════════════════════ */

  /**
   * Decide what to do when an app isn't installed.
   *
   * Two reasoning sources, cheapest first:
   *   1. SYSTEM CORE (offline, always available) — a curated map of well
   *      known apps to their web equivalents, plus a generic guess for
   *      anything that looks like a product name.
   *   2. OLLAMA (preferred when reachable) — asked for a strict JSON verdict.
   *      Only used when the offline core has no confident answer, so a slow
   *      model never delays the common case.
   *
   * The model is never allowed to invent a launch: it can only choose a URL,
   * and that URL is validated before use.
   *
   * @param {string} target
   * @param {{near?:string[]}} [ctx]
   * @returns {Promise<{action:string, url?:string, label?:string, by:string, message?:string}>}
   */
  async reasonFallback(target, { near = [] } = {}) {
    const name = String(target || '').trim();
    if (!name) return { action: 'none', by: 'none' };

    // ── 1. offline system core ────────────────────────────────────────
    const known = WEB_EQUIVALENTS[name.toLowerCase()];
    if (known) {
      return { action: 'open_web', url: known.url, label: known.label, by: 'system core' };
    }

    // ── 2. Ollama, only if the offline core had nothing ───────────────
    try {
      const viaOllama = await this._askOllamaForFallback(name);
      if (viaOllama) return viaOllama;
    } catch { /* offline or no model — fall through */ }

    // ── 3. honest generic guess ───────────────────────────────────────
    if (/^[a-z0-9][a-z0-9 .-]{1,28}$/i.test(name)) {
      const guess = `https://www.google.com/search?q=${encodeURIComponent(name + ' app')}`;
      return {
        action: 'suggest', url: guess, by: 'system core',
        message: `"${name}" isn't installed and I don't know a web version.` +
                 (near.length ? ` Closest matches: ${near.join(', ')}.` : '') +
                 ` You can add it under Settings → Desktop → Applications, or search the web for it.`,
      };
    }
    return { action: 'none', by: 'system core' };
  }

  /**
   * Ask the local model for a fallback. Returns null unless the reply is a
   * valid, safe http(s) URL — a hallucinated answer cannot cause an action.
   */
  async _askOllamaForFallback(name) {
    if (typeof fetch !== 'function') return null;
    let running = false;
    let model = null;
    try {
      const st = await (await fetch('/api/ollama/status', { cache: 'no-store' })).json();
      running = !!st.running;
      model = (st.names || [])[0] || null;
    } catch { return null; }
    if (!running || !model) return null;

    const prompt =
      `The desktop application "${name}" is not installed on this computer.\n` +
      `If it has an official web version, reply with ONLY this JSON:\n` +
      `{"action":"open_web","url":"https://...","label":"Name"}\n` +
      `If it does not, reply with ONLY: {"action":"none"}\n` +
      `No prose, no markdown, JSON only.`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    let text = '';
    try {
      const res = await fetch('/api/ollama/chat', {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
          options: { temperature: 0 },
        }),
      });
      const raw = await res.text();
      // /api/chat with stream:false still arrives as one NDJSON line.
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try { text += JSON.parse(line)?.message?.content || ''; } catch {}
      }
    } catch { return null; } finally { clearTimeout(timer); }

    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) return null;
    let plan;
    try { plan = JSON.parse(m[0]); } catch { return null; }
    if (plan?.action !== 'open_web') return null;

    // Validate: only http(s), no javascript:/data:, no credentials.
    let url;
    try { url = new URL(String(plan.url)); } catch { return null; }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;

    return {
      action: 'open_web', url: url.href,
      label: String(plan.label || url.hostname).slice(0, 40),
      by: `ollama:${model}`,
    };
  }

  /**
   * Search the known application database.
   * @param {string} query
   * @returns {Promise<{ok:boolean, results:object[], source:string, note?:string}>}
   */
  async searchInstalledApps(query, { limit = 8 } = {}) {
    if (!this.ready) await this.initialize();
    const results = this.db.search(query, { limit });
    return {
      ok: true,
      results: results.map(a => this._publicShape(a)),
      source: this.db.scanSource || 'mock',
      note: this.capabilities.enumerate ? undefined
        : 'Results come from the built-in catalogue. A local scan will replace it with your real applications.',
    };
  }

  /**
   * List everything AURA knows about.
   * @returns {Promise<{ok:boolean, apps:object[], stats:object, capabilities?:object}>}
   */
  async getInstalledApps({ category = null, verifiedOnly = false } = {}) {
    if (!this.ready) await this.initialize();

    if (this.backend === BACKEND.NATIVE) {
      // TODO(local): ask the companion for the live list and merge it in:
      //   const live = await native('enumerate');
      //   this.db.mergeScanResults(live.apps, { platform: this.platform });
    }

    let apps = this.db.all();
    if (category) apps = apps.filter(a => a.category === category);
    if (verifiedOnly) apps = apps.filter(a => a.verified);

    return {
      ok: true,
      apps: apps.map(a => this._publicShape(a)).sort((x, y) => x.name.localeCompare(y.name)),
      stats: this.db.stats(),
      capabilities: this.capabilities,
    };
  }

  /**
   * Kick off a full system scan.
   * ARCHITECTURE ONLY — the scanner itself is intentionally not implemented.
   * @param {(p:{phase:string, percent:number, found:number})=>void} [onProgress]
   */
  async scanInstalledApps(onProgress) {
    if (!this.ready) await this.initialize();

    if (this.backend !== BACKEND.NATIVE) {
      return {
        ok: false,
        available: false,
        message: 'Application scanning requires the native desktop companion, which is not installed yet. ' +
                 'AURA is using its built-in catalogue in the meantime.',
        plannedPhases: AppLauncher.SCAN_PHASES,
      };
    }

    // TODO(local): drive the native scanner and stream progress.
    //   for await (const ev of native.scanStream()) onProgress?.(ev);
    //   const merged = this.db.mergeScanResults(ev.apps, { platform: this.platform });
    return this._notImplemented('scanInstalledApps/native');
  }

  /**
   * The phases a real Windows scan will run through. Documented now so the
   * UI can render the plan before the scanner exists.
   */
  static get SCAN_PHASES() {
    return [
      { id: 'start_menu', label: 'Start Menu shortcuts',
        detail: 'Enumerate .lnk files under the user and machine Start Menu folders and resolve their targets.' },
      { id: 'registry', label: 'Registry uninstall keys',
        detail: 'Read HKLM/HKCU Uninstall keys for DisplayName, DisplayIcon and InstallLocation.' },
      { id: 'appx', label: 'Microsoft Store apps',
        detail: 'Query AppX packages for PackageFamilyName and their app user-model IDs.' },
      { id: 'paths', label: 'Common install directories',
        detail: 'Sweep Program Files, Program Files (x86) and LocalAppData for known executables.' },
      { id: 'uri', label: 'Protocol handlers',
        detail: 'Collect registered URI schemes (whatsapp://, spotify://) as launch fallbacks.' },
      { id: 'icons', label: 'Icon extraction',
        detail: 'Extract icons from executables and cache them as data URLs.' },
      { id: 'merge', label: 'Merge into database',
        detail: 'Match discoveries against the catalogue, fill executable paths, mark verified.' },
    ];
  }

  /* ══════════════════════════════════════════════════════════════════
     HELPERS
     ══════════════════════════════════════════════════════════════════ */

  /** Strip internals; never leak raw paths into UI/AI payloads by accident. */
  _publicShape(a) {
    return {
      id: a.id, name: a.name, category: a.category, icon: a.icon,
      aliases: a.aliases, verified: a.verified, source: a.source,
      installed: a.installed, hasPath: !!a.executablePath,
      hasWebFallback: !!a.webFallback, launchCount: a.launchCount || 0,
    };
  }

  _notImplemented(what, app) {
    return {
      ok: false, notImplemented: true, app,
      message: `${what} is not implemented yet — the native desktop companion is required.`,
    };
  }

  status() {
    return {
      ready: this.ready,
      backend: this.backend,
      platform: this.platform,
      capabilities: this.capabilities,
      knownApps: this.db.size,
      running: Array.from(this.running.keys()),
      dbStats: this.db.stats(),
    };
  }
}

export default AppLauncher;

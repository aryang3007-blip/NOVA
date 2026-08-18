/**
 * AURA :: Application Database
 * ----------------------------
 * Stores what AURA knows about installed applications: names, aliases,
 * launcher identifiers, icons, categories, and (later) real executable paths.
 *
 * IMPORTANT — no real paths are hardcoded anywhere. Entries ship with
 * `executablePath: null`. A future local scanner fills that in. Until then
 * every record is clearly flagged `source: 'mock'` and `verified: false`,
 * so the UI never implies an app is actually present.
 *
 * The schema is deliberately cross-platform: `launchers` is keyed by platform
 * so the same record works on Windows, macOS and Linux.
 */

/**
 * @typedef {Object} AppRecord
 * @property {string}   id            stable slug, e.g. 'whatsapp'
 * @property {string}   name          display name
 * @property {string[]} aliases       spoken/typed variants the matcher accepts
 * @property {string}   category      communication | media | dev | ...
 * @property {string}   icon          emoji placeholder until real icons exist
 * @property {Object}   launchers     per-platform launch identifiers
 * @property {?string}  executablePath resolved by the local scanner; null now
 * @property {?string}  webFallback   URL used when no desktop app is found
 * @property {boolean}  verified      true only after a real scan confirms it
 * @property {string}   source        'mock' | 'scan' | 'user'
 * @property {?boolean} installed     null = unknown (never assume absent)
 * @property {?number}  lastLaunched  epoch ms of the last launch
 * @property {number}   launchCount   how many times AURA launched it
 * @property {?string}  iconData      data-URL icon, filled by a future scanner
 */

export const CATEGORIES = {
  communication: { label: 'Communication', icon: '💬' },
  media:         { label: 'Media',         icon: '🎵' },
  dev:           { label: 'Development',   icon: '⌨' },
  productivity:  { label: 'Productivity',  icon: '📄' },
  browser:       { label: 'Browsers',      icon: '🌐' },
  system:        { label: 'System',        icon: '⚙' },
  gaming:        { label: 'Gaming',        icon: '🎮' },
  creative:      { label: 'Creative',      icon: '🎨' },
};

/**
 * Seed catalogue. These are WELL-KNOWN identifiers (URI schemes, store IDs,
 * package names) — not machine-specific paths, so they are safe to ship.
 */
const SEED = [
  {
    id: 'whatsapp', name: 'WhatsApp', category: 'communication', icon: '💬',
    aliases: ['whatsapp', 'whats app', 'wa', 'whatsapp desktop'],
    launchers: {
      win32:  { uri: 'whatsapp://', store: '5319275A.WhatsAppDesktop', exeHint: 'WhatsApp.exe' },
      darwin: { uri: 'whatsapp://', bundleId: 'desktop.WhatsApp', appName: 'WhatsApp' },
      linux:  { uri: 'whatsapp://', binaries: ['whatsapp-for-linux', 'whatsdesk'] },
    },
    webFallback: 'https://web.whatsapp.com',
  },
  {
    id: 'telegram', name: 'Telegram', category: 'communication', icon: '✈',
    aliases: ['telegram', 'tg', 'telegram desktop'],
    launchers: {
      win32:  { uri: 'tg://', store: 'TelegramMessengerLLP.TelegramDesktop', exeHint: 'Telegram.exe' },
      darwin: { uri: 'tg://', bundleId: 'ru.keepcoder.Telegram', appName: 'Telegram' },
      linux:  { uri: 'tg://', binaries: ['telegram-desktop', 'telegram'] },
    },
    webFallback: 'https://web.telegram.org',
  },
  {
    id: 'discord', name: 'Discord', category: 'communication', icon: '🎧',
    aliases: ['discord'],
    launchers: {
      win32:  { uri: 'discord://', exeHint: 'Discord.exe' },
      darwin: { uri: 'discord://', bundleId: 'com.hnc.Discord', appName: 'Discord' },
      linux:  { uri: 'discord://', binaries: ['discord'] },
    },
    webFallback: 'https://discord.com/app',
  },
  {
    id: 'slack', name: 'Slack', category: 'communication', icon: '💼',
    aliases: ['slack'],
    launchers: {
      win32:  { uri: 'slack://', exeHint: 'slack.exe' },
      darwin: { uri: 'slack://', bundleId: 'com.tinyspeck.slackmacgap', appName: 'Slack' },
      linux:  { uri: 'slack://', binaries: ['slack'] },
    },
    webFallback: 'https://app.slack.com',
  },
  {
    id: 'spotify', name: 'Spotify', category: 'media', icon: '🎵',
    aliases: ['spotify', 'music app'],
    launchers: {
      win32:  { uri: 'spotify://', store: 'SpotifyAB.SpotifyMusic', exeHint: 'Spotify.exe' },
      darwin: { uri: 'spotify://', bundleId: 'com.spotify.client', appName: 'Spotify' },
      linux:  { uri: 'spotify://', binaries: ['spotify'] },
    },
    webFallback: 'https://open.spotify.com',
  },
  {
    id: 'vlc', name: 'VLC Media Player', category: 'media', icon: '🎬',
    aliases: ['vlc', 'media player', 'video player'],
    launchers: {
      win32:  { uri: 'vlc://', exeHint: 'vlc.exe' },
      darwin: { bundleId: 'org.videolan.vlc', appName: 'VLC' },
      linux:  { binaries: ['vlc'] },
    },
    webFallback: null,
  },
  {
    id: 'vscode', name: 'Visual Studio Code', category: 'dev', icon: '⌨',
    aliases: ['vscode', 'vs code', 'code', 'visual studio code', 'my editor', 'code editor'],
    launchers: {
      win32:  { uri: 'vscode://', exeHint: 'Code.exe', cli: 'code' },
      darwin: { uri: 'vscode://', bundleId: 'com.microsoft.VSCode', appName: 'Visual Studio Code', cli: 'code' },
      linux:  { uri: 'vscode://', binaries: ['code', 'codium'] },
    },
    webFallback: 'https://vscode.dev',
  },
  {
    id: 'terminal', name: 'Terminal', category: 'dev', icon: '▶',
    aliases: ['terminal', 'console', 'command prompt', 'cmd', 'powershell', 'shell'],
    launchers: {
      win32:  { exeHint: 'wt.exe', fallbackExes: ['powershell.exe', 'cmd.exe'] },
      darwin: { bundleId: 'com.apple.Terminal', appName: 'Terminal' },
      linux:  { binaries: ['gnome-terminal', 'konsole', 'xfce4-terminal', 'x-terminal-emulator', 'xterm'] },
    },
    webFallback: null,
  },
  {
    id: 'chrome', name: 'Google Chrome', category: 'browser', icon: '🌐',
    aliases: ['chrome', 'google chrome', 'browser'],
    launchers: {
      win32:  { exeHint: 'chrome.exe' },
      darwin: { bundleId: 'com.google.Chrome', appName: 'Google Chrome' },
      linux:  { binaries: ['google-chrome', 'chromium', 'chromium-browser'] },
    },
    webFallback: null,
  },
  {
    id: 'firefox', name: 'Mozilla Firefox', category: 'browser', icon: '🦊',
    aliases: ['firefox', 'mozilla'],
    launchers: {
      win32:  { exeHint: 'firefox.exe' },
      darwin: { bundleId: 'org.mozilla.firefox', appName: 'Firefox' },
      linux:  { binaries: ['firefox'] },
    },
    webFallback: null,
  },
  {
    id: 'explorer', name: 'File Manager', category: 'system', icon: '📁',
    aliases: ['files', 'file manager', 'explorer', 'file explorer', 'finder'],
    launchers: {
      win32:  { exeHint: 'explorer.exe' },
      darwin: { bundleId: 'com.apple.finder', appName: 'Finder' },
      linux:  { binaries: ['nautilus', 'dolphin', 'thunar', 'nemo'] },
    },
    webFallback: null,
  },
  {
    id: 'settings', name: 'System Settings', category: 'system', icon: '⚙',
    aliases: ['settings', 'system settings', 'preferences', 'control panel'],
    launchers: {
      win32:  { uri: 'ms-settings:' },
      darwin: { bundleId: 'com.apple.systempreferences', appName: 'System Settings' },
      linux:  { binaries: ['gnome-control-center', 'systemsettings5'] },
    },
    webFallback: null,
  },
  {
    id: 'calculator', name: 'Calculator', category: 'system', icon: '🔢',
    aliases: ['calculator', 'calc app'],
    launchers: {
      win32:  { uri: 'calculator:', exeHint: 'calc.exe' },
      darwin: { bundleId: 'com.apple.calculator', appName: 'Calculator' },
      linux:  { binaries: ['gnome-calculator', 'kcalc', 'galculator'] },
    },
    webFallback: null,
  },
  {
    id: 'notepad', name: 'Notes / Editor', category: 'productivity', icon: '📝',
    aliases: ['notepad', 'notes', 'text editor'],
    launchers: {
      win32:  { exeHint: 'notepad.exe' },
      darwin: { bundleId: 'com.apple.Notes', appName: 'Notes' },
      linux:  { binaries: ['gedit', 'kate', 'mousepad'] },
    },
    webFallback: null,
  },
  {
    id: 'steam', name: 'Steam', category: 'gaming', icon: '🎮',
    aliases: ['steam', 'games'],
    launchers: {
      win32:  { uri: 'steam://', exeHint: 'steam.exe' },
      darwin: { uri: 'steam://', bundleId: 'com.valvesoftware.steam', appName: 'Steam' },
      linux:  { uri: 'steam://', binaries: ['steam'] },
    },
    webFallback: 'https://store.steampowered.com',
  },
  {
    id: 'obs', name: 'OBS Studio', category: 'creative', icon: '🎥',
    aliases: ['obs', 'obs studio', 'streaming'],
    launchers: {
      win32:  { exeHint: 'obs64.exe' },
      darwin: { bundleId: 'com.obsproject.obs-studio', appName: 'OBS' },
      linux:  { binaries: ['obs'] },
    },
    webFallback: null,
  },
  {
    id: 'figma', name: 'Figma', category: 'creative', icon: '🎨',
    aliases: ['figma', 'design'],
    launchers: {
      win32:  { uri: 'figma://', exeHint: 'Figma.exe' },
      darwin: { uri: 'figma://', bundleId: 'com.figma.Desktop', appName: 'Figma' },
      linux:  { uri: 'figma://', binaries: ['figma-linux'] },
    },
    webFallback: 'https://figma.com',
  },
];

const LS_KEY = 'aura.appdb.v1';

/** Turn a free-text name into a stable id: "My Editor!" -> "my-editor". */
export function slugifyId(v) {
  return String(v || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';
}

/** Clean a user-supplied alias list: lowercase, de-duped, always includes the name. */
export function normaliseAliases(list, name) {
  const out = new Set();
  const add = (v) => {
    const t = String(v || '').toLowerCase().trim();
    if (t) out.add(t);
  };
  add(name);
  if (Array.isArray(list)) list.forEach(add);
  else if (typeof list === 'string') list.split(',').forEach(add);
  return Array.from(out).slice(0, 12);
}

export class AppDatabase {
  constructor({ storage = null } = {}) {
    this.storage = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    /** @type {Map<string, AppRecord>} */
    this.apps = new Map();
    this.lastScan = null;
    this.scanSource = null;      // 'mock' until a real scan runs
    this._loadedFromStorage = this.load();
    if (!this._loadedFromStorage) this.seedMock();
  }

  /** Populate with the shipped catalogue. All entries flagged unverified. */
  seedMock() {
    this.apps.clear();
    for (const s of SEED) {
      this.apps.set(s.id, /** @type {any} */ ({
        ...s,
        executablePath: null,      // ← filled by the future local scanner
        verified: false,
        source: 'mock',
        installed: null,           // null = unknown (not "false", which would be a lie)
        lastLaunched: null,
        launchCount: 0,
      }));
    }
    this.scanSource = 'mock';
    this.lastScan = null;
    return this.apps.size;
  }

  /* ── queries ──────────────────────────────────────────────────────── */

  get(id) { return this.apps.get(id) || null; }
  all() { return Array.from(this.apps.values()); }
  get size() { return this.apps.size; }

  byCategory(cat) { return this.all().filter(a => a.category === cat); }

  categories() {
    const counts = {};
    for (const a of this.apps.values()) counts[a.category] = (counts[a.category] || 0) + 1;
    return Object.entries(CATEGORIES).map(([id, c]) => ({ id, ...c, count: counts[id] || 0 }));
  }

  /**
   * Fuzzy-ish lookup over name + aliases. Deterministic scoring:
   * exact alias > exact name > alias prefix > substring.
   * @returns {AppRecord[]} best matches first
   */
  search(query, { limit = 8 } = {}) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const scored = [];
    for (const app of this.apps.values()) {
      const name = app.name.toLowerCase();
      let score = 0;
      if (app.aliases.includes(q)) score = 100;
      else if (name === q) score = 95;
      else if (app.aliases.some(a => a.startsWith(q))) score = 80;
      else if (name.startsWith(q)) score = 75;
      else if (app.aliases.some(a => a.includes(q))) score = 55;
      else if (name.includes(q)) score = 50;
      else if (app.id.includes(q)) score = 40;
      if (score > 0) {
        // prefer apps we've actually confirmed and ones used before
        if (app.verified) score += 6;
        score += Math.min(5, app.launchCount);
        scored.push({ app, score });
      }
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(x => x.app);
  }

  /** Single best match, or null. Used by the Action Manager. */
  resolve(query) {
    const hits = this.search(query, { limit: 1 });
    return hits[0] || null;
  }

  /* ── mutation (used by the future scanner) ────────────────────────── */

  /**
   * Merge scanner results in. Never invents paths — only records what the
   * scanner reports.
   * @param {Array<Partial<AppRecord>>} results
   */
  mergeScanResults(results, { platform = 'unknown' } = {}) {
    let updated = 0, added = 0;
    for (const r of results || []) {
      if (!r.id && !r.name) continue;
      const id = r.id || String(r.name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const existing = this.apps.get(id);
      if (existing) {
        Object.assign(existing, {
          executablePath: r.executablePath ?? existing.executablePath,
          installed: r.installed ?? true,
          verified: true,
          source: 'scan',
          iconData: r.iconData ?? existing.iconData,
        });
        updated++;
      } else {
        this.apps.set(id, {
          id, name: r.name || id, category: r.category || 'system',
          icon: r.icon || '📦', aliases: r.aliases || [String(r.name || id).toLowerCase()],
          launchers: r.launchers || {}, executablePath: r.executablePath || null,
          webFallback: null, verified: true, source: 'scan', installed: true,
          iconData: r.iconData || null, lastLaunched: null, launchCount: 0,
        });
        added++;
      }
    }
    this.lastScan = Date.now();
    this.scanSource = platform;
    this.save();
    return { updated, added, total: this.apps.size };
  }

  addCustom(record) {
    if (!record?.id) throw new Error('Custom app needs an id');
    const id = slugifyId(record.id);
    const name = record.name || record.id;
    this.apps.set(id, {
      category: 'system', icon: '📦',
      launchers: {}, executablePath: null, webFallback: null,
      verified: false, source: 'user', installed: null, lastLaunched: null, launchCount: 0,
      ...record,
      id,
      name,
      aliases: normaliseAliases(record.aliases, name),
    });
    this.save();
    return this.apps.get(id);
  }

  /**
   * Edit an existing app. Only whitelisted fields can change, so a bad edit
   * cannot corrupt the record shape the launcher relies on.
   * @param {string} id
   * @param {{name?:string, icon?:string, category?:string, aliases?:string[],
   *          webFallback?:string, executablePath?:string, launchers?:object}} patch
   */
  update(id, patch = {}) {
    const app = this.apps.get(id);
    if (!app) return { ok: false, message: `No app with id "${id}".` };
    const allowed = ['name', 'icon', 'category', 'aliases', 'webFallback', 'executablePath', 'launchers'];
    for (const k of allowed) {
      if (patch[k] === undefined) continue;
      if (k === 'aliases') {
        app.aliases = normaliseAliases(patch.aliases, app.name || id);
      } else if (k === 'webFallback') {
        const u = String(patch.webFallback || '').trim();
        if (u && !/^https?:\/\//i.test(u)) {
          return { ok: false, message: 'Web fallback must start with http:// or https://' };
        }
        app.webFallback = u || null;
      } else {
        app[k] = patch[k];
      }
    }
    app.source = app.source === 'builtin' ? 'builtin-edited' : (app.source || 'user');
    this.save();
    return { ok: true, app, message: `Updated ${app.name}.` };
  }

  remove(id) { const ok = this.apps.delete(id); if (ok) this.save(); return ok; }

  recordLaunch(id) {
    const a = this.apps.get(id);
    if (!a) return false;
    a.lastLaunched = Date.now();
    a.launchCount = (a.launchCount || 0) + 1;
    this.save();
    return true;
  }

  /* ── persistence ──────────────────────────────────────────────────── */

  save() {
    if (!this.storage) return false;
    try {
      this.storage.setItem(LS_KEY, JSON.stringify({
        apps: Array.from(this.apps.values()),
        lastScan: this.lastScan,
        scanSource: this.scanSource,
      }));
      return true;
    } catch { return false; }
  }

  load() {
    if (!this.storage) return false;
    try {
      const raw = this.storage.getItem(LS_KEY);
      if (!raw) return false;
      const d = JSON.parse(raw);
      if (!Array.isArray(d.apps) || !d.apps.length) return false;
      this.apps.clear();
      for (const a of d.apps) this.apps.set(a.id, a);
      this.lastScan = d.lastScan || null;
      this.scanSource = d.scanSource || 'mock';
      return true;
    } catch { return false; }
  }

  reset() {
    try { this.storage?.removeItem(LS_KEY); } catch {}
    return this.seedMock();
  }

  stats() {
    const all = this.all();
    return {
      total: all.length,
      verified: all.filter(a => a.verified).length,
      mock: all.filter(a => a.source === 'mock').length,
      withPaths: all.filter(a => !!a.executablePath).length,
      lastScan: this.lastScan,
      scanSource: this.scanSource,
      categories: this.categories().filter(c => c.count > 0).length,
    };
  }
}

export { SEED as MOCK_APPS };
export default AppDatabase;

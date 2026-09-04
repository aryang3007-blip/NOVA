/**
 * AURA :: Local Actions Client
 * ----------------------------
 * Talks to the Local Action Bridge in serve.py so AURA can really open apps,
 * control media and take screenshots on the machine it's served from.
 *
 * Degrades honestly: if the bridge is off, AURA says exactly how to enable it
 * instead of pretending the action worked.
 */

import { bus, EV } from '../core/bus.js';
import { state } from '../core/state.js';

export class LocalActions {
  constructor() {
    this.available = false;      // bridge reachable AND actions enabled
    this.serverPresent = false;  // serve.py is running (even if actions off)
    this.token = null;
    this.os = null;
    this.apps = [];
  }

  /** Probe the bridge. Safe to call anywhere — never throws. */
  async init() {
    try {
      const res = await fetch('/api/status', { cache: 'no-store' });
      if (!res.ok) throw new Error('no bridge');
      const s = await res.json();
      this.serverPresent = true;
      this.os = s.os;
      if (!s.actionsEnabled) {
        state.set({ actionsEnabled: false });
        return false;
      }
      const t = await (await fetch('/api/token', { cache: 'no-store' })).json();
      if (!t.ok) return false;
      this.token = t.token;
      this.available = true;
      state.set({ actionsEnabled: true, actionsOs: s.os });
      await this.refreshApps();
      bus.emit(EV.LOG, { text: `Local action bridge online (${s.os})` });
      return true;
    } catch {
      // Not served by serve.py (e.g. opened from a static host) — fine.
      this.available = false;
      state.set({ actionsEnabled: false });
      return false;
    }
  }

  get disabledReason() {
    if (this.available) return null;
    if (this.serverPresent) {
      return 'Desktop actions are disabled. Restart AURA with:\n\n```bash\npython3 serve.py --allow-actions\n```';
    }
    return 'Desktop control needs AURA\'s local server. Run `python3 serve.py --allow-actions` from the aura folder and open http://localhost:8000.';
  }

  async refreshApps() {
    if (!this.available) return [];
    try {
      const r = await fetch('/api/apps', { headers: { 'X-AURA-Token': this.token } });
      const j = await r.json();
      this.apps = j.apps || [];
      return this.apps;
    } catch { return []; }
  }

  /**
   * Dispatch to the local bridge. The server returns action-specific fields
   * (apps, policy, output, entries…) so the result is intentionally loose.
   * @returns {Promise<any>}
   */
  async run(action, params = {}) {
    if (!this.available) {
      return { ok: false, message: this.disabledReason, needsSetup: true };
    }
    try {
      const res = await fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AURA-Token': this.token },
        body: JSON.stringify({ action, params }),
      });
      const j = await res.json();
      bus.emit('action:result', { action, params, result: j });
      return j;
    } catch (e) {
      return { ok: false, message: `Action bridge unreachable: ${e.message}` };
    }
  }

  openApp(app, arg) { return this.run('open_app', { app, arg }); }
  openUrl(url) { return this.run('open_url', { url }); }
  search(query, engine) { return this.run('search', { query, engine }); }
  media(action) { return this.run('media', { action }); }
  volume(level) { return this.run('volume', { level }); }
  screenshot() { return this.run('screenshot', {}); }

  /* ── file system (server enforces the path jail) ─────────────────────── */
  listDirectory(target) { return this.run('list_directory', { target }); }
  readFile(target, maxBytes) { return this.run('read_file', { target, maxBytes }); }
  writeFile(target, content, confirmed = false) {
    return this.run('write_file', { target, content, confirmed });
  }
  openFolder(target) { return this.run('open_folder', { target }); }

  /* ── terminal ─────────────────────────────────────────────────────────
     inspectCommand() asks what WOULD happen without running anything, so the
     UI can show the exact command and its risk before the user confirms. */
  inspectCommand(target) { return this.run('inspect_command', { target }); }
  runCommand(target, /** @type {{cwd?:string, confirmed?:boolean}} */ { cwd, confirmed = false } = {}) {
    return this.run('run_command', { target, cwd, confirmed });
  }
  openTerminal(cwd) { return this.run('open_terminal', { cwd }); }

  /* ── clipboard (OS-level fallback when the browser API is blocked) ───── */
  /* ── terminal policy (user-controlled, not hardcoded) ────────────────── */
  getPolicy() { return this.run('get_policy', {}); }
  setPolicy(policy) { return this.run('set_policy', { policy }); }

  /* ── web research (server-side: ddgs + trafilatura) ───────────────────── */
  webCapabilities() { return this.run('web_capabilities', {}); }
  webSearch(query, maxResults = 6) { return this.run('web_search', { query, maxResults }); }
  webResearch(query, opts = {}) { return this.run('web_research', { query, ...opts }); }
  readPage(url) { return this.run('read_page', { url }); }

  /* ── input automation (mouse + keyboard) ──────────────────────────────── */
  automationCapabilities() { return this.run('automation_capabilities', {}); }
  automationArm() { return this.run('automation_arm', {}); }
  automationDisarm() { return this.run('automation_disarm', {}); }
  automationCursor() { return this.run('automation_cursor', {}); }
  automationDryRun(plan) { return this.run('automation_dry_run', { plan }); }
  automationRun(plan, confirmed = false) { return this.run('automation_run', { plan, confirmed }); }

  /* ── desktop overlay: AURA's real reticle, drawn on the actual screen ─── */
  overlayStatus() { return this.run('overlay_status', {}); }
  overlayShow(x, y, opts = {}) { return this.run('overlay_show', { x, y, ...opts }); }
  overlayHide() { return this.run('overlay_hide', {}); }
  overlayConfig(opts) { return this.run('overlay_config', opts); }

  /* ── document generation (pptx / xlsx / docx) ─────────────────────────── */
  docCapabilities() { return this.run('doc_capabilities', {}); }
  /** options: {theme, transition, speed, animation, images} — feature knobs. */
  docBuild(kind, spec, folder, options = null) {
    return this.run('doc_build', { kind, spec, folder, options });
  }

  /* ── file organiser (preview → confirm → undo) ────────────────────────── */
  organizeCapabilities() { return this.run('organize_capabilities', {}); }
  organizePlan(target, includeHidden = false) {
    return this.run('organize_plan', { target, includeHidden });
  }
  organizeApply(target, token) { return this.run('organize_apply', { target, token }); }
  organizeUndo(target) { return this.run('organize_undo', { target }); }

  /* ── paired devices ───────────────────────────────────────────────────── */
  deviceList() { return this.run('device_list', {}); }
  deviceSend(device, action, params) { return this.run('device_send', { device, action, params }); }
  devicePairStart() { return this.run('device_pair_start', {}); }
  devicePairCancel() { return this.run('device_pair_cancel', {}); }
  deviceUnpair(deviceId) { return this.run('device_unpair', { deviceId }); }

  /* ── window management ────────────────────────────────────────────────── */
  windowStatus() { return this.run('window_status', {}); }
  activeWindow() { return this.run('window_active', {}); }
  listWindows() { return this.run('list_windows', {}); }
  focusWindow(windowId) { return this.run('window_action', { op: 'focus', windowId }); }
  minimizeActiveWindow() { return this.run('window_minimize_active', {}); }
  minimizeWindow(windowId) { return this.run('window_action', { op: 'minimize', windowId }); }
  maximizeWindow(windowId) { return this.run('window_action', { op: 'maximize', windowId }); }
  restoreWindow(windowId) { return this.run('window_action', { op: 'restore', windowId }); }
  closeWindow(windowId) { return this.run('window_action', { op: 'close', windowId }); }

  /* ── virtual desktops (Windows) ───────────────────────────────────────── */
  vdeskStatus() { return this.run('vdesk_status', {}); }
  vdeskSetup() { return this.run('vdesk_setup', {}); }
  vdeskGoAura() { return this.run('vdesk_go_aura', {}); }
  vdeskGoHome() { return this.run('vdesk_go_home', {}); }
  vdeskNext() { return this.run('vdesk_next', {}); }
  vdeskPrev() { return this.run('vdesk_prev', {}); }
  vdeskClose() { return this.run('vdesk_close', {}); }
  vdeskResync(index, count) { return this.run('vdesk_resync', { index, count }); }

  /* ── real installed-application detection ────────────────────────────── */
  detectApps() { return this.run('detect_apps', {}); }

  clipboardRead() { return this.run('clipboard_read', {}); }
  clipboardWrite(text) { return this.run('clipboard_write', { text }); }

  installedApps() { return this.apps.filter(a => a.installed || a.hasWeb); }
}

/* ── natural-language intent parsing ─────────────────────────────────────
   Runs BEFORE the LLM so "open whatsapp" is a real launch, not a chat reply.
   Deliberately conservative: only fires on clear imperatives.            */

const APP_ALIASES = {
  whatsapp: ['whatsapp', 'whats app', 'wa'],
  telegram: ['telegram', 'tg'],
  spotify: ['spotify'],
  discord: ['discord'],
  slack: ['slack'],
  vscode: ['vscode', 'vs code', 'visual studio code', 'code editor', 'my editor'],
  terminal: ['terminal', 'console', 'command prompt', 'shell', 'cmd', 'bash'],
  browser: ['browser', 'web browser'],
  files: ['files', 'file manager', 'explorer', 'finder'],
  calculator: ['calculator', 'calc app'],
  notes: ['notes', 'notepad', 'text editor'],
  settings: ['settings', 'system settings', 'preferences', 'control panel'],
  youtube: ['youtube', 'yt'],
  gmail: ['gmail', 'email', 'mail'],
  calendar: ['calendar'],
  maps: ['maps', 'google maps'],
  github: ['github'],
  chatgpt: ['chatgpt', 'chat gpt'],
};

/**
 * @param {string} text
 * @returns {{type:string, [k:string]:any}|null}
 */
export function parseActionIntent(text) {
  const t = String(text || '').trim();
  const low = t.toLowerCase();
  if (!low) return null;

  // ── media control
  if (/^(play|resume)( the)?( music| song| track| it)?$/.test(low) || /\b(unpause|resume playback)\b/.test(low))
    return { type: 'media', action: 'playpause', label: 'play' };
  if (/^(pause|stop)( the)?( music| song| track| playback| it)?$/.test(low))
    return { type: 'media', action: 'playpause', label: 'pause' };
  if (/\b(next|skip)( the)?( song| track)?\b/.test(low) && low.length < 26)
    return { type: 'media', action: 'next', label: 'next track' };
  if (/\b(previous|back|last)( the)?( song| track)\b/.test(low))
    return { type: 'media', action: 'previous', label: 'previous track' };

  // ── volume
  const volSet = /\b(?:set |turn )?volume (?:to |at )?(\d{1,3})\s*%?/.exec(low);
  if (volSet) return { type: 'volume', level: Math.min(100, parseInt(volSet[1], 10)), label: `volume ${volSet[1]}%` };
  if (/\b(volume up|louder|turn it up|increase volume)\b/.test(low)) return { type: 'volume', level: 'up', label: 'volume up' };
  if (/\b(volume down|quieter|turn it down|lower the volume|decrease volume)\b/.test(low)) return { type: 'volume', level: 'down', label: 'volume down' };
  if (/\b(mute|unmute)\b/.test(low) && !/\byour(self)?\b|\bvoice\b|\bspeech\b/.test(low)) return { type: 'volume', level: 'mute', label: 'mute' };

  // ── screenshot
  if (/\b(take|grab|capture)( a| the)? (screenshot|screen shot|screen capture)\b/.test(low) || /^screenshot$/.test(low))
    return { type: 'screenshot', label: 'screenshot' };

  // ── open <app>  /  launch <app>  /  start <app>
  const openVerb = /\b(open|launch|start|run|fire up|bring up|go to|show me)\b/;
  if (openVerb.test(low)) {
    // never hijack AURA's own UI verbs
    if (/\b(camera|webcam|vision|chat|settings|panel|ar mode|the app)\b/.test(low)) return null;

    for (const [id, names] of Object.entries(APP_ALIASES)) {
      for (const n of names) {
        const rx = new RegExp(`\\b(?:open|launch|start|run|fire up|bring up|go to|show me)\\b[^a-z0-9]{0,12}(?:the |my |an? )?${n.replace(/\s/g, '\\s+')}\\b`, 'i');
        if (rx.test(low)) return { type: 'open_app', app: id, label: n };
      }
    }

    // open a URL / domain
    const url = /\b(?:open|go to|launch|visit)\s+((?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?)/i.exec(t);
    if (url && !/\.(js|css|py|md|json|html?)$/i.test(url[1])) {
      return { type: 'open_url', url: url[1], label: url[1] };
    }
  }

  // ── search the web for X
  const s = /\b(?:search(?: for| the web for)?|google|look up)\s+(.{2,90})$/i.exec(t);
  if (s && !/\byour memory\b|\bthe conversation\b/i.test(s[1])) {
    const yt = /\bon youtube\b/i.test(s[1]);
    return { type: 'search', query: s[1].replace(/\bon (youtube|google)\b/i, '').trim(), engine: yt ? 'youtube' : 'duckduckgo', label: s[1] };
  }
  const play = /\bplay\s+(.{2,60})\s+on\s+(youtube|spotify)\b/i.exec(t);
  if (play) {
    return play[2].toLowerCase() === 'youtube'
      ? { type: 'search', query: play[1], engine: 'youtube', label: `${play[1]} on YouTube` }
      : { type: 'open_app', app: 'spotify', label: 'Spotify' };
  }

  return null;
}

export const localActions = new LocalActions();
export default localActions;

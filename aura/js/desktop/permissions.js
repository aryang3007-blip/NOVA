/**
 * AURA :: Desktop Permission System
 * ---------------------------------
 * Capability-based security for every OS-touching action.
 *
 * DESIGN RULES
 *  • Deny by default. Nothing is granted until the user explicitly opts in.
 *  • The Action Manager checks this registry BEFORE dispatching anything.
 *  • Risk tiers drive the UI (and later, confirmation prompts).
 *  • Grants persist in localStorage, scoped per-permission.
 *
 * This module is pure logic — no DOM, no OS calls — so it unit-tests in Node.
 */

export const RISK = { LOW: 'low', MEDIUM: 'medium', HIGH: 'high', CRITICAL: 'critical' };

/**
 * The full permission catalogue.
 * `requiresNative` = cannot work in a pure browser; needs the local host
 * process (serve.py + bridge) or a future native companion.
 */
export const PERMISSIONS = {
  launch_apps: {
    id: 'launch_apps',
    label: 'Launch Applications',
    description: 'Open installed desktop applications such as WhatsApp, Spotify or VS Code.',
    risk: RISK.MEDIUM,
    requiresNative: true,
    icon: '🚀',
    grantedBy: ['app-launcher'],
  },
  close_apps: {
    id: 'close_apps',
    label: 'Close Applications',
    description: 'Terminate running applications. Unsaved work in those apps may be lost.',
    risk: RISK.HIGH,
    requiresNative: true,
    icon: '✕',
    grantedBy: ['app-launcher'],
  },
  open_websites: {
    id: 'open_websites',
    label: 'Open Websites',
    description: 'Open URLs in your default browser.',
    risk: RISK.LOW,
    requiresNative: false,
    icon: '🌐',
    grantedBy: ['browser-control'],
  },
  file_system: {
    id: 'file_system',
    label: 'File System Access',
    description: 'Read, write, and list files and folders on this machine.',
    risk: RISK.CRITICAL,
    requiresNative: true,
    icon: '📁',
    grantedBy: ['file-system'],
  },
  terminal: {
    id: 'terminal',
    label: 'Terminal Access',
    description: 'Run shell commands. This is the most powerful permission — grant with care.',
    risk: RISK.CRITICAL,
    requiresNative: true,
    icon: '⌨',
    grantedBy: ['terminal'],
  },
  power_controls: {
    id: 'power_controls',
    label: 'Power Controls',
    description: 'Sleep, restart, shut down, or lock the machine.',
    risk: RISK.CRITICAL,
    requiresNative: true,
    icon: '⏻',
    grantedBy: ['windows-integration'],
  },
  keyboard_automation: {
    id: 'keyboard_automation',
    label: 'Keyboard Automation',
    description: 'Simulate keystrokes and type into other applications.',
    risk: RISK.HIGH,
    requiresNative: true,
    icon: '⌨',
    grantedBy: ['windows-integration'],
  },
  mouse_automation: {
    id: 'mouse_automation',
    label: 'Mouse Automation',
    description: 'Move the cursor and simulate clicks.',
    risk: RISK.HIGH,
    requiresNative: true,
    icon: '🖱',
    grantedBy: ['windows-integration'],
  },
  clipboard: {
    id: 'clipboard',
    label: 'Clipboard',
    description: 'Read from and write to the system clipboard.',
    risk: RISK.MEDIUM,
    requiresNative: false,
    icon: '📋',
    grantedBy: ['windows-integration'],
  },
  camera: {
    id: 'camera',
    label: 'Camera',
    description: 'Use the webcam for vision, face and gesture detection.',
    risk: RISK.MEDIUM,
    requiresNative: false,
    icon: '📷',
    grantedBy: ['vision'],
  },
  microphone: {
    id: 'microphone',
    label: 'Microphone',
    description: 'Listen for speech input and the wake word.',
    risk: RISK.MEDIUM,
    requiresNative: false,
    icon: '🎙',
    grantedBy: ['voice'],
  },
  media_control: {
    id: 'media_control',
    label: 'Media Control',
    description: 'Play/pause, skip tracks, and change system volume.',
    risk: RISK.LOW,
    requiresNative: true,
    icon: '⏯',
    grantedBy: ['media'],
  },
  minimize_windows: {
    id: 'minimize_windows',
    label: 'Privacy Guard — Minimize Active Window',
    description: 'Let Privacy Guard minimise the focused window when someone '
      + 'is detected behind you. Uses the OS window API, never mouse clicks.',
    risk: RISK.MEDIUM,
    requiresNative: true,
    icon: '🛡',
    grantedBy: ['privacy-guard'],
  },
  vision_mouse: {
    id: 'vision_mouse',
    label: 'Vision Mouse Control',
    description: 'Let a held fingertip become a real mouse click on the Windows '
      + 'desktop. Dwell-to-click on AURA\u2019s own buttons never needs this \u2014 only '
      + 'clicks that leave the browser and drive the OS pointer do. Requires a '
      + 'full-monitor screen share, because a window or tab share cannot be '
      + 'mapped to desktop pixels.',
    risk: RISK.HIGH,
    requiresNative: true,
    icon: '\u2609',
    grantedBy: ['dwell-click'],
  },
  screen_capture: {
    id: 'screen_capture',
    label: 'Screen Capture',
    description: 'Take screenshots of the desktop.',
    risk: RISK.HIGH,
    requiresNative: true,
    icon: '📸',
    grantedBy: ['windows-integration'],
  },
};

export const PERMISSION_IDS = Object.keys(PERMISSIONS);

const LS_KEY = 'aura.permissions.v1';

export class PermissionManager {
  /**
   * @param {{storage?:Storage, onChange?:Function}} opts
   */
  constructor({ storage = null, onChange = null } = {}) {
    this.storage = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    this.onChange = onChange;
    /** @type {Record<string, {granted:boolean, at:number, source:string}>} */
    this.grants = {};
    /** Audit trail of every check — powers the Settings activity view. */
    this.checkLog = [];
    this.load();
  }

  load() {
    if (!this.storage) return false;
    try {
      const raw = this.storage.getItem(LS_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      // Only keep ids we still recognise, so removing a permission is safe.
      for (const [k, v] of Object.entries(data || {})) {
        if (PERMISSIONS[k]) this.grants[k] = v;
      }
      return true;
    } catch { return false; }
  }

  save() {
    if (!this.storage) return false;
    try { this.storage.setItem(LS_KEY, JSON.stringify(this.grants)); return true; }
    catch { return false; }
  }

  /** Is this permission currently granted? Unknown ids are always false. */
  isGranted(id) {
    if (!PERMISSIONS[id]) return false;
    return this.grants[id]?.granted === true;
  }

  grant(id, source = 'user') {
    if (!PERMISSIONS[id]) throw new Error(`Unknown permission "${id}"`);
    this.grants[id] = { granted: true, at: Date.now(), source };
    this.save();
    this.onChange?.({ id, granted: true, source });
    return true;
  }

  revoke(id, source = 'user') {
    if (!PERMISSIONS[id]) throw new Error(`Unknown permission "${id}"`);
    this.grants[id] = { granted: false, at: Date.now(), source };
    this.save();
    this.onChange?.({ id, granted: false, source });
    return true;
  }

  toggle(id) {
    return this.isGranted(id) ? (this.revoke(id), false) : (this.grant(id), true);
  }

  /** Grant several at once (used by the setup flow's "recommended" preset). */
  grantMany(ids, source = 'setup') {
    for (const id of ids) if (PERMISSIONS[id]) this.grant(id, source);
  }

  revokeAll(source = 'user') {
    for (const id of PERMISSION_IDS) this.revoke(id, source);
  }

  /**
   * The gate used by the Action Manager.
   * @returns {{allowed:boolean, reason?:string, permission?:object}}
   */
  check(id, { actionName = '' } = {}) {
    const perm = PERMISSIONS[id];
    const entry = { t: Date.now(), permission: id, action: actionName };

    if (!perm) {
      this._log({ ...entry, allowed: false, reason: 'unknown-permission' });
      return { allowed: false, reason: `Unknown permission "${id}".` };
    }
    if (!this.isGranted(id)) {
      this._log({ ...entry, allowed: false, reason: 'not-granted' });
      return {
        allowed: false,
        permission: perm,
        reason: `Permission "${perm.label}" is not granted. Enable it in Settings → Desktop → Permissions.`,
      };
    }
    this._log({ ...entry, allowed: true });
    return { allowed: true, permission: perm };
  }

  _log(entry) {
    this.checkLog.push(entry);
    if (this.checkLog.length > 200) this.checkLog.shift();
  }

  /** Snapshot for the Settings UI. */
  list() {
    return PERMISSION_IDS.map(id => ({
      ...PERMISSIONS[id],
      granted: this.isGranted(id),
      grantedAt: this.grants[id]?.at || null,
    }));
  }

  summary() {
    const all = this.list();
    return {
      total: all.length,
      granted: all.filter(p => p.granted).length,
      critical: all.filter(p => p.granted && p.risk === RISK.CRITICAL).length,
      byRisk: Object.fromEntries(
        Object.values(RISK).map(r => [r, all.filter(p => p.risk === r && p.granted).length])),
    };
  }

  /** Recommended low-risk starter set. */
  static recommended() {
    return ['launch_apps', 'open_websites', 'media_control', 'clipboard'];
  }
}

export default PermissionManager;

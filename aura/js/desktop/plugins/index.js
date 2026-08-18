/**
 * AURA :: Desktop Plugin Suite
 * ----------------------------
 * Six plugins covering the planned desktop surface. Each declares its
 * permissions, action schemas, and availability. Where a capability needs
 * native code, the handler returns an honest "needs the companion" result
 * instead of silently failing or pretending.
 *
 * Adding a plugin later is one `registerPlugin()` call — no core changes.
 */

/** Shared helper: a uniform "not built yet" response. */
function pending(feature, detail = '') {
  return {
    ok: false,
    notImplemented: true,
    message: `${feature} needs the native desktop companion, which isn't installed yet.` +
             (detail ? ` ${detail}` : ''),
  };
}

/** Human-readable file size. */
function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}

/* ══════════════════════════════════════════════════════════════════════
   1. APPLICATION LAUNCHER
   ══════════════════════════════════════════════════════════════════════ */
export function applicationLauncherPlugin(launcher) {
  return {
    id: 'app-launcher',
    name: 'Application Launcher',
    description: 'Open, close and search desktop applications.',
    icon: '🚀',
    permissions: ['launch_apps', 'close_apps'],
    available: () => !!launcher?.ready,
    plannedStatus: 'initialising',

    actions: {
      launch_app: {
        permission: 'launch_apps',
        description: 'Open an installed application by name',
        schema: { target: { type: 'string', required: true, maxLength: 80 } },
        run: async ({ target }) => launcher.launchApp(target),
      },
      close_app: {
        permission: 'close_apps',
        description: 'Close a running application',
        confirm: true,
        confirmMessage: 'Closing an app may discard unsaved work. Confirm?',
        schema: {
          target: { type: 'string', required: true, maxLength: 80 },
          force: { type: 'boolean', default: false },
        },
        run: async ({ target, force }) => launcher.closeApp(target, { force }),
      },
      search_apps: {
        permission: 'launch_apps',
        description: 'Search the application database',
        schema: { target: { type: 'string', required: true, maxLength: 60 } },
        run: async ({ target }) => {
          const r = await launcher.searchInstalledApps(target);
          return {
            ok: true,
            message: r.results.length
              ? `Found: ${r.results.map(a => a.name).join(', ')}`
              : `Nothing matching "${target}".`,
            results: r.results,
          };
        },
      },
      list_apps: {
        permission: 'launch_apps',
        description: 'List known applications',
        schema: { category: { type: 'string', maxLength: 30 } },
        run: async ({ category }) => {
          const r = await launcher.getInstalledApps({ category: category || null });
          return { ok: true, message: `${r.apps.length} applications known.`, apps: r.apps, stats: r.stats };
        },
      },
    },
  };
}

/* ══════════════════════════════════════════════════════════════════════
   2. BROWSER CONTROL
   ══════════════════════════════════════════════════════════════════════ */
export function browserControlPlugin(bridge) {
  const SAFE_URL = '^(https?:\\/\\/)?[\\w.-]+\\.[a-z]{2,}(\\/.*)?$';
  return {
    id: 'browser-control',
    name: 'Browser Control',
    description: 'Open websites and run searches in the default browser.',
    icon: '🌐',
    permissions: ['open_websites'],
    available: () => true,          // works in-browser via window.open

    actions: {
      open_url: {
        permission: 'open_websites',
        description: 'Open a website',
        schema: { target: { type: 'string', required: true, maxLength: 400, pattern: SAFE_URL } },
        run: async ({ target }) => {
          if (bridge?.available) return bridge.openUrl(target);
          const url = /^https?:\/\//i.test(target) ? target : `https://${target}`;
          window.open(url, '_blank', 'noopener');
          return { ok: true, message: `Opened ${url}` };
        },
      },
      web_search: {
        permission: 'open_websites',
        description: 'Search the web',
        schema: {
          target: { type: 'string', required: true, maxLength: 200 },
          engine: { type: 'string', enum: ['duckduckgo', 'google', 'youtube'], default: 'duckduckgo' },
        },
        run: async ({ target, engine }) => {
          if (bridge?.available) return bridge.search(target, engine);
          const bases = {
            duckduckgo: 'https://duckduckgo.com/?q=',
            google: 'https://www.google.com/search?q=',
            youtube: 'https://www.youtube.com/results?search_query=',
          };
          window.open(bases[engine] + encodeURIComponent(target), '_blank', 'noopener');
          return { ok: true, message: `Searching for "${target}".` };
        },
      },
      // TODO(local): tab control (list/close/switch) needs a browser extension
      //   or CDP connection. Left unregistered so the AI can't request it.
    },
  };
}

/* ══════════════════════════════════════════════════════════════════════
   3. FILE SYSTEM
   ══════════════════════════════════════════════════════════════════════ */
export function fileSystemPlugin(bridge) {
  return {
    id: 'file-system',
    name: 'File System',
    description: 'Browse, read and write files inside your home folder.',
    icon: '📁',
    permissions: ['file_system'],
    available: () => !!bridge?.available,
    plannedStatus: 'needs local server',

    /**
     * SECURITY: every path is resolved and jailed SERVER-SIDE in
     * bridge._resolve_path(). Symlinks are resolved before the containment
     * check, `..` cannot escape, and credential folders (.ssh, .aws, .env…)
     * are refused outright. The browser never decides what is reachable.
     */
    actions: {
      list_directory: {
        permission: 'file_system',
        description: 'List files in a folder',
        schema: { target: { type: 'string', maxLength: 300 } },
        run: async ({ target }) => {
          if (!bridge?.available) return pending('Listing directories', 'Start AURA with: python serve.py --allow-actions');
          const r = await bridge.listDirectory(target || '~');
          if (!r.ok) return r;
          const list = (r.entries || []).slice(0, 60)
            .map(e => `${e.dir ? '📁' : '📄'} ${e.name}${e.dir ? '' : `  ${fmtBytes(e.size)}`}`)
            .join('\n');
          return { ...r, message: `**${r.path}**\n\n${list || '(empty)'}` };
        },
      },
      read_file: {
        permission: 'file_system',
        description: 'Read a text file',
        schema: {
          target: { type: 'string', required: true, maxLength: 300 },
          maxBytes: { type: 'number', default: 65536, max: 524288 },
        },
        run: async ({ target, maxBytes }) => {
          if (!bridge?.available) return pending('Reading files');
          const r = await bridge.readFile(target, maxBytes);
          if (!r.ok) return r;
          return { ...r, message: `**${r.path}** (${fmtBytes(r.size)})\n\n\`\`\`\n${r.content}\n\`\`\`` };
        },
      },
      write_file: {
        permission: 'file_system',
        description: 'Write a text file',
        confirm: true,
        confirmMessage: 'This will write to disk. Confirm?',
        schema: {
          target: { type: 'string', required: true, maxLength: 300 },
          content: { type: 'string', required: true, maxLength: 500000 },
        },
        // The action manager only calls run() once the user has confirmed,
        // so confirmed:true here is the result of a real human decision.
        run: async ({ target, content }) => {
          if (!bridge?.available) return pending('Writing files');
          return bridge.writeFile(target, content, true);
        },
      },
      open_folder: {
        permission: 'file_system',
        description: 'Reveal a folder in the file manager',
        schema: { target: { type: 'string', maxLength: 300 } },
        run: async ({ target }) => {
          if (!bridge?.available) return pending('Opening folders');
          return bridge.openFolder(target || '~');
        },
      },
    },
  };
}

/* ══════════════════════════════════════════════════════════════════════
   4. TERMINAL
   ══════════════════════════════════════════════════════════════════════ */
export function terminalPlugin(bridge) {
  return {
    id: 'terminal',
    name: 'Terminal',
    description: 'Run allowlisted commands. Destructive verbs are hard-blocked.',
    icon: '⌨',
    permissions: ['terminal'],
    available: () => !!bridge?.available,
    plannedStatus: 'needs local server',

    /**
     * SECURITY (all enforced server-side in bridge._classify_command):
     *   1. DESTRUCTIVE_PATTERNS (rm, del, format, diskpart, shutdown, reg…)
     *      can NEVER run — not with confirmation, not by AI decision.
     *   2. Shell metacharacters (; & | > ` $) are rejected, so a second
     *      command cannot be chained onto a safe one.
     *   3. Everything runs as an argv array with shell=false.
     *   4. Read-only programs run directly; anything else needs an explicit
     *      user confirmation carrying confirmed:true.
     *   5. 20s timeout, output capped, cwd jailed to the home folder.
     */
    actions: {
      run_command: {
        permission: 'terminal',
        description: 'Run an allowlisted shell command',
        confirm: true,
        confirmMessage: 'Running a terminal command can modify your system. Confirm?',
        schema: {
          target: { type: 'string', required: true, maxLength: 200 },
          cwd: { type: 'string', maxLength: 300 },
        },
        run: async ({ target, cwd }) => {
          if (!bridge?.available) return pending('Terminal execution', 'Start AURA with: python serve.py --allow-actions');
          const r = await bridge.runCommand(target, { cwd, confirmed: true });
          if (r.blocked) return r;
          if (!r.ok && !r.output) return r;
          return { ...r, message: `\`${r.command}\` → exit ${r.exitCode}\n\n\`\`\`\n${r.output}\n\`\`\`` };
        },
      },
      open_terminal: {
        permission: 'terminal',
        description: 'Open a terminal window',
        schema: { cwd: { type: 'string', maxLength: 300 } },
        run: async ({ cwd }) => {
          if (!bridge?.available) return pending('Opening a terminal');
          return bridge.openTerminal(cwd);
        },
      },
    },
  };
}

/* ══════════════════════════════════════════════════════════════════════
   5. MEDIA
   ══════════════════════════════════════════════════════════════════════ */
export function mediaPlugin(bridge) {
  return {
    id: 'media',
    name: 'Media Control',
    description: 'Playback and system volume control.',
    icon: '⏯',
    permissions: ['media_control'],
    available: () => !!bridge?.available,
    plannedStatus: 'needs local server',

    actions: {
      media_control: {
        permission: 'media_control',
        description: 'Play, pause or skip tracks',
        schema: { target: { type: 'string', required: true, enum: ['play', 'pause', 'playpause', 'next', 'previous', 'stop'] } },
        run: async ({ target }) => {
          if (!bridge?.available) return pending('Media control', 'Start AURA with: python3 serve.py --allow-actions');
          const map = { play: 'playpause', pause: 'playpause' };
          return bridge.media(map[target] || target);
        },
      },
      set_volume: {
        permission: 'media_control',
        description: 'Set or adjust system volume',
        schema: { target: { type: 'string', required: true, maxLength: 10 } },
        run: async ({ target }) => {
          if (!bridge?.available) return pending('Volume control');
          return bridge.volume(/^\d+$/.test(target) ? parseInt(target, 10) : target);
        },
      },
    },
  };
}

/* ══════════════════════════════════════════════════════════════════════
   6. WINDOWS INTEGRATION
   ══════════════════════════════════════════════════════════════════════ */
export function windowsIntegrationPlugin(bridge) {
  return {
    id: 'windows-integration',
    name: 'Windows Integration',
    description: 'Screenshots, clipboard, window management, power and input automation.',
    icon: '🪟',
    permissions: ['screen_capture', 'clipboard', 'power_controls', 'keyboard_automation', 'mouse_automation'],
    available: () => !!bridge?.available,
    plannedStatus: 'partial',

    actions: {
      screenshot: {
        permission: 'screen_capture',
        description: 'Capture the screen',
        schema: {},
        run: async () => {
          if (!bridge?.available) return pending('Screen capture');
          return bridge.screenshot();
        },
      },
      clipboard_read: {
        permission: 'clipboard',
        description: 'Read the clipboard',
        schema: {},
        run: async () => {
          try {
            const text = await navigator.clipboard.readText();
            return { ok: true, message: `Clipboard: ${text.slice(0, 120)}`, text };
          } catch (e) {
            return { ok: false, message: `Clipboard read blocked: ${e.message}. The page must be focused and permission granted.` };
          }
        },
      },
      clipboard_write: {
        permission: 'clipboard',
        description: 'Copy text to the clipboard',
        schema: { target: { type: 'string', required: true, maxLength: 100000 } },
        run: async ({ target }) => {
          try {
            await navigator.clipboard.writeText(target);
            return { ok: true, message: 'Copied to clipboard.' };
          } catch (e) {
            return { ok: false, message: `Clipboard write blocked: ${e.message}` };
          }
        },
      },
      power_control: {
        permission: 'power_controls',
        description: 'Lock, sleep, restart or shut down',
        confirm: true,
        confirmMessage: 'This will affect your entire machine. Confirm?',
        schema: { target: { type: 'string', required: true, enum: ['lock', 'sleep', 'restart', 'shutdown', 'logoff'] } },
        // TODO(local): rundll32 user32.dll,LockWorkStation / shutdown.exe /r /t 0
        //   macOS: pmset sleepnow · Linux: systemctl suspend
        run: async ({ target }) => pending(`Power control (${target})`),
      },
      type_text: {
        permission: 'keyboard_automation',
        description: 'Type text into the focused window',
        confirm: true,
        schema: { target: { type: 'string', required: true, maxLength: 2000 } },
        // TODO(local): SendInput on Windows / CGEvent on macOS / xdotool on Linux.
        run: async () => pending('Keyboard automation'),
      },
      send_hotkey: {
        permission: 'keyboard_automation',
        description: 'Send a keyboard shortcut',
        schema: { target: { type: 'string', required: true, maxLength: 60 } },
        // TODO(local): parse "ctrl+shift+t" into virtual key codes.
        run: async ({ target }) => pending(`Hotkey "${target}"`),
      },
      mouse_click: {
        permission: 'mouse_automation',
        description: 'Move the cursor and click',
        schema: {
          x: { type: 'number', required: true, min: 0 },
          y: { type: 'number', required: true, min: 0 },
          button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
        },
        // TODO(local): SetCursorPos + mouse_event / CGEvent / xdotool.
        run: async () => pending('Mouse automation'),
      },
      focus_window: {
        permission: 'keyboard_automation',
        description: 'Bring a window to the foreground',
        schema: { target: { type: 'string', required: true, maxLength: 120 } },
        // TODO(local): EnumWindows + SetForegroundWindow, matched on title.
        run: async ({ target }) => pending(`Focusing "${target}"`),
      },
    },
  };
}

/**
 * Register the full suite on an ActionManager.
 * @returns {string[]} plugin ids
 */
export function registerDesktopPlugins(actionManager, { launcher, bridge }) {
  const suite = [
    applicationLauncherPlugin(launcher),
    browserControlPlugin(bridge),
    fileSystemPlugin(bridge),
    terminalPlugin(bridge),
    mediaPlugin(bridge),
    windowsIntegrationPlugin(bridge),
  ];
  for (const p of suite) actionManager.registerPlugin(p);
  return suite.map(p => p.id);
}

export default registerDesktopPlugins;

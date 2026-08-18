/**
 * AURA :: Command Registry
 * ------------------------
 * THE canonical list of everything AURA can do. One namespaced name per
 * capability, each with a schema, a risk level, and the permission it needs.
 *
 * WHY THIS IS THE KEYSTONE
 * ------------------------
 * Before this, the AI emitted free-form action names and each caller mapped
 * them to something ad hoc — `open_app` here, `launch` there, `do:"click"`
 * somewhere else. Three separate normalisation layers existed, and a model
 * could invent a name nobody had considered.
 *
 * Now the AI may ONLY select from this registry. A command that is not here
 * does not exist, and `validate()` rejects it before the Runtime sees it.
 * That is what makes "the AI never touches the OS directly" enforceable
 * rather than aspirational.
 *
 * NAMING: `domain.verb`. The domain maps to the subsystem that executes it,
 * so routing is data, not a switch statement.
 *
 * @module runtime/command-registry
 */

/** Risk drives confirmation policy. */
export const RISK = { SAFE: 'safe', LOW: 'low', MEDIUM: 'medium', HIGH: 'high' };

/**
 * @typedef {Object} CommandSpec
 * @property {string} name           `domain.verb`
 * @property {string} summary        one line, shown to the user and the model
 * @property {string} risk           RISK.*
 * @property {string|null} permission  permission id required, or null
 * @property {Object} params         param name → {type, required, desc}
 * @property {boolean} [needsScreen] requires an active screen share
 * @property {boolean} [readOnly]    observes only; changes nothing
 */

/** @type {Record<string, CommandSpec>} */
export const COMMANDS = {};

function def(spec) {
  COMMANDS[spec.name] = {
    params: {}, permission: null, readOnly: false, needsScreen: false, ...spec,
  };
}

/* ── desktop ───────────────────────────────────────────────────────── */
def({ name: 'desktop.launch_app', summary: 'Open an installed application',
      risk: RISK.MEDIUM, permission: 'launch_apps',
      params: { app: { type: 'string', required: true, desc: 'allowlisted app id' },
                arg: { type: 'string', required: false, desc: 'optional argument' } } });
def({ name: 'desktop.list_apps', summary: 'List launchable applications',
      risk: RISK.SAFE, readOnly: true });
def({ name: 'desktop.running_apps', summary: 'Which applications are running now',
      risk: RISK.SAFE, readOnly: true });
def({ name: 'desktop.screenshot', summary: 'Capture the desktop to a file',
      risk: RISK.HIGH, permission: 'screen_capture' });

/* ── input (the dangerous ones) ────────────────────────────────────── */
def({ name: 'input.click', summary: 'Click a point on screen',
      risk: RISK.HIGH, permission: 'mouse_automation', needsScreen: true,
      params: { cell: { type: 'string', required: true, desc: 'grid cell, e.g. C4' },
                target: { type: 'string', required: false, desc: 'what is being clicked' },
                button: { type: 'string', required: false, desc: 'left|right|double' } } });
def({ name: 'input.move', summary: 'Move the pointer without clicking',
      risk: RISK.MEDIUM, permission: 'mouse_automation', needsScreen: true,
      params: { cell: { type: 'string', required: true, desc: 'grid cell' } } });
def({ name: 'input.type', summary: 'Type text into the focused field',
      risk: RISK.HIGH, permission: 'keyboard_automation',
      params: { text: { type: 'string', required: true, desc: 'literal text' } } });
def({ name: 'input.hotkey', summary: 'Press a key combination',
      risk: RISK.HIGH, permission: 'keyboard_automation',
      params: { keys: { type: 'string', required: true, desc: 'e.g. ctrl+s' } } });
def({ name: 'input.press', summary: 'Press a single key',
      risk: RISK.MEDIUM, permission: 'keyboard_automation',
      params: { key: { type: 'string', required: true, desc: 'e.g. enter' } } });
def({ name: 'input.scroll', summary: 'Scroll up or down',
      risk: RISK.LOW, permission: 'mouse_automation',
      params: { amount: { type: 'number', required: false, desc: '+up / -down' } } });

/* ── paired devices (phone) ────────────────────────────────────────── */
def({ name: 'device.open_url', summary: 'Open a URL on a paired device',
      risk: RISK.MEDIUM, permission: 'open_websites',
      params: { url: { type: 'string', required: true, desc: 'http(s) URL' },
                device: { type: 'string', required: false, desc: 'phone | laptop | device id' } } });
def({ name: 'device.notify', summary: 'Show a notification on a paired device',
      risk: RISK.LOW,
      params: { title: { type: 'string', required: true, desc: 'notification title' },
                body: { type: 'string', required: false, desc: 'body text' },
                device: { type: 'string', required: false, desc: 'target device' } } });
def({ name: 'device.vibrate', summary: 'Vibrate a paired phone',
      risk: RISK.SAFE,
      params: { device: { type: 'string', required: false, desc: 'target device' } } });
def({ name: 'device.list', summary: 'List paired devices',
      risk: RISK.SAFE, readOnly: true });

/* ── window management ─────────────────────────────────────────────── */
def({ name: 'desktop.minimize_active_window',
      summary: 'Minimise the currently focused window (OS API, not a click)',
      risk: RISK.MEDIUM, permission: 'minimize_windows' });
def({ name: 'desktop.active_window', summary: 'Which window is focused right now',
      risk: RISK.SAFE, readOnly: true });

/* ── overlay: AURA's own visible pointer ───────────────────────────── */
def({ name: 'overlay.show', summary: "Show AURA's reticle at a real screen point",
      risk: RISK.LOW, permission: 'screen_capture',
      params: { x: { type: 'number', required: true, desc: 'screen x' },
                y: { type: 'number', required: true, desc: 'screen y' },
                label: { type: 'string', required: false, desc: 'caption' } } });
def({ name: 'overlay.hide', summary: "Hide AURA's reticle", risk: RISK.SAFE });

/* ── virtual desktops ──────────────────────────────────────────────── */
def({ name: 'vdesk.setup', summary: 'Give AURA its own virtual desktop',
      risk: RISK.MEDIUM, permission: 'launch_apps' });
def({ name: 'vdesk.go_aura', summary: "Switch to AURA's desktop",
      risk: RISK.LOW, permission: 'launch_apps' });
def({ name: 'vdesk.go_home', summary: 'Switch back to your desktop',
      risk: RISK.LOW, permission: 'launch_apps' });

/* ── vision ────────────────────────────────────────────────────────── */
def({ name: 'vision.describe', summary: 'Describe what is on the shared screen',
      risk: RISK.SAFE, readOnly: true, needsScreen: true });
def({ name: 'vision.locate', summary: 'Find a UI element and return its grid cell',
      risk: RISK.SAFE, readOnly: true, needsScreen: true,
      params: { target: { type: 'string', required: true, desc: 'visible text or element' } } });
def({ name: 'vision.read_text', summary: 'Transcribe the text on screen',
      risk: RISK.SAFE, readOnly: true, needsScreen: true });

/* ── browser / web ─────────────────────────────────────────────────── */
def({ name: 'browser.open_url', summary: 'Open a URL',
      risk: RISK.MEDIUM, permission: 'open_websites',
      params: { url: { type: 'string', required: true, desc: 'http(s) URL' } } });
def({ name: 'browser.search', summary: 'Search the web',
      risk: RISK.LOW,
      params: { query: { type: 'string', required: true, desc: 'search terms' } } });

/* ── filesystem ────────────────────────────────────────────────────── */
def({ name: 'filesystem.read', summary: 'Read a file inside the allowed folders',
      risk: RISK.MEDIUM, permission: 'file_system', readOnly: true,
      params: { path: { type: 'string', required: true, desc: 'path inside the jail' } } });
def({ name: 'filesystem.write', summary: 'Write a file inside the allowed folders',
      risk: RISK.HIGH, permission: 'file_system',
      params: { path: { type: 'string', required: true, desc: 'path inside the jail' },
                content: { type: 'string', required: true, desc: 'file contents' } } });
def({ name: 'filesystem.search', summary: 'Search for files',
      risk: RISK.LOW, permission: 'file_system', readOnly: true,
      params: { query: { type: 'string', required: true, desc: 'filename fragment' } } });

/* ── memory ────────────────────────────────────────────────────────── */
def({ name: 'memory.store', summary: 'Remember something long-term',
      risk: RISK.SAFE,
      params: { text: { type: 'string', required: true, desc: 'what to remember' } } });
def({ name: 'memory.search', summary: 'Recall from long-term memory',
      risk: RISK.SAFE, readOnly: true,
      params: { query: { type: 'string', required: true, desc: 'what to look for' } } });

/* ── media ─────────────────────────────────────────────────────────── */
def({ name: 'media.play', summary: 'Play / pause media', risk: RISK.LOW, permission: 'media_control' });
def({ name: 'media.pause', summary: 'Pause media', risk: RISK.LOW, permission: 'media_control' });
def({ name: 'media.volume', summary: 'Set the system volume',
      risk: RISK.LOW, permission: 'media_control',
      params: { level: { type: 'number', required: true, desc: '0-100' } } });

/* ── clipboard ─────────────────────────────────────────────────────── */
def({ name: 'clipboard.read', summary: 'Read the clipboard',
      risk: RISK.MEDIUM, permission: 'clipboard', readOnly: true });
def({ name: 'clipboard.write', summary: 'Write to the clipboard',
      risk: RISK.MEDIUM, permission: 'clipboard',
      params: { text: { type: 'string', required: true, desc: 'text to copy' } } });

/* ── terminal + power: highest risk ────────────────────────────────── */
def({ name: 'terminal.run', summary: 'Run an allowlisted shell command',
      risk: RISK.HIGH, permission: 'terminal',
      params: { command: { type: 'string', required: true, desc: 'command line' } } });
def({ name: 'power.shutdown', summary: 'Shut the machine down',
      risk: RISK.HIGH, permission: 'power_controls' });
def({ name: 'power.restart', summary: 'Restart the machine',
      risk: RISK.HIGH, permission: 'power_controls' });

/* ── control flow — used by the Planner, not the OS ────────────────── */
def({ name: 'flow.wait', summary: 'Wait for the UI to settle',
      risk: RISK.SAFE, readOnly: true,
      params: { seconds: { type: 'number', required: false, desc: '0.1-5' } } });
def({ name: 'flow.observe', summary: 'Look at the screen again before deciding',
      risk: RISK.SAFE, readOnly: true });
def({ name: 'flow.done', summary: 'The task is complete',
      risk: RISK.SAFE, readOnly: true,
      params: { reason: { type: 'string', required: false, desc: 'what was achieved' } } });
def({ name: 'flow.fail', summary: 'The task cannot be completed',
      risk: RISK.SAFE, readOnly: true,
      params: { reason: { type: 'string', required: false, desc: 'why' } } });

/* ── API ───────────────────────────────────────────────────────────── */

export const COMMAND_NAMES = Object.keys(COMMANDS);

/** @returns {CommandSpec|null} */
export function getCommand(name) { return COMMANDS[String(name || '')] || null; }

/** Commands grouped by domain, for docs and the dev console. */
export function byDomain() {
  /** @type {Record<string, CommandSpec[]>} */
  const out = {};
  for (const c of Object.values(COMMANDS)) {
    const d = c.name.split('.')[0];
    (out[d] ||= []).push(c);
  }
  return out;
}

/**
 * Legacy/AI-friendly aliases → canonical names.
 *
 * Small models will not reliably emit `desktop.launch_app`. Rather than
 * force them to, we accept what they actually say and map it here — one
 * place, instead of three normalisation layers scattered around the app.
 */
const ALIASES = {
  open_app: 'desktop.launch_app', launch: 'desktop.launch_app',
  open: 'desktop.launch_app', start: 'desktop.launch_app',
  launch_app: 'desktop.launch_app',
  click: 'input.click', tap: 'input.click', click_on: 'input.click',
  double_click: 'input.click', right_click: 'input.click',
  move: 'input.move',
  type: 'input.type', write: 'input.type', enter_text: 'input.type',
  hotkey: 'input.hotkey', shortcut: 'input.hotkey', keys: 'input.hotkey',
  press: 'input.press', key: 'input.press', keypress: 'input.press',
  scroll: 'input.scroll',
  wait: 'flow.wait', sleep: 'flow.wait', pause: 'flow.wait',
  observe: 'flow.observe', look: 'flow.observe', screenshot: 'flow.observe',
  done: 'flow.done', finish: 'flow.done', complete: 'flow.done',
  fail: 'flow.fail', abort: 'flow.fail', give_up: 'flow.fail',
  describe: 'vision.describe', locate: 'vision.locate', find: 'vision.locate',
  read_text: 'vision.read_text', ocr: 'vision.read_text',
  open_url: 'browser.open_url', browse: 'browser.open_url',
  search: 'browser.search', web_search: 'browser.search',
  remember: 'memory.store', recall: 'memory.search',
  volume: 'media.volume', play: 'media.play', playpause: 'media.play',
  copy: 'clipboard.read', paste: 'clipboard.write',
  run: 'terminal.run', exec: 'terminal.run',
};

/** Map whatever the model said onto a canonical name, or null. */
export function resolveName(raw) {
  const n = String(raw || '').trim().toLowerCase().replace(/\s+/g, '_');
  if (COMMANDS[n]) return n;
  if (ALIASES[n]) return ALIASES[n];
  // `desktop_launch_app` → `desktop.launch_app`
  const dotted = n.replace('_', '.');
  if (COMMANDS[dotted]) return dotted;
  return null;
}

/**
 * Validate a proposed command against the registry.
 *
 * This is the gate that makes "the AI cannot invent capabilities" true.
 * It runs BEFORE the Runtime, before permissions, before execution.
 *
 * @param {{command?:string, name?:string, action?:string, do?:string,
 *           params?:object, why?:string, reason?:string}} proposal
 * @returns {{ok:boolean, command?:string, spec?:CommandSpec, params?:object,
 *            error?:string, why?:string}}
 */
export function validate(proposal) {
  if (!proposal || typeof proposal !== 'object') {
    return { ok: false, error: 'Not a command object.' };
  }
  const rawName = proposal.command ?? proposal.name ?? proposal.action ?? proposal.do;
  const name = resolveName(rawName);
  if (!name) {
    return { ok: false, error: `Unknown command "${rawName}". `
      + `It must be one of: ${COMMAND_NAMES.join(', ')}` };
  }
  const spec = COMMANDS[name];

  // Params may arrive nested under `params` or flattened onto the object —
  // models do both constantly.
  const src = { ...(proposal.params || {}), ...proposal };
  delete src.command; delete src.name; delete src.action; delete src.do;
  delete src.params; delete src.why; delete src.reason_text;

  /** @type {Record<string, any>} */
  const params = {};
  for (const [key, p] of Object.entries(spec.params || {})) {
    let v = src[key];
    if (v === undefined || v === null || v === '') {
      if (p.required) {
        return { ok: false, error: `"${name}" needs "${key}" (${p.desc}).` };
      }
      continue;
    }
    if (p.type === 'number') {
      v = Number(v);
      if (Number.isNaN(v)) return { ok: false, error: `"${key}" must be a number.` };
    } else {
      v = String(v);
    }
    params[key] = v;
  }
  // Carry the model's stated reason through — useful in the trace, harmless.
  const why = proposal.why || proposal.reason || '';
  return { ok: true, command: name, spec, params, why };
}

/** Compact description of the registry, for a model prompt. */
/** @param {{include?:string[]}} [opts] */
export function describeForModel({ include } = {}) {
  const list = Object.values(COMMANDS)
    .filter(c => !include || include.includes(c.name));
  return list.map(c => {
    const ps = Object.entries(c.params || {})
      .map(([k, p]) => `${k}${p.required ? '' : '?'}`).join(', ');
    return `${c.name}(${ps}) — ${c.summary}`;
  }).join('\n');
}

export default { COMMANDS, COMMAND_NAMES, RISK, getCommand, validate,
                 resolveName, byDomain, describeForModel };

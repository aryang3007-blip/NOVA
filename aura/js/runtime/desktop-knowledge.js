/**
 * AURA :: Desktop Knowledge Base
 * ------------------------------
 * What every desktop already works like, so a 7B model does not have to
 * rediscover Windows from pixels on every step.
 *
 * WHY THIS IS WORTH MORE THAN IT LOOKS
 * ------------------------------------
 * Asking a small vision model "how do I search in WhatsApp?" wastes 20–30
 * seconds and often gets it wrong. Ctrl+F is Ctrl+F. Encoding the stable,
 * boring facts lets the model spend its one hard judgement — *where is that
 * thing on screen* — on the part only vision can answer.
 *
 * Everything here is a HINT injected into the prompt, never an executed
 * action. If a hint is wrong for a given app the model can ignore it, and the
 * observation loop will catch the mistake on the next iteration.
 *
 * @module runtime/desktop-knowledge
 */

/** Shortcuts that hold across essentially all desktop software. */
export const UNIVERSAL = {
  save: 'ctrl+s', copy: 'ctrl+c', paste: 'ctrl+v', cut: 'ctrl+x',
  undo: 'ctrl+z', redo: 'ctrl+y', selectAll: 'ctrl+a',
  find: 'ctrl+f', closeTab: 'ctrl+w', newTab: 'ctrl+t',
  refresh: 'ctrl+r', print: 'ctrl+p', switchApp: 'alt+tab',
};

/**
 * Per-application knowledge. `search` is the single most valuable field:
 * almost every messaging app has a search box and a shortcut to reach it,
 * which turns "find the contact" from a vision problem into a keystroke.
 */
export const APP_KNOWLEDGE = {
  whatsapp: {
    label: 'WhatsApp Desktop',
    search: { keys: 'ctrl+f', desc: 'focus the chat/contact search box' },
    layout: 'Left column: search box at the top, then the chat list. '
          + 'Right pane: the open conversation, with the message input box along the bottom.',
    send: { keys: 'enter', desc: 'send the typed message' },
    flow: ['ctrl+f to focus search', 'type the contact name', 'press enter or click the result',
           'click the message box at the bottom', 'type the message', 'press enter'],
  },
  telegram: {
    label: 'Telegram Desktop',
    search: { keys: 'ctrl+f', desc: 'search chats' },
    layout: 'Left: search and chat list. Right: conversation with the input box at the bottom.',
    send: { keys: 'enter' },
    flow: ['ctrl+f', 'type the contact name', 'enter', 'click the message box', 'type', 'enter'],
  },
  slack: {
    label: 'Slack',
    search: { keys: 'ctrl+k', desc: 'jump to a channel or person' },
    layout: 'Left sidebar: channels and DMs. Main pane: messages, input box at the bottom.',
    send: { keys: 'enter' },
    flow: ['ctrl+k', 'type the person or channel', 'enter', 'type the message', 'enter'],
  },
  discord: {
    label: 'Discord',
    search: { keys: 'ctrl+k', desc: 'quick switcher' },
    layout: 'Far left: servers. Left: channels. Main: messages with the input at the bottom.',
    send: { keys: 'enter' },
    flow: ['ctrl+k', 'type the channel or person', 'enter', 'type the message', 'enter'],
  },
  spotify: {
    label: 'Spotify',
    search: { keys: 'ctrl+l', desc: 'focus the search field' },
    layout: 'Left: library. Top: search. Bottom bar: playback controls.',
    flow: ['ctrl+l', 'type the track or artist', 'enter', 'click the result'],
  },
  vscode: {
    label: 'VS Code',
    search: { keys: 'ctrl+p', desc: 'quick open a file' },
    palette: { keys: 'ctrl+shift+p', desc: 'command palette — does almost anything' },
    layout: 'Left: explorer. Centre: editor tabs. Bottom: terminal/panel.',
    flow: ['ctrl+p to open a file', 'or ctrl+shift+p for any command'],
  },
  browser: {
    label: 'Web browser',
    search: { keys: 'ctrl+l', desc: 'focus the address bar' },
    layout: 'Top: tabs, then the address bar. Below: the page.',
    flow: ['ctrl+l', 'type the URL or search terms', 'enter'],
    findOnPage: { keys: 'ctrl+f' },
  },
  files: {
    label: 'File Explorer / Finder',
    search: { keys: 'ctrl+f', desc: 'search this folder' },
    address: { keys: 'ctrl+l', desc: 'focus the path bar (Windows)' },
    layout: 'Left: quick access tree. Main: file list. Top: path bar.',
  },
  notes: {
    label: 'Notepad / Notes',
    layout: 'A single text area filling the window.',
    flow: ['click the text area', 'type', 'ctrl+s to save'],
  },
};

/** OS-level facts. */
export const OS_KNOWLEDGE = {
  Windows: {
    label: 'Windows 10/11',
    startMenu: { keys: 'win', desc: 'open Start; type to search apps' },
    runDialog: { keys: 'win+r', desc: 'BLOCKED by AURA — arbitrary command entry' },
    switchApp: { keys: 'alt+tab' },
    minimiseAll: { keys: 'win+d' },
    layout: 'Taskbar along the bottom (Start at the left on Win10, centred on Win11). '
          + 'System tray at the bottom right. Window controls at the top right of each window.',
    closeWindow: 'The X sits at the very top-right of the window — usually the last grid column, row 1.',
  },
  Darwin: {
    label: 'macOS',
    spotlight: { keys: 'cmd+space', desc: 'search and launch' },
    switchApp: { keys: 'cmd+tab' },
    layout: 'Menu bar across the top, Dock at the bottom. Window controls (red/amber/green) '
          + 'at the TOP-LEFT of each window.',
    closeWindow: 'The red dot is at the top-LEFT on macOS, not the right.',
  },
  Linux: {
    label: 'Linux desktop',
    switchApp: { keys: 'alt+tab' },
    layout: 'Varies by desktop environment. Window controls are usually top-right (GNOME/KDE).',
    closeWindow: 'Usually the top-right X, but themes vary.',
  },
};

/**
 * Build a hint block for a prompt.
 * @param {{app?:string, os?:string, task?:string}} ctx
 * @returns {string} '' when we know nothing useful — never filler
 */
export function knowledgeFor({ app, os, task } = {}) {
  const out = [];
  const osk = OS_KNOWLEDGE[os] || null;
  if (osk) {
    out.push(`${osk.label}: ${osk.layout}`);
    if (/close/i.test(task || '')) out.push(osk.closeWindow);
  }
  const a = APP_KNOWLEDGE[String(app || '').toLowerCase()];
  if (a) {
    out.push(`${a.label}: ${a.layout}`);
    if (a.search) out.push(`Search in ${a.label}: press ${a.search.keys} — ${a.search.desc}`);
    if (a.palette) out.push(`Command palette: ${a.palette.keys} — ${a.palette.desc}`);
    if (a.flow?.length) out.push(`Usual sequence: ${a.flow.join(' → ')}`);
  }
  if (!out.length) return '';
  return `KNOWN FACTS (use these instead of hunting on screen):\n- ${out.join('\n- ')}`;
}

/** Which app does this task most likely concern? */
export function guessApp(task) {
  const t = String(task || '').toLowerCase();
  for (const id of Object.keys(APP_KNOWLEDGE)) {
    if (new RegExp(`\\b${id}\\b`).test(t)) return id;
  }
  if (/\b(whats\s?app)\b/.test(t)) return 'whatsapp';
  if (/\b(chrome|firefox|edge|brave|browser|website|url)\b/.test(t)) return 'browser';
  if (/\b(explorer|finder|folder|file manager)\b/.test(t)) return 'files';
  if (/\b(notepad|note)\b/.test(t)) return 'notes';
  return null;
}

export default { UNIVERSAL, APP_KNOWLEDGE, OS_KNOWLEDGE, knowledgeFor, guessApp };

/**
 * Provider-Agnostic Search Abstraction for local files & knowledge engine
 * Supports vector embeddings search with lexical fallback.
 */
export class ProviderAgnosticSearch {
  constructor({ vectorProvider = null } = {}) {
    this.vectorProvider = vectorProvider;
  }

  async search(query, collection = []) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];

    // 1. Vector Search (if provider is configured and available)
    if (this.vectorProvider && typeof this.vectorProvider.query === 'function') {
      try {
        const vResults = await this.vectorProvider.query(q, collection);
        if (vResults && vResults.length) return vResults;
      } catch (e) {
        // Fallback silently to lexical search
      }
    }

    // 2. Lexical Fallback Search
    const terms = q.split(/\s+/).filter(Boolean);
    return collection.filter(item => {
      const text = `${item.title || ''} ${item.text || ''} ${item.name || ''} ${item.path || ''}`.toLowerCase();
      return terms.some(t => text.includes(t));
    }).map(doc => ({ doc, score: 0.8 }));
  }
}

/**
 * AURA :: Command Palette
 * -----------------------
 * Type `/` or `@` in the composer and get a live, filtered list of what you
 * can actually run. Nothing here is a hardcoded menu — the list comes from
 * `plugins.listCommands()`, so a plugin registered tomorrow shows up with no
 * change to this file.
 *
 *   Slash `/` → commands (/look, /cursor, /click …)
 *   At-sign   → context mentions (screen, camera, clipboard …) that expand
 *               into the command that actually does the thing
 *
 * KEYS
 *   ↑ / ↓      move
 *   Tab, Enter accept
 *   Esc        dismiss
 *
 * The palette only opens when the token is at the START of the input, so
 * typing an email address or "3 / 4" never triggers it.
 *
 * @module ui/command-palette
 */

/**
 * `@` mentions. These are shortcuts to a command, not a second command
 * system — each one expands to real, existing syntax so there is exactly one
 * implementation behind it.
 * @type {Array<{name:string, expands:string, help:string, icon:string}>}
 */
export const MENTIONS = [
  { name: 'screen',    expands: '/watch ask ',   icon: '🖥', help: 'Ask about what is on your shared screen' },
  { name: 'camera',    expands: '/look ',        icon: '📷', help: 'Ask about what the webcam sees' },
  { name: 'clipboard', expands: '/clipboard',    icon: '📋', help: 'Read the system clipboard' },
  { name: 'cursor',    expands: '/cursor',       icon: '🖱', help: 'Where is the mouse pointer' },
  { name: 'apps',      expands: '/apps',         icon: '🚀', help: 'List launchable applications' },
  { name: 'memory',    expands: '/remember ',    icon: '🧠', help: 'Save something to long-term memory' },
  { name: 'web',       expands: '/search ',      icon: '🌐', help: 'Search the web' },
  { name: 'models',    expands: '/models',       icon: '⚙',  help: 'Installed models and routing' },
];

const MAX_ROWS = 8;

export class CommandPalette {
  /**
   * @param {object} opts
   * @param {HTMLTextAreaElement} opts.input
   * @param {HTMLElement} opts.mount   element the popup is appended to
   * @param {() => Array<{name:string, usage:string, help:string, plugin:string}>} opts.getCommands
   * @param {(sfx:string)=>void} [opts.sfx]
   */
  constructor({ input, mount, getCommands, sfx = () => {} }) {
    this.input = input;
    this.mount = mount;
    this.getCommands = getCommands;
    this.sfx = sfx;

    this.open = false;
    this.mode = '/';          // '/' or '@'
    this.items = [];
    this.index = 0;

    this.el = document.createElement('div');
    this.el.className = 'cmdp';
    this.el.setAttribute('role', 'listbox');
    this.el.hidden = true;
    this.mount.appendChild(this.el);

    // Mouse selection. Uses mousedown so the textarea never loses focus.
    this.el.addEventListener('mousedown', (e) => {
      const row = /** @type {HTMLElement|null} */ (
        /** @type {HTMLElement} */ (e.target).closest('[data-idx]'));
      if (!row) return;
      e.preventDefault();
      this.index = Number(row.dataset.idx);
      this.accept();
    });

    this._onInput = () => this.refresh();
    this._onKey = (e) => this.handleKey(e);
    this._onBlur = () => setTimeout(() => this.close(), 120);

    input.addEventListener('input', this._onInput);
    // Capture phase: we must intercept Enter/Tab BEFORE the composer's own
    // handler sends the message.
    input.addEventListener('keydown', this._onKey, true);
    input.addEventListener('blur', this._onBlur);
  }

  destroy() {
    this.input.removeEventListener('input', this._onInput);
    this.input.removeEventListener('keydown', this._onKey, true);
    this.input.removeEventListener('blur', this._onBlur);
    this.el.remove();
  }

  /**
   * Parse the current input into a trigger + query.
   * Only fires at the very start of the box, so "a/b" or "x@y" are ignored.
   * @returns {{trigger:string, query:string}|null}
   */
  parse() {
    const v = this.input.value;
    const m = /^([/@])([a-z0-9_-]*)$/i.exec(v);
    if (!m) return null;
    return { trigger: m[1], query: m[2].toLowerCase() };
  }

  refresh() {
    // After accepting `/cursor`, the input still matches the trigger regex,
    // so a naive refresh would immediately re-open the list showing the
    // command you just chose. Swallow exactly one refresh after an accept.
    if (this._justAccepted) { this._justAccepted = false; return this.close(); }
    const p = this.parse();
    if (!p) return this.close();
    this.mode = p.trigger;

    const all = p.trigger === '/'
      ? (this.getCommands() || []).map(c => ({
          key: c.name,
          label: c.usage || `/${c.name}`,
          help: c.help || '',
          icon: iconFor(c.plugin),
          insert: `/${c.name}${/[<[]/.test(c.usage || '') ? ' ' : ''}`,
          done: !/[<[]/.test(c.usage || ''),
        }))
      : MENTIONS.map(m => ({
          key: m.name,
          label: `@${m.name}`,
          help: m.help,
          icon: m.icon,
          insert: m.expands,
          done: !m.expands.endsWith(' '),
        }));

    const q = p.query;
    const scored = all
      .filter(x => !q || x.key.toLowerCase().includes(q))
      .sort((a, b) => {
        // Prefix matches first — typing "cl" should surface /clear and /click
        // above /calc, not bury them.
        const ap = a.key.toLowerCase().startsWith(q) ? 0 : 1;
        const bp = b.key.toLowerCase().startsWith(q) ? 0 : 1;
        return ap - bp || a.key.localeCompare(b.key);
      });

    this.items = scored.slice(0, MAX_ROWS);
    this._total = scored.length;
    this.index = 0;
    this.items.length ? this.show() : this.close();
  }

  show() {
    this.el.innerHTML = this.items.map((it, i) => `
      <div class="cmdp-row${i === this.index ? ' sel' : ''}" data-idx="${i}" role="option"
           aria-selected="${i === this.index}">
        <span class="cmdp-ico">${it.icon}</span>
        <span class="cmdp-name">${esc(it.label)}</span>
        <span class="cmdp-help">${esc(it.help)}</span>
      </div>`).join('')
      + (this._total > this.items.length
        ? `<div class="cmdp-more">+${this._total - this.items.length} more — keep typing</div>` : '')
      + `<div class="cmdp-foot">↑↓ move · Tab/Enter insert · Esc close</div>`;
    this.el.hidden = false;
    this.open = true;
  }

  close() {
    if (!this.open) return;
    this.el.hidden = true;
    this.open = false;
    this.items = [];
  }

  move(d) {
    if (!this.items.length) return;
    this.index = (this.index + d + this.items.length) % this.items.length;
    const rows = this.el.querySelectorAll('.cmdp-row');
    rows.forEach((r, i) => {
      r.classList.toggle('sel', i === this.index);
      r.setAttribute('aria-selected', String(i === this.index));
    });
    rows[this.index]?.scrollIntoView({ block: 'nearest' });
  }

  accept() {
    const it = this.items[this.index];
    if (!it) return false;
    this.input.value = it.insert;
    this._justAccepted = true;
    this.close();
    this.sfx('click');
    this.input.focus();
    // Let the composer resize itself and, for a complete command, re-open
    // nothing — the user can just press Enter.
    this.input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  /** @param {KeyboardEvent} e */
  handleKey(e) {
    if (!this.open) return;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); e.stopPropagation(); this.move(1); break;
      case 'ArrowUp':   e.preventDefault(); e.stopPropagation(); this.move(-1); break;
      case 'Escape':    e.preventDefault(); e.stopPropagation(); this.close(); break;
      case 'Tab':
        // Tab always completes — that is the whole point of Tab.
        e.preventDefault();
        e.stopPropagation();
        this.accept();
        break;

      case 'Enter': {
        /*
         * Enter is ambiguous, and getting it wrong is infuriating.
         *
         * If you have typed a COMPLETE command (`/guide`, `/models`) you mean
         * "run it" — swallowing that to autocomplete the thing you already
         * typed makes the app feel broken, and it silently ate the message.
         * Only intercept Enter when it would genuinely change the text.
         */
        const typed = this.input.value.trim();
        const sel = this.items[this.index];
        const alreadyComplete = sel && typed === sel.insert.trim();
        const isExactCommand = this.mode === '/'
          && (this.getCommands() || []).some(c => `/${c.name}` === typed.toLowerCase());
        if (alreadyComplete || isExactCommand) {
          this.close();      // let the composer's own handler send it
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        this.accept();
        break;
      }
      default:
        break;
    }
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** A glyph per plugin, so the list is scannable rather than a wall of text. */
function iconFor(pluginId) {
  return {
    desktop: '🖥', vision: '📷', voice: '🔊', web: '🌐', live: '📡',
    memory: '🧠', system: '⚙', utility: '🧰', avatar: '🧍', screen: '🖵',
  }[pluginId] || '›';
}

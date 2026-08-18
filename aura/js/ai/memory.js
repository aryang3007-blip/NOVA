/**
 * AURA :: Conversation Memory
 * ---------------------------
 * Rolling-window transcript + a small durable fact store (name, prefs).
 * Optionally persisted to localStorage so a refresh doesn't wipe the session.
 */

const LS_KEY = 'aura.memory.v1';

export class Memory {
  /**
   * @param {{maxTurns?:number, persist?:boolean, storage?:Storage}} opts
   */
  constructor({ maxTurns = 20, persist = false, storage = null } = {}) {
    this.maxTurns = maxTurns;
    this.persist = persist;
    this.storage = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    /**
     * @type {Array<{role:'user'|'assistant'|'system', content:string, t:number,
     *               pinned?:boolean, edited?:number}>}
     * `pinned` survives trimming and is always included in window();
     * `edited` records a manual change made from the Memory Center.
     */
    this.messages = [];
    /** @type {Record<string, any>} */
    this.facts = {};
    /** Hard cap on in-RAM messages — see _trim(). */
    this.maxHistory = 300;
    /** Topics from messages that have been trimmed out of `messages`. */
    this.olderTopics = [];
    if (persist) this.load();
  }

  add(role, content) {
    if (!content && content !== '') return null;
    const msg = { role, content: String(content), t: Date.now() };
    this.messages.push(msg);
    this._trim();
    this.save();
    return msg;
  }

  /**
   * Cap the in-RAM transcript.
   *
   * MEASURED LEAK: only the *persisted* copy was capped (`slice(-120)` in
   * save()); `this.messages` itself grew without bound for the life of the
   * page. A long session therefore kept every message alive in memory and
   * made summary()/context building progressively more expensive.
   *
   * We keep a generous window — far more than the model context uses — so
   * summary() can still describe earlier topics from the dropped tail.
   */
  _trim() {
    const hard = Math.max(this.maxTurns * 2 + 40, this.maxHistory || 300);
    if (this.messages.length <= hard) return;
    // Pinned messages survive trimming — that is what "remember this" means.
    let drop = this.messages.length - hard;
    const dropped = [];
    for (let i = 0; i < this.messages.length && drop > 0; ) {
      if (this.messages[i].pinned) { i++; continue; }
      dropped.push(this.messages.splice(i, 1)[0]);
      drop--;
    }
    // Preserve a trace of what fell off so summary() stays truthful.
    for (const m of dropped) {
      if (m.role !== 'user') continue;
      this.olderTopics.push(m.content.slice(0, 60));
    }
    if (this.olderTopics.length > 12) {
      this.olderTopics.splice(0, this.olderTopics.length - 12);
    }
  }

  /** Stable id — array position is not safe once trimming shifts things. */
  static idOf(m) { return `${m.t}-${m.role}`; }
  find(id) { return this.messages.find(m => Memory.idOf(m) === id) || null; }

  /** Remove one message. @returns {boolean} */
  removeMessage(id) {
    const i = this.messages.findIndex(m => Memory.idOf(m) === id);
    if (i < 0) return false;
    this.messages.splice(i, 1);
    this.save();
    return true;
  }

  /** Edit a message's text. */
  editMessage(id, content) {
    const m = this.find(id);
    if (!m) return false;
    m.content = String(content);
    m.edited = Date.now();
    this.save();
    return true;
  }

  /** Pin/unpin: pinned messages survive trimming and are always in context. */
  pinMessage(id, on = true) {
    const m = this.find(id);
    if (!m) return false;
    if (on) m.pinned = true; else delete m.pinned;
    this.save();
    return true;
  }

  pinnedMessages() { return this.messages.filter(m => m.pinned); }

  /** Substring search across the session. */
  search(q, { limit = 50 } = {}) {
    const needle = String(q || '').toLowerCase().trim();
    if (!needle) return this.messages.slice(-limit).reverse();
    return this.messages.filter(m => m.content.toLowerCase().includes(needle))
      .slice(-limit).reverse();
  }

  addUser(c) { return this.add('user', c); }
  addAssistant(c) { return this.add('assistant', c); }

  /** Replace the content of the last assistant message (used while streaming). */
  updateLastAssistant(content) {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'assistant') {
        this.messages[i].content = content;
        this.save();
        return true;
      }
    }
    return false;
  }

  /** The most recent N turns, suitable for sending to a model. */
  window() {
    const max = this.maxTurns * 2;
    const recent = this.messages.slice(-max);
    const pins = this.messages.filter(m => m.pinned && !recent.includes(m));
    return [...pins, ...recent].map(({ role, content }) => ({ role, content }));
  }

  all() { return this.messages.slice(); }

  lastUser() {
    for (let i = this.messages.length - 1; i >= 0; i--) if (this.messages[i].role === 'user') return this.messages[i];
    return null;
  }

  lastAssistant() {
    for (let i = this.messages.length - 1; i >= 0; i--) if (this.messages[i].role === 'assistant') return this.messages[i];
    return null;
  }

  setFact(k, v) { this.facts[k] = v; this.save(); }
  getFact(k) { return this.facts[k]; }

  /** Compact natural-language digest injected into the system prompt. */
  summary() {
    const parts = [];
    if (Object.keys(this.facts).length) {
      const f = Object.entries(this.facts)
        .map(([k, v]) => `${k === 'userName' ? "user's name" : k}: ${v}`)
        .join('; ');
      parts.push(`Known facts — ${f}.`);
    }
    const windowed = this.messages.slice(0, Math.max(0, this.messages.length - this.maxTurns * 2));
    const topics = [
      ...this.olderTopics,
      ...windowed.filter(m => m.role === 'user').map(m => m.content.slice(0, 60)),
    ].slice(-6);
    if (topics.length) parts.push(`Earlier in this session the user asked about: ${topics.join(' | ')}.`);
    return parts.join(' ');
  }

  clear() {
    this.messages = [];
    this.facts = {};
    this.save();
  }

  save() {
    if (!this.persist || !this.storage) return false;
    try {
      this.storage.setItem(LS_KEY, JSON.stringify({
        messages: [...this.pinnedMessages(), ...this.messages.slice(-120)]
          .filter((m, i, a) => a.indexOf(m) === i),
        facts: this.facts,
      }));
      return true;
    } catch { return false; }
  }

  load() {
    if (!this.storage) return false;
    try {
      const raw = this.storage.getItem(LS_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      this.messages = Array.isArray(data.messages) ? data.messages : [];
      this.facts = data.facts || {};
      return true;
    } catch { return false; }
  }

  export() {
    return this.messages.map(m => `[${new Date(m.t).toLocaleTimeString()}] ${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
  }
}

export default Memory;

/**
 * AURA :: Memory Manager
 * ----------------------
 * Four independent memory categories behind one manager:
 *
 *   A) ConversationMemory  — chat history + rolling context window
 *   B) PreferenceMemory    — user preferences, long-lived facts
 *   C) SystemStateMemory   — running apps, plugins, runtime status, devices
 *   D) KnowledgeMemory     — learned info, imported documents, vector search
 *
 * Each category owns its own storage namespace, so clearing chat history
 * cannot wipe preferences, and a knowledge import cannot evict conversation.
 *
 * The existing `js/ai/memory.js` (Memory class) still works untouched —
 * ConversationMemory wraps the same contract so the AI engine keeps running
 * while gaining the richer API.
 *
 * @module memory/memory-manager
 */

import { createStorage, InMemoryStorage, VectorStore } from './storage.js';

/* ══════════════════════════════════════════════════════════════════════
   A) CONVERSATION MEMORY
   ══════════════════════════════════════════════════════════════════════ */

export class ConversationMemory {
  /** @param {{storage?:object, maxTurns?:number, persist?:boolean}} opts */
  constructor({ storage = null, maxTurns = 20, persist = true } = {}) {
    this.storage = storage || createStorage('aura.mem.conv');
    this.maxTurns = maxTurns;
    this.persist = persist;
    /**
     * @type {Array<{role:string, content:string, t:number,
     *               pinned?:boolean, edited?:number}>}
     * `pinned` survives trimming and is always included in window();
     * `edited` records a manual change made from the Memory Center.
     */
    this.messages = [];
    this.sessionId = `s_${Date.now().toString(36)}`;
    this._loaded = false;
  }

  async load() {
    if (!this.persist) { this._loaded = true; return false; }
    const d = await this.storage.get('messages');
    if (Array.isArray(d)) this.messages = d;
    this._loaded = true;
    return this.messages.length > 0;
  }

  async _save() {
    if (!this.persist) return false;
    // Cap what we persist so storage can't grow without bound.
    return this.storage.set('messages', this.messages.slice(-160));
  }

  add(role, content) {
    if (content === undefined || content === null) return null;
    const m = { role, content: String(content), t: Date.now() };
    this.messages.push(m);
    this._save();
    return m;
  }
  addUser(c) { return this.add('user', c); }
  addAssistant(c) { return this.add('assistant', c); }

  updateLastAssistant(content) {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'assistant') {
        this.messages[i].content = content;
        this._save();
        return true;
      }
    }
    return false;
  }

  /** Rolling window suitable for a model prompt. */
  /**
   * The slice sent to the model: recent turns PLUS every pinned message,
   * in chronological order and de-duplicated.
   */
  window() {
    const recent = this.messages.slice(-this.maxTurns * 2);
    const pins = this.messages.filter(m => m.pinned && !recent.includes(m));
    // Pinned messages are prepended in chronological order so the model sees
    // them as earlier context, not as a sudden interjection.
    return [...pins, ...recent].map(({ role, content }) => ({ role, content }));
  }

  all() { return this.messages.slice(); }
  lastUser() { return [...this.messages].reverse().find(m => m.role === 'user') || null; }
  lastAssistant() { return [...this.messages].reverse().find(m => m.role === 'assistant') || null; }

  /** Topics that fell out of the window — surfaced so context isn't silently lost. */
  droppedTopics(limit = 6) {
    const dropped = this.messages.slice(0, Math.max(0, this.messages.length - this.maxTurns * 2));
    return dropped.filter(m => m.role === 'user').slice(-limit).map(m => m.content.slice(0, 60));
  }

  async clear() {
    this.messages = [];
    this.sessionId = `s_${Date.now().toString(36)}`;
    await this.storage.remove('messages');
    return true;
  }

  stats() {
    return {
      total: this.messages.length,
      user: this.messages.filter(m => m.role === 'user').length,
      assistant: this.messages.filter(m => m.role === 'assistant').length,
      windowTurns: this.maxTurns,
      sessionId: this.sessionId,
    };
  }

  export() {
    return this.messages
      .map(m => `[${new Date(m.t).toLocaleTimeString()}] ${m.role.toUpperCase()}: ${m.content}`)
      .join('\n\n');
  }

  /* ── editing (used by the Memory Center UI) ───────────────────────── */

  /**
   * Stable id for a message. Messages were only ever addressed by array
   * position, which breaks the moment trimming shifts them — so the id is
   * derived from the creation timestamp plus role.
   */
  static idOf(m) { return `${m.t}-${m.role}`; }

  find(id) { return this.messages.find(m => ConversationMemory.idOf(m) === id) || null; }

  /** Remove one message. @returns {Promise<boolean>} */
  async remove(id) {
    const i = this.messages.findIndex(m => ConversationMemory.idOf(m) === id);
    if (i < 0) return false;
    this.messages.splice(i, 1);
    await this._save();
    return true;
  }

  /** Edit a message's text in place. */
  async edit(id, content) {
    const m = this.find(id);
    if (!m) return false;
    m.content = String(content);
    m.edited = Date.now();
    await this._save();
    return true;
  }

  /**
   * Pin a message so trimming never drops it and it is always sent to the
   * model. This is what makes "remember this" durable across a long session.
   */
  async pin(id, on = true) {
    const m = this.find(id);
    if (!m) return false;
    if (on) m.pinned = true; else delete m.pinned;
    await this._save();
    return true;
  }

  pinned() { return this.messages.filter(m => m.pinned); }

  /** Case-insensitive substring search across the conversation. */
  search(q, { limit = 50 } = {}) {
    const needle = String(q || '').toLowerCase().trim();
    if (!needle) return this.messages.slice(-limit).reverse();
    return this.messages
      .filter(m => m.content.toLowerCase().includes(needle))
      .slice(-limit)
      .reverse();
  }
}

/* ══════════════════════════════════════════════════════════════════════
   B) USER PREFERENCE MEMORY
   ══════════════════════════════════════════════════════════════════════ */

export class PreferenceMemory {
  constructor({ storage = null } = {}) {
    this.storage = storage || createStorage('aura.mem.pref');
    /** @type {Record<string, {value:any, at:number, source:string, confidence:number}>} */
    this.prefs = {};
    this._loaded = false;
  }

  async load() {
    const d = await this.storage.get('prefs');
    if (d && typeof d === 'object') this.prefs = d;
    this._loaded = true;
    return Object.keys(this.prefs).length;
  }

  async _save() { return this.storage.set('prefs', this.prefs); }

  /**
   * @param {string} key
   * @param {*} value
   * @param {{source?:string, confidence?:number}} [meta]
   */
  async set(key, value, { source = 'user', confidence = 1 } = {}) {
    this.prefs[key] = { value, at: Date.now(), source, confidence };
    await this._save();
    return value;
  }

  get(key, fallback = null) {
    return this.prefs[key]?.value ?? fallback;
  }

  has(key) { return key in this.prefs; }

  async remove(key) { delete this.prefs[key]; await this._save(); return true; }

  all() {
    return Object.entries(this.prefs).map(([key, v]) => ({ key, ...v }));
  }

  /**
   * Which remembered preferences does THIS message actually touch?
   * Powers the "I remember…" confirmation: AURA only claims memory it
   * demonstrably used (value or key appears in the message), never a
   * broad "I remember 12 things" boast.
   * @param {string} text
   * @param {{minConfidence?:number}} [o]
   * @returns {Array<{key:*, value:*, score:number, confidence:number}>}
   */
  relevant(text, { minConfidence = 0.5 } = {}) {
    const q = String(text || '').toLowerCase();
    const qWords = new Set(q.match(/[a-z0-9]{4,}/g) || []);
    const normVal = (v) => String(v ?? '').toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    const keyWords = (k) => String(humanKey(k)).toLowerCase()
      .split(/\s+/).filter(w => w.length >= 4);
    const out = [];
    for (const p of this.all()) {
      if ((p.confidence ?? 0) < minConfidence) continue;
      const val = normVal(p.value);
      const valHit = val.split(/\s+/).some(w => w.length >= 4 && qWords.has(w));
      const keyHit = keyWords(p.key).some(w => qWords.has(w));
      const score = valHit && keyHit ? 1 : valHit ? 0.8 : keyHit ? 0.6 : 0;
      if (score > 0) out.push({ key: p.key, value: p.value, score, confidence: p.confidence });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  /**
   * Natural-language digest for the system prompt. Only high-confidence
   * entries, so a guess never becomes a stated fact.
   */
  summary({ minConfidence = 0.6 } = {}) {
    const rows = this.all()
      .filter(p => p.confidence >= minConfidence)
      .map(p => `${humanKey(p.key)}: ${formatValue(p.value)}`);
    return rows.length ? rows.join('; ') : '';
  }

  async clear() { this.prefs = {}; await this.storage.remove('prefs'); return true; }
  stats() { return { total: Object.keys(this.prefs).length }; }
}

function humanKey(k) {
  return ({ userName: "user's name", location: 'location', timezone: 'timezone',
            favouriteApp: 'favourite app', tone: 'preferred tone' })[k]
    || k.replace(/([A-Z])/g, ' $1').toLowerCase();
}
function formatValue(v) {
  if (Array.isArray(v)) return v.join(', ');
  if (v && typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/* ══════════════════════════════════════════════════════════════════════
   C) SYSTEM STATE MEMORY
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Volatile by design: this is a snapshot of *now*, not history. Persisting it
 * would make AURA claim an app is running after a reboot.
 */
export class SystemStateMemory {
  constructor({ bus = null } = {}) {
    this.bus = bus;
    this.state = {
      runningApps: [],      // [{id, name, startedAt}]
      activePlugins: [],
      devices: [],
      runtime: { backend: null, platform: null, simulated: true },
      lastAction: null,
      startedAt: Date.now(),
    };
    /** Bounded ring buffer of recent events for "what did you just do?" */
    this.events = [];
    this.eventLimit = 100;
  }

  set(patch) { Object.assign(this.state, patch); return this.state; }
  get(key) { return key ? this.state[key] : { ...this.state }; }

  noteAppLaunched(app) {
    if (!app?.id) return;
    this.state.runningApps = this.state.runningApps.filter(a => a.id !== app.id);
    this.state.runningApps.push({ id: app.id, name: app.name || app.id, startedAt: Date.now() });
    this.recordEvent('app-launched', { id: app.id, name: app.name });
  }

  noteAppClosed(appId) {
    this.state.runningApps = this.state.runningApps.filter(a => a.id !== appId);
    this.recordEvent('app-closed', { id: appId });
  }

  recordEvent(type, data = {}) {
    this.events.push({ type, data, t: Date.now() });
    if (this.events.length > this.eventLimit) this.events.shift();
    this.state.lastAction = { type, data, t: Date.now() };
  }

  recentEvents(n = 10) { return this.events.slice(-n).reverse(); }

  /** Context line for the AI so it knows the live machine state. */
  summary() {
    const s = this.state;
    const bits = [];
    if (s.runtime.backend) {
      bits.push(`Runtime: ${s.runtime.backend}${s.runtime.platform ? ` on ${s.runtime.platform}` : ''}${s.runtime.simulated ? ' (simulated)' : ''}`);
    }
    if (s.runningApps.length) bits.push(`Apps AURA launched this session: ${s.runningApps.map(a => a.name).join(', ')}`);
    if (s.activePlugins.length) bits.push(`${s.activePlugins.length} plugins active`);
    if (s.devices.length) bits.push(`Devices: ${s.devices.join(', ')}`);
    return bits.join('. ');
  }

  clear() {
    this.state.runningApps = [];
    this.events = [];
    this.state.lastAction = null;
    return true;
  }

  stats() {
    return {
      runningApps: this.state.runningApps.length,
      plugins: this.state.activePlugins.length,
      devices: this.state.devices.length,
      events: this.events.length,
      uptimeMs: Date.now() - this.state.startedAt,
    };
  }
}

/* ══════════════════════════════════════════════════════════════════════
   D) KNOWLEDGE MEMORY
   ══════════════════════════════════════════════════════════════════════ */

export class KnowledgeMemory {
  constructor({ storage = null, vectorStore = null } = {}) {
    this.storage = storage || createStorage('aura.mem.know');
    this.vectors = vectorStore || new VectorStore({ storage: new InMemoryStorage({ namespace: 'aura.vec' }) });
    this._loaded = false;
  }

  async load() {
    const docs = await this.storage.get('documents');
    if (Array.isArray(docs)) {
      for (const d of docs) await this.vectors.add(d);
    }
    this._loaded = true;
    return this.vectors.count();
  }

  async _persist() {
    const all = await this.vectors.all();
    return this.storage.set('documents',
      all.map(d => ({ id: d.id, text: d.text, metadata: d.metadata })));
  }

  /**
   * Teach AURA a fact or import a document.
   * @param {{id?:string, text:string, title?:string, source?:string, tags?:string[]}} doc
   */
  async learn(doc) {
    if (!doc?.text) throw new Error('Knowledge entry needs text');
    const id = doc.id || `k_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const rec = await this.vectors.add({
      id, text: doc.text,
      metadata: { title: doc.title || null, source: doc.source || 'user', tags: doc.tags || [], at: Date.now() },
    });
    await this._persist();
    return rec;
  }

  /** @returns {Promise<Array<{doc:object, score:number}>>} */
  async recall(query, opts) { return this.vectors.search(query, opts); }

  /** Formatted context block to inject into a prompt, or '' if nothing relevant. */
  async contextFor(query, { limit = 3, maxChars = 900 } = {}) {
    const hits = await this.recall(query, { limit });
    if (!hits.length) return '';
    let out = '', used = 0;
    for (const h of hits) {
      const title = h.doc.metadata?.title ? `${h.doc.metadata.title}: ` : '';
      const line = `- ${title}${h.doc.text.slice(0, 300)}`;
      if (used + line.length > maxChars) break;
      out += line + '\n'; used += line.length;
    }
    return out ? `Relevant stored knowledge:\n${out.trim()}` : '';
  }

  async forget(id) { const r = await this.vectors.remove(id); await this._persist(); return r; }
  async all() { return this.vectors.all(); }
  async clear() { await this.vectors.clear(); await this.storage.remove('documents'); return true; }
  async stats() {
    return { documents: await this.vectors.count(), backend: this.vectors.kind,
             embeddings: this.vectors.supportsEmbeddings };
  }
}

/* ══════════════════════════════════════════════════════════════════════
   E) EPISODIC MEMORY
   ══════════════════════════════════════════════════════════════════════ */

export class EpisodicMemory {
  constructor({ storage = null } = {}) {
    this.storage = storage || createStorage('nova.mem.episodes');
    /** @type {Array<{id:string, event:string, at:number, why:string, source:string}>} */
    this.episodes = [];
    this._loaded = false;
  }

  async load() {
    const d = await this.storage.get('episodes');
    if (Array.isArray(d)) this.episodes = d;
    this._loaded = true;
    return this.episodes.length;
  }

  async _save() { return this.storage.set('episodes', this.episodes.slice(-200)); }

  async record(event, { why = 'Important user interaction', source = 'cognitive-orchestrator' } = {}) {
    if (!event) return null;
    const ep = {
      id: `ep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      event: String(event),
      at: Date.now(),
      why,
      source,
    };
    this.episodes.push(ep);
    await this._save();
    return ep;
  }

  all() { return this.episodes.slice(); }

  async remove(id) {
    this.episodes = this.episodes.filter(e => e.id !== id);
    await this._save();
    return true;
  }

  async clear() { this.episodes = []; await this.storage.remove('episodes'); return true; }
  stats() { return { total: this.episodes.length }; }
}

/* ══════════════════════════════════════════════════════════════════════
   MANAGER
   ══════════════════════════════════════════════════════════════════════ */

export class MemoryManager {
  /** @param {{bus?:object, maxTurns?:number, persist?:boolean, storageFactory?:Function}} opts */
  constructor({ bus = null, maxTurns = 20, persist = true, storageFactory = createStorage } = {}) {
    this.bus = bus;
    this.conversation = new ConversationMemory({ storage: storageFactory('aura.mem.conv'), maxTurns, persist });
    this.preferences = new PreferenceMemory({ storage: storageFactory('aura.mem.pref') });
    this.system = new SystemStateMemory({ bus });
    this.knowledge = new KnowledgeMemory({ storage: storageFactory('aura.mem.know') });
    this.episodic = new EpisodicMemory({ storage: storageFactory('nova.mem.episodes') });
    this.initialized = false;
  }

  async initialize() {
    await this.conversation.load();
    await this.preferences.load();
    await this.knowledge.load();
    await this.episodic.load();
    this.initialized = true;
    this.bus?.emit('memory:ready', await this.stats());
    return this.stats();
  }

  /**
   * Determine if text is durable information worth remembering automatically
   */
  shouldRemember(text) {
    const raw = String(text || '').toLowerCase();
    return /\b(my name is|i like|i prefer|i live in|remember that|my favorite|i work at|my email is)\b/i.test(raw);
  }

  /**
   * Everything the AI needs, assembled in one call.
   * @param {string} query current user input, used for knowledge recall
   */
  async buildContext(query = '') {
    const parts = [];
    const prefs = this.preferences.summary();
    if (prefs) parts.push(`Known about the user — ${prefs}.`);

    const dropped = this.conversation.droppedTopics();
    if (dropped.length) parts.push(`Earlier this session the user asked about: ${dropped.join(' | ')}.`);

    const sys = this.system.summary();
    if (sys) parts.push(sys + '.');

    const ep = this.episodic.all().slice(-3);
    if (ep.length) parts.push(`Recent key events: ${ep.map(e => e.event).join('; ')}.`);

    if (query) {
      const k = await this.knowledge.contextFor(query);
      if (k) parts.push(k);
    }
    return parts.join('\n');
  }

  async stats() {
    return {
      conversation: this.conversation.stats(),
      preferences: this.preferences.stats(),
      system: this.system.stats(),
      knowledge: await this.knowledge.stats(),
      episodic: this.episodic.stats(),
    };
  }

  /** @param {'conversation'|'preferences'|'system'|'knowledge'|'episodic'|'all'} scope */
  async clear(scope = 'conversation') {
    if (scope === 'all') {
      await this.conversation.clear();
      await this.preferences.clear();
      this.system.clear();
      await this.knowledge.clear();
      await this.episodic.clear();
    } else {
      await this[scope]?.clear();
    }
    this.bus?.emit('memory:cleared', { scope });
    return true;
  }
}

export default MemoryManager;

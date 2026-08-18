/**
 * AURA :: Memory Storage Abstraction
 * ----------------------------------
 * Storage is an interface, not an assumption. Today we ship localStorage and
 * in-memory providers; tomorrow the same interface backs IndexedDB, SQLite in
 * the native companion, or a vector database — with no changes to callers.
 *
 * Deliberately async everywhere, even for synchronous backends, so swapping
 * in a real database later never forces a caller rewrite.
 *
 * @module memory/storage
 */

/**
 * @typedef {Object} StorageProvider
 * @property {(k:string)=>Promise<any>}            get
 * @property {(k:string,v:any)=>Promise<boolean>}  set
 * @property {(k:string)=>Promise<boolean>}        remove
 * @property {(prefix?:string)=>Promise<string[]>} keys
 * @property {()=>Promise<boolean>}                clear
 */

/** Base contract. Subclasses override the five primitives. */
export class MemoryStorage {
  constructor({ namespace = 'aura' } = {}) {
    this.namespace = namespace;
    this.kind = 'abstract';
  }
  _k(key) { return `${this.namespace}.${key}`; }
  /** @param {string} _key @returns {Promise<any>} */
  async get(_key) { throw new Error('get() not implemented'); }
  /** @param {string} _key @param {any} _value @returns {Promise<boolean>} */
  async set(_key, _value) { throw new Error('set() not implemented'); }
  /** @param {string} _key @returns {Promise<boolean>} */
  async remove(_key) { throw new Error('remove() not implemented'); }
  async keys(_prefix = '') { return []; }
  async clear() { return false; }
  async size() { return (await this.keys()).length; }
}

/** Always works — used in Node tests and as the fallback when storage is blocked. */
export class InMemoryStorage extends MemoryStorage {
  constructor(opts = {}) { super(opts); this.kind = 'memory'; this.map = new Map(); }
  async get(key) { return this.map.has(this._k(key)) ? this.map.get(this._k(key)) : null; }
  async set(key, value) { this.map.set(this._k(key), value); return true; }
  async remove(key) { return this.map.delete(this._k(key)); }
  async keys(prefix = '') {
    const p = this._k(prefix);
    return Array.from(this.map.keys()).filter(k => k.startsWith(p))
      .map(k => k.slice(this.namespace.length + 1));
  }
  async clear() { this.map.clear(); return true; }
}

/** Browser default. Degrades to in-memory when localStorage is unavailable. */
export class LocalStorageProvider extends MemoryStorage {
  constructor(opts = {}) {
    super(opts);
    this.kind = 'localStorage';
    this.fallback = null;
    if (!this._usable()) {
      this.fallback = new InMemoryStorage(opts);
      this.kind = 'localStorage(unavailable→memory)';
    }
  }

  _usable() {
    try {
      if (typeof localStorage === 'undefined') return false;
      const t = '__aura_probe__';
      localStorage.setItem(t, '1'); localStorage.removeItem(t);
      return true;
    } catch { return false; }
  }

  async get(key) {
    if (this.fallback) return this.fallback.get(key);
    try {
      const raw = localStorage.getItem(this._k(key));
      return raw === null ? null : JSON.parse(raw);
    } catch { return null; }
  }

  async set(key, value) {
    if (this.fallback) return this.fallback.set(key, value);
    try { localStorage.setItem(this._k(key), JSON.stringify(value)); return true; }
    catch (e) {
      // QuotaExceeded is the realistic failure here — report it, don't crash.
      console.warn('[memory] localStorage write failed', e?.name);
      return false;
    }
  }

  async remove(key) {
    if (this.fallback) return this.fallback.remove(key);
    try { localStorage.removeItem(this._k(key)); return true; } catch { return false; }
  }

  async keys(prefix = '') {
    if (this.fallback) return this.fallback.keys(prefix);
    const p = this._k(prefix);
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(p)) out.push(k.slice(this.namespace.length + 1));
      }
    } catch {}
    return out;
  }

  async clear() {
    if (this.fallback) return this.fallback.clear();
    for (const k of await this.keys()) await this.remove(k);
    return true;
  }
}

/**
 * IndexedDB provider — the growth path for large stores (documents, embeddings)
 * that would blow localStorage's ~5 MB budget.
 *
 * TODO(local): implement using the `idb` pattern:
 *   openDB('aura', 1, { upgrade(db){ db.createObjectStore('memory'); } })
 * Falls back to localStorage until then, so nothing breaks today.
 */
export class IndexedDBStorage extends MemoryStorage {
  constructor(opts = {}) {
    super(opts);
    this.kind = 'indexeddb(pending→localStorage)';
    this.delegate = new LocalStorageProvider(opts);
  }
  static get available() { return typeof indexedDB !== 'undefined'; }
  async get(k) { return this.delegate.get(k); }
  async set(k, v) { return this.delegate.set(k, v); }
  async remove(k) { return this.delegate.remove(k); }
  async keys(p) { return this.delegate.keys(p); }
  async clear() { return this.delegate.clear(); }
}

/**
 * Vector store interface for semantic recall.
 * The knowledge layer programs against THIS, so swapping in a real embedding
 * backend later is a one-line provider change.
 *
 * SEMANTIC RECALL IS NOW REAL. When Ollama has an embedding model installed
 * (nomic-embed-text, mxbai-embed-large, all-minilm…) documents are embedded
 * through `/api/embeddings` and searched by cosine similarity — so "how do I
 * make the assistant faster" can find a note about "reducing model latency"
 * with no shared keywords.
 *
 * Without an embedding model it falls back to the original keyword/TF
 * overlap, and `kind` reports which one is actually in use. It never claims
 * semantic search it isn't doing.
 *
 * TODO(local): sqlite-vec / LanceDB in the native companion would remove the
 *   O(n) scan; fine for the thousands of notes a personal store holds.
 */
export class VectorStore {
  /**
   * @param {{storage?:object, embedUrl?:string, embedModel?:string,
   *          fetchImpl?:Function}} [opts]
   */
  constructor({ storage = null, embedUrl = '/api/ollama/embeddings',
                embedModel = null, fetchImpl = null } = {}) {
    this.storage = storage || new InMemoryStorage({ namespace: 'aura.vec' });
    this.kind = 'keyword-fallback';
    this.supportsEmbeddings = false;
    this.embedUrl = embedUrl;
    this.embedModel = embedModel;          // resolved on first use
    this._fetch = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    this._probed = false;
    /** Cache: identical text embeds to the same vector, so never twice. */
    this._cache = new Map();
  }

  /** Model names that are embedding models rather than chat models. */
  static isEmbeddingModel(name) {
    return /embed|nomic-embed|mxbai|bge-|gte-|all-minilm|e5-/i.test(String(name || ''));
  }

  /**
   * Find an embedding model in Ollama. Runs once; result is cached.
   * @returns {Promise<string|null>}
   */
  async _resolveModel() {
    if (this._probed) return this.embedModel;
    this._probed = true;
    if (this.embedModel) { this.supportsEmbeddings = true; this.kind = 'ollama-embeddings'; return this.embedModel; }
    if (!this._fetch) return null;
    try {
      const r = await this._fetch('/api/ollama/status', { cache: 'no-store' });
      const j = await r.json();
      if (!j.running) return null;
      const names = j.names || (j.models || []).map(m => m.name);
      const hit = names.find(n => VectorStore.isEmbeddingModel(n));
      if (hit) {
        this.embedModel = hit;
        this.supportsEmbeddings = true;
        this.kind = 'ollama-embeddings';
      }
      return hit || null;
    } catch { return null; }
  }

  /**
   * Embed one string. Returns null when no embedding model is available,
   * which is the signal to fall back to keyword search.
   * @returns {Promise<number[]|null>}
   */
  async embed(text) {
    const key = String(text || '').slice(0, 500);
    if (this._cache.has(key)) return this._cache.get(key);
    const model = await this._resolveModel();
    if (!model || !this._fetch) return null;
    try {
      const r = await this._fetch(this.embedUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: String(text || '') }),
      });
      if (!r.ok) return null;
      const j = await r.json();
      const v = j.embedding || j.embeddings?.[0] || null;
      if (!Array.isArray(v) || !v.length) return null;
      if (this._cache.size > 200) this._cache.clear();   // bounded
      this._cache.set(key, v);
      return v;
    } catch { return null; }
  }

  /** Cosine similarity between two vectors, 0..1. */
  static cosine(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    if (na <= 0 || nb <= 0) return 0;
    return Math.max(0, Math.min(1, dot / (Math.sqrt(na) * Math.sqrt(nb))));
  }

  /**
   * @param {{id:string, text:string, metadata?:object}} doc
   */
  async add(doc) {
    if (!doc?.id || !doc?.text) throw new Error('Vector doc needs id and text');
    const rec = {
      id: doc.id, text: doc.text, metadata: doc.metadata || {},
      tokens: tokenize(doc.text), addedAt: Date.now(),
      // Real embedding when a model is available; null falls back to keywords.
      embedding: await this.embed(doc.text),
    };
    await this.storage.set(`doc.${doc.id}`, rec);
    return rec;
  }

  async remove(id) { return this.storage.remove(`doc.${id}`); }

  async all() {
    const keys = await this.storage.keys('doc.');
    const out = [];
    for (const k of keys) { const d = await this.storage.get(k); if (d) out.push(d); }
    return out;
  }

  /**
   * Similarity search. Uses TF-style keyword overlap today; the signature is
   * already the one a real embedding search would use.
   * @returns {Promise<Array<{doc:object, score:number}>>}
   */
  async search(query, { limit = 5, minScore = 0.05 } = {}) {
    const docs = await this.all();
    if (!docs.length) return [];

    // ── semantic path ────────────────────────────────────────────────
    const qv = await this.embed(query);
    if (qv) {
      const embedded = docs.filter(d => Array.isArray(d.embedding) && d.embedding.length === qv.length);
      if (embedded.length) {
        const scored = embedded
          .map(d => ({ doc: d, score: VectorStore.cosine(qv, d.embedding) }))
          // Cosine on sentence embeddings sits high for anything related, so
          // the floor is higher than the keyword path's.
          .filter(x => x.score >= Math.max(minScore, 0.55))
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
        if (scored.length) return scored;
        // Nothing cleared the bar — fall through rather than return nothing.
      }
    }

    // ── keyword fallback ─────────────────────────────────────────────
    const q = tokenize(query);
    if (!q.length) return [];
    const qs = new Set(q);
    const scored = docs.map(d => {
      const ds = new Set(d.tokens);
      let overlap = 0;
      for (const t of qs) if (ds.has(t)) overlap++;
      // Jaccard-ish, normalised by query length so short queries still rank.
      const score = overlap / Math.sqrt(qs.size * Math.max(1, ds.size)) * (overlap / qs.size);
      return { doc: d, score };
    }).filter(x => x.score >= minScore);
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async count() { return (await this.storage.keys('doc.')).length; }
  async clear() { for (const k of await this.storage.keys('doc.')) await this.storage.remove(k); return true; }
}

const STOP = new Set(['the','a','an','is','are','was','were','of','to','in','on','for','and','or','it','this','that','with','as','at','by','be','from','what','how','why','when']);

/** @param {string} text @returns {string[]} */
export function tokenize(text) {
  return String(text || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w));
}

/** Pick the best storage available in this environment. */
export function createStorage(namespace = 'aura.mem') {
  if (typeof localStorage !== 'undefined') return new LocalStorageProvider({ namespace });
  return new InMemoryStorage({ namespace });
}

export default { MemoryStorage, InMemoryStorage, LocalStorageProvider, IndexedDBStorage, VectorStore, createStorage, tokenize };

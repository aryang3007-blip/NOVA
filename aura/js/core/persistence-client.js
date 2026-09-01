/**
 * AURA :: Persistence Client
 * --------------------------
 * Asynchronous frontend client for AURA's local SQLite persistence layer.
 * Communicates with backend /api/db/* routes with seamless in-memory fallback
 * when running standalone or in Node unit tests.
 */

export class PersistenceClient {
  constructor({ baseUrl = '', fetchImpl = null } = {}) {
    this.baseUrl = baseUrl;
    this._fetch = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    this._available = null;
    this._memCache = new Map();
  }

  async isAvailable() {
    if (!this._fetch) return false;
    if (this._available !== null) return this._available;
    try {
      const res = await this._fetch(`${this.baseUrl}/api/db/status`, { cache: 'no-store' });
      this._available = res.ok;
    } catch {
      this._available = false;
    }
    return this._available;
  }

  /* ── CONFIG ───────────────────────────────────────────────────────── */

  async loadConfig() {
    if (!await this.isAvailable()) return null;
    try {
      const res = await this._fetch(`${this.baseUrl}/api/db/config`, { cache: 'no-store' });
      if (!res.ok) return null;
      const data = await res.json();
      return data.config || null;
    } catch {
      return null;
    }
  }

  async saveConfig(configObj) {
    if (!await this.isAvailable()) return false;
    try {
      const res = await this._fetch(`${this.baseUrl}/api/db/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: configObj }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /* ── VAULT (CREDENTIALS) ──────────────────────────────────────────── */

  async saveCredential(provider, key, profile = null) {
    if (!await this.isAvailable()) return false;
    try {
      const res = await this._fetch(`${this.baseUrl}/api/db/vault`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profile ? { provider, key, profile } : { provider, key }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async getVaultStatus() {
    if (!await this.isAvailable()) return {};
    try {
      const res = await this._fetch(`${this.baseUrl}/api/db/vault`, { cache: 'no-store' });
      if (!res.ok) return {};
      const data = await res.json();
      return data.providers || {};
    } catch {
      return {};
    }
  }

  /**
   * Metadata for every stored key profile ({ profile: { provider: meta } }).
   * Never contains plaintext — used to offer "import keys from which
   * profile?" when a fresh browser session has no keys of its own.
   */
  async getVaultProfiles() {
    if (!await this.isAvailable()) return {};
    try {
      const res = await this._fetch(`${this.baseUrl}/api/db/vault/profiles`, { cache: 'no-store' });
      if (!res.ok) return {};
      const data = await res.json();
      return data.profiles || {};
    } catch {
      return {};
    }
  }

  /**
   * Explicit import: fetch the PLAINTEXT keys of one profile so config can
   * repopulate a fresh browser session. Localhost-only, owner-initiated.
   */
  async revealCredentials({ profile = null, provider = null } = {}) {
    if (!await this.isAvailable()) return null;
    try {
      const qs = new URLSearchParams();
      if (profile) qs.set('profile', profile);
      if (provider) qs.set('provider', provider);
      const res = await this._fetch(`${this.baseUrl}/api/db/vault/reveal?${qs}`, { cache: 'no-store' });
      if (!res.ok) return null;
      const data = await res.json();
      return data.keys || null;
    } catch {
      return null;
    }
  }

  /* ── CONVERSATION MEMORY ──────────────────────────────────────────── */

  async getMessages(sessionId = 'default', limit = 160) {
    if (!await this.isAvailable()) return null;
    try {
      const res = await this._fetch(`${this.baseUrl}/api/db/memory/conversation?session=${encodeURIComponent(sessionId)}&limit=${limit}`, { cache: 'no-store' });
      if (!res.ok) return null;
      const data = await res.json();
      return data.messages || [];
    } catch {
      return null;
    }
  }

  async addMessage({ role, content, sessionId = 'default', pinned = false, id = null }) {
    if (!await this.isAvailable()) return null;
    try {
      const res = await this._fetch(`${this.baseUrl}/api/db/memory/conversation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, content, sessionId, pinned, id }),
      });
      if (!res.ok) return null;
      return (await res.json()).message || null;
    } catch {
      return null;
    }
  }

  async pinMessage(id, pinned = true) {
    if (!await this.isAvailable()) return false;
    try {
      const res = await this._fetch(`${this.baseUrl}/api/db/memory/conversation/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, pinned }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async editMessage(id, content) {
    if (!await this.isAvailable()) return false;
    try {
      const res = await this._fetch(`${this.baseUrl}/api/db/memory/conversation/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, content }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async deleteMessage(id) {
    if (!await this.isAvailable()) return false;
    try {
      const res = await this._fetch(`${this.baseUrl}/api/db/memory/conversation?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async clearConversation(sessionId = null) {
    if (!await this.isAvailable()) return false;
    try {
      const url = sessionId
        ? `${this.baseUrl}/api/db/memory/conversation?session=${encodeURIComponent(sessionId)}`
        : `${this.baseUrl}/api/db/memory/conversation`;
      const res = await this._fetch(url, { method: 'DELETE' });
      return res.ok;
    } catch {
      return false;
    }
  }

  /* ── USER PREFERENCES ────────────────────────────────────────────── */

  async getPreferences() {
    if (!await this.isAvailable()) return null;
    try {
      const res = await this._fetch(`${this.baseUrl}/api/db/memory/preferences`, { cache: 'no-store' });
      if (!res.ok) return null;
      return (await res.json()).preferences || {};
    } catch {
      return null;
    }
  }

  async setPreference(key, value, { source = 'user', confidence = 1.0 } = {}) {
    if (!await this.isAvailable()) return false;
    try {
      const res = await this._fetch(`${this.baseUrl}/api/db/memory/preferences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value, source, confidence }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /* ── KNOWLEDGE & VECTOR RECALL ────────────────────────────────────── */

  async getKnowledgeDocs() {
    if (!await this.isAvailable()) return null;
    try {
      const res = await this._fetch(`${this.baseUrl}/api/db/memory/knowledge`, { cache: 'no-store' });
      if (!res.ok) return null;
      return (await res.json()).documents || [];
    } catch {
      return null;
    }
  }

  async addKnowledgeDoc(doc) {
    if (!await this.isAvailable()) return null;
    try {
      const res = await this._fetch(`${this.baseUrl}/api/db/memory/knowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(doc),
      });
      if (!res.ok) return null;
      return (await res.json()).document || null;
    } catch {
      return null;
    }
  }

  async recallKnowledge(query, { queryVector = null, limit = 5, minScore = 0.05 } = {}) {
    if (!await this.isAvailable()) return [];
    try {
      const res = await this._fetch(`${this.baseUrl}/api/db/memory/recall`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, queryVector, limit, minScore }),
      });
      if (!res.ok) return [];
      return (await res.json()).results || [];
    } catch {
      return [];
    }
  }

  async deleteKnowledgeDoc(id) {
    if (!await this.isAvailable()) return false;
    try {
      const res = await this._fetch(`${this.baseUrl}/api/db/memory/knowledge?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /* ── PERMISSIONS ─────────────────────────────────────────────────── */

  async getPermissions() {
    if (!await this.isAvailable()) return null;
    try {
      const res = await this._fetch(`${this.baseUrl}/api/db/permissions`, { cache: 'no-store' });
      if (!res.ok) return null;
      return (await res.json()).permissions || {};
    } catch {
      return null;
    }
  }

  async setPermission(id, granted, source = 'user') {
    if (!await this.isAvailable()) return false;
    try {
      const res = await this._fetch(`${this.baseUrl}/api/db/permissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, granted, source }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /* ── APPS ─────────────────────────────────────────────────────────── */

  async getApps() {
    if (!await this.isAvailable()) return null;
    try {
      const res = await this._fetch(`${this.baseUrl}/api/db/apps`, { cache: 'no-store' });
      if (!res.ok) return null;
      return (await res.json()).apps || [];
    } catch {
      return null;
    }
  }

  async saveApp(app) {
    if (!await this.isAvailable()) return false;
    try {
      const res = await this._fetch(`${this.baseUrl}/api/db/apps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(app),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async recordAppLaunch(id) {
    if (!await this.isAvailable()) return false;
    try {
      const res = await this._fetch(`${this.baseUrl}/api/db/apps/launch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /* ── MIGRATION IMPORTER ───────────────────────────────────────────── */

  async importLocalStorageDump(dump) {
    if (!await this.isAvailable()) return { ok: false, message: 'Database offline' };
    try {
      const res = await this._fetch(`${this.baseUrl}/api/db/migrate/import-client`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storage: dump }),
      });
      if (!res.ok) return { ok: false };
      return await res.json();
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
}

export const persistenceClient = new PersistenceClient();
export default persistenceClient;

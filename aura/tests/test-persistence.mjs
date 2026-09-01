/**
 * AURA :: Frontend Persistence & Storage Integration Tests (Node, no browser).
 * Tests DatabaseStorageProvider, PersistenceClient, MemoryManager, and Config integration.
 */

import { DatabaseStorageProvider, LocalStorageProvider, InMemoryStorage, createStorage } from '../js/memory/storage.js';
import { PersistenceClient } from '../js/core/persistence-client.js';
import { MemoryManager, ConversationMemory, PreferenceMemory, KnowledgeMemory } from '../js/memory/memory-manager.js';
import { Config, DEFAULTS } from '../js/core/config.js';

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, x = '') => {
  if (c) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${n}`);
  } else {
    fail++;
    fails.push(n);
    console.log(`  \x1b[31m✗ ${n}\x1b[0m ${x}`);
  }
};
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), `got=${JSON.stringify(a)} want=${JSON.stringify(b)}`);
const sec = t => console.log(`\n\x1b[36m▸ ${t}\x1b[0m`);

async function run() {
  sec('DatabaseStorageProvider Fallback');
  {
    const st = new DatabaseStorageProvider({ namespace: 'test.mem' });
    ok('instantiates with fallback', st.kind.startsWith('sqlite'));
    await st.set('hello', { foo: 'bar' });
    const v = await st.get('hello');
    eq('get matches set value via fallback', v, { foo: 'bar' });
    await st.remove('hello');
    const v2 = await st.get('hello');
    eq('removed key returns null', v2, null);
  }

  sec('Storage Factory (createStorage)');
  {
    const st = createStorage('aura.mem');
    ok('createStorage creates valid storage provider', typeof st.get === 'function' && typeof st.set === 'function');
  }

  sec('PersistenceClient with Mock Server');
  {
    const mockStore = new Map();
    const fakeFetch = async (url, opts = {}) => {
      const u = new URL(url, 'http://localhost');
      const p = u.pathname;
      const method = (opts.method || 'GET').toUpperCase();

      if (p === '/api/db/status') {
        return { ok: true, json: async () => ({ ok: true, isLocal: true }) };
      }
      if (p === '/api/db/config') {
        if (method === 'GET') {
          return { ok: true, json: async () => ({ ok: true, config: mockStore.get('config') || {} }) };
        }
        if (method === 'POST') {
          const body = JSON.parse(opts.body || '{}');
          mockStore.set('config', body.config);
          return { ok: true, json: async () => ({ ok: true }) };
        }
      }
      if (p === '/api/db/vault') {
        if (method === 'POST') {
          const body = JSON.parse(opts.body || '{}');
          mockStore.set(`vault_${body.provider}`, body.key);
          return { ok: true, json: async () => ({ ok: true }) };
        }
        if (method === 'GET') {
          return { ok: true, json: async () => ({ ok: true, providers: { openai: { hasKey: true } } }) };
        }
      }
      if (p === '/api/db/memory/conversation') {
        if (method === 'GET') {
          return { ok: true, json: async () => ({ ok: true, messages: mockStore.get('conv') || [] }) };
        }
        if (method === 'POST') {
          const body = JSON.parse(opts.body || '{}');
          const list = mockStore.get('conv') || [];
          list.push(body);
          mockStore.set('conv', list);
          return { ok: true, json: async () => ({ ok: true, message: body }) };
        }
      }
      if (p === '/api/db/memory/preferences') {
        if (method === 'GET') {
          return { ok: true, json: async () => ({ ok: true, preferences: mockStore.get('prefs') || {} }) };
        }
        if (method === 'POST') {
          const body = JSON.parse(opts.body || '{}');
          const m = mockStore.get('prefs') || {};
          m[body.key] = { value: body.value, confidence: body.confidence };
          mockStore.set('prefs', m);
          return { ok: true, json: async () => ({ ok: true }) };
        }
      }
      return { ok: false, status: 404 };
    };

    const client = new PersistenceClient({ fetchImpl: fakeFetch });
    ok('isAvailable returns true', await client.isAvailable());

    // Config save and load
    await client.saveConfig({ theme: 'aura-dark' });
    const cfg = await client.loadConfig();
    eq('config saved and loaded', cfg?.theme, 'aura-dark');

    // Credential vault
    const savedKey = await client.saveCredential('openai', 'sk-mock-key-999');
    ok('saveCredential succeeds', savedKey);

    // Conversation messages
    const m = await client.addMessage({ role: 'user', content: 'Testing persistence client' });
    ok('addMessage returns message', m?.content === 'Testing persistence client');
    const msgs = await client.getMessages();
    eq('getMessages returns recorded turns', msgs?.length, 1);

    // Preferences
    await client.setPreference('favColor', 'gold', { confidence: 0.95 });
    const prefs = await client.getPreferences();
    eq('preferences saved and returned', prefs?.favColor?.value, 'gold');
  }

  sec('MemoryManager Integration with Repositories');
  {
    const mm = new MemoryManager({ storageFactory: (ns) => new InMemoryStorage({ namespace: ns }) });
    await mm.initialize();
    ok('MemoryManager initializes all memory categories', mm.initialized);

    mm.conversation.add('user', 'What is AURA?');
    mm.conversation.add('assistant', 'AURA is your local-first AI companion.');
    eq('conversation has 2 messages', mm.conversation.all().length, 2);

    await mm.preferences.set('location', 'New Delhi', { confidence: 1.0 });
    eq('preference set', mm.preferences.get('location'), 'New Delhi');

    await mm.knowledge.learn({ id: 'k1', text: 'AURA runs 100% offline with local Ollama models.' });
    const kDocs = await mm.knowledge.all();
    eq('knowledge doc learned', kDocs.length, 1);

    const ctx = await mm.buildContext('offline');
    ok('buildContext includes preferences and knowledge', ctx.includes('location') && ctx.includes('offline'));
  }

  sec('Config Class Sync & Export');
  {
    const c = new Config();
    c.set('assistantName', 'NOVA Core');
    eq('config getter matches set', c.get('assistantName'), 'NOVA Core');

    c.setKey('anthropic', 'sk-ant-test-key-1234');
    eq('getKey retrieves key', c.getKey('anthropic'), 'sk-ant-test-key-1234');

    const exported = c.export();
    eq('exported config redacts API keys', exported.apiKeys.anthropic, '***redacted***');
  }

  console.log('\n────────────────────────────────────────────────────────');
  console.log(`  PASS ${pass}   FAIL ${fail}`);
  if (fail > 0) {
    console.error('FAILURES:', fails);
    process.exit(1);
  } else {
    console.log('  ALL PERSISTENCE FRONTEND TESTS PASSED\n');
  }
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});

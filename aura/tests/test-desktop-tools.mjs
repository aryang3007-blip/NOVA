/**
 * AURA :: desktop tools + intelligent app fallback
 * ------------------------------------------------
 * Covers the plugin work requested after real use:
 *   • custom application management (add / edit / alias / remove)
 *   • AI-reasoned fallback when an app isn't installed
 *   • the security boundary around that reasoning
 *
 * The security point that matters: the model may only ever propose a URL,
 * and that URL is validated before anything happens. A hallucinated or
 * hostile reply cannot launch, write, or execute.
 */

import { AppDatabase, slugifyId, normaliseAliases } from '../js/desktop/app-database.js';
import { AppLauncher, WEB_EQUIVALENTS } from '../js/desktop/app-launcher.js';

let pass = 0, fail = 0;
const chk = (n, c, d = '') => {
  c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${n}`))
    : (fail++, console.log(`  \x1b[31m✗\x1b[0m ${n} ${d}`));
};

const realFetch = globalThis.fetch;
const noOllama = () => { globalThis.fetch = async () => { throw new Error('offline'); }; };
function mockOllama(reply) {
  globalThis.fetch = async (u) => {
    if (String(u).includes('/status')) return { json: async () => ({ running: true, names: ['gemma2:2b'] }) };
    return { text: async () => JSON.stringify({ message: { content: reply } }) + '\n' };
  };
}

console.log('\n  CUSTOM APPLICATION MANAGEMENT\n');
{
  const db = new AppDatabase({ storage: null });
  db.seedMock();
  const before = db.size;

  const app = db.addCustom({ id: 'My Editor!', name: 'My Editor', aliases: ['ed', 'editor'] });
  chk('id is slugified', app.id === 'my-editor', app.id);
  chk('app is added', db.size === before + 1);
  chk('name is always an alias', app.aliases.includes('my editor'), app.aliases.join(','));
  chk('resolves by custom alias', db.resolve('ed')?.id === 'my-editor');
  chk('marked as user-created', app.source === 'user');

  const up = db.update('my-editor', { name: 'Renamed', aliases: 'alpha, beta' });
  chk('update succeeds', up.ok);
  chk('aliases accept a comma string', db.get('my-editor').aliases.includes('beta'));
  chk('resolves by the new alias', db.resolve('alpha')?.id === 'my-editor');

  chk('rejects a javascript: web fallback',
      !db.update('my-editor', { webFallback: 'javascript:alert(1)' }).ok);
  chk('rejects a data: web fallback',
      !db.update('my-editor', { webFallback: 'data:text/html,x' }).ok);
  chk('accepts a real https fallback',
      db.update('my-editor', { webFallback: 'https://example.com' }).ok);
  chk('unknown id is reported', !db.update('nope', { name: 'x' }).ok);

  chk('protected fields cannot be injected',
      (db.update('my-editor', { source: 'builtin', launchCount: 9999 }),
       db.get('my-editor').launchCount !== 9999));

  chk('remove works', db.remove('my-editor') && !db.get('my-editor'));
}

console.log('\n  HELPERS\n');
chk('slugify strips punctuation', slugifyId('  My  App!! ') === 'my-app');
chk('slugify never returns empty', slugifyId('!!!') === 'app');
chk('aliases de-duplicate', normaliseAliases(['a', 'A', 'a'], 'a').length === 1);
chk('aliases are capped', normaliseAliases(Array.from({ length: 40 }, (_, i) => `a${i}`), 'x').length <= 12);

console.log('\n  OFFLINE SYSTEM-CORE REASONING (no Ollama)\n');
{
  noOllama();
  const db = new AppDatabase({ storage: null }); db.seedMock();
  const l = new AppLauncher({ db, bridge: null }); l.ready = true;

  const wa = await l.reasonFallback('whatsapp');
  chk('whatsapp → web.whatsapp.com', wa.url === 'https://web.whatsapp.com', wa.url);
  chk('answered by the offline core', wa.by === 'system core');

  const sp = await l.reasonFallback('spotify');
  chk('spotify → open.spotify.com', sp.url === 'https://open.spotify.com');
  const dc = await l.reasonFallback('discord');
  chk('discord → discord.com/app', dc.url === 'https://discord.com/app');

  const unknown = await l.reasonFallback('TotallyMadeUpApp');
  chk('unknown app still gets a suggestion', unknown.action === 'suggest');
  chk('suggestion explains itself', /isn't installed/.test(unknown.message || ''));
  chk('every catalogue entry is https',
      Object.values(WEB_EQUIVALENTS).every(v => v.url.startsWith('https://')));
}

console.log('\n  OLLAMA REASONING + ITS SAFETY BOUNDARY\n');
{
  const db = new AppDatabase({ storage: null }); db.seedMock();
  const l = new AppLauncher({ db, bridge: null }); l.ready = true;

  mockOllama('{"action":"open_web","url":"https://obsidian.md","label":"Obsidian"}');
  let r = await l.reasonFallback('Obsidian');
  chk('valid model answer is used', r.action === 'open_web' && /obsidian\.md/.test(r.url));
  chk('attribution names the model', /^ollama:/.test(r.by), r.by);

  mockOllama('Sure!\n```json\n{"action":"open_web","url":"https://slack.com"}\n```');
  r = await l.reasonFallback('SomeChatApp');
  chk('JSON is extracted from markdown', r.action === 'open_web' && /slack\.com/.test(r.url));

  // Hostile / malformed replies must NEVER produce an action.
  for (const [label, reply] of [
    ['javascript:', '{"action":"open_web","url":"javascript:alert(1)"}'],
    ['data:',       '{"action":"open_web","url":"data:text/html,<script>"}'],
    ['file:',       '{"action":"open_web","url":"file:///etc/passwd"}'],
    ['credentials', '{"action":"open_web","url":"https://user:pw@evil.com"}'],
    ['prose',       'I think you should just google it'],
    ['action none', '{"action":"none"}'],
    ['wrong action','{"action":"run_command","target":"rm -rf /"}'],
    ['empty',       ''],
  ]) {
    mockOllama(reply);
    const bad = await l.reasonFallback('UnknownThing');
    chk(`rejects ${label}`, bad.by === 'system core' && bad.action !== 'open_web',
        `${bad.action} ${bad.url || ''} ${bad.by}`);
  }

  // A known app must not even consult the model.
  let asked = false;
  globalThis.fetch = async (u) => {
    asked = true;
    if (String(u).includes('/status')) return { json: async () => ({ running: true, names: ['m'] }) };
    return { text: async () => '{}' };
  };
  await l.reasonFallback('whatsapp');
  chk('known apps skip the model entirely (fast path)', asked === false);
}

globalThis.fetch = realFetch;
console.log(`\n  PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);

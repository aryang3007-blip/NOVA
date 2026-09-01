/**
 * NOVA :: memory confirmation tests
 * =================================
 * The "I remember…" feature must be honest: AURA claims memory only for
 * prefs the current message demonstrably touches, and never repeats a
 * low-confidence guess as a fact.
 *
 *   node tests/test-memory-recall.mjs
 */
import { PreferenceMemory } from '../js/memory/memory-manager.js';

let P = 0, F = 0;
const ok = (n, c, d = '') => {
  if (c) { P++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { F++; console.log(`  \x1b[31m✗\x1b[0m ${n}${d ? `  \x1b[90m${d}\x1b[0m` : ''}`); }
};
const S = (t) => console.log(`\n\x1b[36m▸ ${t}\x1b[0m`);

function mem(prefs) {
  const storage = { data: {}, get: async (k) => storage.data[k], set: async (k, v) => { storage.data[k] = v; }, remove: async (k) => { delete storage.data[k]; } };
  const m = new PreferenceMemory({ storage });
  m._loaded = true;
  for (const [key, value, confidence = 1] of prefs) m.prefs[key] = { value, at: 1, source: 'user', confidence };
  return m;
}

S('VALUE MATCH — "my name is Aryan" recalls userName');
{
  const m = mem([['userName', 'Aryan']]);
  const h = m.relevant('my name is Aryan');
  ok('exactly one hit', h.length === 1, `${h.length}`);
  ok('hit is userName', h[0].key === 'userName');
  ok('strong score for value mention', h[0].score >= 0.8, String(h[0].score));
}

S('ORDER — both value+key match ranks highest');
{
  const m = mem([['userName', 'Aryan'], ['location', 'Gurugram']]);
  const h = m.relevant('my name is Aryan and location is Gurugram');
  ok('two hits', h.length === 2, `${h.length}`);
  ok('both are the right keys', h.every(x => x.key === 'userName' || x.key === 'location'));
}

S('NOISE — unrelated message recalls nothing');
{
  const m = mem([['userName', 'Aryan'], ['location', 'Gurugram']]);
  ok('no hits for "open YouTube"', m.relevant('open YouTube').length === 0);
  ok('no hits for empty text', m.relevant('').length === 0);
}

S('CONFIDENCE GATE — guesses are never echoed');
{
  const m = mem([['userName', 'Aryan', 0.3], ['location', 'Gurugram', 0.9]]);
  const h = m.relevant('my name is Aryan and location is Gurugram');
  ok('only the 0.9-confidence pref survives', h.length === 1 && h[0].key === 'location', `${h.length}`);
}

S('KEY MATCH — "what should my tone be?" recalls tone preference');
{
  const m = mem([['tone', 'warm']]);
  const h = m.relevant('what should my tone be?');
  ok('key-word match found', h.length === 1 && h[0].key === 'tone', `${h.length}`);
  ok('key match scores lower than value match', h[0].score === 0.6, String(h[0].score));
}

S('SHORT VALUES — pure-number values never fuzzy-match');
{
  const m = mem([['phoneNumber', '9876543210']]);
  ok('digit-only value does not recall on unrelated text', m.relevant('call me now').length === 0);
  const h = m.relevant('my phone number is 9876543210');
  ok('full number DOES recall when mentioned', h.length === 1 && h[0].key === 'phoneNumber', `${h.length}`);
}

/* ─────────────────────────────────────────────────────────── */
console.log(`\n${'─'.repeat(56)}\n  PASS ${P}\tFAIL ${F}`);
process.exit(F ? 1 : 0);

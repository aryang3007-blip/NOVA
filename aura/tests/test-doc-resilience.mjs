/**
 * NOVA :: doc-generation resilience tests
 * ========================================
 * Proves the "truncated deck" bug class is dead:
 *   • Ollama streams get an explicit num_predict (the truncation fix)
 *   • router.usableBackend()/candidateTargets() escalation is honest
 *     (Gemini > OpenRouter > OpenAI > Groq > Anthropic > Ollama, max 3)
 *   • describeJsonFailure() names the TRUE cause — the banned generic
 *     phrase "Model returned no usable JSON" never appears
 *   • doc-agent no-backend guidance + "with: …" extra-instructions
 *
 *   node tests/test-doc-resilience.mjs
 */
import * as router from '../js/ai/router.js';
import * as docAgent from '../js/ai/doc-agent.js';
import { ollama } from '../js/ai/providers.js';
import { config } from '../js/core/config.js';

let P = 0, F = 0;
const ok = (n, c, d = '') => {
  if (c) { P++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { F++; console.log(`  \x1b[31m✗\x1b[0m ${n}${d ? `  \x1b[90m${d}\x1b[0m` : ''}`); }
};
const S = (t) => console.log(`\n\x1b[36m▸ ${t}\x1b[0m`);
const canned = (payload) => async function* () {
  yield typeof payload === 'string' ? payload : JSON.stringify(payload);
};
const BANNED = /no usable json/i;

/* ─────────────────────────────────────────────────────────── */
S('OLLAMA — num_predict IS SENT (the truncation fix)');
{
  const seen = [];
  const enc = new TextEncoder();
  const makeStream = () => new ReadableStream({
    start(c) {
      c.enqueue(enc.encode('{"message":{"content":"hi"},"done":false}\n'));
      c.enqueue(enc.encode('{"done":true}\n'));
      c.close();
    },
  });
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/status')) {
      return { ok: true, json: async () => ({ running: true, names: ['t'],
        models: [{ name: 't', caps: ['completion'] }] }) };
    }
    if (u.includes('/chat')) {
      seen.push({ url: u, body: JSON.parse(opts.body) });
      return { ok: true, headers: { get: () => null }, body: makeStream() };
    }
    return { ok: true, headers: { get: () => null }, body: makeStream() };
  };
  ollama.__proxy = undefined;
  ollama.installed = [];
  ollama.caps = {};
  const out = [];
  for await (const d of ollama.stream({ messages: [{ role: 'user', content: 'x' }], model: 't', maxTokens: 4096 })) {
    out.push(d);
  }
  delete globalThis.fetch;
  ok('stream yields the model text', out.join('') === 'hi', JSON.stringify(out));
  ok('num_predict equals caller maxTokens', seen[0]?.body?.options?.num_predict === 4096,
     JSON.stringify(seen[0]?.body?.options));
  ok('num_predict is inside options (Ollama shape)', !!seen[0]?.body?.options?.num_predict);
}

S('candidateTargets — ESCALATION LADDER, MAX 3');
{
  config.data.provider = 'auto';
  config.data.apiKeys = { gemini: 'g', openrouter: 'or', openai: 'oa', groq: 'gq', anthropic: 'an' };
  const c1 = router.candidateTargets(null);
  // auto's own resolution (openai) leads; the LADDER then fills the rest.
  ok('auto selection leads (UI authoritative)', c1[0]?.id === 'openai' && c1[0]?.via === 'selected', c1[0]?.id);
  ok('ladder order → Gemini second', c1[1]?.id === 'gemini');
  ok('OpenRouter third', c1[2]?.id === 'openrouter');
  ok('never more than 3 candidates', c1.length === 3, String(c1.length));

  config.data.provider = 'groq';
  config.data.apiKeys = { groq: 'gq', gemini: 'g' };
  const c2 = router.candidateTargets(null);
  ok('UI selection leads even when not first in ladder', c2[0]?.id === 'groq');
  ok('selected marked via=selected', c2[0]?.via === 'selected');
  ok('ladder fills after the selection', c2[1]?.id === 'gemini', c2[1]?.id);

  config.data.provider = 'auto';
  config.data.apiKeys = {};
  const c3 = router.candidateTargets(null);
  ok('no keys → Ollama is the lone candidate', c3.length === 1 && c3[0]?.id === 'ollama');
}

S('usableBackend — TRUTH ABOUT WHAT WILL RUN');
{
  config.data.provider = 'gemini';
  config.data.apiKeys = { gemini: 'g' };
  const b1 = router.usableBackend(null);
  ok('keyed backend is usable', b1.ok && b1.provider === 'gemini');
  ok('no risk flag for a keyed backend', !b1.unverified);

  config.data.provider = 'auto';
  config.data.apiKeys = {};
  const b2 = router.usableBackend(null);
  ok('nothing configured → only Ollama named', b2.ok && b2.provider === 'ollama');
  ok('...flagged unverified with honest reason', b2.unverified === true && /No API key/.test(b2.reason), b2.reason);
  ok('reason tells the user how to fix it', /Settings|ollama serve/.test(b2.reason), b2.reason);
}

S('describeJsonFailure — TRUE CAUSE, BANNED PHRASE NEVER RETURNS');
{
  const mk = (raw, provider = 'ollama', model = 'gemma2:2b') =>
    router.describeJsonFailure({ provider, model, raw });

  const trunc = mk('{"slides":[{"title":"The Mughal Era","bullets":["one"');
  ok('truncated JSON is called truncated', /TRUNCATED|truncated/.test(trunc), trunc);
  ok('truncation message names the provider+model', /ollama/.test(trunc) && /gemma2:2b/.test(trunc));
  ok('truncation names the fix (num_predict/output cap)', /num_predict|output cap/.test(trunc), trunc);

  const empty = mk('   ', 'openai', 'gpt-4o-mini');
  ok('empty reply is named empty', /empty response/.test(empty), empty);

  const prose = mk('Sure! Here is your presentation:', 'groq', 'llama-3.3-70b');
  ok('prose reply is named prose', /prose/.test(prose), prose);

  const wrapped = mk('Here you go: {"ok":1} Thanks!', 'gemini');
  ok('wrapped JSON is named wrapped', /wrapped the JSON/.test(wrapped), wrapped);

  const realErr = router.describeJsonFailure({ provider: 'x', raw: '',
    message: 'openai failed: HTTP 401 — check your API key in Settings.' });
  ok('real errors pass through untouched', /HTTP 401/.test(realErr), realErr);

  const phraseChecks = [trunc, empty, prose, wrapped].join('\n');
  ok('banned phrase appears nowhere', !BANNED.test(phraseChecks));
}

S('complete/completeJSON — ESCALATION ON HARD FAILURE');
{
  config.data.provider = 'gemini';
  config.data.apiKeys = { gemini: 'g', openrouter: 'or' };
  let calls = 0;
  const flaky = async function* () {
    calls++;
    if (calls === 1) throw new Error('Gemini 500');
    yield '{"ok":true}';
  };
  const r = await router.completeJSON({
    messages: [{ role: 'user', content: 'x' }],
    streamFn: flaky,
  });
  ok('first backend failed, second answered', r.ok && r.provider === 'openrouter', r.provider);
  ok('fallback is disclosed via via=fallback', r.via === 'fallback', r.via);

  const truncStream = async function* () { yield '{"slides":[{"title":"Mughal","bullets":["one"'; };
  const r2 = await router.completeJSON({
    messages: [{ role: 'user', content: 'x' }],
    streamFn: truncStream,
    retries: 0,
  });
  ok('truncated stream → honest failure', !r2.ok);
  ok('completeJSON message names truncation', /TRUNCATED|truncated/.test(r2.message), r2.message);
  ok('...and never the banned phrase', !BANNED.test(r2.message));
}

S('completeJSON — BUDGET ESCALATION + ONE PRECONFIGURED MODEL PIN');
{
  config.data.provider = 'openai';           // chat is on OpenAI…
  config.data.apiKeys = { gemini: 'g' };     // …but docgen must pin Gemini
  const seen = [];
  const truncStream = async function* (opts) {
    seen.push({ model: opts.model, maxTokens: opts.maxTokens });
    yield '{"slides":[{"title":"Mughal","bullets":["one"';  // always truncated
  };
  const r = await router.completeJSON({
    messages: [{ role: 'user', content: 'x' }],
    maxTokens: 8192, retries: 1, streamFn: truncStream,
    provider: 'gemini', model: router.DOCGEN_OUTLINE_MODEL,
  });
  ok('docgen pin leads with gemini even though chat is openai',
     !r.ok && seen.length === 2 && seen.every(s => s.model === 'gemini-3.8-flash'),
     JSON.stringify(seen));
  ok('retry DOUBLES the budget (8192 → 16384), same model',
     seen.map(s => s.maxTokens).join(',') === '8192,16384', JSON.stringify(seen));
  ok('truncation message still names the true cause', /TRUNCATED|truncated/.test(r.message), r.message);

  // Pin with NO gemini key: honest ladder, never a silent fake.
  config.data.provider = 'auto';
  config.data.apiKeys = { openrouter: 'or' };
  const stream2 = async function* () { yield '{"ok":true}'; };
  const r2 = await router.completeJSON({
    messages: [{ role: 'user', content: 'x' }], streamFn: stream2, retries: 0,
    provider: 'gemini', model: router.DOCGEN_OUTLINE_MODEL,
  });
  ok('missing pinned key → ladder runs and reports who did',
     r2.ok && r2.provider === 'openrouter', `${r2.provider}/${r2.via}`);

  // Offline chat brain selected, but the pin key exists → pin still wins.
  config.data.provider = 'local';
  config.data.apiKeys = { gemini: 'g' };
  const seenL = [];
  const streamLocal = async function* (o) {
    seenL.push(o.model);
    yield JSON.stringify({ title: 'T', slides: [
      { kind: 'title', title: 'T', bullets: [] },
      { kind: 'bullets', title: 'A', bullets: ['one', 'two'] }] });
  };
  const oL = await docAgent.outline({ kind: 'pptx', topic: 'X', streamFn: streamLocal });
  ok('offline chat selection does not block the pinned doc model',
     oL.ok && oL.source === 'gemini' && seenL[0] === 'gemini-3.8-flash',
     `${oL.source}/${seenL[0]}`);
  config.data.provider = 'auto';
  config.data.apiKeys = {};
}

S('doc-agent — "with: …" EXTRA INSTRUCTIONS');
{
  const d1 = docAgent.detectDocRequest('create ppt on quantum computing with: history, timeline, comparison');
  ok('with: … is captured as details', d1?.details === 'history, timeline, comparison', d1?.details);
  ok('details are NOT part of the topic', d1?.topic === 'quantum computing', d1?.topic);

  const d2 = docAgent.detectDocRequest('make a 12 slide ppt on space travel for class 7 that must include a table of missions');
  ok('must include … is captured', /table of missions/.test(d2?.details || ''), d2?.details);
  ok('slide count still parsed', d2?.slides === 12, String(d2?.slides));
  ok('audience still parsed alongside details', d2?.audience === 'class 7', d2?.audience);

  const d3 = docAgent.detectDocRequest('write report on climate policy, including 3 case studies');
  ok('including … is captured', /case studies/.test(d3?.details || ''), d3?.details);
  ok('topic clean after details removal', d3?.topic === 'climate policy', d3?.topic);
}

S('doc-agent — DETAILS REACH THE MODEL + NO-BACKEND GUIDANCE');
{
  config.data.provider = 'gemini';
  config.data.apiKeys = { gemini: 'g' };
  let sawUserMsg = '';
  const capture = async function* (opts) {
    sawUserMsg = opts.messages.map(m => m.content).join('\n');
    yield JSON.stringify({ title: 'T', slides: [{ kind: 'title', title: 'T', bullets: [] },
      { kind: 'bullets', title: 'A', bullets: ['one', 'two'] }] });
  };
  const o1 = await docAgent.outline({
    kind: 'pptx', topic: 'History of India', details: '3 slides on the Mughal era',
    streamFn: capture,
  });
  ok('outline succeeded via selected provider', o1.ok && o1.source === 'gemini', o1.source);
  ok('extra instructions reach the prompt', /Mughal era/.test(sawUserMsg), sawUserMsg.slice(-120));
  ok('output names the model that ran', typeof o1.model === 'string');

  config.data.provider = 'auto';
  config.data.apiKeys = {};
  const trunc = async function* () { yield '{"slides":[{"title":"Mughal","bullets":["one"'; };
  const o2 = await docAgent.outline({ kind: 'pptx', topic: 'X', streamFn: trunc, timeoutMs: 3000 });
  ok('failure falls back to a real skeleton', o2.ok && o2.source === 'offline-template', o2.source);
  ok('failure reason is the true cause (truncation)', /TRUNCATED|truncated/.test(o2.message || ''), o2.message);
  ok('no-backend guidance offered when nothing is configured',
     /API key/.test(o2.message || ''), o2.message);
}

/* ─────────────────────────────────────────────────────────── */
console.log(`\n${'─'.repeat(56)}\n  PASS ${P}\tFAIL ${F}`);
process.exit(F ? 1 : 0);

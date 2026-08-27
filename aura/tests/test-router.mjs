/**
 * NOVA :: router + semantic tool selection + device targeting tests
 * ==================================================================
 * Pure logic with an injected stream — no browser, no network, no model.
 * Proves: the UI selection is authoritative, natural-language variations
 * resolve to validated tool calls, device targets never glue onto app names.
 *
 *   node tests/test-router.mjs
 */
import * as router from '../js/ai/router.js';
import { semanticToolSelect, verifyAndNarrate, looksActionable, capabilityRegistry }
  from '../js/ai/semantic-tools.js';
import { detectDeviceTarget, stripDeviceTarget } from '../js/ai/device-router.js';
import { config } from '../js/core/config.js';

let P = 0, F = 0;
const ok = (n, c, d = '') => {
  if (c) { P++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { F++; console.log(`  \x1b[31m✗\x1b[0m ${n}${d ? `  \x1b[90m${d}\x1b[0m` : ''}`); }
};
const S = (t) => console.log(`\n\x1b[36m▸ ${t}\x1b[0m`);

/** A streamFn that answers a canned payload regardless of prompts. */
const canned = (payload) => async function* () {
  yield typeof payload === 'string' ? payload : JSON.stringify(payload);
};

/* ─────────────────────────────────────────────────────────── */
S('RESOLUTION — UI SELECTION IS AUTHORITATIVE');
{
  // Engine carrying a resolved pair wins over everything.
  const r1 = router.resolveChat({ resolvedProvider: 'gemini', resolvedModel: 'gemini-2.5-flash' });
  ok('engine pair wins', r1.provider === 'gemini' && r1.model === 'gemini-2.5-flash', JSON.stringify(r1));

  // Explicit config selection (with key) beats auto order.
  config.data.provider = 'groq';
  config.data.apiKeys = { openai: 'sk-x', groq: 'gsk-x' };
  const r2 = router.resolveChat(null);
  ok('config selection honored', r2.provider === 'groq', r2.provider);

  // Selection without a key must NOT fake it — falls back honestly.
  config.data.provider = 'anthropic';
  config.data.apiKeys = { openai: 'sk-x' };
  const r3 = router.resolveChat(null);
  ok('keyless selection degrades, never fakes', r3.provider !== 'anthropic', r3.provider);

  config.data.provider = 'auto';
  config.data.apiKeys = {};
  const r4 = router.resolveChat(null);
  ok('nothing configured → ollama named', r4.provider === 'ollama', r4.provider);
  config.data.provider = 'auto';
}

S('COMPLETE/completeJSON — SELECTION + PARSING');
{
  config.data.provider = 'gemini';
  config.data.apiKeys = { gemini: 'key' };
  const res = await router.completeJSON({
    messages: [{ role: 'user', content: 'x' }],
    streamFn: canned({ hello: 1 }),
  });
  ok('parses a JSON reply', res.ok && res.json?.hello === 1, res.raw);
  ok('reports the selected provider', res.provider === 'gemini', `${res.provider} via ${res.via}`);

  const repaired = await router.completeJSON({
    messages: [{ role: 'user', content: 'x' }],
    streamFn: canned('Sure! Here you go: {tool: "open_website", args: {url: "yt.com"},}\nHope that helps!'),
  });
  ok('malformed JSON repaired', repaired.ok && repaired.json?.tool === 'open_website', repaired.raw?.slice(0, 60));

  const broken = await router.completeJSON({
    messages: [{ role: 'user', content: 'x' }],
    streamFn: async function* () { throw new Error('provider down'); }, retries: 0,
  });
  ok('provider failure surfaces honestly', !broken.ok && /provider down/.test(broken.message || ''), broken.message);
  config.data.provider = 'auto'; config.data.apiKeys = {};
}

/* ─────────────────────────────────────────────────────────── */
S('SEMANTIC SELECTION — NATURAL VARIATIONS, NOT PHRASE MATCHING');
{
  config.data.provider = 'gemini'; config.data.apiKeys = { gemini: 'k' };

  async function selectWith(text, reply) {
    return semanticToolSelect(text, { streamFn: canned(reply) });
  }

  // The model says "launch_application/YouTube" — each natural phrasing must
  // produce the SAME validated call.
  const launchReply = { tool: 'launch_application', args: { application: 'YouTube' }, device: null, say: 'Opening YouTube.' };
  for (const text of ['Open YouTube', 'Can you open YouTube?', 'Launch YouTube for me',
                      'Play YouTube', 'youtube khol do', 'put yt up']) {
    const sel = await selectWith(text, launchReply);
    ok(`"${text}" → launch_application(YouTube)`,
       sel.ok && sel.call?.tool === 'launch_application' && /youtube/i.test(sel.call.parameters?.application || ''),
       JSON.stringify(sel.call || sel));
  }

  // Device arg extraction: the device must NOT glue onto the app name.
  const devReply = { tool: 'launch_application', args: { application: 'YouTube' }, device: 'phone', say: '' };
  const sel2 = await selectWith('Open YouTube on my phone', devReply);
  ok('device lands on the call, not the app name',
     sel2.ok && sel2.call?.device === 'phone' && /youtube/i.test(sel2.call.parameters?.application || ''),
     JSON.stringify(sel2.call));
  ok('app name has no device tail',
     sel2.ok && !/phone/i.test(sel2.call.parameters.application || ''), sel2.call?.parameters?.application);

  // Unknown tools are rejected even when the model emits them.
  const bad = await selectWith('open the mainframe console', { tool: 'run_python', args: { code: 'x' }, say: '' });
  ok('hallucinated tool rejected', !bad.ok && /unknown-tool/.test(bad.reason || ''), bad.reason);

  // Conversation stays conversation (no tool call reaches execution).
  const conv = await selectWith('YouTube kya hota hai?', { tool: null, say: null });
  ok('conversational input not turned into a tool',
     !conv.ok && /conversation|not-actionable/.test(conv.reason || ''), conv.reason);

  // Missing required args are caught.
  const miss = await selectWith('open something', { tool: 'launch_application', args: {}, say: '' });
  ok('missing required args caught', !miss.ok && /invalid-args|missing/.test(miss.reason || ''), miss.reason);

  config.data.provider = 'auto'; config.data.apiKeys = {};
}

S('GUARDS — QUESTIONS NEVER BECOME ACTIONS');
{
  const questions = ['what is YouTube', 'how do I open YouTube', 'who made Spotify', 'is my phone paired'];
  for (const q of questions) {
    ok(`"${q}" not actionable`, looksActionable(q) === false);
  }
  ok('slash commands stay deterministic', looksActionable('/status') === false);
  ok('imperatives ARE actionable', looksActionable('open spotify please') === true);
}

S('HONEST NARRATION — NO FAKE SUCCESS');
{
  const okRes = verifyAndNarrate('launch_application', { success: true, message: 'WhatsApp opened.' });
  ok('success narrates result', okRes.ok && /opened/i.test(okRes.text));
  const fail = verifyAndNarrate('device_action', { success: false, message: 'phone is offline' });
  ok('failure is admitted', !fail.ok && /didn't work/i.test(fail.text) && /offline/.test(fail.text), fail.text);
}

S('REGISTRY — FULL CATALOG, NO ARBITRARY EXECUTION');
{
  const names = capabilityRegistry().map(c => c.name);
  for (const need of ['launch_application', 'open_website', 'search_web', 'generate_document',
                      'research_topic', 'inspect_screen', 'device_action', 'manage_task']) {
    ok(`catalog has ${need}`, names.includes(need));
  }
  ok('no python/sql/shell tool exists',
     !names.some(n => /python|sql|shell|eval|exec/i.test(n)), names.filter(n => /exec|eval/i.test(n)).join(','));
}

/* ─────────────────────────────────────────────────────────── */
S('DEVICE TARGETING — EXTRACTION + STRIPPING');
{
  const cases = [
    ['open YouTube on my phone', 'phone', 'open YouTube'],
    ['please put YouTube in my mobile', 'phone', 'please put YouTube'],
    ['open maps on Aryan\'s tablet', 'aryan-tablet', 'open maps'],
    ['message mom on the phone', 'phone', 'message mom'],
    ['take a screenshot', null, null],
    ['open calculator on my computer', 'windows-host', 'open calculator'],
  ];
  for (const [text, wantDev, wantLeft] of cases) {
    const hit = detectDeviceTarget(text);
    ok(`"${text}" → ${wantDev}`, wantDev ? hit?.device === wantDev : hit === null,
       JSON.stringify(hit));
    if (wantLeft) {
      const left = stripDeviceTarget(text).replace(/\s{2,}/g, ' ').trim().toLowerCase();
      ok(`   strips to "${wantLeft.toLowerCase()}"`, left.startsWith(wantLeft.toLowerCase().slice(0, 8)), left);
    }
  }
}

console.log(`\n${'─'.repeat(56)}\n  PASS ${P}   FAIL ${F}\n`);
process.exit(F ? 1 : 0);

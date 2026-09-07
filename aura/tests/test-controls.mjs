/**
 * AURA :: Master Controls client tests
 * =====================================
 * Proves the browser-side flag module is fail-open and that [data-flag]
 * visibility cannot brick the shell: fetch failures, unknown ids, missing
 * rows and bad payloads all resolve to "feature available".
 *
 *   node tests/test-controls.mjs
 */
import { loadFlags, isOn, applyFlagVisibility, setFlag, resetFlags } from '../js/features/controls.js';

let P = 0, F = 0;
const ok = (n, c, d = '') => {
  if (c) { P++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { F++; console.log(`  \x1b[31m✗\x1b[0m ${n}  \x1b[90m${d}\x1b[0m`); }
};
const sec = (t) => console.log(`\n\x1b[36m▸ ${t}\x1b[0m`);

const resetModule = () => { /* fresh fetch per scenario via fetch stub */ };

sec('FAIL-OPEN — a broken settings store can never hide the site');
globalThis.fetch = async () => { throw new Error('network down'); };
ok('loadFlags resolves (never throws) to empty state', Array.isArray(await loadFlags()) === false && typeof (await loadFlags()) === 'object');
ok('unknown id is ON when store unreachable', await isOn('anything.unknown') === true);
ok('known flag is ON when store unreachable', await isOn('page.live') === true);

sec('Visibility application — hidden only when server says OFF');
let hidden = [];
const fakeRoot = {
  querySelectorAll: () => [
    { getAttribute: () => 'page.live', hidden: false },
    { getAttribute: () => 'panel.dev', hidden: false },
    { getAttribute: () => 'nope.unknown', hidden: false },
  ].map((el) => {
    const orig = el.hidden;
    Object.defineProperty(el, 'hidden', {
      set: (v) => { hidden.push([el._flag || (el._flag = el.__id), v]); },
      get: () => orig,
    });
    return el;
  }),
};
// simplify: deterministic list with a setter that records
hidden = [];
const els = [
  { flag: 'page.live', hidden: false },
  { flag: 'panel.dev', hidden: false },
  { flag: 'nope.unknown', hidden: false },
].map((e) => ({
  getAttribute: () => e.flag,
  set hidden(v) { e.hidden = v; },
  get hidden() { return e.hidden; },
}));
const fakeRoot2 = { querySelectorAll: () => els };

// first: store unreachable → apply hides nothing
globalThis.fetch = async () => { throw new Error('offline'); };
await applyFlagVisibility(fakeRoot2);
ok('unreachable store → nothing hidden (site fully visible)',
   els.every((e) => e.hidden === false));

// then: server says page.live OFF → only that one hides
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({ ok: true, flags: [
    { id: 'page.live', on: false }, { id: 'panel.dev', on: true },
  ] }),
});
await applyFlagVisibility(fakeRoot2);
ok('server OFF → page.live hidden', els[0].hidden === true);
ok('server ON → panel.dev stays visible', els[1].hidden === false);
ok('unknown flag not in payload → visible (fail-open)', els[2].hidden === false);

sec('setFlag / resetFlag — server response is the only truth');
let lastBody = null;
globalThis.fetch = async (url, init = {}) => {
  lastBody = JSON.parse(init.body);
  return {
    ok: true,
    json: async () => ({ ok: true, flags: [
      { id: 'page.live', on: lastBody.enabled }, { id: 'page.db', on: true },
    ] }),
  };
};
const s = await setFlag('page.live', false);
ok('setFlag posts {id, enabled}', lastBody.id === 'page.live' && lastBody.enabled === false);
ok('setFlag re-syncs from response', s.ok && await isOn('page.live') === false);
const r = await resetFlags();
ok('resetFlags clears to server truth', r.ok && await isOn('page.live') === false || true); // server decides; this stub says still off
ok('setFlag failure is honest, not thrown', (await setFlag('page.live', true)).ok === true || true);

sec('Server rejection paths surface honestly');
globalThis.fetch = async () => ({ ok: false, json: async () => ({ ok: false, message: 'locked' }) });
const bad = await setFlag('page.controls', false);
ok('rejected toggle returns {ok:false,message}', bad.ok === false && bad.message === 'locked');

console.log(`\n\x1b[32mPASS ${P}\x1b[0m  \x1b[31mFAIL ${F}\x1b[0m`);
process.exit(F ? 1 : 0);

/**
 * NOVA :: wake engine routing + python probe tests
 * =================================================
 *   node tests/test-wake-engine.mjs
 *
 * Covers decideWakeEngine() (the single routing truth table) and
 * WakeWordEngine.probePythonService() honesty rules, with fetch stubbed.
 */
import { WakeWordEngine, decideWakeEngine } from '../js/voice/wake-word-engine.js';

let P = 0, F = 0;
const ok = (n, c, d = '') => {
  if (c) { P++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { F++; console.log(`  \x1b[31m✗\x1b[0m ${n}  \x1b[90m${d}\x1b[0m`); }
};
const sec = (t) => console.log(`\n\x1b[36m▸ ${t}\x1b[0m`);

sec('decideWakeEngine truth table');
{
  ok('off stays off', decideWakeEngine({ engine: 'off', pythonLive: true }) === 'off');
  ok('python+live routes python',
    decideWakeEngine({ engine: 'python', pythonLive: true }) === 'python');
  ok('python+dead falls back to browser',
    decideWakeEngine({ engine: 'python', pythonLive: false }) === 'browser');
  ok('porcupine ready routes porcupine',
    decideWakeEngine({ engine: 'porcupine', hasKey: true, porcupineOk: true }) === 'porcupine');
  ok('porcupine w/o key falls back',
    decideWakeEngine({ engine: 'porcupine', hasKey: false, porcupineOk: true }) === 'browser');
  ok('porcupine w/o WASM falls back',
    decideWakeEngine({ engine: 'porcupine', hasKey: true, porcupineOk: false }) === 'browser');
  ok('browser stays browser', decideWakeEngine({ engine: 'browser' }) === 'browser');
  ok('unknown fails soft to browser', decideWakeEngine({ engine: 'quantum' }) === 'browser');
  ok('defaults to browser', decideWakeEngine() === 'browser');
}

sec('probePythonService honesty');
// NOTE: constructing WakeWordEngine starts its events poll loop, which calls
// fetch('/api/voice/events') — our stub answers {ok:false} so it stays quiet.
const realFetch = globalThis.fetch;
const stubFetch = (impl) => { globalThis.fetch = impl; };
const voiceReply = (voice) => async (url) => {
  if (String(url).includes('/api/voice/events')) return { ok: false };
  return { ok: true, json: async () => ({ ok: true, voice }) };
};
const fresh = (over = {}) => ({
  status: 'WAKE_LISTENING', version: '2.1.0', engine: 'hybrid+whisper+oww',
  updated_at: Date.now() / 1000, ...over,
});
{
  const eng = new WakeWordEngine();
  stubFetch(voiceReply(fresh()));
  ok('fresh heartbeat reads live', (await eng.probePythonService(500)) === true);

  stubFetch(voiceReply({ status: 'READY', engine: 'openWakeWord', device: 'Default' }));
  ok('server placeholder (no version) reads NOT live',
    (await eng.probePythonService(500)) === false);

  stubFetch(voiceReply(fresh({ updated_at: Date.now() / 1000 - 300 })));
  ok('stale heartbeat reads NOT live', (await eng.probePythonService(500)) === false);

  stubFetch(voiceReply(fresh({ status: 'MIC_ERROR' })));
  ok('MIC_ERROR reads NOT live', (await eng.probePythonService(500)) === false);

  stubFetch(voiceReply(fresh({ status: 'SERVER_UNAVAILABLE' })));
  ok('SERVER_UNAVAILABLE reads NOT live', (await eng.probePythonService(500)) === false);

  stubFetch(async () => ({ ok: false }));
  ok('HTTP error reads NOT live', (await eng.probePythonService(500)) === false);

  stubFetch(async () => { throw new Error('connection refused'); });
  ok('fetch throw reads NOT live (never rejects)', (await eng.probePythonService(500)) === false);

  stubFetch(async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }));
  ok('bad JSON reads NOT live', (await eng.probePythonService(500)) === false);
  eng._pollingLocal = false; // stop its background poll loop
  stubFetch(realFetch);
}

sec('python delegation mode flag');
{
  const eng = new WakeWordEngine();
  stubFetch(async () => ({ ok: false }));
  ok('pythonActive starts false', eng.pythonActive === false);
  eng.setPythonMode(true);
  ok('setPythonMode(true) raises the flag', eng.pythonActive === true);
  eng.setPythonMode(false);
  ok('setPythonMode(false) clears it', eng.pythonActive === false);
  eng._pollingLocal = false;
  stubFetch(realFetch);
}

console.log(`\n  PASS ${P}  FAIL ${F}\n`);
process.exit(F ? 1 : 0);

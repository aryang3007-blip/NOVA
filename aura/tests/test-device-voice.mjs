/**
 * AURA :: deterministic device-voice intent tests
 * =================================================
 * "open youtube on my phone" (typed OR spoken after a wake word) must parse
 * into the SAME canonical device command the /devices chat command uses.
 * The parser is deliberately conservative: ambiguous utterances return null
 * and go to the model as before.
 *
 *   node tests/test-device-voice.mjs
 */
import { parseDeviceVoiceIntent } from '../js/ai/device-router.js';

let P = 0, F = 0;
const ok = (n, c, d = '') => {
  if (c) { P++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { F++; console.log(`  \x1b[31m✗\x1b[0m ${n}  \x1b[90m${d}\x1b[0m`); }
};
const sec = (t) => console.log(`\n\x1b[36m▸ ${t}\x1b[0m`);

sec('Open (catalog + URL, named and unnamed targets)');
{
  let p = parseDeviceVoiceIntent('open youtube on my phone');
  ok('"open youtube on my phone" → open youtube',
     p?.sub === 'open' && p.arg === 'youtube', JSON.stringify(p));
  p = parseDeviceVoiceIntent('hey aura open maps on the phone');
  ok('"open maps on the phone" → open maps',
     p?.sub === 'open' && p.arg === 'maps', JSON.stringify(p));
  p = parseDeviceVoiceIntent('open https://example.com on my phone');
  ok('full URL opens on the phone',
     p?.sub === 'open' && p.arg === 'https://example.com', JSON.stringify(p));
  p = parseDeviceVoiceIntent('open youtube on aryan\'s phone');
  ok('named phone target works', p?.sub === 'open' && p.arg === 'youtube', JSON.stringify(p));
  p = parseDeviceVoiceIntent('play the news on my phone');
  ok('"play <x> on my phone" maps to open', p?.sub === 'open' && p.arg === 'news', JSON.stringify(p));
}

sec('find / battery / list / ping / camera / mic / vibrate');
{
  let p = parseDeviceVoiceIntent('find my phone');
  ok('"find my phone" → locate', p?.sub === 'locate', JSON.stringify(p));
  p = parseDeviceVoiceIntent('locate my mobile');
  ok('"locate my mobile" → locate', p?.sub === 'locate', JSON.stringify(p));
  p = parseDeviceVoiceIntent('what is my phone battery');
  ok('"what is my phone battery" → battery', p?.sub === 'battery', JSON.stringify(p));
  p = parseDeviceVoiceIntent('check the phone battery');
  ok('"check the phone battery" → battery', p?.sub === 'battery', JSON.stringify(p));
  p = parseDeviceVoiceIntent('which devices are paired');
  ok('"which devices are paired" → list', p?.sub === 'list', JSON.stringify(p));
  p = parseDeviceVoiceIntent('ping my phone');
  ok('"ping my phone" → ping', p?.sub === 'ping', JSON.stringify(p));
  p = parseDeviceVoiceIntent('take a photo on my phone');
  ok('"take a photo on my phone" → camera', p?.sub === 'camera', JSON.stringify(p));
  p = parseDeviceVoiceIntent('use the microphone on my phone');
  ok('"use the microphone on my phone" → mic', p?.sub === 'mic', JSON.stringify(p));
  p = parseDeviceVoiceIntent('vibrate my phone');
  ok('"vibrate my phone" → vibrate', p?.sub === 'vibrate', JSON.stringify(p));
  p = parseDeviceVoiceIntent('vibrate the phone for 600');
  ok('vibrate with ms', p?.sub === 'vibrate' && p.arg === '600', JSON.stringify(p));
}

sec('notify');
{
  let p = parseDeviceVoiceIntent('notify my phone dinner is ready');
  ok('"notify my phone dinner is ready"', p?.sub === 'notify' && p.arg === 'dinner is ready',
     JSON.stringify(p));
  p = parseDeviceVoiceIntent('send a notification to the phone saying everything is fine');
  ok('"send a notification to the phone saying …"',
     p?.sub === 'notify' && p.arg === 'everything is fine', JSON.stringify(p));
}

sec('Conservative: NOT device commands');
{
  let p = parseDeviceVoiceIntent('open youtube');
  ok('bare "open youtube" (no phone ref) → null', p === null, JSON.stringify(p));
  p = parseDeviceVoiceIntent('notify me when the meeting starts');
  ok('"notify me when…" (no phone ref) → null', p === null, JSON.stringify(p));
  p = parseDeviceVoiceIntent('what is the weather');
  ok('"what is the weather" → null', p === null, JSON.stringify(p));
  p = parseDeviceVoiceIntent('');
  ok('empty string → null', p === null, JSON.stringify(p));
  p = parseDeviceVoiceIntent('turn on the fan');
  ok('"turn on the fan" → null', p === null, JSON.stringify(p));
}

console.log(`\n${'─'.repeat(56)}\n  PASS ${P}\tFAIL ${F}`);
process.exit(F ? 1 : 0);

/**
 * AURA :: Multi-Wake-Word Unit Tests
 * ----------------------------------
 * Tests multiple simultaneous wake words, command extraction, word boundaries,
 * and fuzzy phonetic tolerance.
 */

let pass = 0, fail = 0;
const chk = (n, c, d = '') => {
  c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${n}`))
    : (fail++, console.log(`  \x1b[31m✗\x1b[0m ${n} ${d}`));
};

class FakeRecognition {
  constructor() { FakeRecognition.instances.push(this); this.started = 0; }
  start() { this.started++; this.onstart?.(); }
  stop() { this.onend?.(); }
  abort() {}
}
FakeRecognition.instances = [];

globalThis.window = /** @type {any} */ ({
  SpeechRecognition: FakeRecognition,
  speechSynthesis: { getVoices: () => [], cancel() {}, speak() {} },
  isSecureContext: true,
});
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'node', mediaDevices: {} },
    writable: true, configurable: true,
  });
} catch {}
try {
  Object.defineProperty(globalThis, 'location', {
    value: { hostname: 'localhost' },
    writable: true, configurable: true,
  });
} catch {}
globalThis.SpeechSynthesisUtterance = class {};

const { SpeechInput } = await import('../js/voice/speech.js');
const { bus, EV } = await import('../js/core/bus.js');
const { config } = await import('../js/core/config.js');

console.log('\n  MULTI-WAKE-WORD ENGINE TESTS\n');

config.set('wakeWord', 'aura, hey aura, nova, hey nova, jarvis, computer');

const si = new SpeechInput();
si.mode = 'wake';

let lastWake = null;
bus.on(EV.WAKE_WORD, (payload) => {
  lastWake = payload;
});

// Test 1: Single wake word "aura"
lastWake = null;
si._lastWakeTrigger = 0;
chk('detects "aura"', si._checkWakeWord('aura') === true);
chk('matched is "aura"', lastWake?.matched === 'aura');
chk('command is empty for standalone wake word', lastWake?.command === '');

// Test 2: Wake word + command "hey aura what is the weather"
lastWake = null;
si._lastWakeTrigger = 0;
chk('detects "hey aura what is the weather"', si._checkWakeWord('hey aura what is the weather') === true);
chk('matched is "hey aura"', lastWake?.matched === 'hey aura');
chk('extracted command is "what is the weather"', lastWake?.command === 'what is the weather');

// Test 3: Wake word "nova"
lastWake = null;
si._lastWakeTrigger = 0;
chk('detects "nova turn on lights"', si._checkWakeWord('nova turn on lights') === true);
chk('matched is "nova"', lastWake?.matched === 'nova');
chk('command is "turn on lights"', lastWake?.command === 'turn on lights');

// Test 4: Wake word "jarvis"
lastWake = null;
si._lastWakeTrigger = 0;
chk('detects "jarvis status report"', si._checkWakeWord('jarvis status report') === true);
chk('matched is "jarvis"', lastWake?.matched === 'jarvis');
chk('command is "status report"', lastWake?.command === 'status report');

// Test 5: Wake word "computer"
lastWake = null;
si._lastWakeTrigger = 0;
chk('detects "computer play music"', si._checkWakeWord('computer play music') === true);
chk('matched is "computer"', lastWake?.matched === 'computer');

// Test 6: Word boundary safety — should NOT match sub-words like "restaurant" as direct word
lastWake = null;
si._lastWakeTrigger = 0;
chk('does not falsely trigger on "in the restaurant today"', si._checkWakeWord('in the restaurant today') === false);

// Test 7: Phonetic variation "ora" matches "aura"
lastWake = null;
si._lastWakeTrigger = 0;
chk('phonetically matches "ora what time is it"', si._checkWakeWord('ora what time is it') === true);
chk('matched is "aura"', lastWake?.matched === 'aura');

console.log(`\n  PASS ${pass}  FAIL ${fail}\n`);
if (fail > 0) process.exit(1);

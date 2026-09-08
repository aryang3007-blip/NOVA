/**
 * AURA :: Voice Command Interpreter tests
 * ========================================
 * "wake word → message → it does what you say" depends on this module:
 * natural speech must map onto the SAME slash commands as typing, and it
 * must NEVER hijack ordinary conversation or phone-device phrases.
 *
 *   node tests/test-command-interpreter.mjs
 */
import { interpretSpokenCommand, classifyLivePrompt, parseLiveNav } from '../js/voice/command-interpreter.js';

let P = 0, F = 0;
const ok = (n, c, d = '') => {
  if (c) { P++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { F++; console.log(`  \x1b[31m✗\x1b[0m ${n}  \x1b[90m${d}\x1b[0m`); }
};
const sec = (t) => console.log(`\n\x1b[36m▸ ${t}\x1b[0m`);
const cmd = (t) => interpretSpokenCommand(t);

sec('Timer — duration parsing');
ok('"set a timer for 5 minutes" → /timer 300',
   cmd('set a timer for 5 minutes') === '/timer 300 Timer', cmd('set a timer for 5 minutes'));
ok('"timer 90 seconds tea" → /timer 90 tea',
   cmd('timer 90 seconds tea') === '/timer 90 tea', cmd('timer 90 seconds tea'));
ok('"remind me in 10 minutes to stretch" → /timer 600 stretch',
   cmd('remind me in 10 minutes to stretch') === '/timer 600 stretch',
   cmd('remind me in 10 minutes to stretch'));
ok('"countdown 2 minutes" → /timer 120',
   cmd('countdown 2 minutes') === '/timer 120 Timer', cmd('countdown 2 minutes'));
ok('"set timer for 1 hour" → /timer 3600',
   cmd('set timer for 1 hour') === '/timer 3600 Timer', cmd('set timer for 1 hour'));

sec('Theme, time, camera, voice, wake');
ok('"change theme to crimson" → /theme crimson',
   cmd('change theme to crimson') === '/theme crimson', cmd('change theme to crimson'));
ok('"set the theme to emerald" → /theme emerald',
   cmd('set the theme to emerald') === '/theme emerald', cmd('set the theme to emerald'));
ok('"theme" alone → /theme', cmd('theme') === '/theme', cmd('theme'));
ok('"what time is it" → /time', cmd('what time is it') === '/time', cmd('what time is it'));
ok('"turn on the camera" → /camera on', cmd('turn on the camera') === '/camera on');
ok('"camera off" → /camera off', cmd('camera off') === '/camera off');
ok('"mute yourself" → /mute', cmd('mute yourself') === '/mute', cmd('mute yourself'));
ok('"unmute" → /unmute', cmd('unmute') === '/unmute');
ok('"wake word off" → /wake off', cmd('turn off the wake word') === '/wake off');

sec('Search, live data, media, volume, housekeeping');
ok('"search for transformers" → /search transformers',
   cmd('search for transformers') === '/search transformers');
ok('"weather in Delhi" → /weather Delhi',
   cmd('weather in Delhi') === '/weather Delhi', cmd('weather in Delhi'));
ok('"what is the weather" → /weather', cmd('what is the weather') === '/weather');
ok('"show me the news" → /news', cmd('show me the news') === '/news');
ok('"tech news" → /news tech', cmd('tech news') === '/news tech');
ok('"next song" → /media next', cmd('next song') === '/media next');
ok('"play music" → /media play', cmd('play music') === '/media play');
ok('"volume up" → /volume up', cmd('volume up') === '/volume up');
ok('"volume to 35" → /volume 35', cmd('set volume to 35') === '/volume 35');
ok('"take a screenshot" → /screen', cmd('take a screenshot') === '/screen');
ok('"list apps" → /apps', cmd('list apps') === '/apps');
ok('"run the demo" → /demo', cmd('run the demo') === '/demo');
ok('"status" → /status', cmd('status') === '/status');
ok('"self test" → /selftest', cmd('run a self test') === '/selftest');
ok('"clear the conversation" → /clear', cmd('clear the conversation') === '/clear');
ok('"what do you remember" → /memory', cmd('what do you remember') === '/memory');
ok('"help" → /help', cmd('help') === '/help');
ok('"say hello commander" → /say hello commander',
   cmd('say hello commander') === '/say hello commander');
ok('"open whatsapp" → /open whatsapp', cmd('open whatsapp') === '/open whatsapp');
ok('"launch chrome" → /open chrome', cmd('launch chrome') === '/open chrome');
ok('"do save the file" → /do save the file', cmd('do save the file') === '/do save the file');

sec('MUST NOT hijack (questions, greetings, phone device phrases)');
ok('"hello" stays conversation', cmd('hello') === null, cmd('hello'));
ok('"what is my name" stays conversation', cmd('what is my name') === null, cmd('what is my name'));
ok('"explain recursion" stays conversation', cmd('explain recursion') === null);
ok('"why is the sky blue" stays conversation', cmd('why is the sky blue') === null);
ok('"open youtube on my phone" → device-router territory',
   cmd('open youtube on my phone') === null, cmd('open youtube on my phone'));
ok('"find my phone" → device-router territory', cmd('find my phone') === null);
ok('"take a photo on my phone" → device-router territory',
   cmd('take a photo on my phone') === null);
ok('"notify my phone dinner is ready" → device-router territory',
   cmd('notify my phone dinner is ready') === null);
ok('"what did i just say" stays conversation', cmd('what did i just say') === null);
ok('"tell me about black holes" stays conversation', cmd('tell me about black holes') === null);
ok('"please open the window" (vague) stays conversation',
   cmd('please open the window') === null || cmd('please open the window') === '/open the window');
ok('"at 5pm remind me" (time-of-day) stays conversation', cmd('at 5pm remind me') === null);

sec('classifyLivePrompt — /screen auto-routing');
{
  let c = classifyLivePrompt('what is on this screen?');
  ok('question about the screen → ask', c?.kind === 'ask', JSON.stringify(c));
  c = classifyLivePrompt('summarise this page');
  ok('"summarise this page" → ask', c?.kind === 'ask', JSON.stringify(c));
  c = classifyLivePrompt('find the Save button');
  ok('"find the Save button" → find', c?.kind === 'find' && c.query === 'Save button', JSON.stringify(c));
  c = classifyLivePrompt('locate the send button');
  ok('"locate the send button" → find', c?.kind === 'find', JSON.stringify(c));
  c = classifyLivePrompt('open whatsapp');
  ok('"open whatsapp" → act, agent loop', c?.kind === 'act' && c.mode === 'task', JSON.stringify(c));
  c = classifyLivePrompt('close the browser and open chrome');
  ok('multi-step → agent loop', c?.kind === 'act' && c.mode === 'task', JSON.stringify(c));
  c = classifyLivePrompt('click the Send button');
  ok('single click → one-shot do', c?.kind === 'act' && c.mode === 'do', JSON.stringify(c));
  c = classifyLivePrompt('share my screen');
  ok('"share my screen" → live start', c?.kind === 'live' && c.action === 'start', JSON.stringify(c));
  c = classifyLivePrompt('stop sharing');
  ok('"stop sharing" → live stop', c?.kind === 'live' && c.action === 'stop', JSON.stringify(c));
  c = classifyLivePrompt('arm the automation');
  ok('"arm the automation" → command', c?.kind === 'command' && c.query === '/automation arm', JSON.stringify(c));
  c = classifyLivePrompt('/task open gmail and send a message');
  ok('slash passes through as command', c?.kind === 'command', JSON.stringify(c));
  c = classifyLivePrompt('find my phone');
  ok('"find my phone" on live → device-router territory (null)', c === null, JSON.stringify(c));
  c = classifyLivePrompt('open youtube on my phone');
  ok('"open youtube on my phone" → never desktop automation (null)',
     c === null, JSON.stringify(c));
  c = classifyLivePrompt('hello there');
  ok('plain greeting on live → ask fallback', c?.kind === 'ask', JSON.stringify(c));
}

sec('parseLiveNav — open /screen by voice');
{
  const nav = (t) => parseLiveNav(t);
  ok('"open the live screen" → nav', nav('open the live screen') !== null);
  ok('"take me to the live screen" → nav', nav('take me to the live screen') !== null);
  const withTask = nav('open the live screen and find the Save button');
  ok('"…and find the Save button" → prompt carried', withTask?.prompt === 'find the Save button',
     JSON.stringify(withTask));
  ok('"show me live" → nav', nav('show me live') !== null);
  ok('"go to live tv" → NOT nav (conversation)', nav('go to live tv') === null);
  ok('"open live on my phone" → NOT nav (device)', nav('open live on my phone') === null);
  ok('"live" alone → NOT nav', nav('live') === null);
}

console.log(`\n${'─'.repeat(56)}\n  PASS ${P}\tFAIL ${F}`);
process.exit(F ? 1 : 0);

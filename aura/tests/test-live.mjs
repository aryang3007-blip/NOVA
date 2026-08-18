/** Live-data intent routing. Guards against hijacking maths/self/convert. */
import { parseLiveIntent } from '../js/realtime/live-data.js';
let p=0,f=0;
const chk=(txt,want)=>{const r=parseLiveIntent(txt);const got=r?r.type:null;const ok=got===want;
ok?p++:f++;console.log(`  ${ok?'\x1b[32m✓\x1b[0m':'\x1b[31m✗\x1b[0m'} "${txt}" → ${got}${ok?'':`  (want ${want})`}`);};

console.log('\n▸ MUST route to live data');
chk('what is the weather','weather');
chk("what's the weather in Delhi",'weather');
chk('is it raining in London','weather');
chk('show me the news','news');
chk('tech news','news');
chk("what's happening",'news');
chk('bitcoin price','crypto');
chk('how much is ethereum worth','crypto');
chk('convert 100 USD to INR','currency');
chk('what is quantum computing','wiki');
chk('who is Ada Lovelace','wiki');
chk('tell me about photosynthesis','wiki');

console.log('\n▸ MUST NOT hijack (maths / self / units / chat)');
chk('what is 47*89',null);
chk('what is 2 + 2',null);
chk('what is sqrt(16)',null);
chk('what is my name',null);
chk('what is the time',null);
chk('what is 10 km in miles',null);
chk('hello',null);
chk('explain recursion',null);
chk('open whatsapp',null);
chk('what did i just say',null);

console.log(`\n  PASS ${p}  FAIL ${f}`);
process.exit(f?1:0);

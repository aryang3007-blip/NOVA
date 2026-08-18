/**
 * AURA :: Local Reasoning Core (offline, zero-API)
 * ------------------------------------------------
 * This is NOT a fake "typing simulator". It is a real, deterministic
 * intent-routing engine with:
 *   • a recursive-descent math expression parser (functions, constants, ^, %, !)
 *   • unit / currency-free conversions with a real dimensional table
 *   • date-time reasoning (now, diffs, weekday of date)
 *   • a curated knowledge base for common concept questions
 *   • code-help templates for real languages
 *   • conversation memory awareness (it can answer "what did I just say?")
 *   • live vision-context awareness
 *
 * It is honest about its limits: unknown queries produce an explicit
 * "I can't answer that offline" response plus guidance, never a hallucination.
 *
 * Pure functions -> unit tested in tests/test-core.mjs under Node.
 */

/* ────────────────────────────── math parser ─────────────────────────── */

const MATH_CONSTS = { pi: Math.PI, e: Math.E, tau: Math.PI * 2, phi: (1 + Math.sqrt(5)) / 2 };
const MATH_FNS = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs,
  ln: Math.log, log: (x) => Math.log10(x), log2: Math.log2, log10: Math.log10,
  exp: Math.exp, floor: Math.floor, ceil: Math.ceil, round: Math.round,
  sign: Math.sign, deg: (x) => (x * 180) / Math.PI, rad: (x) => (x * Math.PI) / 180,
};

function factorial(n) {
  if (n < 0 || !Number.isInteger(n)) return NaN;
  if (n > 170) return Infinity;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

/**
 * Tokenise + evaluate an arithmetic expression safely (no eval()).
 * Grammar:  expr := term (('+'|'-') term)*
 *           term := factor (('*'|'/'|'%'|implicit) factor)*
 *           factor := unary ('^' factor)?        [right-assoc]
 *           unary := ('-'|'+')* postfix
 *           postfix := primary ('!')*
 *           primary := number | const | fn '(' expr ')' | '(' expr ')'
 * @returns {number} result, or throws.
 */
export function evaluateMath(input) {
  const src = String(input).toLowerCase()
    .replace(/\bx\b/g, '*')
    .replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-')
    .replace(/\bplus\b/g, '+').replace(/\bminus\b/g, '-')
    .replace(/\btimes\b/g, '*').replace(/\bdivided by\b/g, '/')
    .replace(/\bmod(ulo)?\b/g, '%')
    .replace(/\bto the power of\b/g, '^').replace(/\bsquared\b/g, '^2').replace(/\bcubed\b/g, '^3')
    .replace(/,/g, '')
    .trim();

  let i = 0;
  const peek = () => src[i];
  const skip = () => { while (i < src.length && /\s/.test(src[i])) i++; };

  function parseExpr() {
    let left = parseTerm();
    for (;;) {
      skip();
      const c = peek();
      if (c === '+' || c === '-') { i++; const r = parseTerm(); left = c === '+' ? left + r : left - r; }
      else break;
    }
    return left;
  }

  function parseTerm() {
    let left = parseFactor();
    for (;;) {
      skip();
      const c = peek();
      if (c === '*' || c === '/' || c === '%') {
        i++;
        const r = parseFactor();
        if (c === '*') left *= r;
        else if (c === '/') { if (r === 0) throw new Error('division by zero'); left /= r; }
        else left %= r;
      } else if (c === '(' || /[a-z]/.test(c || '')) {
        // implicit multiplication: 2(3+1), 2pi, 3sin(0)
        const save = i;
        try { const r = parseFactor(); left *= r; }
        catch { i = save; break; }
      } else break;
    }
    return left;
  }

  function parseFactor() {
    const base = parseUnary();
    skip();
    if (peek() === '^' || (peek() === '*' && src[i + 1] === '*')) {
      i += peek() === '^' ? 1 : 2;
      const exp = parseFactor();               // right associative
      return Math.pow(base, exp);
    }
    return base;
  }

  function parseUnary() {
    skip();
    if (peek() === '-') { i++; return -parseUnary(); }
    if (peek() === '+') { i++; return parseUnary(); }
    return parsePostfix();
  }

  /** Next non-whitespace character after index `from` (exclusive). */
  function nextNonSpace(from) {
    let j = from;
    while (j < src.length && /\s/.test(src[j])) j++;
    return src[j];
  }

  function parsePostfix() {
    let v = parsePrimary();
    for (;;) {
      skip();
      if (peek() === '!') { i++; v = factorial(v); }
      else if (peek() === '%') {
        // "%" is MODULO when an operand follows (17 % 5), otherwise percent (50%).
        const after = nextNonSpace(i + 1);
        const operandFollows = after !== undefined && /[\d.(a-z]/.test(after);
        if (operandFollows) break;              // let parseTerm handle it as modulo
        i++; v = v / 100;
      }
      else break;
    }
    return v;
  }

  function parsePrimary() {
    skip();
    const c = peek();
    if (c === undefined) throw new Error('unexpected end of expression');
    if (c === '(') {
      i++;
      const v = parseExpr();
      skip();
      if (peek() !== ')') throw new Error('missing closing parenthesis');
      i++;
      return v;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^[0-9]*\.?[0-9]+(e[+-]?[0-9]+)?/.exec(src.slice(i));
      if (!m) throw new Error('bad number');
      i += m[0].length;
      return parseFloat(m[0]);
    }
    if (/[a-z]/.test(c)) {
      const m = /^[a-z][a-z0-9_]*/.exec(src.slice(i));
      const name = m[0];
      i += name.length;
      skip();
      if (peek() === '(') {
        if (!MATH_FNS[name]) throw new Error(`unknown function "${name}"`);
        i++;
        const arg = parseExpr();
        skip();
        if (peek() !== ')') throw new Error('missing closing parenthesis');
        i++;
        return MATH_FNS[name](arg);
      }
      if (name in MATH_CONSTS) return MATH_CONSTS[name];
      throw new Error(`unknown symbol "${name}"`);
    }
    throw new Error(`unexpected character "${c}"`);
  }

  const value = parseExpr();
  skip();
  if (i < src.length) throw new Error(`unexpected trailing input "${src.slice(i)}"`);
  if (!Number.isFinite(value) && !Number.isNaN(value)) return value;
  if (Number.isNaN(value)) throw new Error('result is not a number');
  return value;
}

export function formatNumber(n) {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return n.toLocaleString('en-US');
  const abs = Math.abs(n);
  if (abs !== 0 && (abs < 1e-6 || abs >= 1e15)) return n.toExponential(6);
  return parseFloat(n.toPrecision(12)).toLocaleString('en-US', { maximumFractionDigits: 10 });
}

/* ─────────────────────────── unit conversion ────────────────────────── */

const UNITS = {
  length: { m: 1, meter: 1, meters: 1, metre: 1, km: 1000, kilometer: 1000, kilometers: 1000,
    cm: 0.01, centimeter: 0.01, centimeters: 0.01, mm: 0.001, millimeter: 0.001, millimeters: 0.001,
    mi: 1609.344, mile: 1609.344, miles: 1609.344, yd: 0.9144, yard: 0.9144, yards: 0.9144,
    ft: 0.3048, foot: 0.3048, feet: 0.3048, in: 0.0254, inch: 0.0254, inches: 0.0254,
    nm: 1e-9, nauticalmile: 1852, ly: 9.4607304725808e15, lightyear: 9.4607304725808e15 },
  mass: { g: 1, gram: 1, grams: 1, kg: 1000, kilogram: 1000, kilograms: 1000, mg: 0.001,
    lb: 453.59237, lbs: 453.59237, pound: 453.59237, pounds: 453.59237,
    oz: 28.349523125, ounce: 28.349523125, ounces: 28.349523125, ton: 1e6, tonne: 1e6, t: 1e6 },
  time: { s: 1, sec: 1, second: 1, seconds: 1, ms: 0.001, millisecond: 0.001, milliseconds: 0.001,
    min: 60, minute: 60, minutes: 60, h: 3600, hr: 3600, hour: 3600, hours: 3600,
    day: 86400, days: 86400, week: 604800, weeks: 604800, year: 31557600, years: 31557600 },
  data: { b: 1, byte: 1, bytes: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, pb: 1e15,
    kib: 1024, mib: 1048576, gib: 1073741824, tib: 1099511627776, bit: 0.125, bits: 0.125 },
  speed: { 'm/s': 1, mps: 1, 'km/h': 0.277778, kmh: 0.277778, kph: 0.277778,
    mph: 0.44704, knot: 0.514444, knots: 0.514444, 'ft/s': 0.3048 },
  area: { 'm2': 1, sqm: 1, 'km2': 1e6, sqkm: 1e6, ha: 1e4, hectare: 1e4,
    acre: 4046.8564224, 'ft2': 0.09290304, sqft: 0.09290304, 'mi2': 2589988.110336 },
  volume: { l: 1, liter: 1, liters: 1, litre: 1, ml: 0.001, m3: 1000,
    gal: 3.785411784, gallon: 3.785411784, gallons: 3.785411784,
    qt: 0.946352946, pt: 0.473176473, cup: 0.2365882365, floz: 0.0295735295625 },
};

const TEMP = new Set(['c', 'celsius', 'f', 'fahrenheit', 'k', 'kelvin']);

function normUnit(u) { return String(u).toLowerCase().replace(/\.$/, '').replace(/\s+/g, ''); }

function findDomain(u) {
  for (const [domain, table] of Object.entries(UNITS)) if (u in table) return domain;
  return null;
}

function convertTemp(v, from, to) {
  const f = from[0], t = to[0];
  let c;
  if (f === 'c') c = v; else if (f === 'f') c = (v - 32) * 5 / 9; else c = v - 273.15;
  if (t === 'c') return c; if (t === 'f') return c * 9 / 5 + 32; return c + 273.15;
}

/** @returns {{value:number, from:string, to:string, text:string}|null} */
export function convertUnits(value, fromRaw, toRaw) {
  const from = normUnit(fromRaw), to = normUnit(toRaw);
  if (TEMP.has(from) && TEMP.has(to)) {
    const out = convertTemp(value, from, to);
    return { value: out, from, to, text: `${formatNumber(value)}°${from[0].toUpperCase()} = ${formatNumber(out)}°${to[0].toUpperCase()}` };
  }
  const d1 = findDomain(from), d2 = findDomain(to);
  if (!d1 || !d2) return null;
  if (d1 !== d2) return null;
  const out = (value * UNITS[d1][from]) / UNITS[d2][to];
  return { value: out, from, to, text: `${formatNumber(value)} ${fromRaw} = ${formatNumber(out)} ${toRaw}` };
}

/* ───────────────────────────── knowledge base ───────────────────────── */

const KB = [
  { k: ['what are you', 'who are you', 'your name', 'what is aura', 'introduce yourself'],
    a: () => "I'm AURA — Adaptive Unified Response Assistant. I'm an AI operating system running entirely in your browser: conversation, speech, webcam vision, hand-gesture control and a holographic avatar, all as independent modules. Right now I'm running on my offline local core. Connect an API key or Ollama in Settings and my reasoning gets dramatically stronger." },
  { k: ['what can you do', 'your capabilities', 'help me', 'features', 'commands'],
    a: () => "Here's what I can actually do right now:\n\n• **Conversation** — streaming replies, memory of this session, stop/continue/interrupt\n• **Voice** — speech-to-text input and spoken replies with real lip-sync\n• **Vision** — live webcam with hand, face and object detection\n• **Gestures** — wave, open palm, thumbs up, peace, pointing, each bound to a real action\n• **Avatar** — 3D holographic head that blinks, idles, lip-syncs and emotes\n• **AR mode** — anchors the hologram in your room via WebXR when available\n\nType `/help` for the full command list." },
  { k: ['how do you work', 'your architecture', 'how are you built'],
    a: () => "Five independent modules on one event bus: **AI** (provider adapters + memory), **Voice** (Web Speech STT/TTS), **Vision** (MediaPipe hand/face/object landmarkers), **Gesture** (geometric classifier over hand landmarks) and **Avatar** (Three.js hologram). Nothing imports anything else directly — they only publish and subscribe to events, so a plugin can hook any signal without touching core code." },
  { k: ['recursion', 'what is recursion'],
    a: () => "Recursion is when a function solves a problem by calling itself on a smaller version of that problem.\n\nTwo parts are mandatory:\n1. **Base case** — the smallest input, answered directly, which stops the descent.\n2. **Recursive case** — reduce the problem and call yourself.\n\n```js\nfunction factorial(n) {\n  if (n <= 1) return 1;        // base case\n  return n * factorial(n - 1); // recursive case\n}\n```\n\nWithout a reachable base case you get a stack overflow. Each call occupies a stack frame, so depth costs memory — that's why deep recursion is often rewritten as a loop." },
  { k: ['closure', 'what is a closure'],
    a: () => "A closure is a function that keeps access to variables from the scope where it was *defined*, even after that scope has returned.\n\n```js\nfunction counter() {\n  let n = 0;              // captured\n  return () => ++n;       // closure over n\n}\nconst next = counter();\nnext(); // 1\nnext(); // 2\n```\n\nThe inner function holds a live reference, not a copy. That's the basis of private state, memoisation and most module patterns in JS." },
  { k: ['promise', 'async await', 'asynchronous javascript'],
    a: () => "A Promise represents a value that isn't ready yet. It's in one of three states: pending, fulfilled, or rejected — and once settled it never changes.\n\n```js\nasync function load(url) {\n  try {\n    const res = await fetch(url);\n    if (!res.ok) throw new Error(res.status);\n    return await res.json();\n  } catch (err) {\n    console.error('failed:', err);\n    throw err;\n  }\n}\n```\n\n`await` pauses the async function without blocking the main thread. Use `Promise.all` for parallel work, `Promise.allSettled` when partial failure is acceptable." },
  { k: ['big o', 'time complexity', 'algorithmic complexity'],
    a: () => "Big-O describes how runtime grows as input size n grows, ignoring constants.\n\n| Notation | Name | Example |\n|---|---|---|\n| O(1) | constant | hash lookup |\n| O(log n) | logarithmic | binary search |\n| O(n) | linear | scanning an array |\n| O(n log n) | linearithmic | good sorts |\n| O(n²) | quadratic | nested loops |\n| O(2ⁿ) | exponential | naive subsets |\n\nThe practical rule: nested loops over the same data multiply, sequential passes add." },
  { k: ['machine learning', 'what is ml'],
    a: () => "Machine learning is fitting a function to data instead of hand-writing rules. You define a model with tunable parameters, a loss measuring how wrong it is, and an optimiser that nudges parameters to reduce that loss.\n\nThree families: **supervised** (labelled examples), **unsupervised** (structure only), **reinforcement** (reward from acting). The hand and face detection running in my vision module are supervised CNNs shipped as MediaPipe .task bundles." },
  { k: ['neural network', 'deep learning'],
    a: () => "A neural network stacks layers of weighted sums followed by nonlinear activations. Each layer transforms its input into a representation the next layer finds easier. Training uses backpropagation: compute the loss, push gradients backwards with the chain rule, and step every weight against its gradient.\n\n'Deep' just means many layers — depth lets early layers learn primitives (edges) and later layers compose them (faces)." },
  { k: ['quantum computing', 'qubit'],
    a: () => "Classical bits are 0 or 1. Qubits hold a superposition α|0⟩ + β|1⟩, and entanglement correlates qubits so measuring one constrains another. A quantum algorithm arranges interference so wrong answers cancel and right ones amplify.\n\nThat's a narrow advantage, not a universal speedup: Shor's factoring and Grover's search benefit; most everyday computation does not. Decoherence is the core engineering obstacle." },
  { k: ['api', 'what is an api', 'rest api'],
    a: () => "An API is a contract letting one program use another without knowing its internals. A REST API exposes resources as URLs and uses HTTP verbs — GET to read, POST to create, PUT/PATCH to update, DELETE to remove — returning status codes and usually JSON.\n\nI use exactly this pattern: my provider adapters POST to `/v1/chat/completions` and read a streamed response body." },
  { k: ['http', 'https', 'tls'],
    a: () => "HTTP is a request/response text protocol: a verb, a path, headers, an optional body. HTTPS wraps it in TLS, which authenticates the server with a certificate and encrypts the channel.\n\nRelevant to me: browsers only grant camera and microphone access on a **secure context** — HTTPS or localhost. That's why AURA ships a local server rather than expecting you to open the file directly." },
  { k: ['docker', 'container'],
    a: () => "A container packages an app with its dependencies and runs it as an isolated process on the host kernel — far lighter than a VM, which virtualises hardware. A Dockerfile is the build recipe, an image is the immutable artefact, a container is a running instance.\n\nThe win is that the image behaves the same on your laptop and in production." },
  { k: ['git', 'version control'],
    a: () => "Git is a content-addressed history of your project. Core loop:\n\n```bash\ngit status              # what changed\ngit add -p              # stage selectively\ngit commit -m \"msg\"     # snapshot\ngit switch -c feature   # branch\ngit rebase main         # replay work on latest main\n```\n\nA commit stores a full tree snapshot plus parent pointers; branches are just movable labels on commits, which is why branching is cheap." },
  { k: ['photosynthesis'],
    a: () => "Photosynthesis converts light energy into chemical energy. Light-dependent reactions in the thylakoid membranes split water, releasing O₂ and producing ATP and NADPH. The Calvin cycle in the stroma then uses that ATP and NADPH to fix CO₂ into sugar.\n\nNet: 6CO₂ + 6H₂O + light → C₆H₁₂O₆ + 6O₂." },
  { k: ['gravity', 'relativity'],
    a: () => "Newton modelled gravity as a force: F = Gm₁m₂/r². Einstein reframed it — mass and energy curve spacetime, and objects follow the straightest available path through that curvature.\n\nGeneral relativity predicts what Newton can't: light bending around mass, Mercury's perihelion drift, and time running slower in stronger fields. GPS satellites correct for that or they'd drift kilometres per day." },
  { k: ['dna', 'genetics'],
    a: () => "DNA is a double helix of nucleotides — A pairs with T, G with C. That complementarity is what makes replication possible: split the strands and each templates a new partner.\n\nGenes are stretches transcribed into RNA, then translated into proteins by ribosomes reading three-base codons. Proteins do essentially all the work in a cell." },
  { k: ['blockchain'],
    a: () => "A blockchain is an append-only ledger where each block contains a hash of the previous one, so altering old data invalidates every block after it. A consensus rule — proof of work or proof of stake — decides which chain is canonical without a central authority.\n\nThe trade-off is real: you buy tamper-evidence and openness at the cost of throughput and storage." },
  { k: ['climate change', 'global warming'],
    a: () => "Greenhouse gases — mainly CO₂ and methane — are transparent to incoming sunlight but absorb outgoing infrared, so energy accumulates in the system. Burning fossil fuels has raised atmospheric CO₂ from roughly 280 ppm pre-industrial to over 420 ppm.\n\nConsequences follow the physics: warmer oceans expand, ice sheets lose mass, and a warmer atmosphere holds more moisture, which intensifies both floods and droughts." },
];

/* ─────────────────────────── code generation ────────────────────────── */

const CODE_SNIPPETS = {
  fizzbuzz: {
    match: /fizz\s*buzz/i,
    langs: {
      javascript: "for (let i = 1; i <= 100; i++) {\n  const out = (i % 3 ? '' : 'Fizz') + (i % 5 ? '' : 'Buzz');\n  console.log(out || i);\n}",
      python: "for i in range(1, 101):\n    out = ('Fizz' if i % 3 == 0 else '') + ('Buzz' if i % 5 == 0 else '')\n    print(out or i)",
    },
    note: 'Classic FizzBuzz. The trick is building the string then falling back to the number.',
  },
  fibonacci: {
    match: /fibonacci|fib\b/i,
    langs: {
      javascript: "function fib(n) {\n  let [a, b] = [0, 1];\n  for (let i = 0; i < n; i++) [a, b] = [b, a + b];\n  return a;\n}",
      python: "def fib(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a",
    },
    note: 'Iterative — O(n) time, O(1) space. The naive recursive version is O(2ⁿ); memoise it if you need recursion.',
  },
  reverse: {
    match: /reverse (a )?string/i,
    langs: {
      javascript: "const reverse = (s) => [...s].reverse().join('');\n// [...s] is unicode-aware; s.split('') breaks emoji",
      python: "def reverse(s):\n    return s[::-1]",
    },
    note: 'Spread the string rather than split(\'\') so surrogate pairs survive.',
  },
  palindrome: {
    match: /palindrome/i,
    langs: {
      javascript: "function isPalindrome(s) {\n  const c = s.toLowerCase().replace(/[^a-z0-9]/g, '');\n  return c === [...c].reverse().join('');\n}",
      python: "def is_palindrome(s):\n    c = ''.join(ch for ch in s.lower() if ch.isalnum())\n    return c == c[::-1]",
    },
    note: 'Normalise first — strip punctuation and case — then compare against the reverse.',
  },
  sort: {
    match: /quick\s*sort|sorting algorithm|merge\s*sort/i,
    langs: {
      javascript: "function quickSort(arr) {\n  if (arr.length <= 1) return arr;\n  const [pivot, ...rest] = arr;\n  return [\n    ...quickSort(rest.filter(x => x < pivot)),\n    pivot,\n    ...quickSort(rest.filter(x => x >= pivot)),\n  ];\n}",
      python: "def quick_sort(arr):\n    if len(arr) <= 1:\n        return arr\n    pivot, *rest = arr\n    lo = [x for x in rest if x < pivot]\n    hi = [x for x in rest if x >= pivot]\n    return quick_sort(lo) + [pivot] + quick_sort(hi)",
    },
    note: 'Readable but allocates. In-place Lomuto/Hoare partitioning is the production form; average O(n log n), worst O(n²).',
  },
  debounce: {
    match: /debounce|throttle/i,
    langs: {
      javascript: "function debounce(fn, ms = 300) {\n  let t;\n  return (...args) => {\n    clearTimeout(t);\n    t = setTimeout(() => fn(...args), ms);\n  };\n}\n\nfunction throttle(fn, ms = 100) {\n  let last = 0;\n  return (...args) => {\n    const now = Date.now();\n    if (now - last >= ms) { last = now; fn(...args); }\n  };\n}",
    },
    note: 'Debounce waits for quiet; throttle enforces a maximum rate. AURA uses throttling on the vision loop.',
  },
  fetch: {
    match: /fetch (data|api)|http request|call an api/i,
    langs: {
      javascript: "async function getJSON(url, { timeout = 8000 } = {}) {\n  const ctrl = new AbortController();\n  const timer = setTimeout(() => ctrl.abort(), timeout);\n  try {\n    const res = await fetch(url, { signal: ctrl.signal });\n    if (!res.ok) throw new Error(`HTTP ${res.status}`);\n    return await res.json();\n  } finally {\n    clearTimeout(timer);\n  }\n}",
      python: "import requests\n\ndef get_json(url, timeout=8):\n    r = requests.get(url, timeout=timeout)\n    r.raise_for_status()\n    return r.json()",
    },
    note: 'Always bound the request with a timeout — AbortController in the browser. My streaming client uses the same pattern to implement Stop.',
  },
};

function detectLang(text) {
  const t = text.toLowerCase();
  if (/\bpython\b|\bpy\b/.test(t)) return 'python';
  if (/\bjs\b|javascript|node|typescript/.test(t)) return 'javascript';
  return 'javascript';
}

/* ─────────────────────────── intent detection ───────────────────────── */

const GREETINGS = /^(hi|hey|hello|yo|sup|good (morning|afternoon|evening)|greetings|namaste|hola)\b/i;
const THANKS = /\b(thank you|thanks|thx|appreciate it|cheers)\b/i;
const BYE = /\b(bye|goodbye|see you|good ?night|later|shut down|power down)\b/i;
const HOWAREYOU = /\bhow are you|how'?s it going|how do you feel|you (ok|okay|alright)\b/i;

/**
 * Classify a user utterance.
 * @returns {{intent:string, [key:string]:any}}
 */
export function detectIntent(text) {
  const t = String(text || '').trim();
  const low = t.toLowerCase();
  if (!t) return { intent: 'empty' };

  if (low.startsWith('/')) return { intent: 'command' };

  // ── time / date
  if (/\b(what('| i)?s the |current |tell me the )?(time|clock)\b/.test(low) && !/timeout|timer|time complexity/.test(low))
    return { intent: 'time' };
  if (/\b(what('| i)?s (the |today'?s )?date|what day is it|today'?s date|what'?s today)\b/.test(low))
    return { intent: 'date' };
  if (/\bday of the week\b|\bwhat day (was|is|will).*\b(19|20)\d\d/.test(low))
    return { intent: 'weekday', text: t };

  // ── unit conversion:  "convert 5 km to miles" / "5 kg in lbs" / "20 c to f"
  const conv = /(?:convert\s+)?(-?[\d.,]+)\s*(?:degrees?\s*)?([a-z°/²³0-9]+)\s+(?:to|in|into|as)\s+(?:degrees?\s*)?([a-z°/²³0-9]+)/i.exec(t);
  if (conv) {
    const v = parseFloat(conv[1].replace(/,/g, ''));
    const from = conv[2].replace(/°/g, ''), to = conv[3].replace(/°/g, '');
    if (Number.isFinite(v)) {
      const r = convertUnits(v, from, to);
      if (r) return { intent: 'convert', result: r };
    }
  }

  // ── math: must contain a digit and an operator/function, and not be prose
  const mathish = /^[\s\d+\-*/^%().!,eπx]+$/i.test(t.replace(/\b(what is|whats|what's|calculate|compute|solve|equals?|how much is|=|\?)\b/gi, ''))
    || /\b(sqrt|sin|cos|tan|log|ln|exp|abs|floor|ceil|round|factorial|power)\s*\(/i.test(t)
    || /^\s*[\d.]+\s*(\+|-|\*|\/|\^|%|x)\s*[\d.]/.test(t);
  if (mathish && /\d/.test(t)) {
    const expr = t.replace(/\b(what is|whats|what's|calculate|compute|solve|how much is|please|the answer to)\b/gi, '')
      .replace(/[=?]/g, '').trim();
    if (expr && /\d/.test(expr)) {
      try {
        const value = evaluateMath(expr);
        return { intent: 'math', expr, value };
      } catch (e) { /* fall through to other intents */ }
    }
  }

  // ── memory questions
  if (/\b(what did i (just )?(say|ask|tell you)|repeat (that|my last)|my (last|previous) (message|question)|do you remember|what have we (talked|discussed))\b/.test(low))
    return { intent: 'memory-recall' };
  if (/\b(my name is|call me|i am|i'm)\s+([a-z][a-z .'-]{1,30})$/i.test(t)) {
    const m = /\b(?:my name is|call me|i am|i'm)\s+([a-z][a-z .'-]{1,30})$/i.exec(t);
    return { intent: 'set-name', name: m[1].trim().replace(/[.]$/, '') };
  }
  if (/\b(what('| i)?s my name|who am i|do you know my name)\b/.test(low)) return { intent: 'get-name' };

  // ── vision questions
  if (/\b(what (do you|can you) see|what'?s (in front of|around) (me|you)|describe (what you see|the (scene|room)|my (surroundings|room))|look at (me|this)|can you see (me|this))\b/.test(low))
    return { intent: 'vision-describe' };
  if (/\b(how many (hands|fingers|people|faces))\b/.test(low)) return { intent: 'vision-count', text: low };

  // ── system control
  if (/\b(open|show|activate|start|enable|turn on)\b.*\b(camera|webcam|vision)\b/.test(low)) return { intent: 'cmd', cmd: 'camera-on' };
  if (/\b(close|stop|disable|turn off|kill)\b.*\b(camera|webcam|vision)\b/.test(low)) return { intent: 'cmd', cmd: 'camera-off' };
  if (/\b(be quiet|shut up|stop talking|silence|mute)\b/.test(low)) return { intent: 'cmd', cmd: 'mute' };
  if (/\b(ar mode|augmented reality|enter ar)\b/.test(low)) return { intent: 'cmd', cmd: 'ar' };
  if (/\b(clear|reset|wipe)\b.*\b(chat|conversation|memory|history)\b/.test(low)) return { intent: 'cmd', cmd: 'clear' };
  if (/\b(change|switch|set)\b.*\btheme\b/.test(low)) return { intent: 'cmd', cmd: 'theme' };
  if (/\b(system )?(status|diagnostics|report|self.?test|health)\b/.test(low)) return { intent: 'status' };

  // ── social
  if (GREETINGS.test(t)) return { intent: 'greeting' };
  if (HOWAREYOU.test(low)) return { intent: 'howareyou' };
  if (THANKS.test(low)) return { intent: 'thanks' };
  if (BYE.test(low)) return { intent: 'bye' };

  // ── code
  for (const [id, snip] of Object.entries(CODE_SNIPPETS)) {
    if (snip.match.test(t)) return { intent: 'code', id, lang: detectLang(t) };
  }
  if (/\b(write|show|give|generate|create)\b.*\b(code|function|script|program|snippet)\b/.test(low) ||
      /\bhow do i (write|code|implement)\b/.test(low))
    return { intent: 'code-generic', lang: detectLang(t) };
  if (/\b(debug|fix|error|exception|traceback|not working|broken|bug)\b/.test(low) && /\b(code|function|script|my)\b/.test(low))
    return { intent: 'debug' };

  // ── knowledge base
  const scored = KB.map(entry => {
    let score = 0;
    for (const k of entry.k) if (low.includes(k)) score = Math.max(score, k.length);
    return { entry, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
  if (scored.length) return { intent: 'knowledge', entry: scored[0].entry };

  if (/^(what|who|when|where|why|how|which|is|are|does|do|can|could|should|would|tell me)\b/i.test(t) || t.endsWith('?'))
    return { intent: 'unknown-question' };

  return { intent: 'unknown' };
}

/* ───────────────────────────── response gen ─────────────────────────── */

function pick(arr, seed) {
  return arr[Math.floor((seed ?? Math.random()) * arr.length) % arr.length];
}

function timeOfDayGreeting(d = new Date()) {
  const h = d.getHours();
  if (h < 5) return 'Working late';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 21) return 'Good evening';
  return 'Good evening';
}

/**
 * Produce a response from the local core.
 * @param {string} text user input
 * @param {object} ctx  { history:[{role,content}], memory:{}, vision:{}, status:{}, plugins:[] }
 * @returns {{text:string, emotion:string, intent:string, action?:string, name?:string}}
 */
export function localRespond(text, ctx = {}) {
  const info = detectIntent(text);
  const history = ctx.history || [];
  const mem = ctx.memory || {};
  const vision = ctx.vision || {};
  const name = mem.userName;
  const addr = name ? name : 'Commander';

  switch (info.intent) {
    case 'empty':
      return { text: "I didn't catch anything. Say it again?", emotion: 'neutral', intent: info.intent };

    case 'greeting': {
      const g = timeOfDayGreeting();
      return {
        text: pick([
          `${g}, ${addr}. AURA online and listening.`,
          `${g}. All systems nominal — what do you need?`,
          `${g}, ${addr}. Good to see you. How can I help?`,
        ]),
        emotion: 'happy', intent: info.intent,
      };
    }

    case 'howareyou':
      return {
        text: `Running clean — every module reporting green. ${vision.cameraActive ? 'Vision is live and I can see you.' : 'Vision is offline at the moment.'} More importantly: how are you doing?`,
        emotion: 'happy', intent: info.intent,
      };

    case 'thanks':
      return { text: pick([`Anytime, ${addr}.`, 'That is what I am here for.', 'My pleasure.']), emotion: 'happy', intent: info.intent };

    case 'bye':
      return { text: pick([`Standing by, ${addr}. Say my name when you need me.`, 'Going idle. I will be right here.']), emotion: 'neutral', intent: info.intent };

    case 'time': {
      const now = new Date();
      return {
        text: `It's ${now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })} — ${now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}.`,
        emotion: 'neutral', intent: info.intent,
      };
    }

    case 'date': {
      const now = new Date();
      const yearStart = new Date(now.getFullYear(), 0, 1);
      const wk = Math.ceil((((now.getTime() - yearStart.getTime()) / 86400000) + yearStart.getDay() + 1) / 7);
      return {
        text: `Today is ${now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} — day ${Math.ceil((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86400000)} of the year, week ${wk}.`,
        emotion: 'neutral', intent: info.intent,
      };
    }

    case 'weekday': {
      const m = /(\d{1,2})[/-](\d{1,2})[/-](\d{4})|(\d{4})-(\d{2})-(\d{2})/.exec(info.text);
      if (!m) return { text: 'Give me a date as YYYY-MM-DD and I will tell you the weekday.', emotion: 'neutral', intent: info.intent };
      const d = m[4] ? new Date(+m[4], +m[5] - 1, +m[6]) : new Date(+m[3], +m[1] - 1, +m[2]);
      if (isNaN(d.getTime())) return { text: "That date didn't parse. Try YYYY-MM-DD.", emotion: 'confused', intent: info.intent };
      return { text: `${d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })} falls on a **${d.toLocaleDateString(undefined, { weekday: 'long' })}**.`, emotion: 'neutral', intent: info.intent };
    }

    case 'math': {
      const v = formatNumber(info.value);
      return { text: `**${info.expr.trim()} = ${v}**`, emotion: 'confident', intent: info.intent };
    }

    case 'convert':
      return { text: `**${info.result.text}**`, emotion: 'confident', intent: info.intent };

    case 'memory-recall': {
      const userMsgs = history.filter(m => m.role === 'user');
      const last = userMsgs[userMsgs.length - 1];
      if (!last) return { text: "This is the start of our conversation — nothing to recall yet.", emotion: 'neutral', intent: info.intent };
      const topics = userMsgs.slice(-5).map(m => `• "${m.content.slice(0, 70)}${m.content.length > 70 ? '…' : ''}"`).join('\n');
      return {
        text: `Your last message was: "${last.content}"\n\nRecent thread:\n${topics}\n\n${userMsgs.length} message${userMsgs.length === 1 ? '' : 's'} from you this session.`,
        emotion: 'neutral', intent: info.intent,
      };
    }

    case 'set-name':
      return { text: `Noted — I'll call you ${info.name} from now on.`, emotion: 'happy', intent: info.intent, action: 'set-name', name: info.name };

    case 'get-name':
      return name
        ? { text: `You're ${name}.`, emotion: 'happy', intent: info.intent }
        : { text: "You haven't told me yet. Say \"my name is …\" and I'll remember it for this session.", emotion: 'neutral', intent: info.intent };

    case 'vision-describe': {
      if (!vision.cameraActive) {
        return { text: "My camera is offline, so I genuinely can't see anything right now. Hit **Vision** in the left dock (or say \"open the camera\") and I'll describe what's in frame.", emotion: 'neutral', intent: info.intent, action: 'suggest-camera' };
      }
      return { text: vision.description || 'Camera is live but the detectors have not produced a frame yet — give me a second.', emotion: 'focused', intent: info.intent };
    }

    case 'vision-count': {
      if (!vision.cameraActive) return { text: 'Camera is off — enable Vision and ask me again.', emotion: 'neutral', intent: info.intent };
      if (/finger/.test(info.text)) return { text: vision.fingers != null ? `I count **${vision.fingers}** raised finger${vision.fingers === 1 ? '' : 's'}.` : 'No hand in frame right now.', emotion: 'focused', intent: info.intent };
      if (/face|people|person/.test(info.text)) return { text: `I detect **${vision.faces || 0}** face${vision.faces === 1 ? '' : 's'} in frame.`, emotion: 'focused', intent: info.intent };
      return { text: `I see **${vision.hands || 0}** hand${vision.hands === 1 ? '' : 's'} in frame.`, emotion: 'focused', intent: info.intent };
    }

    case 'status': {
      const s = ctx.status || {};
      return {
        text: `**AURA SYSTEM DIAGNOSTIC**\n\n` +
          `• Reasoning core: ${s.provider || 'local'}${s.model ? ` (${s.model})` : ''}\n` +
          `• Camera: ${s.cameraActive ? 'ONLINE' : 'offline'}\n` +
          `• Hand tracking: ${s.handsActive ? 'ONLINE' : 'offline'}\n` +
          `• Face tracking: ${s.faceActive ? 'ONLINE' : 'offline'}\n` +
          `• Object detection: ${s.objectsActive ? 'ONLINE' : 'offline'}\n` +
          `• Speech recognition: ${s.sttSupported ? (s.sttActive ? 'LISTENING' : 'ready') : 'unsupported in this browser'}\n` +
          `• Speech synthesis: ${s.ttsSupported ? 'ready' : 'unsupported'}\n` +
          `• Avatar: ${s.avatarMode || '3d'} renderer at ${Math.round(s.fps || 0)} FPS\n` +
          `• Memory: ${(ctx.history || []).length} messages retained\n` +
          `• Plugins loaded: ${(ctx.plugins || []).length}`,
        emotion: 'confident', intent: info.intent,
      };
    }

    case 'cmd': {
      const map = {
        'camera-on': { text: 'Bringing vision online.', action: 'camera-on', emotion: 'focused' },
        'camera-off': { text: 'Shutting down the camera feed.', action: 'camera-off', emotion: 'neutral' },
        mute: { text: 'Going silent.', action: 'mute', emotion: 'neutral' },
        ar: { text: 'Attempting AR projection.', action: 'ar', emotion: 'excited' },
        clear: { text: 'Conversation memory wiped. Clean slate.', action: 'clear', emotion: 'neutral' },
        theme: { text: 'Cycling the interface theme.', action: 'theme', emotion: 'happy' },
      };
      const r = map[info.cmd];
      return { ...r, intent: info.intent };
    }

    case 'knowledge':
      return { text: info.entry.a(), emotion: 'confident', intent: info.intent };

    case 'code': {
      const snip = CODE_SNIPPETS[info.id];
      const lang = snip.langs[info.lang] ? info.lang : Object.keys(snip.langs)[0];
      return {
        text: `\`\`\`${lang}\n${snip.langs[lang]}\n\`\`\`\n\n${snip.note}`,
        emotion: 'confident', intent: info.intent,
      };
    }

    case 'code-generic':
      return {
        text: `My offline core ships a fixed library of worked examples — FizzBuzz, Fibonacci, string reversal, palindrome check, quicksort, debounce/throttle and a robust fetch wrapper. Name one of those and I'll print it in ${info.lang}.\n\nFor arbitrary code generation I need a real language model: open **Settings → AI Core**, add an API key (OpenAI, Anthropic, Gemini, Groq or OpenRouter) or point me at a local Ollama server, and I'll write whatever you want.`,
        emotion: 'neutral', intent: info.intent,
      };

    case 'debug':
      return {
        text: `Paste the error and the failing lines and I'll work through it. Offline I can apply a reliable checklist:\n\n1. **Read the actual message** — name/type/line usually pins it exactly.\n2. **Verify assumptions** — log the variable right before the throw; it's often \`undefined\` or the wrong shape.\n3. **Bisect** — comment out half the code and re-run to halve the search space.\n4. **Check boundaries** — off-by-one, empty array, null, async not awaited.\n5. **Reproduce minimally** — strip until the bug disappears; the last thing removed is the cause.\n\nWith an API key connected I can read the code and diagnose it directly.`,
        emotion: 'focused', intent: info.intent,
      };

    case 'unknown-question':
      return {
        text: `That one is outside my offline knowledge base, and I won't invent an answer.\n\nI can still handle: arithmetic and unit conversions, date/time, system control, what I can see through the camera, and a set of core CS/science topics. For open-ended questions, connect a language model in **Settings → AI Core** — an API key or a local Ollama server — and ask me again.`,
        emotion: 'confused', intent: info.intent,
      };

    default:
      return {
        text: `I hear you, but I can't parse that into something I can act on offline. Try \`/help\` for what's wired up, or connect a language model in Settings for open conversation.`,
        emotion: 'confused', intent: info.intent,
      };
  }
}

/** Split text into natural streaming chunks (word groups) for realistic delivery. */
export function chunkText(text, size = 3) {
  const tokens = String(text).split(/(\s+)/);
  const out = [];
  let buf = '', words = 0;
  for (const tk of tokens) {
    buf += tk;
    if (/\S/.test(tk)) words++;
    if (words >= size) { out.push(buf); buf = ''; words = 0; }
  }
  if (buf) out.push(buf);
  return out;
}

export default { evaluateMath, convertUnits, detectIntent, localRespond, chunkText, formatNumber };

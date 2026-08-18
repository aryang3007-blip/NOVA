/**
 * AURA :: Built-in Self-Documentation
 * -----------------------------------
 * Answers "how do I use this?" with ZERO model required.
 *
 * This is the one kind of question AURA should never need an LLM for — it is
 * documentation about itself, and the answers are deterministic. It also
 * inspects live state, so guidance reflects reality: if your camera is
 * already on, it says so instead of telling you to enable it.
 *
 * Runs at the LOCAL router stage, above web lookup, so it is instant and free.
 *
 * @module ai/guide
 */

/**
 * @typedef {Object} GuideEntry
 * @property {RegExp[]} match
 * @property {(ctx:object)=>string} answer
 * @property {string} topic
 */

/** @type {GuideEntry[]} */
const GUIDE = [
  /* ── getting started ─────────────────────────────────────────────── */
  {
    topic: 'overview',
    match: [
      /\bhow (do i|to|can i) use (this|the app|aura|you)\b/i,
      /\bhow does (this|aura) work\b/i,
      /\bwhat (is|does) this (app|thing)\b/i,
      /\bgetting started\b/i,
      /\bhelp me get started\b/i,
      /\bwhere (do i|should i) start\b/i,
    ],
    answer: (c) => {
      const brain = c.provider === 'Local Core'
        ? `You're on my **offline core** right now — I handle maths, time, unit conversion, this guide, and everything below without any model. For real conversation, connect Ollama (see "how do I set up Ollama").`
        : `You're connected to **${c.provider}**${c.model ? ` running \`${c.model}\`` : ''}, so full conversation is live.`;
      return `**Using AURA**

${brain}

**Four ways to interact:**

1. **Type** — this box. Try \`what is 47*89\`, \`weather in Delhi\`, or \`/help\`.
2. **Speak** — click 🎙 or press **Space**. ${c.sttSupported ? 'Ready to go.' : '_Not supported in this browser — use Chrome or Edge._'}
3. **Gesture** — enable **Vision**, then wave, point, or give a thumbs up.
4. **Commands** — anything starting with \`/\`. There are ${c.commandCount} of them.

**The panels** (left dock):
• **CHAT** — conversation
• **VISION** — camera, hand/face tracking
• **GESTURE** — what each gesture does
• **OPS** — live system command center
• **STYLE** — avatar wardrobe
• **SYSTEM** — diagnostics

Ask me *"what can you do"*, *"how do gestures work"*, or *"how do I set up Ollama"* for detail on any of it.`;
    },
  },

  /* ── ollama ──────────────────────────────────────────────────────── */
  {
    topic: 'ollama',
    match: [
      /\bhow (do i|to) (set ?up|install|configure|connect|use)\b.*\bollama\b/i,
      /\bollama\b.*\b(setup|install|not working|isn'?t working|connect|configure)\b/i,
      /\bconnect (a |an )?(model|llm|ai)\b/i,
      /\bhow (do i|to) (add|get) (a )?(model|brain|llm)\b/i,
      /\bwhy (is|are) (there )?no (model|ai|brain)\b/i,
    ],
    answer: (c) => {
      const live = c.ollamaReady;
      return `**Connecting Ollama**

${live
  ? `✅ Ollama is **already connected**${c.ollamaModel ? ` and I'm using \`${c.ollamaModel}\`` : ''}. Nothing to do.`
  : `⚪ Ollama is **not detected** right now.`}

**Setup:**

1. Install from [ollama.com/download](https://ollama.com/download)
2. Pull a model — a small one is ideal for chat:
   \`\`\`bash
   ollama pull gemma2:2b
   \`\`\`
3. Make sure AURA is running through its own server:
   \`\`\`bash
   python3 serve.py --allow-actions
   \`\`\`
4. Reload this page.

**You do NOT need \`OLLAMA_ORIGINS\`.** AURA proxies Ollama through its own server at \`/api/ollama\`, so it's same-origin and CORS never applies. That's the usual reason browser apps fail to reach Ollama.

Type \`/models\` to see what's installed and which model I'm routing each task to.`;
    },
  },

  /* ── model routing ───────────────────────────────────────────────── */
  {
    topic: 'models',
    match: [
      /\bwhich model\b.*\b(using|do you use|are you)\b/i,
      /\bwhat model (are you|is)\b/i,
      /\bhow (do you|does aura) (choose|pick|select)\b.*\bmodel\b/i,
      /\bmodel routing\b/i,
      /\bwhy (is it|are you) so slow\b/i,
    ],
    answer: (c) => `**How I pick a model**

${c.model ? `Right now: \`${c.model}\` via ${c.provider}.` : `Right now: **${c.provider}** (no Ollama model selected).`}

I read your installed models from Ollama and route by task:

| Task | What I look for |
|---|---|
| Chat | smallest/fastest model |
| Code | a \`coder\`-named model |
| Reasoning | an \`r1\`/reasoning model |
| Tools | a tool-calling family |

**Large models are excluded from automatic routing.** Anything above the size ceiling (default **9B**) is never auto-selected, because a 20B or 30B model can take minutes per reply on a typical machine. Those stay available — you just have to pin them deliberately in **Settings → AI Core**.

I also measure real throughput as you use each model, and demote anything that turns out slow on your hardware regardless of its size.

Type \`/models\` for the full breakdown.`,
  },

  /* ── gestures ────────────────────────────────────────────────────── */
  {
    topic: 'gestures',
    match: [
      /\bhow (do|does)\b.*\bgestures?\b.*\bwork\b/i,
      /\bhow (do i|to) use gestures?\b/i,
      /\bwhat gestures?\b/i,
      /\bgesture (control|list|commands)\b/i,
      /\bhand (tracking|gestures)\b/i,
    ],
    answer: (c) => `**Gesture control**

${c.cameraActive ? '✅ Camera is live — gestures are active right now.' : '⚪ Camera is off. Open **VISION** → **ENABLE CAMERA**, or just say *"open the camera"*.'}

Hold a pose steady for about half a second:

| | Gesture | What happens |
|---|---|---|
| 👋 | Wave | I greet you out loud |
| 🖐 | Open palm | Starts listening (and interrupts my speech) |
| 👍 | Thumbs up | Confirms a pending action |
| 👎 | Thumbs down | Cancels / stops generation |
| ✌ | Peace | Opens the chat panel |
| ☝ | Point | Reticle tracks your fingertip |
| ✊ | Fist | Hard stop — halts generation and speech |
| 👌 | OK | Spoken systems check |
| 🤘 | Rock on | Toggles background music |

There's a **2.2 second cooldown** per gesture so you don't fire the same one repeatedly. Adjust it in **Settings → Vision**.`,
  },

  /* ── voice ───────────────────────────────────────────────────────── */
  {
    topic: 'voice',
    match: [
      /\bhow (do i|to) (use|enable|turn on)\b.*\b(voice|speech|mic|microphone|talk)\b/i,
      /\b(voice|mic|microphone)\b.*\bnot working\b/i,
      /\bhow (do i|to) talk to you\b/i,
      /\bwake word\b/i,
    ],
    answer: (c) => `**Talking to me**

${c.sttSupported
  ? `✅ Speech recognition is available.${c.sttActive ? ' I\'m listening right now.' : ''}`
  : `❌ This browser doesn't support the Web Speech API. Chrome, Edge and Safari do — Firefox does not. Typing works everywhere.`}

**To speak:** click the 🎙 button, press **Space**, or show an open palm to the camera.

**Wake word:** enable it in **Settings → Voice**, then say *"${c.wakeWord}"* followed by your request. It keeps the mic open continuously, so Chrome will show a persistent recording indicator.

**My voice:** ${c.ttsEnabled ? 'enabled' : 'muted'} — toggle with **M** or the VOICE button. Pick a different voice in **Settings → Voice**; \`/voices\` lists what your system has.

**To interrupt me:** press **Esc**, show a fist, or hit the INTERRUPT chip.

_If the mic silently does nothing, click **VISION → WHY ISN'T IT WORKING?** — it reports the exact cause._`,
  },

  /* ── desktop control ─────────────────────────────────────────────── */
  {
    topic: 'desktop',
    match: [
      /\bhow (do i|to)\b.*\b(open|launch)\b.*\b(apps?|applications?|programs?)\b/i,
      /\bdesktop (control|integration|actions?)\b/i,
      /\bcan you (open|launch|control)\b.*\b(my|apps?|computer|pc)\b/i,
      /\bwhy can'?t you open\b/i,
      /\bhow (do i|to) (enable|grant) permissions?\b/i,
    ],
    answer: (c) => `**Controlling your computer**

${c.desktopSimulated
  ? `⚠ Currently **simulated** — no desktop host process is running, so actions are mocked and I'll say \`[SIMULATED]\`.\n\nTo make it real:\n\`\`\`bash\npython3 serve.py --allow-actions\n\`\`\``
  : `✅ **Live** on ${c.platform || 'this machine'} — real actions are enabled.`}

**Permissions are denied by default.** Grant them in **Settings → Desktop → Permissions**. You currently have **${c.permsGranted}/${c.permsTotal}** granted.

**Then just ask:**
\`\`\`
open whatsapp          play music
open spotify           next song
volume 40              take a screenshot
\`\`\`

Or use \`/open <app>\`, \`/apps\`, \`/media\`, \`/volume\`, \`/screen\`.

**Safety:** every action goes through an Action Manager that validates the request, checks permissions, rate-limits, and asks you to confirm destructive ones. I never run shell commands directly — only allowlisted actions.`,
  },

  /* ── camera / vision ─────────────────────────────────────────────── */
  {
    topic: 'vision',
    match: [
      /\bhow (do i|to) (use|enable|turn on)\b.*\b(camera|vision|webcam)\b/i,
      /\b(camera|webcam)\b.*\b(not working|won'?t start|blocked)\b/i,
      /\bwhat can you see\b.*\bhow\b/i,
    ],
    answer: (c) => `**Vision**

${c.cameraActive
  ? `✅ Camera is live. Detecting **${c.hands}** hand(s), **${c.faces}** face(s)${c.objects ? `, **${c.objects}** object(s)` : ''}.`
  : '⚪ Camera is off. Open **VISION** → **ENABLE CAMERA**, or say *"open the camera"*.'}

**What runs locally on your machine (nothing is uploaded):**
• Hand tracking — 21 landmarks per hand, drives gestures
• Face tracking — 478 landmarks + expression detection
• Object detection — 80 everyday classes (opt-in; it's the heaviest model)

Ask *"what do you see"* any time for a description.

**If it won't start:** the camera needs a **secure context** — \`localhost\` or \`https\`. Opening the HTML file directly (\`file://\`) will always be blocked. The **WHY ISN'T IT WORKING?** button diagnoses the exact reason.`,
  },

  /* ── privacy ─────────────────────────────────────────────────────── */
  {
    topic: 'privacy',
    match: [
      /\b(is|are)\b.*\b(this|my data|my camera|my voice)\b.*\b(private|safe|secure|uploaded|sent)\b/i,
      /\bprivacy\b/i,
      /\bdo you (send|upload|store|record)\b.*\b(my|data|video|audio)\b/i,
      /\bwhere (is|does) my data\b/i,
    ],
    answer: (c) => `**Privacy**

**Never leaves your machine:**
• Camera frames — hand/face/object detection runs locally via MediaPipe
• Microphone audio — except as noted below
• Your API keys — stored in this browser's localStorage only
• Conversation memory, preferences, stored knowledge

**Does leave your machine:**
• Chat text, **only** if you've connected a cloud provider. With Ollama or the offline core, nothing leaves at all${c.provider === 'Local Core' || c.provider?.includes('Ollama') ? ' — which is your current setup.' : `. You're currently on **${c.provider}**, so messages go there.`}
• Live-data lookups (weather, news, prices) hit public APIs. \`/offline on\` disables all of them.
• ⚠ **Speech recognition:** Chrome's Web Speech API sends audio to Google's servers. That's the browser's implementation, not mine — there is no local speech recognition available in-browser.

AURA has no backend of its own and no telemetry. Nothing is collected about you.`,
  },

  /* ── commands ────────────────────────────────────────────────────── */
  {
    topic: 'commands',
    match: [
      /\bwhat commands?\b/i,
      /\blist (of )?commands?\b/i,
      /\bhow (do i|to) use commands?\b/i,
      /\bslash commands?\b/i,
    ],
    answer: (c) => `**Commands**

There are **${c.commandCount}** across **${c.pluginCount}** plugins. Type \`/help\` for the complete list.

**Most useful:**
\`\`\`
/help          every command
/models        installed models + routing
/runtime       layer + hardware status
/status        full diagnostics
/selftest      live subsystem checks
/why <text>    explain how I'd route something
\`\`\`

**Live data:** \`/weather\` \`/news\` \`/crypto\` \`/fx\` \`/wiki\` \`/define\` \`/repo\`
**Desktop:** \`/open\` \`/apps\` \`/media\` \`/volume\` \`/screen\`
**Memory:** \`/remember\` \`/recall\` \`/learn\` \`/forget\`
**Other:** \`/theme\` \`/outfit\` \`/color\` \`/offline\` \`/export\``,
  },

  /* ── troubleshooting ─────────────────────────────────────────────── */
  {
    topic: 'troubleshooting',
    match: [
      // "nothing is working" / "it's not working" / "this isn't working".
      // The earlier pattern required "not working" to directly follow the
      // subject, so "nothing is working" (no "not") never matched.
      /\b(nothing|nothings|it|this|aura)\b.*\b(not working|isn'?t working|won'?t work|is working)\b/i,
      /\bnothing (is )?work/i,
      /\bwhy (isn'?t|is|are|does|doesn'?t)\b.*\b(work|working|broken|failing)\b/i,
      /\btroubleshoot/i,
      /\bhow (do i|to) fix\b/i,
      /\bsomething (is |seems )?(broken|wrong|off)\b/i,
      /\b(broken|not responding|stuck)\b/i,
    ],
    answer: (c) => `**Troubleshooting**

Run \`/selftest\` first — it exercises every subsystem and reports what's actually failing.

**Common causes:**

**No AI replies / only basic answers**
→ No model connected. You're on **${c.provider}**. Ask *"how do I set up Ollama"*.

**Camera or mic blocked**
→ Needs \`localhost\` or \`https\`. \`file://\` never works. Click **VISION → WHY ISN'T IT WORKING?**

**Ollama not detected**
→ Is \`ollama serve\` running? Is AURA started via \`python3 serve.py\`? Opening \`index.html\` directly disables the proxy.

**"Open whatsapp" only simulates**
→ Restart with \`python3 serve.py --allow-actions\` and grant **Launch Applications** in Settings → Desktop.

**Replies are very slow**
→ A large model is likely selected. \`/models\` shows which; pick something smaller for chat.

Current state: ${c.provider} · camera ${c.cameraActive ? 'on' : 'off'} · desktop ${c.desktopSimulated ? 'simulated' : 'live'} · ${c.permsGranted}/${c.permsTotal} permissions`,
  },

  /* ── keyboard ────────────────────────────────────────────────────── */
  {
    topic: 'shortcuts',
    match: [/\b(keyboard )?shortcuts?\b/i, /\bhotkeys?\b/i, /\bkey ?bindings?\b/i],
    answer: () => `**Keyboard shortcuts**

\`\`\`
Enter        send message
Shift+Enter  new line
Space        toggle microphone
Esc          stop generation and speech
M            mute / unmute my voice
T            cycle theme
,            open settings
/            focus input
\`\`\``,
  },
];

/**
 * Try to answer a "how does this work" question from the built-in guide.
 * @param {string} text
 * @param {object} ctx live state snapshot
 * @returns {{topic:string, text:string}|null}
 */
export function matchGuide(text, ctx = {}) {
  const t = String(text || '').trim();
  if (!t || t.length < 4) return null;
  for (const entry of GUIDE) {
    for (const rx of entry.match) {
      if (rx.test(t)) {
        try { return { topic: entry.topic, text: entry.answer(ctx) }; }
        catch (e) { return null; }
      }
    }
  }
  return null;
}

export const GUIDE_TOPICS = GUIDE.map(g => g.topic);
export default matchGuide;

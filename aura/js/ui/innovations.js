/**
 * AURA :: Innovations (hidden page)
 * ---------------------------------
 * A private idea board. Not linked from any menu, not listed in /help, and
 * not discoverable by clicking around — reachable only by typing the unlock
 * sequence (`aura`) or the hidden `/innovations` command.
 *
 * These are deliberately NOT "add more chatbot features". Each one is chosen
 * because AURA already has the hard parts in place — a webcam vision
 * pipeline, gesture classification, a 19-bone avatar, a permissioned desktop
 * bridge, an event bus that sees everything, and a local model. The ideas
 * combine those in ways an ordinary assistant cannot.
 *
 * Every entry states honestly what already exists versus what would be new.
 *
 * @module ui/innovations
 */

/**
 * @typedef {Object} Innovation
 * @property {string}   title
 * @property {string}   tag        one-line hook
 * @property {string}   idea       what it does
 * @property {string}   why        why it is genuinely different
 * @property {string}   have       what AURA already has that makes it feasible
 * @property {string}   needs      the honest missing piece
 * @property {'low'|'medium'|'high'} lift
 */

/** @type {Innovation[]} */
export const INNOVATIONS = [
  {
    title: 'Ambient Home Presence',
    tag: 'The house reacts to the room, not to commands.',
    idea: 'Smart-home control, but driven by what AURA already senses rather than by voice commands: lights warm when the camera says the room went dark, media pauses when you leave, the desk lamp follows your focus state.',
    why: 'Deliberately DROPPED from the build roadmap — every ecosystem (Hue, Home Assistant, Matter) is a separate integration and it would derail work on the assistant itself. It stays here because the interesting part is not the switching, it is the sensing, and AURA already has that.',
    have: 'Presence via face detection, focus state from the emotion system, the plugin API and the permission model.',
    needs: 'One integration to start with — Home Assistant\'s REST API is the most general.',
    lift: 'medium',
  },
  {
    title: 'Presence-Aware Ambient Mode',
    tag: 'The room, not the app, is the interface.',
    idea: 'Face detection already runs. Use *presence* rather than identity: when you leave, AURA pauses media, mutes TTS mid-sentence and dims to a low-power idle. When you sit back down it silently resumes the exact sentence it was cut off on.',
    why: 'Every assistant waits to be addressed. This one notices you stopped listening. No wake word, no click — the absence of a face is the command.',
    have: 'MediaPipe face landmarker, TTS interrupt/resume, the event bus, media control via the bridge.',
    needs: 'A debounce so a sneeze does not pause your film, and a "presence" state on the bus.',
    lift: 'low',
  },
  {
    title: 'Gesture Macros — record your own',
    tag: 'Teach it a sign, bind it to anything.',
    idea: 'Record a hand movement a few times; AURA stores the landmark trajectory and matches future motion against it with dynamic time warping. Bind the new gesture to any tool call — a terminal command, an app launch, a scene.',
    why: 'The nine built-in gestures are somebody else\'s vocabulary. This makes gesture control *yours*, and DTW means it works for motions no classifier was trained on.',
    have: '21-landmark hand tracking at 24fps, WaveDetector proves temporal matching works, the tool-call layer, the permission gate.',
    needs: 'A DTW matcher (~120 lines) and a small recording UI.',
    lift: 'medium',
  },
  {
    title: 'The Session Flight Recorder',
    tag: 'Rewind your own workday.',
    idea: 'The bus already sees every event. Persist a ring buffer of them with timestamps, then offer a scrubber: "what was I doing at 3pm?" replays the actual sequence — apps launched, questions asked, gestures made, errors hit.',
    why: 'Not a chat log. A behavioural trace of a whole session that you can scrub, search and ask questions about. Debugging your day rather than your code.',
    have: 'ActivityFeed already wildcard-subscribes to every event; storage layer exists.',
    needs: 'Durable ring buffer + a timeline UI. Must stay local-only and be trivially wipeable.',
    lift: 'medium',
  },
  {
    title: 'Explain-My-Screen',
    tag: 'Point at confusion, get an answer.',
    idea: 'Screenshot capture already works. Combine it with a local vision model (llava / moondream via Ollama) so you can ask "what is this dialog asking me?" and AURA answers from what is actually on screen — no copy-paste.',
    why: 'Turns the assistant from something you describe things to, into something that looks with you. Entirely local, so screenshots never leave the machine.',
    have: 'bridge.screenshot(), the Ollama proxy, model registry that auto-detects vision-capable models.',
    needs: 'SHIPPED for the webcam — /look sends the frame to a vision model. What remains is doing the same for a SCREENSHOT, plus a redaction pass before anything is sent.',
    lift: 'medium',
  },
  {
    title: 'Avatar as Status Instrument',
    tag: 'Read the machine by looking at the face.',
    idea: 'Bind avatar micro-behaviour to real telemetry: breathing rate tracks CPU load, blink rate slows as RAM fills, posture sags when the disk is nearly full, a subtle flinch on an error event.',
    why: 'Peripheral vision reads body language faster than it reads numbers. You would feel the machine struggling before you looked at a graph. Genuinely novel — nobody uses an avatar as an ambient gauge.',
    have: 'Live psutil metrics, a 19-bone rig with breathing/blink/posture channels already animated.',
    needs: 'A mapping layer, and a hard rule that it never becomes distracting.',
    lift: 'low',
  },
  {
    title: 'Consequence Preview for Dangerous Actions',
    tag: 'See the blast radius before you say yes.',
    idea: 'Before any destructive action, AURA does a dry run and shows exactly what would change: which files, how many bytes, whether it is reversible — then asks. Terminal commands get parsed and explained in plain English first.',
    why: 'Confirmation dialogs train you to click yes. A dialog that says "this deletes 1,204 files in Documents, not reversible" does not.',
    have: 'The permission system, confirm flags, and inspect_command() which already classifies without executing.',
    needs: 'Per-action dry-run implementations and a diff-style preview panel.',
    lift: 'medium',
  },
  {
    title: 'Two-Model Debate',
    tag: 'Make your local models argue.',
    idea: 'For a hard question, run two installed models with opposing briefs — one proposes, one critiques — for a couple of rounds, then have the faster model summarise where they agreed and where they did not.',
    why: 'You own several models and only ever use one at a time. Disagreement between them is a genuine, free signal about answer confidence that a single model cannot give you.',
    have: 'Model registry with capability profiles, task routing, the streaming engine.',
    needs: 'An orchestration loop and a UI showing both positions. Slow — an opt-in "deep think" button.',
    lift: 'medium',
  },
  {
    title: 'Spatial Desktop Memory',
    tag: 'Remember where, not just what.',
    idea: 'Anchor notes to physical space via the webcam: turn to a corner of your desk, leave a spoken note, and it is there when you look back. Uses camera orientation and background features as the anchor.',
    why: 'Human memory is spatial. This gives digital notes a location instead of a filename, and it needs no headset — just the webcam already running.',
    have: 'Camera pipeline, AR module with hit-testing, TTS/STT, the memory system.',
    needs: 'Lightweight visual place recognition. The honest hard part: it must survive lighting changes.',
    lift: 'high',
  },
  {
    title: 'Self-Healing Diagnostics',
    tag: 'It finds its own bugs and offers the patch.',
    idea: 'AURA already ships an architecture test suite. Let it run those checks against itself on demand, and when something fails, use the local coding model to propose a diff — shown to you, never auto-applied.',
    why: 'The project already caught 30+ of its own bugs through tests. Closing that loop makes the assistant a maintainer of itself, with you as the reviewer.',
    have: 'test-architecture.mjs, the file-system plugin, qwen2.5-coder in the model registry.',
    needs: 'A patch-proposal UI and an absolute rule: propose, never apply.',
    lift: 'high',
  },
  {
    title: 'Focus Contracts',
    tag: 'Ask it to hold you to something.',
    idea: '"Keep me off YouTube until 5pm." AURA holds the contract, and when you ask it to launch a blocked app it refuses *and reminds you of the deal you made*. You can always override, but the override is logged and it tells you how many times you have broken it.',
    why: 'Blockers are adversarial and get uninstalled. An assistant that remembers your own stated intent and reflects it back is social, not technical — much harder to argue with.',
    have: 'App launcher intercepts every launch, memory system, the permission model.',
    needs: 'A contract store with expiry, and careful tone — supportive, never nagging.',
    lift: 'low',
  },
  {
    title: 'Voice Fingerprint Privacy Lock',
    tag: 'It answers you, not your speakers.',
    idea: 'Learn a coarse embedding of your voice from a short enrolment. Commands that do not match get transcribed but not executed — perfect for guarding desktop actions when a video is playing.',
    why: 'A natural extension of the echo suppression already built: instead of only ignoring AURA\'s own voice, ignore *every* voice that is not yours.',
    have: 'The half-duplex echo guard, Web Audio access, the permission layer as the enforcement point.',
    needs: 'Browser-side speaker embedding (hard without a model) — likely needs a small ONNX model or the native companion.',
    lift: 'high',
  },
  {
    title: 'Offline-First Knowledge Garden',
    tag: 'Your notes become the model\'s context.',
    idea: 'Point AURA at a folder of markdown. It embeds it locally via Ollama, and every answer is grounded in your own notes, with citations back to the file and line.',
    why: 'Turns the assistant from something with generic knowledge into something with *your* knowledge — and because embeddings run through local Ollama, nothing is uploaded.',
    have: 'VectorStore scaffolding, the file-system plugin, Ollama /api/embeddings, the memory manager.',
    needs: 'SHIPPED in part — VectorStore now embeds through Ollama and searches by cosine similarity. What remains is pointing it at a folder and watching for changes.',
    lift: 'medium',
  },
];

/** Render the hidden page. */
export function renderInnovations(host) {
  if (!host) return;
  const lift = (l) => `<span class="innov-lift ${l}">${l} lift</span>`;
  host.innerHTML = `
    <p class="innov-intro">
      Private idea board — not linked anywhere in the UI. Each entry says what
      already exists versus what would genuinely need building, so nothing here
      reads as a promise that has already been kept.
    </p>
    ${INNOVATIONS.map((v, i) => `
      <article class="innov">
        <div class="innov-h">
          <span class="innov-n">${String(i + 1).padStart(2, '0')}</span>
          <h3>${v.title}</h3>
          ${lift(v.lift)}
        </div>
        <p class="innov-tag">${v.tag}</p>
        <p class="innov-idea">${v.idea}</p>
        <dl class="innov-meta">
          <dt>Why it's different</dt><dd>${v.why}</dd>
          <dt>Already in place</dt><dd>${v.have}</dd>
          <dt>Still missing</dt><dd>${v.needs}</dd>
        </dl>
      </article>`).join('')}
    <p class="innov-foot">${INNOVATIONS.length} ideas · sorted by nothing in particular · add your own in <code>js/ui/innovations.js</code></p>`;
}

export default { INNOVATIONS, renderInnovations };

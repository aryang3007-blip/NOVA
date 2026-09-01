/**
 * AURA :: Persistent Config
 * -------------------------
 * localStorage-backed settings. API keys never leave the browser — AURA has
 * no backend, so keys are sent directly from your machine to the provider
 * you chose. Includes a graceful in-memory fallback when localStorage is
 * blocked (e.g. sandboxed iframe), so the app never hard-crashes.
 */

const KEY = 'aura.config.v1';

const DEFAULTS = {
  // ── AI ────────────────────────────────────────────────────────────────
  provider: 'auto',            // auto | local | openai | anthropic | gemini | groq | openrouter | ollama
  model: '',                   // '' = provider default
  apiKeys: {},                 // { openai: 'sk-...', ... }
  // ── Key vault profiles ────────────────────────────────────────────────
  // Keys are mirrored server-side into the DPAPI vault (never the SQLite
  // config row) under a NAMED profile. A fresh browser session — empty
  // localStorage — can then import them back instead of making you re-paste.
  keyProfile: 'default',       // which vault profile setKey() writes to
  autoImportKeys: true,        // fresh sessions auto-import keys from the vault
  ollamaUrl: 'http://localhost:11434',
  // Hybrid routing: send short/simple turns to a local Ollama model (free,
  // private, fast) and only escalate hard ones to the cloud provider.
  hybridRouting: true,
  ollamaSmallModel: '',        // '' = first installed model
  hybridMaxWords: 28,          // longer than this counts as a "big" task
  // Auto-routing NEVER picks a model larger than this. Big models remain
  // usable, but only when pinned deliberately — a 30B model can take minutes
  // per reply on modest hardware.
  maxAutoParams: 9,
  modelStrategy: 'speed',      // speed | balanced | quality
  temperature: 0.7,
  maxTokens: 1024,
  assistantName: 'NOVA',
  systemPrompt:
    "IDENTITY\n" +
    "You are NOVA — AURA's intelligent assistant and orchestration layer. Precise, warm, " +
    "quick-witted, never sycophantic. You run on the user's own machine and act through " +
    "real capabilities (apps, files, screen, documents, web research, paired devices).\n\n" +
    "PRIMARY OBJECTIVE\n" +
    "Understand what the user ACTUALLY wants, then accomplish it with the appropriate " +
    "capability. Natural phrasing varies wildly — interpret intent, never keyword-match. " +
    "Weak or telegraphic English is still a command if it asks for an action.\n\n" +
    "OPERATING PRINCIPLES\n" +
    "1. When the user asks you to DO something, do it through the action/tool protocol — " +
    "do not answer with generic conversation instead of acting.\n" +
    "2. Never pretend an action happened. Never invent tool results. Report only what the " +
    "system actually returned, and say plainly when something failed or is unverifiable.\n" +
    "3. Do not claim success without verification when verification is possible.\n" +
    "4. Ambiguous request? Ask one short clarifying question instead of guessing wildly.\n" +
    "5. Use the context provided (devices, tools, preferences, memory, screen state) — " +
    "for example 'open my browser' means THEIR preferred browser when you know it.\n" +
    "6. Destructive, explosive or security-weakening requests are refused briefly, with a " +
    "safe alternative offered.\n" +
    "7. Keep spoken answers tight (2-5 sentences) unless elaboration or code is requested. " +
    "Use markdown for code. Never invent capabilities you do not have.",
  memoryTurns: 20,             // conversation turns kept in the rolling window
  persistConversation: true,

  // ── Voice ─────────────────────────────────────────────────────────────
  ttsEnabled: true,
  ttsVoice: '',
  ttsRate: 1.03,
  ttsPitch: 0.95,
  ttsVolume: 1.0,
  sttLang: 'en-US',
  sttContinuous: true,
  wakeWordEnabled: false,
  wakeWord: 'aura, hey aura, nova, hey nova, jarvis, computer',
  autoSendOnFinal: true,
  commanderGreeting: 'Yes, Commander?',
  commanderGreetingTone: 'questioning',
  commanderFollowup: true,       // one command after a wake command without re-waking

  // ── Porcupine wake-word engine ────────────────────────────────────────
  // Get a free access key at https://console.picovoice.ai/
  // Free tier: 3 hours/month, no credit card required.
  picovoiceKey: '',
  // 'porcupine' = Picovoice engine  |  'browser' = Web Speech fallback  |  'off'
  wakeWordEngine: 'browser',
  // URL to a custom .ppn model file (trained for "Web" platform at Picovoice Console).
  // Leave blank to use Porcupine's built-in keywords (porcupine, computer, jarvis, ...).
  wakeWordModelUrl: '',
  // 'automatic' = always listen after TTS ends  |  'push-to-talk' = manual
  voiceActivation: 'push-to-talk',

  // ── Vision ────────────────────────────────────────────────────────────
  cameraFacing: 'user',
  handTracking: true,
  faceTracking: true,
  objectDetection: false,      // heaviest model; opt-in
  /** EfficientDet-Lite0 scores low on webcam frames; 0.42 was too strict. */
  objectScoreThreshold: 0.28,
  // Identity recognition from the 478 face landmarks already being computed.
  // Stores a numeric signature per person — never an image. Opt-in.
  faceRecognition: false,

  /**
   * Dwell-to-click: hold a pointing fingertip still and it clicks whatever is
   * under it. Off by default — a feature that clicks things must be asked for.
   */
  dwellClick: false,
  /** How long the hold must last, in ms. 600–2500 via the Settings slider. */
  dwellMs: 1000,
  /** Jitter tolerance around the target, in normalised frame units. */
  dwellHoldRadius: 0.026,

  /**
   * Where generated .pptx / .xlsx / .docx files are written.
   * Empty means the bridge default: <Downloads>/AURA, or ~/AURA if there is no
   * Downloads folder. Whatever is set here is still path-jailed server-side.
   */
  docFolder: '',

  /**
   * How AURA reads a shared screen.
   *   'auto'   — text questions go through a small OCR model, visual
   *              questions go to a full multimodal model (default)
   *   'ocr'    — always transcribe first, then answer with the fast chat
   *              model. Lowest latency on a modest machine.
   *   'vision' — always send the picture to a multimodal model.
   */
  /** AURA Live visibility. A runtime toggle — the code and routes remain. */
  auraLiveEnabled: true,
  screenMode: 'auto',
  /** Avatar height multiplier. 1 = as authored. Range 0.6 - 1.6. */
  avatarHeight: 1,
  /** Max iterations for /task. Hard-capped at 14 in task-agent.js. */
  taskMaxSteps: 10,
  /** Change-detection poll interval for /watch, in ms. A screen is static. */
  screenWatchMs: 2000,
  faceGreeting: true,          // say hello when a known person appears
  // Developer fast boot — skip boot animation on page load
  devSkipBoot: false,
  // Multimodal / Desktop Vision provider & model selection
  visionProvider: 'auto',      // 'auto' | 'ollama' | 'gemini' | 'openai' | 'anthropic' | 'openrouter' | 'groq'
  visionModel: '',
  // Structured wake words array (UI tag manager)
  wakeWords: ['Hey Nova', 'Yo Nova', 'Nova', 'Okay Nova'],
  // Web research: search only runs when AURA cannot answer offline.
  webSearch: true,
  webSearchDepth: 'adaptive',  // adaptive | snippets | read
  visionTargetFps: 24,
  mirrorCamera: true,
  gestureCooldownMs: 2200,

  // ── Avatar / UI ───────────────────────────────────────────────────────
  avatarMode: 'body',          // body (provider system) | 3d (head) | 2d
  // Which avatar provider renders the agent. The Sphere is the default: it is
  // the product identity, it reflects real agent state, it is fully offline
  // and it is far cheaper than the humanoid on a software renderer.
  avatarProvider: 'sphere',    // sphere | builtin | gltf | readyplayerme
  avatarSolid: true,           // true = solid character, false = wireframe hologram
  avatarModelUrl: '',          // remote .glb/.vrm (optional)
  avatarModelName: '',         // label for an imported file
  avatarRpmUrl: '',            // Ready Player Me avatar URL or ID
  avatarOutfit: 'suit',
  avatarHair: 'short',         // see HAIRSTYLES in avatar/outfits.js
  avatarHairColor: 'match',    // 'match' follows the palette accent
  avatarBodyType: 'neutral',   // neutral | masculine | feminine | athletic | slim | heavy
  avatarPalette: 'cyan',
  avatarAccessory: 'visor',
  liveData: true,              // master switch for all internet lookups
  defaultCity: '',
  glassUI: true,
  // Command Gold is the product identity: near-black with a warm gold accent.
  theme: 'aura-gold',
  // ── Appearance engine (js/ui/theming.js) ─────────────────────────────
  // Every value below maps to a CSS variable, so changing one restyles the
  // whole interface — including the WebGL avatar's accent-coloured elements.
  background: 'gradient',      // gradient | flat | aurora | grid | vignette | scanline
  hudStyle: 'brackets',        // brackets | frame | minimal | none
  density: 'comfortable',      // comfortable | compact | spacious
  customAccent: '',            // '' = use the preset's accent
  customAccent2: '',
  accentHue: 0,                // -180..180 hue rotation applied to the accents
  glassBlur: 18,
  panelOpacity: 0.78,
  glowStrength: 0.22,
  cornerRadius: 14,
  fontScale: 1,
  animSpeed: 1,
  bgIntensity: 1,
  hiddenWidgets: [],           // ids from WIDGETS in theming.js
  particles: true,
  ambientSound: false,
  ambientVolume: 0.22,
  musicEnabled: false,
  musicVolume: 0.14,
  uiSounds: true,
  reduceMotion: false,
  showHud: true,

  // ── Performance ───────────────────────────────────────────────────────
  // Cap on message elements kept in the DOM. The full conversation still
  // lives in memory/storage; this stops the document growing without bound,
  // which measurably slowed rendering in long sessions.
  maxTranscriptNodes: 220,

  // ── System monitor ────────────────────────────────────────────────────
  showGpuMetric: false,        // integrated GPUs report nothing useful
};

function safeParse(raw) {
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

// The old default system prompt, used to detect-and-upgrade installs whose
// saved config still carries it (saved rows win merges, so the new operating
// prompt would otherwise never reach existing users).
const LEGACY_SYSTEM_PROMPT_PREFIX = 'You are NOVA (Next-gen Omnipresent Vision & Action assistant)';

class Config {
  constructor() {
    this._mem = null;                      // fallback store
    this.data = { ...DEFAULTS, ...this._read() };
    // deep-ish merge for nested apiKeys
    this.data.apiKeys = { ...DEFAULTS.apiKeys, ...(this.data.apiKeys || {}) };
    // If the saved system prompt is just the old default, move to the new
    // operating prompt. A genuinely customised prompt is left untouched.
    if (typeof this.data.systemPrompt === 'string'
        && this.data.systemPrompt.startsWith(LEGACY_SYSTEM_PROMPT_PREFIX)
        && this.data.systemPrompt !== DEFAULTS.systemPrompt) {
      this.data.systemPrompt = DEFAULTS.systemPrompt;
      this._write?.(this.data);
    }
    this.listeners = new Set();
  }

  get storageAvailable() {
    try {
      const t = '__aura_t__';
      localStorage.setItem(t, '1');
      localStorage.removeItem(t);
      return true;
    } catch { return false; }
  }

  _read() {
    if (!this.storageAvailable) return this._mem || {};
    return safeParse(localStorage.getItem(KEY));
  }

  _write(obj) {
    if (this.storageAvailable) {
      try { localStorage.setItem(KEY, JSON.stringify(obj)); }
      catch (e) { console.warn('[config] persist failed', e); }
    } else {
      this._mem = obj;
    }
    // Asynchronously synchronize to SQLite
    if (typeof fetch === 'function') {
      import('./persistence-client.js').then(({ persistenceClient }) => {
        persistenceClient.saveConfig(obj).catch(() => {});
      }).catch(() => {});
    }
    return true;
  }

  async syncWithDatabase() {
    if (typeof fetch !== 'function') return false;
    try {
      const { persistenceClient } = await import('./persistence-client.js');
      const dbConfig = await persistenceClient.loadConfig();
      if (dbConfig && typeof dbConfig === 'object') {
        Object.assign(this.data, dbConfig);
        this.data.apiKeys = { ...DEFAULTS.apiKeys, ...(this.data.apiKeys || {}) };
        return true;
      }
    } catch {}
    return false;
  }

  get(key) { return key === undefined ? { ...this.data } : this.data[key]; }

  set(key, value) {
    const patch = typeof key === 'object' ? key : { [key]: value };
    Object.assign(this.data, patch);
    this._write(this.data);
    for (const fn of this.listeners) { try { fn(patch, this.data); } catch (e) { console.error(e); } }
    return this.data;
  }

  getKey(provider) { return (this.data.apiKeys || {})[provider] || ''; }

  setKey(provider, key) {
    const keys = { ...(this.data.apiKeys || {}) };
    const prov = String(provider || '').trim().toLowerCase();
    const cleanKey = key ? String(key).trim() : '';
    if (cleanKey) keys[prov] = cleanKey; else delete keys[prov];
    this.set('apiKeys', keys);

    // Save into hardware/OS DPAPI Vault under the active profile
    if (typeof fetch === 'function') {
      const profile = this.data.keyProfile || 'default';
      import('./persistence-client.js').then(({ persistenceClient }) => {
        persistenceClient.saveCredential(prov, cleanKey, profile).catch(() => {});
      }).catch(() => {});
    }
  }

  /**
   * Repopulate apiKeys from the server-side vault. Called automatically on
   * boot when this browser has no keys of its own (fresh profile/session);
   * also callable directly to switch profiles.
   *
   * Profile choice: the configured `keyProfile` wins if it holds keys, else
   * 'default', else whichever profile stores the most providers.
   *
   * @param {{force?:boolean, profile?:string}} [opts]
   *   force   — import even though this browser already has keys locally
   *   profile — import from exactly this profile (also becomes keyProfile)
   * @returns {Promise<number>} how many provider keys were imported
   */
  async restoreKeysFromVault({ force = false, profile = null } = {}) {
    if (typeof fetch !== 'function') return 0;
    if (!force && this.data.autoImportKeys === false) return 0;
    const local = this.data.apiKeys || {};
    if (!force && Object.values(local).some(k => typeof k === 'string' && k.trim())) return 0;
    try {
      const { persistenceClient } = await import('./persistence-client.js');
      const profiles = await persistenceClient.getVaultProfiles();
      const names = Object.keys(profiles || {});
      if (!names.length) return 0;

      let chosen = profile;
      if (!chosen) {
        const wanted = this.data.keyProfile || 'default';
        if (names.includes(wanted)) chosen = wanted;
        else if (names.includes('default')) chosen = 'default';
        else chosen = names.sort((a, b) =>
          Object.keys(profiles[b] || {}).length - Object.keys(profiles[a] || {}).length)[0];
      }

      const keys = await persistenceClient.revealCredentials({ profile: chosen });
      if (!keys || !Object.keys(keys).length) return 0;

      const merged = { ...(this.data.apiKeys || {}) };
      let imported = 0;
      for (const [prov, k] of Object.entries(keys)) {
        if (!k || typeof k !== 'string') continue;
        if (!force && merged[prov]) continue;          // local wins unless forced
        merged[prov] = k.trim();
        imported++;
      }
      this.set({ apiKeys: merged, ...(profile ? { keyProfile: chosen } : {}) });
      try {
        const { bus } = await import('./bus.js');
        bus.emit('config:keys-imported', { profile: chosen, count: imported });
      } catch {}
      return imported;
    } catch {
      return 0;
    }
  }

  /**
   * User-facing profile switch: pull keys from a named profile, replacing
   * this browser's current set, and make it the profile setKey() writes to.
   */
  async importKeysFromProfile(name) {
    return this.restoreKeysFromVault({ force: true, profile: String(name || '').trim().toLowerCase() || null });
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  reset() {
    this.data = JSON.parse(JSON.stringify(DEFAULTS));
    this._write(this.data);
    for (const fn of this.listeners) { try { fn(this.data, this.data); } catch {} }
  }

  export() {
    const clone = JSON.parse(JSON.stringify(this.data));
    clone.apiKeys = Object.fromEntries(Object.keys(clone.apiKeys || {}).map(k => [k, '***redacted***']));
    return clone;
  }
}

export const config = new Config();
// Attempt initial database synchronization, then recover API keys from the
// vault when this browser has none (new session/profile). Keys live in the
// DPAPI vault file, not the DB row — so this runs even if the config row is
// missing or empty.
if (typeof fetch === 'function') {
  config.syncWithDatabase()
    .catch(() => {})
    .then(() => config.restoreKeysFromVault())
    .then(n => { if (n) console.info(`[config] imported ${n} API key(s) from the vault`); })
    .catch(() => {});
}
export { Config, DEFAULTS };
export default config;



/**
 * AURA :: Reactive State Store
 * ----------------------------
 * Tiny observable store. Modules read/write shared runtime state without
 * knowing about each other. Subscribers fire only when a watched key
 * actually changes (shallow compare).
 */

export class Store {
  constructor(initial = {}) {
    this.data = { ...initial };
    /** @type {Map<string, Set<Function>>} */
    this.subs = new Map();
    this.anySubs = new Set();
  }

  get(key) {
    return key === undefined ? { ...this.data } : this.data[key];
  }

  /**
   * Set one key or merge an object of keys.
   * @param {string|object} key
   * @param {*} [value]
   */
  set(key, value) {
    const patch = typeof key === 'object' && key !== null ? key : { [key]: value };
    const changed = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!Object.is(this.data[k], v)) {
        const prev = this.data[k];
        this.data[k] = v;
        changed.push([k, v, prev]);
      }
    }
    for (const [k, v, prev] of changed) {
      const set = this.subs.get(k);
      if (set) for (const fn of Array.from(set)) { try { fn(v, prev, k); } catch (e) { console.error('[store]', e); } }
    }
    if (changed.length) {
      for (const fn of Array.from(this.anySubs)) {
        try { fn(Object.fromEntries(changed.map(([k, v]) => [k, v]))); } catch (e) { console.error('[store]', e); }
      }
    }
    return changed.length > 0;
  }

  /** Watch a key (or '*'). Returns unsubscribe. Fires immediately if `immediate`. */
  watch(key, fn, immediate = false) {
    if (key === '*') {
      this.anySubs.add(fn);
      return () => this.anySubs.delete(fn);
    }
    if (!this.subs.has(key)) this.subs.set(key, new Set());
    this.subs.get(key).add(fn);
    if (immediate) fn(this.data[key], undefined, key);
    return () => this.subs.get(key)?.delete(fn);
  }

  /** Atomically update via a function of the previous value. */
  update(key, fn) {
    return this.set(key, fn(this.data[key]));
  }
}

/** Global runtime state (not persisted — see config.js for that). */
export const state = new Store({
  booted: false,
  // ai
  aiProvider: 'local',
  aiModel: '',
  aiStreaming: false,
  aiCanContinue: false,
  lastAssistantTruncated: false,
  // voice
  sttSupported: false,
  sttActive: false,
  ttsSupported: false,
  ttsSpeaking: false,
  wakeWordActive: false,
  micPermission: 'unknown',
  // vision
  cameraActive: false,
  cameraPermission: 'unknown',
  handsActive: false,
  faceActive: false,
  objectsActive: false,
  handCount: 0,
  faceCount: 0,
  objectCount: 0,
  visionFps: 0,
  // gesture
  currentGesture: 'none',
  gestureConfidence: 0,
  listenMode: false,
  // avatar
  avatarEmotion: 'neutral',
  avatarMode: '3d',
  // ui
  theme: 'aura-blue',
  arMode: false,
  fps: 0,
});

export default state;

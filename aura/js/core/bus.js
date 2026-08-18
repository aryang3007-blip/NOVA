/**
 * AURA :: Core Event Bus
 * ----------------------
 * The single nervous system of the OS. Every module (AI, Vision, Voice,
 * Avatar, Gesture) communicates ONLY through this bus. No module imports
 * another module's internals, which is what keeps them independent and
 * makes plugins trivial to add.
 *
 * Pure JS, zero DOM dependency -> unit-testable in Node.
 */

export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this.channels = new Map();
    /** @type {Array<{event:string,payload:any,t:number}>} */
    this.history = [];
    this.historyLimit = 400;
    this.wildcards = new Set();
  }

  /**
   * Subscribe to an event. Returns an unsubscribe function.
   * @param {string} event  Event name, or '*' for everything.
   * @param {Function} handler
   */
  on(event, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError(`EventBus.on(${event}): handler must be a function`);
    }
    if (event === '*') {
      this.wildcards.add(handler);
      return () => this.wildcards.delete(handler);
    }
    if (!this.channels.has(event)) this.channels.set(event, new Set());
    this.channels.get(event).add(handler);
    return () => this.off(event, handler);
  }

  /** Subscribe for exactly one emission. */
  once(event, handler) {
    const off = this.on(event, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  off(event, handler) {
    const set = this.channels.get(event);
    if (set) {
      set.delete(handler);
      if (set.size === 0) this.channels.delete(event);
    }
  }

  /**
   * Emit an event. Handler errors are isolated so one broken listener
   * can never take down the OS.
   */
  emit(event, payload) {
    this.history.push({ event, payload, t: Date.now() });
    if (this.history.length > this.historyLimit) this.history.shift();

    const set = this.channels.get(event);
    if (set) {
      for (const handler of Array.from(set)) {
        try {
          handler(payload);
        } catch (err) {
          console.error(`[bus] handler error on "${event}"`, err);
          // Avoid infinite loop if the error channel itself throws.
          if (event !== 'sys:error') {
            this.emit('sys:error', { source: `bus:${event}`, error: err });
          }
        }
      }
    }
    for (const handler of Array.from(this.wildcards)) {
      try {
        handler({ event, payload });
      } catch (err) {
        console.error('[bus] wildcard handler error', err);
      }
    }
    return this;
  }

  /** Wait for an event, with optional timeout (ms). Resolves with payload. */
  waitFor(event, timeout = 0) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const off = this.on(event, (payload) => {
        if (timer) clearTimeout(timer);
        off();
        resolve(payload);
      });
      if (timeout > 0) {
        timer = setTimeout(() => {
          off();
          reject(new Error(`Timed out waiting for "${event}"`));
        }, timeout);
      }
    });
  }

  listenerCount(event) {
    return (this.channels.get(event)?.size || 0) + this.wildcards.size;
  }

  clear() {
    this.channels.clear();
    this.wildcards.clear();
    this.history.length = 0;
  }
}

/** Canonical event names. Keeps typos from becoming silent bugs. */
export const EV = {
  // lifecycle
  BOOT_STEP: 'sys:boot-step',
  READY: 'sys:ready',
  ERROR: 'sys:error',
  LOG: 'sys:log',
  // ai
  AI_USER_MESSAGE: 'ai:user-message',
  AI_STREAM_START: 'ai:stream-start',
  AI_STREAM_DELTA: 'ai:stream-delta',
  AI_STREAM_END: 'ai:stream-end',
  AI_STREAM_ABORT: 'ai:stream-abort',
  AI_ERROR: 'ai:error',
  AI_PROVIDER_CHANGED: 'ai:provider-changed',
  AI_MEMORY_UPDATED: 'ai:memory-updated',
  // voice
  STT_START: 'voice:stt-start',
  STT_PARTIAL: 'voice:stt-partial',
  STT_FINAL: 'voice:stt-final',
  STT_END: 'voice:stt-end',
  STT_ERROR: 'voice:stt-error',
  TTS_START: 'voice:tts-start',
  TTS_VISEME: 'voice:tts-viseme',
  TTS_END: 'voice:tts-end',
  TTS_INTERRUPT: 'voice:tts-interrupt',
  WAKE_WORD: 'voice:wake-word',
  WAKE_ENGINE_STATE: 'voice:wake-engine-state', // { state, prev, reason, engine }
  VOICE_STATE: 'voice:state',                   // full voice pipeline state broadcast
  // vision
  CAM_START: 'vision:camera-start',
  CAM_STOP: 'vision:camera-stop',
  CAM_ERROR: 'vision:camera-error',
  HANDS: 'vision:hands',
  FACES: 'vision:faces',
  OBJECTS: 'vision:objects',
  SCENE_UPDATE: 'vision:scene',
  /** Lightweight person-presence signal derived from the current frame. */
  PRESENCE: 'vision:presence',
  // gestures
  GESTURE: 'gesture:detected',
  GESTURE_END: 'gesture:ended',
  POINTER: 'gesture:pointer',
  // avatar
  AVATAR_EMOTION: 'avatar:emotion',
  AVATAR_REACT: 'avatar:react',
  // ui
  UI_PANEL: 'ui:panel',
  UI_THEME: 'ui:theme',
  UI_TOAST: 'ui:toast',
  UI_HIGHLIGHT: 'ui:highlight',
  UI_LISTEN_MODE: 'ui:listen-mode',
  // plugins
  PLUGIN_REGISTERED: 'plugin:registered',
  COMMAND: 'sys:command',
};

/** Global singleton bus. */
export const bus = new EventBus();
export default bus;

/**
 * AURA :: Avatar Provider interface
 * =================================
 * A provider is ONLY responsible for putting pixels on screen. It receives a
 * pose from the AnimationEngine every frame and renders it.
 *
 * It must NOT:
 *   • subscribe to the event bus (the engine does that)
 *   • know about TTS, vision, gestures or the AI
 *   • implement blinking, lip-sync or emotion timing
 *
 * That separation is what lets a VRM or Ready Player Me avatar inherit the
 * whole performance — including waving back — without touching AURA.
 *
 * Adding a provider:
 *   1. extend AvatarProvider
 *   2. implement init() / applyPose() / dispose()
 *   3. register it in providers/index.js
 * Nothing else in the codebase changes.
 *
 * @module avatar/providers/base
 */

/**
 * @typedef {Object} ProviderCapabilities
 * @property {boolean} lipSync       can move a mouth
 * @property {boolean} blink         can close eyelids
 * @property {boolean} emotions      can change facial expression
 * @property {boolean} gestures      has arms / can play gesture impulses
 * @property {boolean} customise     supports outfit/colour/accessory changes
 * @property {boolean} offline       works with no network
 */

/**
 * @typedef {Object} ProviderInfo
 * @property {string} id
 * @property {string} label
 * @property {string} description
 * @property {ProviderCapabilities} capabilities
 * @property {boolean} ready
 * @property {string} [reason]  why it is not ready
 * @property {string} [detail]  provider-specific summary (bones mapped, etc)
 */

export class AvatarProvider {
  /**
   * @param {HTMLElement} container
   * @param {object} [options]
   */
  constructor(container, options = {}) {
    if (new.target === AvatarProvider) {
      throw new Error('AvatarProvider is abstract — extend it.');
    }
    this.container = container;
    this.options = options;
    this.initialized = false;
    /** Set by subclasses when init() fails, so the UI can explain itself. */
    this.failureReason = null;
  }

  /** Stable identifier used in config. Subclasses MUST override. */
  static get id() { return 'base'; }
  static get label() { return 'Base'; }
  static get description() { return ''; }

  /** @returns {ProviderCapabilities} */
  static get capabilities() {
    return { lipSync: false, blink: false, emotions: false, gestures: false, customise: false, offline: true };
  }

  /**
   * Is this provider usable in the current environment? Checked before we try
   * to switch to it, so the UI can grey it out with a reason instead of
   * failing at runtime.
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  static async isAvailable() { return /** @type {{ok:boolean, reason?:string}} */ ({ ok: true }); }

  /**
   * Build the scene. Must be idempotent and must never throw — return false
   * and set failureReason so the manager can fall back cleanly.
   * @returns {Promise<boolean>}
   */
  async init() { throw new Error('init() not implemented'); }

  /**
   * Render one frame from an engine pose.
   * @param {import('../animation-engine.js').AvatarPose} _pose
   */
  applyPose(_pose) { /* subclasses implement */ }

  /** Optional: outfit / palette customisation. */
  applyOutfit(_outfitId, _paletteId) { return false; }
  applyAccessory(_accId) { return false; }

  /** Optional: quality tier for weak machines. */
  setQuality(_level) { return false; }

  /** Called on container resize. */
  resize() { /* optional */ }

  /** Release GPU resources, listeners and DOM. MUST be safe to call twice. */
  dispose() { this.initialized = false; }

  /** @returns {ProviderInfo} */
  describe() {
    const C = /** @type {typeof AvatarProvider} */ (this.constructor);
    return {
      id: C.id,
      label: C.label,
      description: C.description,
      capabilities: C.capabilities,
      ready: this.initialized,
      reason: this.failureReason || undefined,
    };
  }
}

export default AvatarProvider;

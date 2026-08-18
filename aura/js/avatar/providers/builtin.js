/**
 * AURA :: Built-in Avatar Provider (default)
 * ==========================================
 * Wraps the hand-built 19-bone rig and drives it from an AnimationEngine pose.
 *
 * WHAT CHANGED VS THE OLD HOLOGRAM
 * --------------------------------
 * The old look was "glowing lines": every mesh was ~50% transparent with a
 * wireframe overlay on top, so you saw the inside of the model through itself.
 * Two settings control the look now:
 *
 *   avatarSolid  true  → opaque MeshStandardMaterial, no wireframe overlay,
 *                        soft-shaded rounded geometry (the new default)
 *                false → the original translucent hologram, kept because some
 *                        people liked it
 *
 * The rig, bone names and gesture poses are unchanged, so all existing tests
 * and the wave animation keep working.
 *
 * @module avatar/providers/builtin
 */

import { AvatarProvider } from './base.js';
import { config } from '../../core/config.js';

export class BuiltInAvatarProvider extends AvatarProvider {
  static get id() { return 'builtin'; }
  static get label() { return 'Built-in AURA Avatar'; }
  static get description() {
    return 'Solid-mesh 3D character built into AURA. Fully offline, no setup, lowest resource use.';
  }
  static get capabilities() {
    return { lipSync: true, blink: true, emotions: true, gestures: true, customise: true, offline: true };
  }

  static async isAvailable() {
    if (typeof document === 'undefined') return { ok: false, reason: 'No DOM' };
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) return { ok: false, reason: 'WebGL is not available in this browser' };
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: `WebGL check failed: ${e.message}` };
    }
  }

  constructor(container, options = {}) {
    super(container, options);
    /** @type {any} */ this.body = null;
  }

  async init() {
    try {
      const { AvatarBody } = await import('../avatar-body.js');
      // externalAnim: the body must NOT wire its own bus listeners or run its
      // own rAF loop — the AvatarManager drives it from the shared engine.
      this.body = new AvatarBody(this.container, { externalAnim: true });
      const ok = await this.body.init();
      if (!ok) {
        this.failureReason = 'WebGL renderer could not be created';
        return false;
      }
      this.initialized = true;
      return true;
    } catch (e) {
      this.failureReason = e.message;
      return false;
    }
  }

  applyPose(pose) {
    if (!this.initialized || !this.body) return;
    this.body.renderPose(pose);
  }

  applyOutfit(outfitId, paletteId) {
    if (!this.body) return false;
    this.body.applyOutfit(outfitId, paletteId);
    return true;
  }

  applyAccessory(accId) {
    if (!this.body) return false;
    this.body.applyAccessory(accId);
    return true;
  }

  /** Hairstyle + hair colour (built-in rig only). */
  applyHair(hairId, colorId) { return this.body?.applyHair?.(hairId, colorId) ?? false; }

  /** Body proportions preset — scales bones, animations are unaffected. */
  applyBodyType(typeId) { return this.body?.applyBodyType?.(typeId) ?? false; }

  /**
   * Height scaling. Scales Y on the root group only, so the character gets
   * taller/shorter without becoming wider — which is what "height" means.
   * A little X/Z compensation keeps it from looking stretched.
   */
  setHeight(v) {
    const root = this.body?.root;
    if (!root) return false;
    const lateral = 1 + (v - 1) * 0.35;   // partial, so proportions stay plausible
    root.scale.set(lateral, v, lateral);
    // Re-frame, or a taller avatar walks out of the top of the viewport.
    this.body?._frameCamera?.();
    return true;
  }

  /** Toggle between the solid character and the original translucent look. */
  setSolid(on) {
    if (!this.body?.setSolid) return false;
    this.body.setSolid(!!on);
    config.set('avatarSolid', !!on);
    return true;
  }

  setQuality(level) { return this.body?.setQuality?.(level) ?? false; }
  resize() { this.body?.resize?.(); }

  dispose() {
    try { this.body?.dispose?.(); } catch {}
    this.body = null;
    this.initialized = false;
  }
}

export default BuiltInAvatarProvider;

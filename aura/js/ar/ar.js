/**
 * AURA :: AR Module
 * -----------------
 * Two real paths, chosen by capability detection:
 *
 *  1. WebXR immersive-ar — genuine world-anchored hologram with hit-testing
 *     (Chrome on Android / Quest browser). The avatar is re-parented into an
 *     XR scene and placed on a detected surface via a reticle + tap.
 *
 *  2. Camera-passthrough AR — when WebXR is unavailable (all desktop browsers,
 *     iOS Safari), AURA composites the hologram over the live camera feed with
 *     device-orientation parallax. This is explicitly labelled "SIMULATED AR"
 *     in the UI so the user is never misled.
 */

import { bus, EV } from '../core/bus.js';
import { state } from '../core/state.js';

export class ARModule {
  constructor(ctx) {
    this.ctx = ctx;
    this.mode = 'none';          // none | webxr | passthrough
    this.session = null;
    this.supported = null;
    this.orientation = { alpha: 0, beta: 0, gamma: 0 };
    this._orientHandler = null;
  }

  /** @returns {Promise<{webxr:boolean, passthrough:boolean, reason:string}>} */
  async capabilities() {
    let webxr = false;
    let reason = '';
    if (navigator.xr?.isSessionSupported) {
      try { webxr = await navigator.xr.isSessionSupported('immersive-ar'); }
      catch (e) { reason = e.message; }
      if (!webxr && !reason) reason = 'This browser has WebXR but reports no immersive-ar support (typical on desktop).';
    } else {
      reason = 'navigator.xr is unavailable — WebXR is not implemented in this browser.';
    }
    const passthrough = !!(navigator.mediaDevices?.getUserMedia) &&
      (window.isSecureContext || location.hostname === 'localhost');
    this.supported = { webxr, passthrough, reason };
    return this.supported;
  }

  async enter() {
    const caps = await this.capabilities();
    if (caps.webxr) {
      const ok = await this._enterWebXR();
      if (ok) return { mode: 'webxr', message: 'WebXR immersive AR session started. Tap a surface to anchor AURA.' };
    }
    if (caps.passthrough) {
      await this._enterPassthrough();
      return {
        mode: 'passthrough',
        message: `Simulated AR active — hologram composited over your live camera with motion parallax.\n\n_True WebXR unavailable: ${caps.reason}_`,
      };
    }
    return { mode: 'none', message: `AR unavailable. ${caps.reason} Camera passthrough also needs a secure context (https or localhost).` };
  }

  async _enterWebXR() {
    const { avatar } = this.ctx;
    if (!avatar?.renderer || !avatar.ok) return false;
    try {
      const session = await navigator.xr.requestSession('immersive-ar', {
        requiredFeatures: ['local'],
        optionalFeatures: ['hit-test', 'dom-overlay', 'light-estimation'],
        domOverlay: { root: document.getElementById('ar-overlay') || document.body },
      });
      this.session = session;
      this.mode = 'webxr';

      const gl = avatar.renderer.getContext();
      await gl.makeXRCompatible();
      avatar.renderer.xr.enabled = true;
      await avatar.renderer.xr.setSession(session);

      // Full-body avatars stand on the floor at human scale; the head-only
      // avatar floats at eye level. Different anchoring for each.
      if (avatar.isBody) {
        avatar.root.scale.setScalar(0.62);        // ~1.6 m tall
        avatar.root.position.set(0, -0.6, -1.8);  // on the ground, 1.8 m away
      } else {
        avatar.root.scale.setScalar(0.32);
        avatar.root.position.set(0, 0, -1.1);
      }
      if (avatar.particles) avatar.particles.visible = false;

      // hit-test reticle so the user can place it on a real surface
      try {
        const viewerSpace = await session.requestReferenceSpace('viewer');
        const refSpace = await session.requestReferenceSpace('local');
        const hitTestSource = await session.requestHitTestSource?.({ space: viewerSpace });
        if (hitTestSource) {
          session.addEventListener('select', () => {
            const frame = this._lastFrame;
            if (!frame) return;
            const results = frame.getHitTestResults(hitTestSource);
            if (results.length) {
              const pose = results[0].getPose(refSpace);
              if (pose) {
                const p = pose.transform.position;
                // body stands ON the detected floor; head floats above it
                avatar.root.position.set(p.x, p.y + (avatar.isBody ? 0.62 : 0.35), p.z);
                bus.emit(EV.UI_TOAST, { type: 'success', text: 'AURA anchored to surface.' });
              }
            }
          });
          avatar.renderer.setAnimationLoop((t, frame) => {
            this._lastFrame = frame;
            const now = performance.now();
            let dt = (now - (avatar.lastT || now)) / 1000;
            avatar.lastT = now;
            if (dt > 0.05) dt = 0.05;
            avatar.update(dt);
            avatar.renderer.render(avatar.scene, avatar.camera);
          });
        }
      } catch (e) {
        console.warn('[ar] hit-test unavailable', e);
      }

      session.addEventListener('end', () => this._exitWebXR());
      state.set({ arMode: true });
      bus.emit('ar:enter', { mode: 'webxr' });
      return true;
    } catch (e) {
      console.error('[ar] webxr failed', e);
      bus.emit(EV.UI_TOAST, { type: 'warn', text: `WebXR session failed: ${e.message}` });
      return false;
    }
  }

  _exitWebXR() {
    const { avatar } = this.ctx;
    this.session = null;
    this.mode = 'none';
    if (avatar?.renderer) {
      avatar.renderer.xr.enabled = false;
      avatar.renderer.setAnimationLoop(null);
      avatar.root.scale.setScalar(1);
      avatar.root.position.set(0, 0, 0);
      if (avatar.particles) avatar.particles.visible = true;
      avatar.lastT = performance.now();
      avatar._loop();
      avatar.resize();
    }
    state.set({ arMode: false });
    bus.emit('ar:exit', {});
  }

  async _enterPassthrough() {
    const { vision, ui } = this.ctx;
    this.mode = 'passthrough';
    if (!state.get('cameraActive')) {
      await ui.enableVision();
    }
    document.body.classList.add('ar-passthrough');
    state.set({ arMode: true });

    // device orientation parallax (real sensor on mobile; no-op on desktop)
    if (window.DeviceOrientationEvent) {
      const start = () => {
        this._orientHandler = (e) => {
          this.orientation = { alpha: e.alpha || 0, beta: e.beta || 0, gamma: e.gamma || 0 };
          this._applyParallax();
        };
        window.addEventListener('deviceorientation', this._orientHandler);
      };
      const DOE = /** @type {any} */ (DeviceOrientationEvent);
      if (typeof DOE.requestPermission === 'function') {
        try { const p = await DOE.requestPermission(); if (p === 'granted') start(); }
        catch { /* user declined; parallax simply stays off */ }
      } else start();
    }

    // desktop fallback: mouse parallax so it still feels spatial
    this._mouseHandler = (e) => {
      const nx = (e.clientX / window.innerWidth - 0.5) * 2;
      const ny = (e.clientY / window.innerHeight - 0.5) * 2;
      this._setAvatarOffset(nx * 0.35, -ny * 0.22);
    };
    window.addEventListener('mousemove', this._mouseHandler);

    bus.emit('ar:enter', { mode: 'passthrough' });
  }

  _applyParallax() {
    const { gamma, beta } = this.orientation;
    this._setAvatarOffset((gamma / 45) * 0.5, ((beta - 45) / 45) * 0.3);
  }

  _setAvatarOffset(x, y) {
    const { avatar } = this.ctx;
    if (avatar?.root) {
      avatar.root.position.x = Math.max(-1.2, Math.min(1.2, x));
      avatar.root.position.y = Math.max(-0.8, Math.min(0.8, y));
    }
  }

  exit() {
    if (this.mode === 'webxr' && this.session) { try { this.session.end(); } catch {} return; }
    if (this.mode === 'passthrough') {
      document.body.classList.remove('ar-passthrough');
      if (this._orientHandler) { window.removeEventListener('deviceorientation', this._orientHandler); this._orientHandler = null; }
      if (this._mouseHandler) { window.removeEventListener('mousemove', this._mouseHandler); this._mouseHandler = null; }
      this._setAvatarOffset(0, 0);
      this.mode = 'none';
      state.set({ arMode: false });
      bus.emit('ar:exit', {});
    }
  }

  get active() { return this.mode !== 'none'; }
}

export default ARModule;

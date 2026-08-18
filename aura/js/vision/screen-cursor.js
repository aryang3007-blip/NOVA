/**
 * AURA :: Screen Cursor
 * ---------------------
 * AURA's OWN pointer, drawn over the shared screen preview.
 *
 * WHY THIS EXISTS
 * ---------------
 * `/watch` used to be read-only: it looked at the screen and never moved
 * anything. `/find` could move the REAL OS pointer, but only when an entire
 * monitor was shared, and moving the real pointer fights the user for control
 * of their own mouse. Both were wrong.
 *
 * This is a SOFT cursor: a reticle AURA positions inside the captured frame.
 * It works on any surface — tab, window or full screen — because it lives in
 * capture-space, not desktop-space. It never steals your mouse.
 *
 * Promotion to a real click is a separate, explicit step, and only possible
 * when the capture maps to desktop pixels (a full-monitor share). That
 * boundary is enforced in ScreenShare.toScreenPoint(), not here.
 *
 * @module vision/screen-cursor
 */

import { bus } from '../core/bus.js';
import { state } from '../core/state.js';

export class ScreenCursor {
  /**
   * @param {{screen: import('./screen-share.js').ScreenShare}} opts
   */
  constructor({ screen }) {
    this.screen = screen;
    /** Position in CAPTURED-frame pixels. */
    this.x = 0;
    this.y = 0;
    this.visible = false;
    this.label = '';
    /** 'idle' | 'searching' | 'found' | 'acting' */
    this.mode = 'idle';
    /** @type {Array<{x:number,y:number,label:string,at:number}>} */
    this.trail = [];
  }

  /**
   * Move AURA's cursor, in captured-frame coordinates.
   * @param {number} x
   * @param {number} y
   * @param {{label?:string, mode?:string, trail?:boolean}} [opts]
   */
  moveTo(x, y, { label = '', mode = 'found', trail = true } = {}) {
    const g = this.screen.geometry();
    if (!g) return { ok: false, message: 'Nothing is being shared.' };
    this.x = Math.max(0, Math.min(Math.round(x), g.capturedWidth));
    this.y = Math.max(0, Math.min(Math.round(y), g.capturedHeight));
    this.label = label;
    this.mode = mode;
    this.visible = true;
    if (trail) {
      this.trail.push({ x: this.x, y: this.y, label, at: Date.now() });
      if (this.trail.length > 12) this.trail.shift();
    }
    state.set({ auraCursorX: this.x, auraCursorY: this.y, auraCursorVisible: true });
    bus.emit('screen:cursor', { x: this.x, y: this.y, label, mode });
    return { ok: true, x: this.x, y: this.y };
  }

  /** Move using a grid cell reference like "C4". */
  moveToCell(cell, cols, rows, opts = {}) {
    const m = /^([A-Z])\s*(\d+)$/i.exec(String(cell || '').trim());
    const g = this.screen.geometry();
    if (!m || !g) return { ok: false, message: `Bad cell reference “${cell}”.` };
    const col = m[1].toUpperCase().charCodeAt(0) - 65;
    const row = parseInt(m[2], 10) - 1;
    if (col < 0 || col >= cols || row < 0 || row >= rows) {
      return { ok: false, message: `Cell “${cell}” is outside the ${cols}x${rows} grid.` };
    }
    return this.moveTo(
      (col + 0.5) * (g.capturedWidth / cols),
      (row + 0.5) * (g.capturedHeight / rows),
      opts);
  }

  hide() {
    this.visible = false;
    this.mode = 'idle';
    state.set({ auraCursorVisible: false });
    bus.emit('screen:cursor', { visible: false });
  }

  clearTrail() { this.trail = []; }

  /**
   * The real desktop coordinate under AURA's cursor, when that is meaningful.
   * @returns {{ok:boolean, x?:number, y?:number, message?:string}}
   */
  toScreenPoint() {
    if (!this.visible) return { ok: false, message: 'AURA\'s cursor is not placed anywhere.' };
    return this.screen.toScreenPoint(this.x, this.y);
  }

  /**
   * Draw the cursor onto a 2D context sized to the captured frame.
   * Pure rendering — no state changes — so a preview and a snapshot can both
   * call it.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} w
   * @param {number} h
   */
  draw(ctx, w, h) {
    if (!this.visible) return;
    const g = this.screen.geometry();
    if (!g) return;
    const sx = w / g.capturedWidth;
    const sy = h / g.capturedHeight;
    const x = this.x * sx, y = this.y * sy;
    const colour = { searching: '#ffb020', found: '#38bdf8', acting: '#ff5470' }[this.mode] || '#38bdf8';

    // Fading trail, so a multi-step plan is legible after the fact.
    ctx.save();
    if (this.trail.length > 1) {
      ctx.strokeStyle = 'rgba(56,189,248,0.35)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      this.trail.forEach((p, i) => {
        const px = p.x * sx, py = p.y * sy;
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Reticle: two rings + crosshair. Reads clearly over any wallpaper.
    ctx.strokeStyle = colour;
    ctx.fillStyle = colour;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, 18, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 0.45;
    ctx.beginPath(); ctx.arc(x, y, 28, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(x - 26, y); ctx.lineTo(x - 8, y);
    ctx.moveTo(x + 8, y);  ctx.lineTo(x + 26, y);
    ctx.moveTo(x, y - 26); ctx.lineTo(x, y - 8);
    ctx.moveTo(x, y + 8);  ctx.lineTo(x, y + 26);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();

    if (this.label) {
      ctx.font = 'bold 13px monospace';
      const tw = ctx.measureText(this.label).width;
      ctx.fillStyle = 'rgba(6,8,13,0.82)';
      ctx.fillRect(x + 32, y - 12, tw + 12, 22);
      ctx.fillStyle = colour;
      ctx.fillText(this.label, x + 38, y + 3);
    }
    ctx.restore();
  }

  status() {
    return {
      visible: this.visible, x: this.x, y: this.y,
      label: this.label, mode: this.mode,
      trail: this.trail.length,
      screenPoint: this.visible ? this.screen.toScreenPoint(this.x, this.y) : null,
    };
  }
}

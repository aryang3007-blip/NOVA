/**
 * AURA :: Ready Player Me Avatar Provider
 * =======================================
 * Ready Player Me hands out a plain .glb URL, so this provider is a thin
 * subclass of the GLB loader: it normalises whatever the user pastes into a
 * canonical model URL, then reuses the existing loading + retargeting path.
 *
 * Accepted inputs (all become the same .glb):
 *   https://models.readyplayer.me/64bfa15f0e72c63d7c3934a6.glb
 *   https://models.readyplayer.me/64bfa15f0e72c63d7c3934a6
 *   https://yourapp.readyplayer.me/avatar?id=64bfa15f0e72c63d7c3934a6
 *   64bfa15f0e72c63d7c3934a6                       (bare id)
 *
 * Ready Player Me avatars use ARKit blendshape names, which the parent class
 * already probes for, so lip-sync and blinking work without extra mapping.
 *
 * NOT OFFLINE. This is the one provider that needs the network, and it says
 * so — `capabilities.offline` is false and the UI warns before you switch.
 * No API key is required for public avatar URLs.
 *
 * @module avatar/providers/readyplayerme
 */

import { GLTFAvatarProvider } from './gltf.js';

const RPM_HOST = 'models.readyplayer.me';
const ID_RX = /^[a-f0-9]{20,32}$/i;

/**
 * Turn user input into a canonical Ready Player Me .glb URL.
 * @param {string} input
 * @returns {{ok:true, url:string, id:string} | {ok:false, reason:string}}
 */
export function normaliseRpmUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, reason: 'Paste your Ready Player Me avatar URL or ID.' };

  // Bare id
  if (ID_RX.test(raw)) {
    return { ok: true, id: raw, url: `https://${RPM_HOST}/${raw}.glb` };
  }

  let u;
  try { u = new URL(raw); }
  catch { return { ok: false, reason: 'That is not a valid URL or avatar ID.' }; }

  if (u.protocol !== 'https:') {
    return { ok: false, reason: 'Ready Player Me URLs must be https.' };
  }
  if (!/(^|\.)readyplayer\.me$/i.test(u.hostname)) {
    return { ok: false, reason: `Expected a readyplayer.me URL, got ${u.hostname}.` };
  }

  // ?id= form
  const qid = u.searchParams.get('id');
  if (qid && ID_RX.test(qid)) {
    return { ok: true, id: qid, url: `https://${RPM_HOST}/${qid}.glb` };
  }

  // /<id>[.glb] form
  const last = u.pathname.split('/').filter(Boolean).pop() || '';
  const id = last.replace(/\.glb$/i, '');
  if (!ID_RX.test(id)) {
    return { ok: false, reason: 'Could not find an avatar ID in that URL.' };
  }
  return { ok: true, id, url: `https://${RPM_HOST}/${id}.glb` };
}

export class ReadyPlayerMeProvider extends GLTFAvatarProvider {
  static get id() { return 'readyplayerme'; }
  static get label() { return 'Ready Player Me'; }
  static get description() {
    return 'Load an avatar you made at readyplayer.me. Needs internet on first load; no API key.';
  }
  static get capabilities() {
    return { lipSync: true, blink: true, emotions: true, gestures: true, customise: false, offline: false };
  }

  static async isAvailable() {
    const base = await GLTFAvatarProvider.isAvailable();
    if (!base.ok) return base;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return { ok: false, reason: 'You are offline — Ready Player Me needs to download the model.' };
    }
    return { ok: true };
  }

  /** @param {HTMLElement} container @param {{url?:string}} [options] */
  constructor(container, options = {}) {
    const parsed = normaliseRpmUrl(options.url || '');
    super(container, {
      ...options,
      url: parsed.ok ? parsed.url : undefined,
      name: parsed.ok ? `Ready Player Me ${parsed.id.slice(0, 8)}` : 'Ready Player Me',
    });
    this._parseError = parsed.ok ? null : /** @type {{ok:false, reason:string}} */ (parsed).reason;
  }

  async init() {
    if (this._parseError) {
      this.failureReason = this._parseError;
      return false;
    }
    const ok = await super.init();
    if (!ok && this.failureReason && /fetch|network|load/i.test(this.failureReason)) {
      this.failureReason =
        `Could not download the avatar. Check the URL and your connection. (${this.failureReason})`;
    }
    return ok;
  }
}

export default ReadyPlayerMeProvider;

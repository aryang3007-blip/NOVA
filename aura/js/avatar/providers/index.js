/**
 * AURA :: Avatar Provider registry
 * ================================
 * The single place a new provider is registered. Adding one here makes it
 * appear in the Avatar Manager automatically — no other file changes.
 *
 * @module avatar/providers/index
 */

import { AvatarProvider } from './base.js';
import { BuiltInAvatarProvider } from './builtin.js';
import { GLTFAvatarProvider } from './gltf.js';
import { ReadyPlayerMeProvider } from './readyplayerme.js';
import { SphereAvatarProvider } from './sphere.js';

/** @type {Array<typeof AvatarProvider>} order = display order */
export const PROVIDERS = [
  SphereAvatarProvider,
  BuiltInAvatarProvider,
  GLTFAvatarProvider,
  ReadyPlayerMeProvider,
];

/**
 * The Sphere is the default: it is the product's identity (a golden AI energy
 * core that reflects real agent state), it is offline, and it is far cheaper
 * than the humanoid on a software renderer. The humanoid remains one click
 * away in Settings -> Avatar.
 */
export const DEFAULT_PROVIDER = SphereAvatarProvider.id;

/** @returns {typeof AvatarProvider | null} */
export function getProviderClass(id) {
  return PROVIDERS.find(p => p.id === id) || null;
}

/** Descriptor list for the settings UI (no instantiation). */
export function listProviders() {
  return PROVIDERS.map(P => ({
    id: P.id,
    label: P.label,
    description: P.description,
    capabilities: P.capabilities,
    isDefault: P.id === DEFAULT_PROVIDER,
  }));
}

/** Which providers can actually run here, and why not if they can't. */
export async function probeProviders() {
  return Promise.all(PROVIDERS.map(async (P) => {
    /** @type {{ok:boolean, reason?:string}} */
    let avail = { ok: false, reason: 'probe failed' };
    try { avail = await P.isAvailable(); } catch (e) { avail = { ok: false, reason: e.message }; }
    return {
      id: P.id, label: P.label, description: P.description,
      capabilities: P.capabilities, available: avail.ok,
      reason: avail.ok ? null : avail.reason,
      isDefault: P.id === DEFAULT_PROVIDER,
    };
  }));
}

export { AvatarProvider, BuiltInAvatarProvider, GLTFAvatarProvider,
         ReadyPlayerMeProvider, SphereAvatarProvider };
export default PROVIDERS;

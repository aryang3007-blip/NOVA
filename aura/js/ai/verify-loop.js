/**
 * NOVA :: Desktop-action verification loop
 * =========================================
 * After AURA claims "opened WhatsApp", WHO checked? §9 says never fake a
 * result — so a launch action gets one honest verification pass BEFORE the
 * reply is narrated:
 *
 *   1. foreground window title via the bridge (fast, no screen share needed)
 *   2. if inconclusive AND a screen share is live: re-read the screen once
 *
 * The engine decides WHEN to run it and does the I/O; everything here is
 * pure matching/decision logic so the honesty guarantees are unit-tested.
 * Verification is ALWAYS best-effort: a miss is reported as a miss ("it may
 * still be loading"), never silently passed off as success.
 *
 * @module ai/verify-loop
 */

/** Actions that are supposed to bring something to the foreground. */
const LAUNCH_RX = /launch|open|run|start|play/;

/** "WhatsApp.exe" → "whatsapp", "Visual Studio Code (64-bit)" → "visual studio code". */
export function normalizeAppName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\.(exe|app|lnk|url)$/i, '')
    .replace(/\b(64[- ]?bit|desktop app|application|alpha|beta|the)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Significant (>=3 char) tokens of a normalized name. */
export function appTokens(s) {
  return normalizeAppName(s).split(/\s+/).filter(w => w.length >= 3);
}

/**
 * Does a window title / OCR text plausibly belong to the requested app?
 * Exact normalized match → yes. Whole-name substring (either direction) →
 * yes. Otherwise token overlap ≥ 60% (so "vs code" matches "Visual Studio
 * Code", while "Chrome" does not match "Word - Document1").
 */
export function appMatchesTitle(appName, title) {
  const a = normalizeAppName(appName);
  const t = normalizeAppName(title);
  if (!a || !t) return false;
  if (a === t) return true;
  if (t.includes(a) || a.includes(t)) return true;
  const aw = appTokens(a);
  if (!aw.length) return false;
  const tw = new Set(appTokens(t));
  const hit = aw.filter(w => tw.has(w)).length;
  return hit / aw.length >= 0.6;
}

export function isLaunchAction(action) {
  return LAUNCH_RX.test(String(action || '').toLowerCase());
}

/**
 * Should we even try to verify? A close/volume/screenshot action has nothing
 * to verify on screen; a failed or simulated action must never be "verified".
 */
export function shouldVerify({ enabled = true, ok = false, simulated = false,
                               target = '', action = '' } = {}) {
  return !!(enabled && ok && !simulated
            && String(target || '').trim() !== '' && isLaunchAction(action));
}

/**
 * The honest line appended to a narrated result.
 * @param {{verified:boolean, app:string, method?:string, reason?:string}|null} v
 * @returns {string} '' when there was no verification attempt
 */
export function verificationNote(v) {
  if (!v) return '';
  if (v.verified) {
    return `Verified — ${v.app} is in the foreground`
         + (v.method === 'screen' ? ' (screen re-read)' : '') + '.';
  }
  return `Could not confirm ${v.app} on screen`
       + (v.reason ? ` — ${v.reason}` : '') + '.';
}

export default { normalizeAppName, appTokens, appMatchesTitle, isLaunchAction,
                 shouldVerify, verificationNote };

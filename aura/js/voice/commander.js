/**
 * AURA :: wake commander follow-up mode
 * ======================================
 * After a wake word + command ("Hey Aura, open WhatsApp"), the conversation
 * does not have to die: AURA re-arms command listening for ONE follow-up
 * ("also open Spotify") without the user re-waking. The mic then falls back
 * to wake-only scanning automatically.
 *
 * Pure decision helpers are exported so this behaviour is unit-testable
 * without the UI/voice stack.
 *
 * @module voice/commander
 */

/** How long a commander follow-up window stays open. */
export const FOLLOWUP_WINDOW_MS = 12000;

/** Delay after the reply finishes before re-arming the mic. */
export const REARM_DELAY_MS = 900;

/**
 * Should command listening be re-armed after the current turn?
 * One follow-up per wake, never while a reply is still coming or speaking.
 *
 * @param {{
 *   wakeOriginated?:boolean, followupEnabled?:boolean, wakeWordEnabled?:boolean,
 *   streaming?:boolean, speaking?:boolean
 * }} s
 */
export function shouldRearmCommander(s) {
  return !!(s?.wakeOriginated && s?.followupEnabled !== false
            && s?.wakeWordEnabled && !s?.streaming && !s?.speaking);
}

/** Is `now` inside the follow-up window that closes at `until`? */
export function followupOpen(now, until) {
  return Number.isFinite(now) && Number.isFinite(until) && now <= until;
}

export default { FOLLOWUP_WINDOW_MS, REARM_DELAY_MS, shouldRearmCommander, followupOpen };

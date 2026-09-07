/**
 * AURA :: Device-Aware Intent Routing
 * ------------------------------------
 * Detects when user wants to target a paired device (phone, PC, etc)
 * Extracts device reference and routes appropriately.
 *
 * @module ai/device-router
 */

/**
 * Patterns that indicate user wants to target a specific device.
 * Must capture the device identifier.
 */
const DEVICE_PATTERNS = [
  // Named device: "on Aryan's phone" / "on mom's tablet" — the NAME matters
  // because several devices can be paired. Keep the name as the reference.
  { rx: /\b(?:on|to|onto)\s+([a-z][a-z0-9]{1,20}?)['’]s\s+(phone|mobile|android|iphone|tablet|tablet|ipad|laptop|computer|pc)\b/i,
    device: (m) => `${m[1].toLowerCase()}-${m[2].toLowerCase()}`,
    label: (m) => `${m[1]}'s ${m[2]}` },
  // "on my phone" / "in my mobile" / "phone pe" / "to the tablet"
  { rx: /\b(?:on|in|at|to|into|onto|send to|route to|put on|cast to)\s+(?:my\s+|the\s+|mera\s+|mere\s+)(phone|mobile|android|iphone|ipad|ios|tablet|cell|fone)\b/i,
    device: () => 'phone', label: () => 'phone' },
  { rx: /\b(phone|mobile|tablet)\s+(pe|par|me|mein)\b/i,
    device: () => 'phone', label: () => 'phone' },
  // "on my laptop" / "on this computer" / "another desktop" / "your desktop"
  { rx: /\b(?:on|at|to|send to|route to)\s+(?:my\s+|the\s+|this\s+)?(laptop|pc|computer|windows machine|desktop)\b/i,
    device: () => 'windows-host', label: () => 'this computer' },
  { rx: /\b(?:on|in|to)\s+(?:your|another|the other|a second)\s+(desktop|computer|pc|aura device|machine)\b/i,
    device: (m) => `aura-${m[1].toLowerCase().replace(/\s+/g, '-')}`,
    label: (m) => `another ${m[1]}` },
  // "on my mac"
  { rx: /\b(?:on|at|to|send to|route to)\s+(?:my\s+)?(mac|macbook|macos|osx)\b/i,
    device: () => 'macos', label: () => 'mac' },
  // Device ID directly: "on android-001" / "on phone-003"
  { rx: /\b(?:on|at|to|send to|route to)\s+([a-z0-9\-]+-\d{3,})\b/i,
    device: (m) => m[1] },
];

/**
 * Extract device reference from user input.
 * Returns { device: string, confidence: number, reason: string } or null
 *
 * @param {string} text
 * @returns {{device:string, confidence:number, reason:string} | null}
 */
export function detectDeviceTarget(text) {
  const t = String(text || '').trim();
  if (!t) return null;

  for (const pattern of DEVICE_PATTERNS) {
    const m = pattern.rx.exec(t);
    if (m) {
      const device = pattern.device(m);
      if (!device) continue;
      return {
        device,
        confidence: 0.92,
        reason: `device:${device}`,
        match: m[0],
      };
    }
  }
  return null;
}

/**
 * Remove device targeting from text so the core action can be extracted.
 * e.g. "open youtube on my phone" → "open youtube"
 *
 * @param {string} text
 * @returns {string}
 */
export function stripDeviceTarget(text) {
  const t = String(text || '');
  let result = t;

  for (const pattern of DEVICE_PATTERNS) {
    result = result.replace(pattern.rx, '').trim();
  }

  return result || t;
}

/**
 * Deterministic device-intent parser for VOICE follow-ups.
 *
 * A wake-word command like "open youtube on my phone" should work the same
 * as typing `/devices open youtube` — same canonical function, same honest
 * errors, no model needed. This maps natural speech onto the device command
 * surface. It is deliberately CONSERVATIVE: only unambiguous device actions
 * match; anything else returns null and goes to the model as before.
 *
 * @param {string} text
 * @returns {{sub:string, arg:string, device:string|null, reason:string} | null}
 */
export function parseDeviceVoiceIntent(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const low = t.toLowerCase().replace(/\s+/g, ' ').trim();
  const phoneWord = /\b(?:phone|mobile|device|android|iphone|cell)\b/;
  const hasPhoneRef = (s) => phoneWord.test(s);
  const phoneRef = "(?:(?:my|the|this|[a-z][a-z0-9]{0,18}'?s?)\\s+)?(?:phone|mobile|device|android|iphone)";

  // ── find / locate / ring my phone
  let m = new RegExp("\\b(?:find|locate|ring|where'?s)\\s+" + phoneRef + "\\b", 'i').exec(low);
  if (m) return { sub: 'locate', arg: '', device: 'phone', reason: 'locate' };

  // ── battery
  if (/\bbattery\b/.test(low) && hasPhoneRef(low)) {
    return { sub: 'battery', arg: '', device: 'phone', reason: 'battery' };
  }

  // ── list devices / what is paired
  if (/\b(?:list|show|which)\b.*\b(?:devices|paired)\b/.test(low)) {
    return { sub: 'list', arg: '', device: null, reason: 'list' };
  }

  // ── ping / check the phone
  if (/\bping\b/.test(low) && hasPhoneRef(low)) {
    return { sub: 'ping', arg: '', device: 'phone', reason: 'ping' };
  }

  // ── camera / mic
  if (/\b(?:take|open|use)\s+(?:a\s+|the\s+)?(?:photo|picture|snapshot|camera)\b/.test(low) && hasPhoneRef(low)) {
    return { sub: 'camera', arg: '', device: 'phone', reason: 'camera' };
  }
  if (/\b(?:use|open|turn on)\s+(?:the\s+)?(?:mic|microphone)\b/.test(low) && hasPhoneRef(low)) {
    return { sub: 'mic', arg: '', device: 'phone', reason: 'mic' };
  }

  // ── vibrate [ms]
  if (/\bvibrate\b/.test(low) && hasPhoneRef(low)) {
    const ms = /(\d{2,4})/.exec(low);
    return { sub: 'vibrate', arg: ms ? ms[1] : '', device: 'phone', reason: 'vibrate' };
  }

  // ── notify: "notify my phone dinner is ready" / "send a notification to the
  //    phone saying everything is fine"
  const notifyRx = new RegExp(
    '\\b(?:notify|alert|tell)\\s+' + phoneRef + '?\\s+(.*)$|' +
    '\\b(?:send)\\s+(?:a\\s+|the\\s+)?notification\\s+(?:to\\s+)?' + phoneRef + '?' +
    '\\s*(?:saying\\s+)?(.*)$', 'i');
  m = notifyRx.exec(low);
  if (m && (m[1] || m[2]) && hasPhoneRef(low)) {
    const msg = (m[1] || m[2] || '').trim();
    if (msg) return { sub: 'notify', arg: msg, device: 'phone', reason: 'notify' };
  }

  // ── open: "<verb> <app|url> on my phone" (device target phrase anywhere)
  m = new RegExp(
    '\\b(?:open|launch|start|play|show|take me to)\\s+' +
    '(.+?)\\s+(?:on|in|to)\\s+' + phoneRef + '\\b', 'i').exec(low);
  if (m) {
    // "play the news on my phone" → "news" (the catalog name), not "the news".
    const clean = m[1].trim().replace(/^(?:the|a|an)\s+/i, '');
    return { sub: 'open', arg: clean, device: 'phone', reason: 'open' };
  }

  // "open youtube" or a bare URL without an explicit phone phrase is still a
  // phone action ONLY when the whole utterance targets the phone ("please
  // open youtube") — otherwise it is desktop-bound and must NOT be hijacked.
  m = /\b(?:open|launch|start|play)\s+(.+)$/.exec(low);
  if (m && hasPhoneRef(low)) {
    return { sub: 'open', arg: m[1].trim(), device: 'phone', reason: 'open' };
  }

  return null;
}

/**
 * Resolve device reference to actual device ID.
 * Calls the devices module to look up by name/platform.
 *
 * @param {string} deviceRef - e.g. "phone", "android-001", "my phone"
 * @param {Function} devicesResolve - devices.resolve function
 * @returns {{id:string, error?:string}}
 */
export function resolveDevice(deviceRef, devicesResolve) {
  if (!devicesResolve) {
    return { id: null, error: 'Device gateway not available' };
  }

  const [id, err] = devicesResolve(deviceRef);
  if (err) {
    return { id: null, error: err };
  }
  return { id, error: null };
}

export default { detectDeviceTarget, stripDeviceTarget, resolveDevice, parseDeviceVoiceIntent };

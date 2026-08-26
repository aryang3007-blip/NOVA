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

export default { detectDeviceTarget, stripDeviceTarget, resolveDevice };

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
  // "on my phone" / "on the phone" / "on my android"
  { rx: /\b(on|at|to|send to|route to)\s+(my\s+)?(?:the\s+)?(phone|mobile|android|iphone|ipad|ios|cell)/i,
    device: (m) => m[4]?.toLowerCase().match(/iphone|ipad|ios/) ? 'phone' : 'phone' },
  // "on my laptop" / "on my pc" / "on this computer"
  { rx: /\b(on|at|to|send to|route to)\s+(my\s+)?(?:this\s+)?(laptop|pc|computer|windows machine|desktop)/i,
    device: () => 'windows-host' },
  // "on my mac"
  { rx: /\b(on|at|to|send to|route to)\s+(my\s+)?(mac|macos|osx)/i,
    device: () => 'macos' },
  // Device ID directly: "on android-001" / "on phone-003"
  { rx: /\b(on|at|to|send to|route to)\s+([a-z0-9\-]+)\b/i,
    device: (m) => m[2] },
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

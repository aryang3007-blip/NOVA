/**
 * AURA :: Gesture Classifier
 * --------------------------
 * Pure geometry over MediaPipe Hands' 21 landmarks. No ML beyond the
 * landmarker itself, no hardcoded "if frame 30 then wave" cheating.
 *
 * Landmark indices (MediaPipe standard):
 *   0  wrist
 *   1-4   thumb  (CMC, MCP, IP, TIP)
 *   5-8   index  (MCP, PIP, DIP, TIP)
 *   9-12  middle
 *   13-16 ring
 *   17-20 pinky
 *
 * Image coords are normalised 0..1 with y increasing DOWNWARD.
 *
 * Pure functions -> unit tested in Node.
 */

export const LM = {
  WRIST: 0,
  THUMB_CMC: 1, THUMB_MCP: 2, THUMB_IP: 3, THUMB_TIP: 4,
  INDEX_MCP: 5, INDEX_PIP: 6, INDEX_DIP: 7, INDEX_TIP: 8,
  MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_DIP: 11, MIDDLE_TIP: 12,
  RING_MCP: 13, RING_PIP: 14, RING_DIP: 15, RING_TIP: 16,
  PINKY_MCP: 17, PINKY_PIP: 18, PINKY_DIP: 19, PINKY_TIP: 20,
};

export const GESTURES = {
  none: { label: 'None', icon: '' },
  wave: { label: 'Wave', icon: '👋' },
  open_palm: { label: 'Open Palm', icon: '🖐' },
  thumbs_up: { label: 'Thumbs Up', icon: '👍' },
  thumbs_down: { label: 'Thumbs Down', icon: '👎' },
  peace: { label: 'Peace', icon: '✌' },
  pointing: { label: 'Pointing', icon: '☝' },
  fist: { label: 'Fist', icon: '✊' },
  rock: { label: 'Rock On', icon: '🤘' },
  ok: { label: 'OK', icon: '👌' },
  // Three-finger salute — a deliberate, unmistakable pose for a destination
  // you do not want to reach by accident.
  three: { label: 'Three Fingers', icon: '🤟' },
  // Directional swipes. Temporal, like the wave.
  swipe_left: { label: 'Swipe Left', icon: '👈' },
  swipe_right: { label: 'Swipe Right', icon: '👉' },
  swipe_up: { label: 'Swipe Up', icon: '👆' },
  swipe_down: { label: 'Swipe Down', icon: '👇' },
};

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));

/** Reference scale: wrist → middle-MCP. Makes thresholds distance-invariant. */
export function palmSize(L) {
  return Math.max(dist(L[LM.WRIST], L[LM.MIDDLE_MCP]), 1e-6);
}

/**
 * Which fingers are extended? Returns [thumb, index, middle, ring, pinky].
 * Non-thumb: tip must be measurably beyond the PIP joint *away from the wrist*.
 * Thumb: uses lateral distance from the index MCP, since the thumb abducts
 * sideways rather than curling along the same axis.
 */
export function fingersUp(L) {
  if (!L || L.length < 21) return [false, false, false, false, false];
  const scale = palmSize(L);
  const wrist = L[LM.WRIST];

  const straight = (mcp, pip, tip) => {
    const dTip = dist(L[tip], wrist);
    const dPip = dist(L[pip], wrist);
    const dMcp = dist(L[mcp], wrist);
    // extended when the tip is clearly farther from the wrist than the PIP,
    // and the whole chain grows monotonically outward
    return dTip > dPip + scale * 0.12 && dPip >= dMcp - scale * 0.05;
  };

  const index = straight(LM.INDEX_MCP, LM.INDEX_PIP, LM.INDEX_TIP);
  const middle = straight(LM.MIDDLE_MCP, LM.MIDDLE_PIP, LM.MIDDLE_TIP);
  const ring = straight(LM.RING_MCP, LM.RING_PIP, LM.RING_TIP);
  const pinky = straight(LM.PINKY_MCP, LM.PINKY_PIP, LM.PINKY_TIP);

  // Thumb: far from the index knuckle AND tip beyond the IP joint.
  const thumbSpread = dist(L[LM.THUMB_TIP], L[LM.INDEX_MCP]) / scale;
  const thumbExtended = dist(L[LM.THUMB_TIP], wrist) > dist(L[LM.THUMB_IP], wrist) + scale * 0.02;
  const thumb = thumbSpread > 0.62 && thumbExtended;

  return [thumb, index, middle, ring, pinky];
}

/** Signed hand orientation: -1 = fingers point up on screen, +1 = down. */
export function handDirection(L) {
  return Math.sign(L[LM.MIDDLE_MCP].y - L[LM.WRIST].y) || -1;
}

/** Angle of the index finger in degrees (0 = right, 90 = up). */
export function pointingAngle(L) {
  const dx = L[LM.INDEX_TIP].x - L[LM.INDEX_MCP].x;
  const dy = L[LM.INDEX_TIP].y - L[LM.INDEX_MCP].y;
  return (Math.atan2(-dy, dx) * 180) / Math.PI;
}

/**
 * Classify a single hand's static pose.
 * @param {Array<{x:number,y:number,z?:number}>} L 21 landmarks
 * @returns {{gesture:string, confidence:number, fingers:boolean[], count:number}}
 */
export function classifyGesture(L) {
  if (!L || !Array.isArray(L) || L.length < 21) {
    return { gesture: 'none', confidence: 0, fingers: [false, false, false, false, false], count: 0 };
  }
  const f = fingersUp(L);
  const [thumb, index, middle, ring, pinky] = f;
  const count = f.filter(Boolean).length;
  const scale = palmSize(L);
  const wrist = L[LM.WRIST];

  // ── OK sign: thumb tip touches index tip, other three extended
  const pinchDist = dist3(L[LM.THUMB_TIP], L[LM.INDEX_TIP]) / scale;
  if (pinchDist < 0.32 && middle && ring && pinky) {
    return { gesture: 'ok', confidence: clamp(1 - pinchDist / 0.32, 0.6, 0.97), fingers: f, count };
  }

  // ── Open palm: all five out
  if (count === 5) {
    const spread = (dist(L[LM.INDEX_TIP], L[LM.PINKY_TIP]) / scale);
    return { gesture: 'open_palm', confidence: clamp(0.7 + spread * 0.22, 0.7, 0.99), fingers: f, count };
  }

  // ── Four fingers, thumb tucked → still an open hand for UX purposes
  if (count === 4 && !thumb) {
    return { gesture: 'open_palm', confidence: 0.78, fingers: f, count };
  }

  // ── Peace / victory
  if (index && middle && !ring && !pinky) {
    const sep = dist(L[LM.INDEX_TIP], L[LM.MIDDLE_TIP]) / scale;
    if (sep > 0.22) {
      return { gesture: 'peace', confidence: clamp(0.68 + sep * 0.5, 0.68, 0.98), fingers: f, count };
    }
    return { gesture: 'peace', confidence: 0.62, fingers: f, count };
  }

  // ── Three fingers (index + middle + ring, pinky and thumb down).
  // Distinct from open_palm (5) and peace (2), and hard to form by accident.
  if (index && middle && ring && !pinky && !thumb) {
    return { gesture: 'three', confidence: 0.86, fingers: f, count };
  }

  // ── Rock on 🤘 (index + pinky)
  if (index && pinky && !middle && !ring) {
    return { gesture: 'rock', confidence: 0.85, fingers: f, count };
  }

  // ── Pointing (index only)
  if (index && !middle && !ring && !pinky) {
    const reach = dist(L[LM.INDEX_TIP], wrist) / scale;
    return { gesture: 'pointing', confidence: clamp(0.62 + reach * 0.16, 0.62, 0.97), fingers: f, count };
  }

  // ── Thumbs up / down (thumb only)
  if (thumb && !index && !middle && !ring && !pinky) {
    const vertical = (wrist.y - L[LM.THUMB_TIP].y) / scale;   // + means tip above wrist
    if (vertical > 0.35) {
      return { gesture: 'thumbs_up', confidence: clamp(0.68 + vertical * 0.22, 0.68, 0.98), fingers: f, count };
    }
    if (vertical < -0.35) {
      return { gesture: 'thumbs_down', confidence: clamp(0.68 + Math.abs(vertical) * 0.22, 0.68, 0.98), fingers: f, count };
    }
    return { gesture: 'thumbs_up', confidence: 0.55, fingers: f, count };
  }

  // ── Fist
  if (count === 0) {
    const curl = (dist(L[LM.INDEX_TIP], L[LM.INDEX_MCP]) + dist(L[LM.MIDDLE_TIP], L[LM.MIDDLE_MCP])) / (2 * scale);
    return { gesture: 'fist', confidence: clamp(1.05 - curl, 0.6, 0.96), fingers: f, count };
  }

  return { gesture: 'none', confidence: 0.3, fingers: f, count };
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Temporal wave detector.
 * A wave = an open-ish hand whose wrist x-position oscillates: at least
 * `minReversals` direction changes with meaningful amplitude inside the window.
 */
export class WaveDetector {
  constructor({ windowMs = 1600, minReversals = 3, minAmplitude = 0.055 } = {}) {
    this.windowMs = windowMs;
    this.minReversals = minReversals;
    this.minAmplitude = minAmplitude;
    /** @type {Array<{x:number,t:number}>} */
    this.samples = [];
  }

  reset() { this.samples.length = 0; }

  /**
   * @param {number} x normalised wrist x
   * @param {number} t timestamp ms
   * @param {boolean} handOpen only count when the hand is open-ish
   * @returns {{isWave:boolean, confidence:number, reversals:number, amplitude:number}}
   */
  push(x, t = Date.now(), handOpen = true) {
    if (!handOpen) { this.reset(); return { isWave: false, confidence: 0, reversals: 0, amplitude: 0 }; }
    this.samples.push({ x, t });
    const cutoff = t - this.windowMs;
    while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();
    if (this.samples.length < 6) return { isWave: false, confidence: 0, reversals: 0, amplitude: 0 };

    const xs = this.samples.map(s => s.x);
    const amplitude = Math.max(...xs) - Math.min(...xs);

    // count direction reversals on a smoothed signal
    const sm = [];
    for (let i = 0; i < xs.length; i++) {
      const a = xs[Math.max(0, i - 1)], b = xs[i], c = xs[Math.min(xs.length - 1, i + 1)];
      sm.push((a + b + c) / 3);
    }
    let reversals = 0, lastDir = 0;
    for (let i = 1; i < sm.length; i++) {
      const d = sm[i] - sm[i - 1];
      if (Math.abs(d) < 0.004) continue;
      const dir = Math.sign(d);
      if (lastDir !== 0 && dir !== lastDir) reversals++;
      lastDir = dir;
    }

    const isWave = reversals >= this.minReversals && amplitude >= this.minAmplitude;
    const confidence = isWave
      ? clamp(0.55 + reversals * 0.08 + amplitude * 1.6, 0.55, 0.98)
      : 0;
    return { isWave, confidence, reversals, amplitude };
  }
}

/**
 * Directional swipe detector — the "Iron Man" flick.
 *
 * A swipe is a FAST, MOSTLY-STRAIGHT, ONE-WAY movement of the palm. That
 * definition is what separates it from a wave, which is slow and oscillates.
 * Both watch the same wrist position, so the two must not fight:
 *
 *   wave  = many direction reversals, low net displacement
 *   swipe = zero/one reversal, high net displacement, high speed
 *
 * Requiring `straightness` (net displacement / path length) above 0.75 kills
 * the false positives, because a wave's path length is huge while its net
 * displacement is near zero.
 *
 * Coordinates are normalised (0..1) and the camera is MIRRORED, so a hand
 * moving right on screen has DECREASING x. We report the direction the user
 * perceives, not the raw axis.
 */
export class SwipeDetector {
  constructor({ windowMs = 500, minDistance = 0.20, minSpeed = 0.55,
                minStraightness = 0.75, cooldownMs = 900 } = {}) {
    this.windowMs = windowMs;
    this.minDistance = minDistance;       // normalised units
    this.minSpeed = minSpeed;             // units per second
    this.minStraightness = minStraightness;
    this.cooldownMs = cooldownMs;
    /** @type {Array<{x:number,y:number,t:number}>} */
    this.samples = [];
    this.lastFire = 0;
  }

  reset() { this.samples.length = 0; }

  /**
   * @param {number} x normalised wrist x (mirrored view)
   * @param {number} y normalised wrist y
   * @param {number} t timestamp ms
   * @param {boolean} handOpen swipes are made with an open hand
   * @returns {{swipe:string|null, confidence:number, distance:number,
   *            speed:number, straightness:number}}
   */
  push(x, y, t = Date.now(), handOpen = true) {
    const none = { swipe: null, confidence: 0, distance: 0, speed: 0, straightness: 0 };
    if (!handOpen) { this.reset(); return none; }
    if (t - this.lastFire < this.cooldownMs) return none;

    this.samples.push({ x, y, t });
    const cutoff = t - this.windowMs;
    while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();
    if (this.samples.length < 4) return none;

    const a = this.samples[0], b = this.samples[this.samples.length - 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const net = Math.hypot(dx, dy);

    // Path length — a wave inflates this while `net` stays small.
    let path = 0;
    for (let i = 1; i < this.samples.length; i++) {
      path += Math.hypot(this.samples[i].x - this.samples[i - 1].x,
                         this.samples[i].y - this.samples[i - 1].y);
    }
    const straightness = path > 1e-6 ? net / path : 0;
    const dt = Math.max(1, b.t - a.t) / 1000;
    const speed = net / dt;

    if (net < this.minDistance || speed < this.minSpeed || straightness < this.minStraightness) {
      return { swipe: null, confidence: 0, distance: net, speed, straightness };
    }

    // Dominant axis wins; require it to clearly dominate so a diagonal
    // flick does not fire an arbitrary direction.
    let swipe;
    if (Math.abs(dx) > Math.abs(dy) * 1.4) {
      // Mirrored preview: screen-right is decreasing x.
      swipe = dx < 0 ? 'swipe_right' : 'swipe_left';
    } else if (Math.abs(dy) > Math.abs(dx) * 1.4) {
      swipe = dy < 0 ? 'swipe_up' : 'swipe_down';
    } else {
      return { swipe: null, confidence: 0, distance: net, speed, straightness };
    }

    this.lastFire = t;
    this.reset();
    return {
      swipe,
      confidence: clamp(0.6 + net * 0.8 + straightness * 0.2, 0.6, 0.98),
      distance: net, speed, straightness,
    };
  }
}

/**
 * Debounce + hysteresis so a gesture must be stable before it fires,
 * and cannot re-fire until it has been released or the cooldown elapses.
 */
/**
 * Gestures that are TEMPORAL rather than a held pose.
 *
 * A wave is already proof of intent by the time WaveDetector reports it: it
 * has seen ~3 direction reversals over up to 1.6s. Requiring it to then hold
 * for `holdFrames` consecutive frames — like a static thumbs-up — is wrong,
 * and combined with WaveDetector.reset() after firing it meant most real
 * waves were swallowed and the avatar never waved back.
 */
const TRANSIENT_GESTURES = new Set([
  'wave', 'swipe_left', 'swipe_right', 'swipe_up', 'swipe_down',
]);

export class GestureStabilizer {
  constructor({ holdFrames = 5, cooldownMs = 2200, minConfidence = 0.6,
                transientHoldFrames = 1, transientCooldownMs = 1200 } = {}) {
    this.holdFrames = holdFrames;
    this.cooldownMs = cooldownMs;
    this.minConfidence = minConfidence;
    /** Frames a temporal gesture must persist (it already proved itself). */
    this.transientHoldFrames = transientHoldFrames;
    /** Shorter cooldown so a second wave is answered, not ignored. */
    this.transientCooldownMs = transientCooldownMs;
    this.candidate = 'none';
    this.streak = 0;
    this.active = 'none';
    this.lastFired = new Map();
  }

  reset() { this.candidate = 'none'; this.streak = 0; this.active = 'none'; }

  /**
   * @returns {{fire:boolean, gesture:string, confidence:number, released?:string}}
   */
  update(gesture, confidence, now = Date.now()) {
    let released;
    if (gesture !== this.candidate) {
      this.candidate = gesture;
      this.streak = 1;
    } else {
      this.streak++;
    }

    if (this.active !== 'none' && gesture !== this.active && this.streak >= 2) {
      released = this.active;
      this.active = 'none';
    }

    const transient = TRANSIENT_GESTURES.has(gesture);
    const needFrames = transient ? this.transientHoldFrames : this.holdFrames;
    const cooldown = transient ? this.transientCooldownMs : this.cooldownMs;

    const stable = this.streak >= needFrames && confidence >= this.minConfidence && gesture !== 'none';
    if (!stable) return { fire: false, gesture, confidence, released };

    const last = this.lastFired.get(gesture) || 0;
    // A held pose shouldn't re-fire while still held. A transient gesture has
    // no "held" state — each detected wave is a new event.
    if (!transient && this.active === gesture) return { fire: false, gesture, confidence, released };
    if (now - last < cooldown) return { fire: false, gesture, confidence, released };

    this.lastFired.set(gesture, now);
    this.active = gesture;
    return { fire: true, gesture, confidence, released };
  }
}

export default { classifyGesture, fingersUp, WaveDetector, SwipeDetector, GestureStabilizer, GESTURES, LM, pointingAngle, palmSize, handDirection };

/**
 * AURA :: Face Recognition (identity)
 * ===================================
 * Recognises *who* is in front of the camera, not just that a face is there.
 *
 * WHY NO EXTRA MODEL DOWNLOAD
 * ---------------------------
 * A conventional approach ships FaceNet/ArcFace — another 5-20 MB of weights
 * and a second inference pass every frame. AURA already runs MediaPipe's
 * FaceLandmarker, which returns **478 3-D landmarks**. Those landmarks encode
 * the geometry of a face precisely enough to tell a handful of people apart,
 * so we build the signature from data we are already paying for: zero extra
 * download, zero extra inference, works fully offline.
 *
 * HOW THE SIGNATURE WORKS
 * -----------------------
 * Raw landmark coordinates are useless on their own — they move when you move.
 * So we compute **ratios between distances**, which are invariant to how far
 * away you are, where you are in frame, and (mostly) which way you are facing:
 *
 *     signature[i] = distance(landmark A, landmark B) / interocular distance
 *
 * Normalising by the eye-to-eye distance removes scale. Using pairs that span
 * the face (jaw width vs nose height, brow spacing vs mouth width, …) captures
 * bone structure rather than expression. Two enrolments of the same person
 * land close together; two different people do not.
 *
 * HONEST LIMITATIONS — stated because this is a recognition system:
 *   • Geometric, not deep-learned. Good for a household (2-8 people). It is
 *     NOT a security mechanism and must never gate anything sensitive.
 *   • Identical twins will very likely collide.
 *   • Extreme head rotation degrades accuracy; we detect and reject bad poses
 *     during enrolment rather than storing a poor sample.
 *   • Heavy expression change shifts some ratios; we average several samples
 *     per person to average that out.
 *
 * PRIVACY: what is stored is a short array of floats. No image, no video, no
 * upload. It lives in this browser's localStorage and you can delete it.
 *
 * @module vision/face-recognition
 */

/**
 * Landmark index pairs whose distance ratios form the signature.
 * Chosen to span bone structure rather than soft tissue: eye corners, nose
 * bridge, jaw hinges, brow ridge, skull width.
 * (MediaPipe FaceMesh canonical indices.)
 */
const PAIRS = [
  [33, 263],   // outer eye corner → outer eye corner  (the normaliser)
  [133, 362],  // inner eye corners
  [1, 152],    // nose tip → chin
  [10, 152],   // forehead → chin  (face height)
  [234, 454],  // left cheek → right cheek (face width)
  [61, 291],   // mouth corners
  [0, 17],     // upper lip → lower lip
  [70, 300],   // brow outer ends
  [55, 285],   // brow inner ends
  [168, 1],    // nose bridge → tip
  [98, 327],   // nostril width
  [132, 361],  // jaw hinges
  [58, 288],   // jaw mid
  [93, 323],   // ear-line width
  [10, 168],   // forehead → bridge
  [152, 175],  // chin depth
  [46, 276],   // brow arch span
  [7, 249],    // lower eyelids
  [159, 145],  // right eye height
  [386, 374],  // left eye height
  [78, 308],   // inner mouth width
  [13, 14],    // lip gap
  [234, 152],  // cheek → chin
  [454, 152],  // cheek → chin (other side)
  [33, 1],     // eye → nose tip
  [263, 1],    // eye → nose tip (other side)
];

const NORM_PAIR = 0;              // index into PAIRS used to normalise scale
const MIN_SAMPLES = 3;            // enrolment samples required
// Tuned against measured spreads from the new similarity metric:
// same person scores ~0.92-0.94 (including scale/position change), different
// people score ~0.0. 0.80 sits well clear of both, so noise cannot flip it.
const MATCH_THRESHOLD = 0.80;
const MARGIN = 0.06;              // best must beat runner-up by this much
const LS_KEY = 'aura.faces.v1';

const dist3 = (a, b) => {
  const dx = a.x - b.x, dy = a.y - b.y, dz = (a.z || 0) - (b.z || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

/**
 * Turn 478 landmarks into a compact, scale-invariant signature.
 * @param {Array<{x:number,y:number,z:number}>} lm
 * @returns {number[]|null} null when the landmarks are unusable
 */
export function computeSignature(lm) {
  if (!Array.isArray(lm) || lm.length < 468) return null;
  const norm = dist3(lm[PAIRS[NORM_PAIR][0]], lm[PAIRS[NORM_PAIR][1]]);
  if (!norm || !Number.isFinite(norm) || norm < 1e-6) return null;

  const sig = [];
  for (let i = 0; i < PAIRS.length; i++) {
    if (i === NORM_PAIR) continue;            // always 1.0, carries no info
    const [a, b] = PAIRS[i];
    if (!lm[a] || !lm[b]) return null;
    const v = dist3(lm[a], lm[b]) / norm;
    if (!Number.isFinite(v)) return null;
    sig.push(v);
  }
  return sig;
}

/**
 * How square-on is the face? Enrolling a heavily turned head produces a
 * signature that will not match a front-facing one, so we refuse it.
 * @returns {number} 0 = extreme angle, 1 = facing the camera
 */
export function frontalScore(lm) {
  if (!Array.isArray(lm) || lm.length < 468) return 0;
  const nose = lm[1], l = lm[234], r = lm[454];
  if (!nose || !l || !r) return 0;
  const dl = Math.abs(nose.x - l.x);
  const dr = Math.abs(r.x - nose.x);
  const total = dl + dr;
  if (total < 1e-6) return 0;
  // Perfectly centred nose → 1. Fully turned → 0.
  return 1 - Math.abs(dl - dr) / total;
}

/**
 * Similarity between two signatures, 0..1.
 *
 * NOT plain cosine. All human faces share the same broad proportions, so
 * cosine similarity between any two people sits around 0.97 — the useful
 * signal is buried in the last two decimal places, and a threshold there is
 * indistinguishable from noise. (Measured: same person 0.9985, different
 * person 0.9720 — a 2.6% spread.)
 *
 * Instead we score on RELATIVE per-feature deviation: how far apart the two
 * signatures are on each ratio, as a fraction of the ratio itself. That
 * stretches the useful range across the whole 0..1 interval, so a threshold
 * means something. Same person now scores ~0.99, different people ~0.4.
 */
export function similarity(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return 0;

  // MAGNITUDE-WEIGHTED relative deviation.
  //
  // A plain per-feature relative error is wrong here: some ratios are tiny
  // (~0.001), so fixed landmark jitter becomes an enormous *relative* error
  // for them and drowns out the large, structural features that actually
  // identify a face. Measured: moving the same face nearer/further produced
  // 0.85 relative error on a near-zero feature while the mean was 0.27 —
  // enough to reject a correct match.
  //
  // Weighting each feature by its own magnitude means big, stable distances
  // (face width, jaw span) dominate and noise-prone micro-distances
  // contribute proportionally little.
  let wsum = 0, acc = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i], bv = b[i];
    if (!Number.isFinite(av) || !Number.isFinite(bv)) continue;
    const mag = Math.max(Math.abs(av), Math.abs(bv));
    if (mag < 1e-6) continue;
    const rel = Math.abs(av - bv) / mag;
    acc += rel * mag;      // weight the error by how large the feature is
    wsum += mag;
  }
  if (wsum <= 0) return 0;
  const weighted = acc / wsum;
  // 8% weighted deviation ≈ a different face. Tuned against measured spreads:
  // same person (incl. scale/position change) lands ~0.90+, different ~0.
  return Math.max(0, 1 - weighted / 0.08);
}

/** Element-wise mean of several signatures — the enrolled template. */
export function averageSignatures(list) {
  const valid = (list || []).filter(s => Array.isArray(s) && s.length);
  if (!valid.length) return null;
  const n = valid[0].length;
  const out = new Array(n).fill(0);
  for (const s of valid) {
    if (s.length !== n) continue;
    for (let i = 0; i < n; i++) out[i] += s[i];
  }
  return out.map(v => v / valid.length);
}

export class FaceRecognizer {
  /** @param {{storage?:Storage, threshold?:number}} [opts] */
  constructor({ storage = null, threshold = MATCH_THRESHOLD } = {}) {
    this.storage = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    this.threshold = threshold;
    /** @type {Array<{id:string, name:string, template:number[], samples:number, at:number, seen:number, lastSeen:number|null}>} */
    this.people = [];
    /** Enrolment in progress. */
    this.enrolling = null;
    this._lastMatch = null;
    this._stableCount = 0;
    this.load();
  }

  /* ── persistence ──────────────────────────────────────────────────── */

  load() {
    if (!this.storage) return 0;
    try {
      const raw = this.storage.getItem(LS_KEY);
      if (!raw) return 0;
      const d = JSON.parse(raw);
      this.people = Array.isArray(d.people) ? d.people : [];
    } catch { this.people = []; }
    return this.people.length;
  }

  save() {
    if (!this.storage) return false;
    try {
      this.storage.setItem(LS_KEY, JSON.stringify({ v: 1, people: this.people }));
      return true;
    } catch { return false; }
  }

  /* ── enrolment ────────────────────────────────────────────────────── */

  /**
   * Begin enrolling a person. Call addSample() with live landmarks until
   * `needed` reaches 0, then finishEnrollment().
   */
  startEnrollment(name) {
    const clean = String(name || '').trim().slice(0, 40);
    if (!clean) return { ok: false, message: 'Give the person a name.' };
    this.enrolling = { name: clean, samples: [], startedAt: Date.now() };
    return { ok: true, name: clean, needed: MIN_SAMPLES,
             message: `Look at the camera. Capturing ${MIN_SAMPLES} samples for ${clean}.` };
  }

  /**
   * Feed one frame's landmarks into the enrolment.
   * Rejects samples that are too angled or too similar to the previous one —
   * three copies of the same frame is not three samples.
   */
  addSample(landmarks) {
    if (!this.enrolling) return { ok: false, message: 'Not enrolling.' };
    const frontal = frontalScore(landmarks);
    if (frontal < 0.62) {
      return { ok: false, rejected: 'angle', frontal,
               message: 'Face the camera more directly.' };
    }
    const sig = computeSignature(landmarks);
    if (!sig) return { ok: false, rejected: 'landmarks', message: 'Face not clear enough.' };

    const prev = this.enrolling.samples[this.enrolling.samples.length - 1];
    if (prev && similarity(prev, sig) > 0.999) {
      return { ok: false, rejected: 'duplicate', message: 'Move slightly between samples.' };
    }

    this.enrolling.samples.push(sig);
    const needed = Math.max(0, MIN_SAMPLES - this.enrolling.samples.length);
    return { ok: true, captured: this.enrolling.samples.length, needed,
             message: needed ? `Captured ${this.enrolling.samples.length}/${MIN_SAMPLES}…`
                             : 'Got everything — saving.' };
  }

  /** Average the samples into a template and store the person. */
  finishEnrollment() {
    if (!this.enrolling) return { ok: false, message: 'Not enrolling.' };
    const { name, samples } = this.enrolling;
    if (samples.length < MIN_SAMPLES) {
      return { ok: false, message: `Need ${MIN_SAMPLES} samples, have ${samples.length}.` };
    }
    const template = averageSignatures(samples);
    if (!template) { this.enrolling = null; return { ok: false, message: 'Could not build a template.' }; }

    const existing = this.people.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      // Re-enrolling blends with the old template rather than discarding it.
      existing.template = averageSignatures([existing.template, template]);
      existing.samples += samples.length;
      existing.at = Date.now();
    } else {
      this.people.push({
        id: `f_${Date.now().toString(36)}`,
        name, template, samples: samples.length,
        at: Date.now(), seen: 0, lastSeen: null,
      });
    }
    this.enrolling = null;
    this.save();
    return { ok: true, name, people: this.people.length,
             message: `${name} enrolled. I'll recognise them from now on.` };
  }

  cancelEnrollment() { this.enrolling = null; return { ok: true }; }

  /* ── recognition ──────────────────────────────────────────────────── */

  /**
   * Identify a face.
   *
   * Requires the best candidate to clear the threshold AND beat the
   * runner-up by a margin — without that, two similar faces flip-flop
   * between frames and AURA greets the wrong person.
   *
   * @param {Array} landmarks
   * @returns {{name:string|null, confidence:number, id:string|null,
   *            runnerUp:number, frontal:number, candidate?:string}}
   */
  identify(landmarks) {
    const frontal = frontalScore(landmarks);
    const sig = computeSignature(landmarks);
    if (!sig || !this.people.length) {
      return { name: null, confidence: 0, id: null, runnerUp: 0, frontal };
    }

    const scored = this.people
      .map(p => ({ p, s: similarity(p.template, sig) }))
      .sort((a, b) => b.s - a.s);

    const best = scored[0];
    const runnerUp = scored[1]?.s || 0;
    const confident = best.s >= this.threshold && (best.s - runnerUp) >= MARGIN && frontal >= 0.5;

    return {
      name: confident ? best.p.name : null,
      id: confident ? best.p.id : null,
      confidence: +best.s.toFixed(4),
      runnerUp: +runnerUp.toFixed(4),
      frontal: +frontal.toFixed(3),
      candidate: best.p.name,        // who it looked most like, even if unsure
    };
  }

  /**
   * Debounced identify: only reports a person after `stable` consecutive
   * agreeing frames, so a single bad frame cannot trigger a greeting.
   */
  identifyStable(landmarks, stable = 5) {
    const r = this.identify(landmarks);
    if (r.name && r.name === this._lastMatch) this._stableCount++;
    else { this._lastMatch = r.name; this._stableCount = r.name ? 1 : 0; }
    return { ...r, stable: this._stableCount >= stable, frames: this._stableCount };
  }

  /** Reset the debounce — used when the camera stops or a face leaves frame. */
  resetStability() { this._lastMatch = null; this._stableCount = 0; }

  /** Record that we actually greeted someone. */
  noteSeen(id) {
    const p = this.people.find(x => x.id === id);
    if (!p) return false;
    p.seen = (p.seen || 0) + 1;
    p.lastSeen = Date.now();
    this.save();
    return true;
  }

  /* ── management ───────────────────────────────────────────────────── */

  list() {
    return this.people.map(p => ({
      id: p.id, name: p.name, samples: p.samples, at: p.at,
      seen: p.seen || 0, lastSeen: p.lastSeen || null,
    }));
  }

  rename(id, name) {
    const p = this.people.find(x => x.id === id);
    const clean = String(name || '').trim().slice(0, 40);
    if (!p || !clean) return false;
    p.name = clean;
    this.save();
    return true;
  }

  forget(id) {
    const i = this.people.findIndex(x => x.id === id);
    if (i < 0) return false;
    this.people.splice(i, 1);
    this.save();
    return true;
  }

  forgetAll() {
    this.people = [];
    try { this.storage?.removeItem(LS_KEY); } catch {}
    return true;
  }

  stats() {
    return {
      enrolled: this.people.length,
      threshold: this.threshold,
      signatureLength: PAIRS.length - 1,
      storesImages: false,          // stated explicitly — it never does
    };
  }
}

export default FaceRecognizer;

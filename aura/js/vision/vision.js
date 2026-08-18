/**
 * AURA :: Vision Module
 * ---------------------
 * Wraps MediaPipe Tasks-Vision:
 *   • HandLandmarker   — 21 3D landmarks per hand, up to 2 hands
 *   • FaceLandmarker   — 478 landmarks + 52 blendshapes (real expression read)
 *   • ObjectDetector   — EfficientDet-Lite0, 80 COCO classes
 *
 * Runs a single rAF loop, throttled to a target FPS, drawing the skeleton
 * overlay on a canvas sized to the video. Publishes results on the bus.
 *
 * Models and WASM are vendored in /vendor so this works offline; a CDN
 * fallback kicks in automatically if a local file is missing.
 */

import { bus, EV } from '../core/bus.js';
import { state } from '../core/state.js';
import { config } from '../core/config.js';
import { classifyGesture, WaveDetector, SwipeDetector, GestureStabilizer, LM, pointingAngle } from './gesture-classifier.js';

const LOCAL_WASM = './vendor/wasm';
const CDN_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODELS = {
  hand: { local: './vendor/models/hand_landmarker.task', cdn: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task' },
  face: { local: './vendor/models/face_landmarker.task', cdn: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task' },
  object: { local: './vendor/models/efficientdet_lite0.tflite', cdn: 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/1/efficientdet_lite0.tflite' },
};

/** Hand skeleton bone list (MediaPipe standard connections). */
export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

async function urlExists(url) {
  try {
    const r = await fetch(url, { method: 'HEAD' });
    return r.ok;
  } catch { return false; }
}

/**
 * Face identity. Lazily constructed so the recogniser costs nothing until a
 * face is actually seen, and so vision.js has no hard dependency on it.
 */
let _recognizer = null;
async function getRecognizer() {
  if (_recognizer) return _recognizer;
  const { FaceRecognizer } = await import('./face-recognition.js');
  _recognizer = new FaceRecognizer();
  return _recognizer;
}

export class VisionModule {
  constructor() {
    this.video = null;
    this.canvas = null;
    this.ctx = null;
    this.stream = null;
    this.running = false;
    this.rafId = null;
    this.tasks = null;                // the imported tasks-vision namespace
    this.handLandmarker = null;
    this.faceLandmarker = null;
    this.objectDetector = null;
    this.loading = { hand: false, face: false, object: false };

    this.waveDetectors = [new WaveDetector(), new WaveDetector()];
    this.swipeDetectors = [new SwipeDetector(), new SwipeDetector()];
    this.stabilizer = new GestureStabilizer({ cooldownMs: config.get('gestureCooldownMs') });

    this.lastFrameT = 0;
    this.frameTimes = [];
    this.lastVideoTime = -1;
    this.latest = { hands: [], faces: [], objects: [], gesture: 'none', confidence: 0 };
    this._objectThrottle = 0;
    this._lastObjects = [];
    this._sceneTimer = null;
    /** Enrolment scan overlay state, or null. */
    this._enrollViz = null;
    /** Dwell-to-click ring state, pushed in by InteractionManager, or null. */
    this._dwell = null;
  }

  /* ── camera ──────────────────────────────────────────────────────── */

  get secureContext() {
    return typeof window === 'undefined' ? false
      : window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  }

  get cameraSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  /**
   * Explain *precisely* why the camera can't start, before we even ask.
   * Silent failure was the single biggest usability complaint.
   */
  async diagnose() {
    const d = { ok: true, issues: [], devices: [], permission: 'unknown' };

    if (!window.isSecureContext && !['localhost', '127.0.0.1'].includes(location.hostname)) {
      d.ok = false;
      d.issues.push({
        code: 'insecure',
        msg: `Page is on "${location.protocol}//${location.hostname}" which is not a secure context. ` +
             `Browsers only grant camera/mic on https:// or localhost. Run: python3 serve.py`,
      });
    }
    if (window.self !== window.top) {
      d.iframe = true;
      d.issues.push({
        code: 'iframe',
        msg: 'AURA is running inside an iframe. The parent page must include ' +
             'allow="camera; microphone" on the iframe, otherwise access is blocked. ' +
             'Open AURA in its own tab to be sure.',
      });
    }
    if (!this.cameraSupported) {
      d.ok = false;
      d.issues.push({ code: 'noapi', msg: 'navigator.mediaDevices.getUserMedia is unavailable in this browser.' });
      return d;
    }

    try {
      if (navigator.permissions?.query) {
        const st = await navigator.permissions.query(/** @type {any} */ ({ name: 'camera' }));
        d.permission = st.state;
        if (st.state === 'denied') {
          d.ok = false;
          d.issues.push({
            code: 'denied',
            msg: 'Camera permission is DENIED for this site. Click the camera/lock icon in the address bar, ' +
                 'set Camera to Allow, then reload.',
          });
        }
      }
    } catch { /* Firefox lacks the camera permission name */ }

    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      d.devices = devs.filter(x => x.kind === 'videoinput').map(x => ({ id: x.deviceId, label: x.label }));
      if (!d.devices.length) {
        d.ok = false;
        d.issues.push({ code: 'nodevice', msg: 'No video input device found on this machine.' });
      }
    } catch (e) {
      d.issues.push({ code: 'enum', msg: `Could not enumerate devices: ${e.message}` });
    }
    return d;
  }

  attach(videoEl, canvasEl) {
    this.video = videoEl;
    this.canvas = canvasEl;
    this.ctx = canvasEl ? canvasEl.getContext('2d') : null;
  }

  async startCamera() {
    if (!this.cameraSupported) {
      const msg = 'This browser exposes no camera API (navigator.mediaDevices is undefined).';
      bus.emit(EV.CAM_ERROR, { fatal: true, message: msg });
      throw new Error(msg);
    }
    if (!this.secureContext) {
      const msg = 'Camera requires a secure context. Open AURA over https:// or http://localhost — opening the HTML file directly (file://) will not work.';
      bus.emit(EV.CAM_ERROR, { fatal: true, message: msg });
      throw new Error(msg);
    }
    if (this.stream) return this.stream;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: config.get('cameraFacing'), width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (err) {
      const map = {
        NotAllowedError: window.self !== window.top
          ? 'Camera blocked. AURA is in an iframe without allow="camera" — open it in its own tab (http://localhost:8000).'
          : 'Camera permission denied. Click the camera icon in the address bar → Allow → reload the page.',
        NotFoundError: 'No camera device found on this machine.',
        NotReadableError: 'The camera is in use by another app (Zoom, Teams, OBS…). Close it and retry.',
        OverconstrainedError: 'No camera matches the requested settings — try switching Front/Rear in Settings → Vision.',
        SecurityError: 'Blocked by browser security policy. Serve AURA over https:// or http://localhost.',
        AbortError: 'The camera was released by the OS before it could start. Retry.',
      };
      const message = map[err.name] || `Camera failed: ${err.message}`;
      state.set({ cameraPermission: err.name === 'NotAllowedError' ? 'denied' : 'error' });
      bus.emit(EV.CAM_ERROR, { fatal: true, message, error: err });
      throw new Error(message);
    }

    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    await new Promise((resolve) => {
      if (this.video.readyState >= 2 && this.video.videoWidth) return resolve();
      this.video.onloadeddata = () => resolve();
      setTimeout(resolve, 3000);
    });

    if (this.video?.videoWidth && this.video?.videoHeight) {
      const wrap = this.video.closest('.cam-wrap');
      if (wrap) wrap.style.setProperty('--cam-aspect', `${this.video.videoWidth}/${this.video.videoHeight}`);
    }

    state.set({ cameraActive: true, cameraPermission: 'granted' });
    bus.emit(EV.CAM_START, { width: this.video.videoWidth, height: this.video.videoHeight });
    return this.stream;
  }

  stopCamera() {
    this.stopLoop();
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    if (this.video) this.video.srcObject = null;
    if (this.ctx && this.canvas) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.latest = { hands: [], faces: [], objects: [], gesture: 'none', confidence: 0 };
    state.set({ cameraActive: false, handCount: 0, faceCount: 0, objectCount: 0, currentGesture: 'none', gestureConfidence: 0 });
    bus.emit(EV.CAM_STOP, {});
    this.publishScene();
  }

  /* ── model loading ───────────────────────────────────────────────── */

  async _loadTasks() {
    if (this.tasks) return this.tasks;
    try {
      this.tasks = await import('../../vendor/vision_bundle.mjs');
    } catch (e) {
      console.warn('[vision] local tasks-vision failed, trying CDN', e);
      this.tasks = await import(/* @vite-ignore */ 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs');
    }
    return this.tasks;
  }

  async _fileset() {
    if (this._filesetPromise) return this._filesetPromise;
    this._filesetPromise = (async () => {
      const t = await this._loadTasks();
      const localOk = await urlExists(`${LOCAL_WASM}/vision_wasm_internal.wasm`);
      const root = localOk ? LOCAL_WASM : CDN_WASM;
      bus.emit(EV.LOG, { text: `MediaPipe runtime: ${localOk ? 'local vendor' : 'CDN'}` });
      return t.FilesetResolver.forVisionTasks(root);
    })();
    return this._filesetPromise;
  }

  async _modelUrl(kind) {
    const m = MODELS[kind];
    return (await urlExists(m.local)) ? m.local : m.cdn;
  }

  /**
   * Create a MediaPipe task, trying the GPU delegate first and transparently
   * falling back to CPU. Machines without a real GPU (headless, software GL,
   * some VMs) either throw or run at ~1 FPS on the GPU path — the CPU delegate
   * is dramatically faster there. Detected during browser testing.
   */
  async _createTask(TaskClass, fileset, modelPath, options, label) {
    const delegates = this.forceCpu ? ['CPU'] : ['GPU', 'CPU'];
    let lastErr = null;
    for (const delegate of delegates) {
      try {
        const t0 = performance.now();
        const task = await TaskClass.createFromOptions(fileset, {
          ...options,
          baseOptions: { modelAssetPath: modelPath, delegate },
        });
        bus.emit(EV.LOG, { text: `${label}: ${delegate} delegate ready in ${Math.round(performance.now() - t0)}ms` });
        this.activeDelegate = delegate;
        return task;
      } catch (e) {
        lastErr = e;
        console.warn(`[vision] ${label} ${delegate} delegate failed`, e);
      }
    }
    throw lastErr || new Error(`${label}: no delegate available`);
  }

  /**
   * Benchmark real inference cost and, if the GPU path is pathologically slow
   * (software rasteriser / SwiftShader / blocklisted GPU), rebuild every task
   * on the CPU delegate.
   *
   * Measured in this environment: GPU(SwiftShader) 760ms vs CPU 94ms per frame.
   * On real hardware the GPU path wins, so GPU is still tried first.
   *
   * `tuning` gates the main loop so we never run two inferences concurrently.
   */
  async _autoTuneDelegate() {
    if (this._tuned || !this.handLandmarker || !this.video?.videoWidth) return;
    this._tuned = true;
    this.tuning = true;
    try {
      // median of 3 to avoid a cold-start outlier
      const samples = [];
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        try { this.handLandmarker.detectForVideo(this.video, t0); } catch { break; }
        samples.push(performance.now() - t0);
        await new Promise(r => setTimeout(r, 30));
      }
      if (!samples.length) return;
      samples.sort((a, b) => a - b);
      const ms = samples[Math.floor(samples.length / 2)];
      this.inferenceMs = Math.round(ms);
      bus.emit(EV.LOG, { text: `Hand inference: ${ms.toFixed(0)}ms median on ${this.activeDelegate}` });

      if (ms > 180 && this.activeDelegate === 'GPU' && !this.forceCpu) {
        bus.emit(EV.LOG, { text: 'GPU path too slow — switching detectors to CPU delegate' });
        this.forceCpu = true;
        const hadFace = !!this.faceLandmarker;
        const hadObj = !!this.objectDetector;
        try { this.handLandmarker?.close(); } catch {}
        this.handLandmarker = null;
        if (hadFace) { try { this.faceLandmarker.close(); } catch {} this.faceLandmarker = null; }
        if (hadObj) { try { this.objectDetector.close(); } catch {} this.objectDetector = null; }
        this.lastVideoTime = -1;
        await this.loadHands();
        if (hadFace) await this.loadFaces();
        if (hadObj) await this.loadObjects();

        // re-measure so the readout reflects reality
        try {
          const t0 = performance.now();
          this.handLandmarker.detectForVideo(this.video, t0);
          this.inferenceMs = Math.round(performance.now() - t0);
          bus.emit(EV.LOG, { text: `CPU delegate inference: ${this.inferenceMs}ms` });
        } catch {}
      }
    } catch (e) {
      console.warn('[vision] auto-tune failed', e);
    } finally {
      this.tuning = false;
      this.lastVideoTime = -1;
      bus.emit('vision:tuned', { delegate: this.activeDelegate, inferenceMs: this.inferenceMs });
    }
  }

  async loadHands() {
    if (this.handLandmarker || this.loading.hand) return this.handLandmarker;
    this.loading.hand = true;
    bus.emit(EV.BOOT_STEP, { step: 'Loading hand landmarker…' });
    try {
      const t = await this._loadTasks();
      const fileset = await this._fileset();
      this.handLandmarker = await this._createTask(t.HandLandmarker, fileset, await this._modelUrl('hand'), {
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      }, 'HandLandmarker');
      state.set({ handsActive: true });
      bus.emit(EV.LOG, { text: 'Hand landmarker ready' });
    } catch (e) {
      console.error('[vision] hand model failed', e);
      bus.emit(EV.CAM_ERROR, { fatal: false, message: `Hand tracking failed to load: ${e.message}` });
    } finally { this.loading.hand = false; }
    return this.handLandmarker;
  }

  async loadFaces() {
    if (this.faceLandmarker || this.loading.face) return this.faceLandmarker;
    this.loading.face = true;
    bus.emit(EV.BOOT_STEP, { step: 'Loading face landmarker…' });
    try {
      const t = await this._loadTasks();
      const fileset = await this._fileset();
      this.faceLandmarker = await this._createTask(t.FaceLandmarker, fileset, await this._modelUrl('face'), {
        runningMode: 'VIDEO',
        numFaces: 2,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: false,
      }, 'FaceLandmarker');
      state.set({ faceActive: true });
      bus.emit(EV.LOG, { text: 'Face landmarker ready' });
    } catch (e) {
      console.error('[vision] face model failed', e);
      bus.emit(EV.CAM_ERROR, { fatal: false, message: `Face tracking failed to load: ${e.message}` });
    } finally { this.loading.face = false; }
    return this.faceLandmarker;
  }

  async loadObjects() {
    if (this.objectDetector || this.loading.object) return this.objectDetector;
    this.loading.object = true;
    bus.emit(EV.BOOT_STEP, { step: 'Loading object detector…' });
    try {
      const t = await this._loadTasks();
      const fileset = await this._fileset();
      /*
       * DIAGNOSED (v0.18): object detection looked broken — it reported
       * nothing almost all the time. The model, the .tflite file and the
       * plumbing were all fine. The cause was `scoreThreshold: 0.42`.
       *
       * Measured on a live frame with the threshold dropped to 0.01, the
       * BEST detection scored 0.453 and everything else fell between 0.019
       * and 0.043. EfficientDet-Lite0 is a small model on a 640px webcam
       * frame; its confidences are genuinely low. At 0.42 a correct
       * detection sat a hair above the cut-off and flickered in and out,
       * which reads as "unreliable" rather than "threshold too high".
       *
       * 0.28 keeps real objects visible while still rejecting the 0.02-0.05
       * noise floor. The UI shows each score so a weak detection is visibly
       * weak rather than silently dropped.
       */
      this.objectDetector = await this._createTask(t.ObjectDetector, fileset, await this._modelUrl('object'), {
        runningMode: 'VIDEO',
        scoreThreshold: config.get('objectScoreThreshold') ?? 0.28,
        maxResults: 12,
      }, 'ObjectDetector');
      state.set({ objectsActive: true });
      bus.emit(EV.LOG, { text: 'Object detector ready' });
    } catch (e) {
      console.error('[vision] object model failed', e);
      bus.emit(EV.CAM_ERROR, { fatal: false, message: `Object detection failed to load: ${e.message}` });
    } finally { this.loading.object = false; }
    return this.objectDetector;
  }

  async unloadObjects() {
    if (this.objectDetector) { try { this.objectDetector.close(); } catch {} this.objectDetector = null; }
    this._lastObjects = [];
    state.set({ objectsActive: false, objectCount: 0 });
  }

  /* ── main loop ───────────────────────────────────────────────────── */

  startLoop() {
    if (this.running) return;
    this.running = true;
    this.lastVideoTime = -1;
    this._tuned = false;
    setTimeout(() => this._autoTuneDelegate(), 900);
    const loop = () => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(loop);
      this._tick();
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stopLoop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  _tick() {
    const v = this.video;
    if (!v || v.readyState < 2 || !v.videoWidth) return;
    if (this.tuning) return;              // don't overlap with the benchmark

    const now = performance.now();
    // Never request frames faster than the hardware can actually infer them —
    // otherwise the rAF queue backs up and the UI stutters.
    const targetDelta = 1000 / Math.max(8, config.get('visionTargetFps'));
    const capabilityDelta = this.inferenceMs ? this.inferenceMs * 1.15 : 0;
    const minDelta = Math.max(targetDelta, capabilityDelta);
    if (now - this.lastFrameT < minDelta) return;
    this.lastFrameT = now;

    // fps meter
    this.frameTimes.push(now);
    while (this.frameTimes.length && now - this.frameTimes[0] > 1000) this.frameTimes.shift();
    state.set({ visionFps: this.frameTimes.length });

    // resize canvas to match video
    if (this.canvas && (this.canvas.width !== v.videoWidth || this.canvas.height !== v.videoHeight)) {
      this.canvas.width = v.videoWidth;
      this.canvas.height = v.videoHeight;
    }

    if (v.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = v.currentTime;
    const ts = now;

    let hands = [], faces = [], blendshapes = [];

    if (this.handLandmarker) {
      try {
        const r = this.handLandmarker.detectForVideo(v, ts);
        hands = (r.landmarks || []).map((lm, i) => ({
          landmarks: lm,
          handedness: r.handedness?.[i]?.[0]?.categoryName || 'Unknown',
          score: r.handedness?.[i]?.[0]?.score || 0,
        }));
      } catch (e) { /* transient GPU hiccup */ }
    }

    if (this.faceLandmarker) {
      try {
        const r = this.faceLandmarker.detectForVideo(v, ts);
        faces = r.faceLandmarks || [];
        blendshapes = r.faceBlendshapes || [];
      } catch (e) {}
    }

    if (this.objectDetector) {
      // object detection is expensive — run at ~4 Hz
      if (now - this._objectThrottle > 250) {
        this._objectThrottle = now;
        try {
          const r = this.objectDetector.detectForVideo(v, ts);
          this._lastObjects = (r.detections || []).map(d => ({
            label: d.categories?.[0]?.categoryName || 'object',
            score: d.categories?.[0]?.score || 0,
            box: d.boundingBox,
          }));
          this._objectError = null;
        } catch (e) {
          // DIAGNOSIS PROBE: this catch used to be empty, which is why a
          // broken object detector looked like "no objects in view".
          this._objectError = String(e?.message || e);
          console.warn('[vision] objectDetector.detectForVideo failed:', this._objectError);
        }
      }
    }
    const objects = this._lastObjects;

    // ── person presence signal (consumed by PrivacyGuard)
    //    Derived from detectors that already ran on THIS frame. No extra
    //    model, no extra capture, no network.
    this._emitPresence(faces, objects, v, now);

    // ── gesture analysis
    const gestureResult = this._analyzeGestures(hands, now);

    this.latest = { hands, faces, objects, blendshapes, ...gestureResult };
    state.set({ handCount: hands.length, faceCount: faces.length, objectCount: objects.length });

    bus.emit(EV.HANDS, { hands, gesture: gestureResult.gesture, confidence: gestureResult.confidence });
    if (faces.length) {
      bus.emit(EV.FACES, { faces, blendshapes });
      // Identity runs at ~4 Hz: the signature is cheap but the debounce
      // needs consecutive agreeing frames, and 24 Hz would burn CPU for no
      // extra accuracy.
      /*
       * ENROLMENT MUST RUN EVEN WHEN RECOGNITION IS OFF.
       *
       * Bug: this was gated purely on `config.faceRecognition`, which is off
       * by default. Starting an enrolment while it was off meant addSample()
       * was never called — the progress bar sat at 0 and the user was told
       * nothing was happening, because nothing was. Enrolling is itself the
       * act of opting in, so it always runs.
       */
      const enrolling = !!this._enrolling;
      if ((enrolling || config.get('faceRecognition'))
          && now - (this._idThrottle || 0) > 260) {
        this._idThrottle = now;
        this._identifyFace(faces[0]).catch(() => {});
        if (config.get('faceRecognition')) this._identifyAll(faces).catch(() => {});
      }
    }
    if (objects.length) bus.emit(EV.OBJECTS, { objects });

    this._draw(hands, faces, objects);
    this._scheduleScenePublish();
  }

  _analyzeGestures(hands, now) {
    if (!hands.length) {
      this.waveDetectors.forEach(d => d.reset());
      this.swipeDetectors.forEach(d => d.reset());
      const st = this.stabilizer.update('none', 0, now);
      if (st.released) bus.emit(EV.GESTURE_END, { gesture: st.released });
      state.set({ currentGesture: 'none', gestureConfidence: 0 });
      return { gesture: 'none', confidence: 0, perHand: [] };
    }

    const perHand = hands.map((h, i) => {
      const cls = classifyGesture(h.landmarks);
      const openish = cls.gesture === 'open_palm' || cls.count >= 3;
      const wave = this.waveDetectors[i % 2].push(h.landmarks[LM.WRIST].x, now, openish);
      // Swipes are made with an open hand, same as waves - the detectors
      // separate them by straightness, not by pose.
      const swipe = this.swipeDetectors[i % 2].push(
        h.landmarks[LM.WRIST].x, h.landmarks[LM.WRIST].y, now, openish);
      return { ...cls, wave, swipe, handedness: h.handedness, index: i };
    });

    // A swipe outranks a wave, which outranks a static pose. A swipe is the
    // most deliberate of the three (fast + straight + long), so if the
    // detector is confident enough to report one, that is what was meant.
    const swiping = perHand.find(p => p.swipe?.swipe);
    const waving = perHand.find(p => p.wave.isWave);
    let gesture, confidence;
    if (swiping) {
      gesture = swiping.swipe.swipe;
      confidence = swiping.swipe.confidence;
      // A swipe consumes the wave history on that hand, so the tail of the
      // movement cannot immediately register as a wave too.
      this.waveDetectors.forEach(d => d.reset());
    } else if (waving) {
      gesture = 'wave';
      confidence = waving.wave.confidence;
    } else {
      const best = perHand.reduce((a, b) => (b.confidence > a.confidence ? b : a));
      gesture = best.gesture;
      confidence = best.confidence;
    }

    state.set({ currentGesture: gesture, gestureConfidence: confidence });

    const st = this.stabilizer.update(gesture, confidence, now);
    if (st.released) bus.emit(EV.GESTURE_END, { gesture: st.released });
    if (st.fire) {
      const hand = swiping || waving || perHand.find(p => p.gesture === gesture) || perHand[0];
      bus.emit(EV.GESTURE, {
        gesture, confidence, handedness: hand?.handedness,
        fingers: hand?.fingers, count: hand?.count,
      });
      if (gesture === 'wave') this.waveDetectors.forEach(d => d.reset());
    }

    // continuous pointer stream (no debounce — used for UI highlighting)
    const pointer = perHand.find(p => p.gesture === 'pointing');
    if (pointer) {
      const h = hands[pointer.index];
      bus.emit(EV.POINTER, {
        x: h.landmarks[LM.INDEX_TIP].x,
        y: h.landmarks[LM.INDEX_TIP].y,
        angle: pointingAngle(h.landmarks),
        confidence: pointer.confidence,
      });
    }

    return { gesture, confidence, perHand };
  }

  /**
   * Publish a lightweight presence signal from detections that already
   * happened this frame.
   *
   * WHY FACES FIRST: the face landmarker is always on when vision is
   * enabled, is far cheaper than the object detector, and a face is a much
   * stronger "someone is behind me" signal than a COCO `person` box. Object
   * `person` detections are used only as a fallback when object detection
   * happens to be enabled.
   *
   * `area` is the fraction of the frame the largest person occupies, which
   * is the only proximity proxy a single camera can honestly provide — it is
   * NOT a distance measurement and is not presented as one.
   */
  _emitPresence(faces, objects, video, now) {
    let count = 0, confidence = 0, box = null, source = null;

    if (faces?.length) {
      count = faces.length;
      source = 'face';
      // Landmarks are normalised 0..1, so the extent IS the frame fraction.
      for (const lm of faces) {
        let minX = 1, minY = 1, maxX = 0, maxY = 0;
        for (const p of lm) {
          if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
        }
        const b = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
        if (!box || b.width * b.height > box.width * box.height) box = b;
      }
      // The landmarker only returns a face it is confident about; treat the
      // detection itself as high confidence rather than inventing a number.
      confidence = 0.9;
    } else if (objects?.length) {
      const people = objects.filter(o => o.label === 'person');
      if (people.length) {
        const w = video?.videoWidth || 1, h = video?.videoHeight || 1;
        count = people.length;
        source = 'object';
        const best = people.reduce((a, b) => (b.score > a.score ? b : a));
        confidence = best.score;
        if (best.box) {
          box = { x: best.box.originX / w, y: best.box.originY / h,
                  width: best.box.width / w, height: best.box.height / h };
        }
      }
    }

    const present = count > 0;
    const area = box ? Math.max(0, Math.min(1, box.width * box.height)) : 0;
    /*
     * IDENTITY, not just presence.
     *
     * Privacy Guard v1 minimised when ONE face filled enough of the frame —
     * which is the user sitting at their own laptop. It fired on the owner,
     * every time. The fix needs two extra facts, and both come from work the
     * pipeline already does:
     *   • how many faces are in frame (faces.length — free)
     *   • whether one of them is an enrolled owner (face-recognition, which
     *     already runs on faces[0] every ~500ms for greetings)
     * `_knownFaces` is maintained by _identifyFace(); reading it here costs
     * nothing.
     */
    const known = this._knownFaces || { names: [], at: 0 };
    const ownerFresh = known.at && (now - known.at) < 2500;
    // Only emit on change or on a slow heartbeat — a per-frame event would
    // be pure noise on the bus and in the Developer Console.
    const changed = present !== this._presencePresent || count !== this._presenceCount;
    if (changed || now - (this._presenceAt || 0) > 400) {
      this._presencePresent = present;
      this._presenceCount = count;
      this._presenceAt = now;
      bus.emit(EV.PRESENCE, {
        type: present ? 'person_detected' : 'person_absent',
        present, count, confidence, source, area,
        boundingBox: box, timestamp: now,
        faceCount: faces?.length || 0,
        knownNames: ownerFresh ? known.names.slice() : [],
        ownerPresent: ownerFresh && known.names.length > 0,
      });
    }
  }

  /* ── overlay drawing ─────────────────────────────────────────────── */

  /**
   * Recognise EVERY face in frame and cache the result for Privacy Guard.
   *
   * `_identifyFace` only ever looked at faces[0] because it exists to greet
   * one arriving person. Privacy Guard needs the opposite question: is there
   * anyone here who ISN'T enrolled? So this runs over all faces, throttled,
   * and caches names plus an unknown count.
   *
   * Throttled to ~3 Hz: signature comparison is cheap, but there is no point
   * doing it per frame when a person cannot appear that fast.
   */
  async _identifyAll(faces) {
    const now = performance.now();
    if (now - (this._idAllAt || 0) < 320) return;
    this._idAllAt = now;
    const fr = await getRecognizer();
    if (fr.enrolling) return;
    const names = [];
    let unknown = 0;
    for (const lm of faces.slice(0, 4)) {
      if (!fr.people.length) { unknown++; continue; }
      const r = fr.identify(lm);
      if (r.name) names.push(r.name);
      else unknown++;
    }
    this._knownFaces = { names, unknown, total: faces.length, at: now };
    state.set({ knownFaceCount: names.length, unknownFaceCount: unknown });
  }

  /**
   * Recognise who is on camera and announce arrivals.
   * Only emits when the match is STABLE across several frames — a single
   * bad frame must never make AURA greet the wrong person.
   */
  async _identifyFace(landmarks) {
    const fr = await getRecognizer();
    this._enrolling = !!fr.enrolling;
    if (fr.enrolling) {
      const r = fr.addSample(landmarks);
      // Drive the on-canvas scan overlay. `captured` only advances on an
      // accepted sample, so the ring genuinely reflects progress rather than
      // animating regardless.
      const total = (r.captured || 0) + (r.needed ?? 0) || 3;
      this._enrollViz = {
        pct: (r.captured || 0) / total,
        label: r.ok ? `SCANNING ${r.captured}/${total}` : 'HOLD STILL',
      };
      bus.emit('vision:enroll-progress', r);
      if (r.ok && r.needed === 0) bus.emit('vision:enroll-ready', {});
      return;
    }
    this._enrollViz = null;
    if (!fr.people.length) return;

    const r = fr.identifyStable(landmarks, 4);
    this.lastIdentity = r;
    state.set({ faceIdentity: r.name || null, faceConfidence: r.confidence });

    if (r.stable && r.name && r.name !== this._greeted) {
      this._greeted = r.name;
      clearTimeout(this._greetReset);
      // Don't re-greet the same person for 5 minutes.
      this._greetReset = setTimeout(() => { this._greeted = null; }, 300000);
      fr.noteSeen(r.id);
      bus.emit('vision:face-recognized', { name: r.name, id: r.id, confidence: r.confidence });
    }
  }

  /** @returns {Promise<import('./face-recognition.js').FaceRecognizer>} */
  async recognizer() { return getRecognizer(); }

  /**
   * Begin enrolment and open the identify path immediately.
   * Callers used to reach the recognizer directly, which left `_enrolling`
   * false until an identify happened — and identify never happened because
   * recognition was off. This makes starting enrolment self-sufficient.
   */
  async startEnrollment(name) {
    const fr = await getRecognizer();
    const r = fr.startEnrollment(name);
    this._enrolling = !!fr.enrolling;
    this._enrollViz = { pct: 0, label: 'HOLD STILL' };
    return r;
  }

  async cancelEnrollment() {
    const fr = await getRecognizer();
    const r = fr.cancelEnrollment();
    this._enrolling = false;
    this._enrollViz = null;
    return r;
  }

  _draw(hands, faces, objects) {
    const ctx = this.ctx;
    if (!ctx || !this.canvas) return;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);

    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#22d3ee';
    const accent2 = getComputedStyle(document.documentElement).getPropertyValue('--accent-2').trim() || '#a855f7';

    // ── faces: subtle mesh dots + bounding frame
    if (faces.length) {
      ctx.save();
      ctx.fillStyle = 'rgba(168,85,247,0.55)';
      for (const f of faces) {
        for (let i = 0; i < f.length; i += 6) {
          const p = f[i];
          ctx.fillRect(p.x * W, p.y * H, 1.6, 1.6);
        }
        let minX = 1, minY = 1, maxX = 0, maxY = 0;
        for (const p of f) {
          if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
        }
        drawBracket(ctx, minX * W, minY * H, (maxX - minX) * W, (maxY - minY) * H, accent2, 'FACE');

        /*
         * ENROLMENT VISUALS.
         *
         * The user asked how they can tell enrolment is doing anything — it
         * was text-only ("Captured 1/3"), which reads as nothing happening.
         * While enrolling, the face gets a scanning bar sweeping over it, a
         * dense mesh, and a live percentage ring, all drawn from landmarks
         * we already have. No extra detection work.
         */
        if (this._enrollViz) {
          const bx = minX * W, by = minY * H;
          const bw = (maxX - minX) * W, bh = (maxY - minY) * H;
          const pct = Math.max(0, Math.min(1, this._enrollViz.pct));
          const t = (performance.now() % 1400) / 1400;

          // Dense mesh while scanning — visibly different from idle.
          ctx.fillStyle = 'rgba(52,211,153,0.75)';
          for (let i = 0; i < f.length; i += 2) ctx.fillRect(f[i].x * W, f[i].y * H, 1.5, 1.5);

          // Sweeping scan bar, clipped to the face box.
          ctx.save();
          ctx.beginPath(); ctx.rect(bx, by, bw, bh); ctx.clip();
          const sy = by + t * bh;
          const g = ctx.createLinearGradient(0, sy - 22, 0, sy + 22);
          g.addColorStop(0, 'rgba(52,211,153,0)');
          g.addColorStop(0.5, 'rgba(52,211,153,0.5)');
          g.addColorStop(1, 'rgba(52,211,153,0)');
          ctx.fillStyle = g; ctx.fillRect(bx, sy - 22, bw, 44);
          ctx.strokeStyle = 'rgba(52,211,153,0.95)'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(bx, sy); ctx.lineTo(bx + bw, sy); ctx.stroke();
          ctx.restore();

          // Progress ring above the head.
          const cx = bx + bw / 2, cy = by - 26, r = 17;
          ctx.lineWidth = 4;
          ctx.strokeStyle = 'rgba(255,255,255,0.16)';
          ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
          ctx.strokeStyle = '#34d399';
          ctx.beginPath();
          ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + pct * Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = '#eaf0f7';
          ctx.font = 'bold 12px monospace';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(`${Math.round(pct * 100)}%`, cx, cy);
          ctx.font = 'bold 10px monospace';
          ctx.fillStyle = '#34d399';
          ctx.fillText(this._enrollViz.label || 'SCANNING', cx, by + bh + 14);
          ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
        }
      }
      ctx.restore();
    }

    // ── objects
    if (objects.length) {
      ctx.save();
      for (const o of objects) {
        const b = o.box;
        if (!b) continue;
        drawBracket(ctx, b.originX, b.originY, b.width, b.height, '#facc15',
          `${o.label.toUpperCase()} ${(o.score * 100).toFixed(0)}%`);
      }
      ctx.restore();
    }

    // ── hands: glowing skeleton
    for (const h of hands) {
      const L = h.landmarks;
      ctx.save();
      ctx.shadowColor = accent;
      ctx.shadowBlur = 14;
      ctx.strokeStyle = accent;
      ctx.lineWidth = Math.max(2, W / 420);
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const [a, b] of HAND_CONNECTIONS) {
        ctx.moveTo(L[a].x * W, L[a].y * H);
        ctx.lineTo(L[b].x * W, L[b].y * H);
      }
      ctx.stroke();

      ctx.shadowBlur = 10;
      for (let i = 0; i < L.length; i++) {
        const tip = [4, 8, 12, 16, 20].includes(i);
        ctx.fillStyle = tip ? '#ffffff' : accent;
        ctx.beginPath();
        ctx.arc(L[i].x * W, L[i].y * H, tip ? Math.max(4, W / 260) : Math.max(2.5, W / 400), 0, Math.PI * 2);
        ctx.fill();
      }

      // handedness tag
      ctx.shadowBlur = 0;
      ctx.fillStyle = accent;
      ctx.font = `600 ${Math.max(12, W / 64)}px ui-monospace, monospace`;
      ctx.fillText(h.handedness.toUpperCase(), L[0].x * W - 18, L[0].y * H + 26);
      ctx.restore();
    }

    // ── dwell-to-click progress ring (drawn last, always on top)
    this._drawDwell(ctx, W, H);
  }

  /**
   * The dwell progress ring: 0 → 25 → 50 → 75 → 100%.
   *
   * State is pushed in by the InteractionManager via `setDwell()` rather than
   * read from it, so vision.js keeps no dependency on the interaction layer
   * and still draws nothing at all when dwell is off.
   *
   * @param {CanvasRenderingContext2D} ctx
   */
  _drawDwell(ctx, W, H) {
    const d = this._dwell;
    if (!d || !d.point) return;
    if (d.state !== 'ARMING' && d.state !== 'DWELLING' && d.state !== 'COMMITTED') return;

    const x = d.point.x * W, y = d.point.y * H;
    const r = Math.max(20, W / 26);
    const pct = d.progress || 0;

    // Colour carries the meaning of the target, so the user knows what a
    // completed hold will actually do BEFORE it happens.
    const colour = d.target === 'web' ? '#38bdf8'
      : d.target === 'desktop' ? (d.needsPermission ? '#ff5470' : '#facc15')
      : '#64748b';

    ctx.save();
    ctx.lineCap = 'round';

    // track
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();

    // the five quantised stops, as ticks, so progress is readable at a glance
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 2;
    for (const frac of [0.25, 0.5, 0.75]) {
      const a = -Math.PI / 2 + frac * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * (r - 6), y + Math.sin(a) * (r - 6));
      ctx.lineTo(x + Math.cos(a) * (r + 6), y + Math.sin(a) * (r + 6));
      ctx.stroke();
    }

    // progress arc
    if (pct > 0) {
      ctx.strokeStyle = colour;
      ctx.shadowColor = colour;
      ctx.shadowBlur = 12;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + pct * Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // centre dot + percentage
    ctx.fillStyle = colour;
    ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();

    ctx.font = `bold ${Math.max(11, W / 70)}px ui-monospace, monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#eaf0f7';
    ctx.fillText(`${d.ring ?? 0}%`, x, y - r - 12);

    if (d.label) {
      ctx.font = `bold ${Math.max(9, W / 90)}px ui-monospace, monospace`;
      ctx.fillStyle = colour;
      ctx.fillText(d.label, x, y + r + 14);
    }
    ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
    ctx.restore();
  }

  /**
   * Receive dwell state for the overlay. Called by InteractionManager.
   * @param {{state:string, progress:number, ring:number,
   *          point:{x:number,y:number}|null, target:string,
   *          needsPermission?:boolean, label?:string}|null} d
   */
  setDwell(d) { this._dwell = d; }

  /* ── scene description ───────────────────────────────────────────── */

  _scheduleScenePublish() {
    if (this._sceneTimer) return;
    this._sceneTimer = setTimeout(() => {
      this._sceneTimer = null;
      this.publishScene();
    }, 700);
  }

  /** Human-readable description of the current frame — used by the AI. */
  describeScene() {
    if (!state.get('cameraActive')) return { cameraActive: false, description: '' };
    const { hands, faces, objects, gesture, confidence } = this.latest;
    const parts = [];

    if (faces.length) {
      parts.push(`${faces.length} human face${faces.length > 1 ? 's' : ''} in frame`);
      const emo = this.readEmotion();
      if (emo && emo.emotion !== 'neutral') parts.push(`the person appears ${emo.emotion} (${Math.round(emo.score * 100)}% confidence)`);
    }
    if (hands.length) {
      const names = hands.map(h => h.handedness.toLowerCase()).join(' and ');
      parts.push(`${hands.length} hand${hands.length > 1 ? 's' : ''} visible (${names})`);
      if (gesture && gesture !== 'none') parts.push(`current gesture: ${gesture.replace(/_/g, ' ')} at ${Math.round(confidence * 100)}% confidence`);
      const fingers = this.countFingers();
      if (fingers != null) parts.push(`${fingers} finger${fingers === 1 ? '' : 's'} raised`);
    }
    if (objects.length) {
      const counts = {};
      for (const o of objects) counts[o.label] = (counts[o.label] || 0) + 1;
      const list = Object.entries(counts).map(([k, n]) => (n > 1 ? `${n} ${k}s` : `a ${k}`)).join(', ');
      parts.push(`objects detected: ${list}`);
    }
    if (!parts.length) {
      const enabled = [];
      if (state.get('handsActive')) enabled.push('hand');
      if (state.get('faceActive')) enabled.push('face');
      if (state.get('objectsActive')) enabled.push('object');
      return {
        cameraActive: true,
        description: `The camera is live but nothing is detected right now — no ${enabled.join(', ') || 'detector'} matches in the current frame.`,
        hands: 0, faces: 0, objects: 0,
      };
    }
    return {
      cameraActive: true,
      description: `Through the webcam I can see: ${parts.join('; ')}.`,
      hands: hands.length, faces: faces.length, objects: objects.length,
      gesture, fingers: this.countFingers(),
      objectLabels: objects.map(o => o.label),
    };
  }

  countFingers() {
    const h = this.latest.hands?.[0];
    if (!h) return null;
    return classifyGesture(h.landmarks).count;
  }

  /** Read emotion from FaceLandmarker blendshapes — real signal, not a guess. */
  readEmotion() {
    const bs = this.latest.blendshapes?.[0];
    if (!bs || !bs.categories) return null;
    const g = (name) => bs.categories.find(c => c.categoryName === name)?.score || 0;
    const smile = (g('mouthSmileLeft') + g('mouthSmileRight')) / 2;
    const frown = (g('mouthFrownLeft') + g('mouthFrownRight')) / 2;
    const browUp = (g('browInnerUp') + g('browOuterUpLeft') + g('browOuterUpRight')) / 3;
    const browDown = (g('browDownLeft') + g('browDownRight')) / 2;
    const jawOpen = g('jawOpen');
    const squint = (g('eyeSquintLeft') + g('eyeSquintRight')) / 2;

    const scores = {
      happy: smile * 1.5,
      surprised: browUp * 0.9 + jawOpen * 0.9,
      angry: browDown * 1.3,
      sad: frown * 1.2 + browUp * 0.3,
      focused: squint * 0.9 + browDown * 0.4,
    };
    let best = 'neutral', bestScore = 0.16;
    for (const [k, v] of Object.entries(scores)) if (v > bestScore) { best = k; bestScore = v; }
    return { emotion: best, score: Math.min(1, bestScore), blink: (g('eyeBlinkLeft') + g('eyeBlinkRight')) / 2 };
  }

  publishScene() {
    const scene = this.describeScene();
    bus.emit(EV.SCENE_UPDATE, scene);
    return scene;
  }

  /* ── lifecycle helpers ───────────────────────────────────────────── */

  async enable({ hands = true, faces = true, objects = false } = {}) {
    await this.startCamera();
    const jobs = [];
    if (hands) jobs.push(this.loadHands());
    if (faces) jobs.push(this.loadFaces());
    if (objects) jobs.push(this.loadObjects());
    await Promise.all(jobs);
    this.startLoop();
    return true;
  }

  disable() { this.stopCamera(); }

  /** Snapshot the current frame as a data URL (used by /snapshot). */
  snapshot() {
    if (!this.video || !this.video.videoWidth) return null;
    const c = document.createElement('canvas');
    c.width = this.video.videoWidth;
    c.height = this.video.videoHeight;
    const cx = c.getContext('2d');
    cx.drawImage(this.video, 0, 0);
    if (this.canvas) cx.drawImage(this.canvas, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  }
}

/** Sci-fi corner bracket box with a label. */
function drawBracket(ctx, x, y, w, h, color, label) {
  const c = Math.min(w, h) * 0.22;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  ctx.beginPath();
  ctx.moveTo(x, y + c); ctx.lineTo(x, y); ctx.lineTo(x + c, y);
  ctx.moveTo(x + w - c, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + c);
  ctx.moveTo(x + w, y + h - c); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - c, y + h);
  ctx.moveTo(x + c, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - c);
  ctx.stroke();
  if (label) {
    ctx.shadowBlur = 0;
    ctx.font = '600 12px ui-monospace, monospace';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x, y - 16, tw + 8, 15);
    ctx.fillStyle = color;
    ctx.fillText(label, x + 4, y - 4);
  }
  ctx.restore();
}

export default VisionModule;

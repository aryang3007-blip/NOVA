/**
 * AURA :: Ambient declarations for untyped externals
 * --------------------------------------------------
 * Two categories live here:
 *
 *   1. Vendored third-party bundles (three.js, MediaPipe tasks-vision) that
 *      ship as plain .js with no .d.ts. They are excluded from checkJs, but
 *      the import specifier still needs a declaration.
 *
 *   2. Browser APIs that exist at runtime but are missing from TypeScript's
 *      DOM lib — WebXR, prefixed AudioContext, Web Speech, and the
 *      Chrome-only performance.memory. AURA feature-detects all of these
 *      before use, so declaring them is accurate, not a suppression.
 *
 * Nothing here changes behaviour; it only tells the checker what the runtime
 * already provides.
 */

/* ── vendored bundles (loaded via local path or CDN fallback) ─────────── */

declare module '*/three.module.js' {
  const THREE: any;
  export = THREE;
}

declare module '*/vision_bundle.mjs' {
  export const FilesetResolver: any;
  export const HandLandmarker: any;
  export const FaceLandmarker: any;
  export const ObjectDetector: any;
}

declare module 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js' {
  const THREE: any;
  export = THREE;
}

declare module 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs' {
  export const FilesetResolver: any;
  export const HandLandmarker: any;
  export const FaceLandmarker: any;
  export const ObjectDetector: any;
}

/* ── browser APIs absent from the DOM lib ─────────────────────────────── */

interface Navigator {
  /** WebXR Device API — present in Chrome/Edge, feature-detected in js/ar/ar.js */
  xr?: {
    isSessionSupported(mode: string): Promise<boolean>;
    requestSession(mode: string, opts?: any): Promise<any>;
  };
  /** Coarse device memory in GB (Chrome). Used only as a fallback hint. */
  deviceMemory?: number;
  /** Network Information API (Chrome). */
  connection?: { effectiveType?: string; downlink?: number; rtt?: number };
  /** Battery Status API. */
  getBattery?(): Promise<{ level: number; charging: boolean }>;
  /** WebGPU adapter access. */
  gpu?: any;
}

interface Window {
  /** Safari-prefixed AudioContext. */
  webkitAudioContext?: typeof AudioContext;
  /** Web Speech API — Chrome/Edge/Safari only. */
  SpeechRecognition?: any;
  webkitSpeechRecognition?: any;
  /** AURA's own debug handle, attached in js/main.js. */
  AURA?: any;
}

interface Performance {
  /** Chrome-only JS heap stats. NOT system RAM — labelled as such in the UI. */
  memory?: {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
    jsHeapSizeLimit: number;
  };
}

interface HTMLCanvasElement {
  /** Used by the mock camera provider to synthesise a stream. */
  captureStream?(frameRate?: number): MediaStream;
}

interface DeviceOrientationEventStatic {
  /** iOS 13+ permission gate. */
  requestPermission?(): Promise<'granted' | 'denied'>;
}

declare const DeviceOrientationEvent: DeviceOrientationEventStatic & {
  new (type: string, eventInitDict?: DeviceOrientationEventInit): DeviceOrientationEvent;
  prototype: DeviceOrientationEvent;
};

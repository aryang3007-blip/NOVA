#!/usr/bin/env python3
"""
NOVA :: Python Wake-Word Service
================================
Owns the microphone and turns acoustic wake candidates into CONFIRMED wake
events. This is the authoritative wake path when running; the browser wake
scanner is the fallback (see js/voice/wake-word-engine.js).

Pipeline:
    mic (reconnecting) ──> VAD gate ──> openWakeWord candidate
        ──> faster-whisper confirmation ──> phrase match
        ──> POST /api/voice/wake ──> browser (via /api/voice/events)

HONESTY RULES (architectural, enforced in code — not comments):
  1. An openWakeWord model score alone NEVER emits an event for a phrase it
     was not trained on. ``hey nova`` mapped to ``hey_jarvis`` is a CANDIDATE
     accelerator only; emission requires transcript confirmation. A hey_jarvis
     candidate followed by "play some jazz" is REJECTED, loudly logged.
  2. Phrases with no openWakeWord model at all ("nova", "okay nova") are pure
     custom phrases: they are detected by whisper transcript matching, and
     are DISABLED (with a log line) when whisper is unavailable — never
     silently dead, never falsely live.
  3. Only phrases whose text exactly matches their model name ("hey jarvis"
     == hey_jarvis) may emit on a candidate score without a transcript, and
     only when whisper is genuinely unavailable.

States (this service owns mic + detection; the browser owns dialog/TTS):
    OFF -> STARTING -> READY -> WAKE_LISTENING ⇄ WAKE_CANDIDATE
        -> CONFIRMING -> WAKE_LISTENING
    PAUSED (explicit --pause / speaking suppression is logged, not a state)
    MIC_ERROR / MODEL_ERROR / SERVER_UNAVAILABLE (all recoverable except
    MODEL_ERROR at startup, which exits non-zero with the reason)
    STOPPED.

Every component (mic, oww, whisper, vad, http) is constructor-injected, so
the whole pipeline is unit-testable with synthetic audio and fakes — see
tests/test-wake-service.py. Nothing here requires audio hardware to import.
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.request
from collections import deque
from pathlib import Path

import numpy as np

# Audio capture defaults
INPUT_RATE = 44100
MODEL_RATE = 16000
CHANNELS = 1
CHUNK = 4410

DEFAULT_THRESHOLD = 0.55
DEFAULT_CONFIRM_THRESHOLD = 0.60
DEFAULT_COOLDOWN_MS = 1500
DEFAULT_VAD_RMS = 220.0
DEFAULT_VAD_HANGOVER_MS = 350
DEFAULT_HEARTBEAT_SEC = 15
DEFAULT_SPEAKING_POLL_SEC = 2.0
DEFAULT_PREROLL_SEC = 2.5
DEFAULT_SERVER_URL = "http://127.0.0.1:8000/api/voice/wake"

ROOT_DIR = Path(__file__).resolve().parent.parent
CONFIG_FILE = ROOT_DIR / "voice" / "wake_phrases.json"

SERVICE_VERSION = "2.0.0"

DEFAULT_CONFIG = {
    "enabled": True,
    "server_url": DEFAULT_SERVER_URL,
    # "hybrid" (oww candidate + whisper confirm) | "openwakeword" | "whisper"
    "engine": "hybrid",
    "threshold": DEFAULT_THRESHOLD,
    "confirm_threshold": DEFAULT_CONFIRM_THRESHOLD,
    "cooldown_ms": DEFAULT_COOLDOWN_MS,
    "vad_rms": DEFAULT_VAD_RMS,
    "vad_hangover_ms": DEFAULT_VAD_HANGOVER_MS,
    "vad_engine": "energy",  # "energy" | "silero" (silero needs torch)
    "heartbeat_sec": DEFAULT_HEARTBEAT_SEC,
    "speaking_poll_sec": DEFAULT_SPEAKING_POLL_SEC,
    "preroll_sec": DEFAULT_PREROLL_SEC,
    "device_id": None,
    "device_name": None,
    "phrases": [
        # "model" is a CANDIDATE accelerator only (see Honesty Rules above).
        # Emission always requires transcript confirmation for these.
        {"name": "Hey Nova", "phrase": "hey nova", "model": "hey_jarvis", "enabled": True},
        {"name": "Yo Nova", "phrase": "yo nova", "model": "hey_jarvis", "enabled": True},
        {"name": "Nova", "phrase": "nova", "model": None, "enabled": True},
        {"name": "Okay Nova", "phrase": "okay nova", "model": None, "enabled": True},
        {"name": "Hey Jarvis", "phrase": "hey jarvis", "model": "hey_jarvis", "enabled": True},
    ],
}


class VoiceServiceLifecycle:
    """Service states. Detection-side only (mic + wake); dialog/TTS states
    live in the browser. SERVER_UNAVAILABLE / MIC_ERROR are recoverable and
    the loop keeps retrying; MODEL_ERROR at startup is fatal."""

    OFF = "OFF"
    STARTING = "STARTING"
    READY = "READY"
    WAKE_LISTENING = "WAKE_LISTENING"
    WAKE_CANDIDATE = "WAKE_CANDIDATE"
    CONFIRMING = "CONFIRMING"
    PAUSED = "PAUSED"
    MIC_ERROR = "MIC_ERROR"
    MODEL_ERROR = "MODEL_ERROR"
    SERVER_UNAVAILABLE = "SERVER_UNAVAILABLE"
    STOPPED = "STOPPED"


class MicError(RuntimeError):
    """Raised when the audio stream cannot deliver (unplugged device,
    exclusive-mode grab, driver hiccup). The service loop treats this as
    recoverable and re-opens the stream with backoff."""


def log(tag, message):
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] [{tag}] {message}", flush=True)


# ── text helpers ──────────────────────────────────────────────────────────

_NON_ALNUM = re.compile(r"[^a-z0-9 ]")


def normalize_text(s):
    """Lowercase, strip punctuation, collapse whitespace."""
    return re.sub(r"\s+", " ", _NON_ALNUM.sub(" ", str(s or "").lower())).strip()


def model_matches_phrase(model_name, phrase_text):
    """True only when the oww model name IS the phrase ("hey_jarvis" ==
    "hey jarvis"). This is the gate for candidate-only emission."""
    if not model_name or not phrase_text:
        return False
    return str(model_name).lower().replace("_", " ").strip() == normalize_text(phrase_text)


def phrase_confidence(transcript, phrase):
    """How strongly does `transcript` contain `phrase`? 0.0..1.0.

    1.0 exact substring (normalised) · partial credit by token overlap
    (order-sensitive F1 over tokens) so "hey novah" still scores below the
    default confirm threshold instead of false-firing.
    """
    t = normalize_text(transcript)
    p = normalize_text(phrase)
    if not t or not p:
        return 0.0
    if p in t:
        return 1.0
    t_tok, p_tok = t.split(" "), p.split(" ")
    if not p_tok:
        return 0.0
    # Longest ordered run of phrase tokens appearing in the transcript.
    best, run = 0, 0
    ti = 0
    for pt in p_tok:
        found = False
        while ti < len(t_tok):
            if t_tok[ti] == pt:
                found = True
                ti += 1
                break
            ti += 1
        if found:
            run += 1
            best = max(best, run)
        else:
            run = 0
    recall = best / len(p_tok)
    # Single-token phrases need the token to actually appear.
    if len(p_tok) == 1:
        return 1.0 if p_tok[0] in t_tok else 0.0
    return round(recall * 0.9, 4)


def match_phrase(transcript, phrases):
    """Best (phrase_dict, confidence) for `transcript`, or (None, 0.0)."""
    best, best_conf = None, 0.0
    for p in phrases or []:
        c = phrase_confidence(transcript, p.get("phrase", ""))
        if c > best_conf:
            best, best_conf = p, c
    return best, best_conf


def pcm_rms_int16(raw):
    """RMS of int16 PCM bytes. Pure python (no numpy) so VAD probing works
    even in minimal environments."""
    if not raw or len(raw) < 2:
        return 0.0
    n = len(raw) // 2
    acc = 0
    for i in range(n):
        v = int.from_bytes(raw[2 * i:2 * i + 2], "little", signed=True)
        acc += v * v
    return (acc / n) ** 0.5


# ── config ────────────────────────────────────────────────────────────────

def load_config():
    # 1. Try SQLite repository
    try:
        from persistence.repositories import wake_repo
        phrases = wake_repo.get_all_phrases()
        if phrases and len(phrases) > 0:
            cfg = dict(DEFAULT_CONFIG)
            cfg["phrases"] = phrases
            return cfg
    except Exception:
        pass

    # 2. Fallback to wake_phrases.json
    if not CONFIG_FILE.exists():
        try:
            CONFIG_FILE.write_text(json.dumps(DEFAULT_CONFIG, indent=4), encoding="utf-8")
        except Exception:
            pass
        return dict(DEFAULT_CONFIG)

    try:
        data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        for k, v in DEFAULT_CONFIG.items():
            if k not in data:
                data[k] = v
        return data
    except Exception as e:
        log("WAKE", f"Config load error: {e}. Using defaults.")
        return dict(DEFAULT_CONFIG)


def status_url_for(server_url):
    return str(server_url or "").replace("/api/voice/wake", "/api/voice/status")


# ── audio devices ─────────────────────────────────────────────────────────

def _pyaudio_module():
    try:
        import pyaudiowpatch as pyaudio
        return pyaudio
    except ImportError:
        try:
            import pyaudio
            return pyaudio
        except ImportError:
            return None


def list_audio_devices():
    """List all available input audio devices on the host."""
    pyaudio = _pyaudio_module()
    if pyaudio is None:
        print("[WAKE] Error: pyaudio/pyaudiowpatch not installed.")
        return []

    p = pyaudio.PyAudio()
    devices = []
    try:
        count = p.get_device_count()
        default_index = None
        try:
            default_info = p.get_default_input_device_info()
            default_index = default_info.get("index")
        except Exception:
            pass

        for i in range(count):
            try:
                info = p.get_device_info_by_index(i)
                if info.get("maxInputChannels", 0) > 0:
                    dev = {
                        "index": i,
                        "name": info.get("name"),
                        "channels": info.get("maxInputChannels"),
                        "sampleRate": int(info.get("defaultSampleRate", 44100)),
                        "isDefault": (i == default_index),
                    }
                    devices.append(dev)
            except Exception:
                continue
    finally:
        p.terminate()
    return devices


def resample_to_16k(audio, source_rate=INPUT_RATE):
    """Resample PCM audio array to 16 kHz int16."""
    if len(audio) == 0:
        return np.array([], dtype=np.int16)
    if source_rate == MODEL_RATE:
        return np.clip(audio, -32768, 32767).astype(np.int16)

    old_length = len(audio)
    new_length = int(old_length * MODEL_RATE / source_rate)

    old_positions = np.linspace(0, 1, old_length, endpoint=False)
    new_positions = np.linspace(0, 1, new_length, endpoint=False)

    converted = np.interp(new_positions, old_positions, audio)
    return np.clip(converted, -32768, 32767).astype(np.int16)


# ── HTTP to the NOVA server ───────────────────────────────────────────────

def send_wake_event(server_url, phrase, score, source="openwakeword", transcript="",
                    confidence=1.0, post_fn=None):
    """Post wake event payload to NOVA server endpoint. Returns True on 200."""
    payload = {
        "type": "wake_detected",
        "phrase": phrase,
        "score": round(float(score), 4),
        "confidence": round(float(confidence), 4),
        "source": source,
        "transcript": transcript,
        "timestamp": time.time(),
    }
    if post_fn is not None:
        return bool(post_fn(server_url, payload))
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        server_url,
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": "NOVA-VoiceService/2.0"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=3.0) as resp:
            if resp.status == 200:
                log("WAKE", f"Dispatched '{phrase}' to server "
                             f"(score: {score:.2f}, conf: {confidence:.2f}, src: {source})")
                return True
            log("WAKE", f"Server returned status {resp.status}")
            return False
    except Exception as e:
        log("WAKE", f"Could not notify server at {server_url}: {e}")
        return False


def post_status(status_url, payload, post_fn=None):
    """POST service telemetry. Returns True on 200."""
    if post_fn is not None:
        return bool(post_fn(status_url, payload))
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        status_url,
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": "NOVA-VoiceService/2.0"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=3.0) as resp:
            return resp.status == 200
    except Exception as e:
        log("WAKE", f"Status post failed ({status_url}): {e}")
        return False


def fetch_status(status_url, get_fn=None, timeout=2.0):
    """GET merged voice status (used for the TTS speaking flag)."""
    if get_fn is not None:
        try:
            return get_fn(status_url) or {}
        except Exception:
            return {}
    try:
        with urllib.request.urlopen(status_url, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8") or "{}")
            return data.get("voice", data) if isinstance(data, dict) else {}
    except Exception:
        return {}


# ── VAD ───────────────────────────────────────────────────────────────────

class EnergyVAD:
    """Zero-dependency voice activity gate: RMS threshold + hangover so a
    word is not chopped between chunks. Not a speaker verifier — its job is
    to keep silence/music/fan noise away from the expensive models."""

    def __init__(self, threshold_rms=DEFAULT_VAD_RMS, hangover_ms=DEFAULT_VAD_HANGOVER_MS,
                 chunk_ms=100.0):
        self.threshold_rms = float(threshold_rms)
        self.hangover_chunks = max(1, int(float(hangover_ms) / max(1.0, chunk_ms)))
        self._quiet_for = self.hangover_chunks  # start released

    def is_speech(self, raw_pcm16):
        if pcm_rms_int16(raw_pcm16) >= self.threshold_rms:
            self._quiet_for = 0
            return True
        self._quiet_for += 1
        return self._quiet_for <= self.hangover_chunks


class SileroVAD:
    """Optional Silero VAD (needs torch). Raises on construction when torch
    or the model is unavailable — the service falls back to EnergyVAD."""

    def __init__(self, threshold=0.5):
        import torch  # noqa: F401  (proves availability)
        from silero_vad import load_silero_vad  # pip: silero-vad
        self._model = load_silero_vad()
        self.threshold = float(threshold)

    def is_speech(self, audio_16k_int16):
        import numpy as _np
        import torch
        x = _np.asarray(audio_16k_int16, dtype=_np.float32) / 32768.0
        # Silero consumes 512-sample windows at 16 kHz.
        for i in range(0, len(x) - 511, 512):
            chunk = torch.from_numpy(x[i:i + 512])
            with torch.no_grad():
                if float(self._model(chunk, 16000).item()) >= self.threshold:
                    return True
        return False


# ── model providers (None-safe, injectable) ───────────────────────────────

class OpenWakeWordProvider:
    def __init__(self, models):
        from openwakeword.model import Model
        self._model = Model(wakeword_models=list(models))
        self.models = list(models)

    def predict(self, audio_16k_int16):
        try:
            out = self._model.predict(np.asarray(audio_16k_int16, dtype=np.int16))
            return {k: float(v) for k, v in (out or {}).items()}
        except Exception as e:
            log("WAKE", f"openWakeWord predict failed: {e}")
            return {}


class WhisperProvider:
    def __init__(self, model_name="tiny.en"):
        from faster_whisper import WhisperModel
        self._model = WhisperModel(model_name, device="cpu", compute_type="int8")
        self.model_name = model_name

    def transcribe(self, audio_16k_int16):
        """Return the transcript string ('' when nothing recognised)."""
        import numpy as _np
        audio = _np.asarray(audio_16k_int16, dtype=_np.float32) / 32768.0
        if audio.size < 1600:  # <100ms — not worth a model call
            return ""
        try:
            segments, _info = self._model.transcribe(
                audio, language="en", beam_size=1, vad_filter=False,
                condition_on_previous_text=False)
            return " ".join((s.text or "") for s in segments).strip()
        except Exception as e:
            log("WAKE", f"whisper transcribe failed: {e}")
            return ""


# ── microphone (reconnecting) ─────────────────────────────────────────────

class ReconnectingMic:
    """Owns the input stream. Resolves device (id -> name substring ->
    default), falls back across sample rates, and raises MicError (instead
    of dying) when reads fail so the service can re-open with backoff."""

    def __init__(self, device_id=None, device_name=None, rate=INPUT_RATE,
                 chunk=CHUNK, pyaudio_module=None, max_read_errors=5):
        self.device_id = device_id
        self.device_name = device_name
        self.rate = rate
        self.chunk = chunk
        self.max_read_errors = max_read_errors
        self._pa_mod = pyaudio_module or _pyaudio_module()
        if self._pa_mod is None:
            raise MicError("pyaudio/pyaudiowpatch is not installed "
                           "(pip install pyaudiowpatch)")
        self._pa = None
        self._stream = None
        self.actual_rate = rate
        self.mic_name = "Default"
        self.device_index = None
        self._read_errors = 0

    def open(self):
        self.close()
        self._pa = self._pa_mod.PyAudio()
        self.device_index = self._resolve_device()
        last_err = None
        for rate in [self.rate, 48000, 16000]:
            try:
                frames = int(self.chunk * rate / INPUT_RATE)
                self._stream = self._pa.open(
                    format=self._pa_mod.paInt16, channels=CHANNELS, rate=rate,
                    input=True, input_device_index=self.device_index,
                    frames_per_buffer=frames)
                self.actual_rate = rate
                self._read_errors = 0
                if rate != self.rate:
                    log("WAKE", f"Opened audio stream with fallback sample rate: {rate}Hz")
                return self
            except Exception as e:
                last_err = e
        raise MicError(f"Could not open audio stream on microphone "
                       f"[{self.device_index}] ({last_err})")

    def _resolve_device(self):
        if self.device_id is not None:
            try:
                info = self._pa.get_device_info_by_index(int(self.device_id))
                self.mic_name = info.get("name", f"Device #{self.device_id}")
                return int(self.device_id)
            except Exception:
                log("WAKE", f"device_id {self.device_id} unavailable, resolving otherwise")
        if self.device_name:
            try:
                for i in range(self._pa.get_device_count()):
                    info = self._pa.get_device_info_by_index(i)
                    if (info.get("maxInputChannels", 0) > 0
                            and self.device_name.lower() in str(info.get("name", "")).lower()):
                        self.mic_name = info.get("name")
                        return i
            except Exception:
                pass
        try:
            default_info = self._pa.get_default_input_device_info()
            self.mic_name = default_info.get("name", "Default Microphone")
            return default_info.get("index")
        except Exception as e:
            raise MicError(f"No usable input device: {e}")

    def read(self):
        if not self._stream:
            raise MicError("stream is not open")
        try:
            frames = int(self.chunk * self.actual_rate / INPUT_RATE)
            raw = self._stream.read(frames, exception_on_overflow=False)
            if not raw:
                raise MicError("empty read from audio stream")
            self._read_errors = 0
            return raw
        except MicError:
            raise
        except Exception as e:
            self._read_errors += 1
            if self._read_errors >= self.max_read_errors:
                raise MicError(f"audio read failing ({self._read_errors}x): {e}")
            return b""

    def close(self):
        if self._stream:
            try:
                self._stream.stop_stream()
                self._stream.close()
            except Exception:
                pass
            self._stream = None
        if self._pa:
            try:
                self._pa.terminate()
            except Exception:
                pass
            self._pa = None


# ── the service ───────────────────────────────────────────────────────────

class WakeWordService:
    def __init__(self, config=None, mic=None, oww=None, whisper=None, vad=None,
                 post_event=None, post_status=None, fetch_status=None,
                 time_fn=None, sleep_fn=None):
        self.config = config or load_config()
        self.state = VoiceServiceLifecycle.OFF
        self.server_url = self.config.get("server_url", DEFAULT_SERVER_URL)
        self.status_url = self.config.get("status_url") or status_url_for(self.server_url)
        self.threshold = float(self.config.get("threshold", DEFAULT_THRESHOLD))
        self.confirm_threshold = float(self.config.get("confirm_threshold",
                                                       DEFAULT_CONFIRM_THRESHOLD))
        self.cooldown_sec = float(self.config.get("cooldown_ms", DEFAULT_COOLDOWN_MS)) / 1000.0
        self.engine_mode = str(self.config.get("engine", "hybrid")).lower()
        self.heartbeat_sec = float(self.config.get("heartbeat_sec", DEFAULT_HEARTBEAT_SEC))
        self.speaking_poll_sec = float(self.config.get("speaking_poll_sec",
                                                       DEFAULT_SPEAKING_POLL_SEC))
        preroll = float(self.config.get("preroll_sec", DEFAULT_PREROLL_SEC))
        self._ring_max = int(MODEL_RATE * preroll)

        # Injected (real implementations built in initialize() when None).
        self.mic = mic
        self.oww = oww
        self.whisper = whisper
        self.vad = vad
        self._post_event = post_event
        self._post_status = post_status
        self._fetch_status = fetch_status
        self._clock = time_fn or time.time
        self._sleep = sleep_fn or time.sleep

        self.running = False
        self.actual_rate = INPUT_RATE
        self.mic_name = "Default"
        self.active_phrases = []
        self.disabled_phrases = []
        self.last_trigger = 0.0
        self._ring = deque(maxlen=self._ring_max)
        self._speaking = False
        self._last_speaking_poll = 0.0
        self._last_heartbeat = 0.0
        self._last_whisper_scan = 0.0
        self._server_ok = True
        self._started_at = 0.0
        self._chunks = 0
        self._candidates = 0
        self._rejections = 0
        self._emitted = 0
        self._state_reason = ""
        # _oww/_whisper sentinel: None = not attempted, False = unavailable.
        self._oww_missing = False
        self._whisper_missing = False

    # ── lifecycle ──

    def set_state(self, state, reason=""):
        if state != self.state:
            log("WAKE", f"state {self.state} -> {state}" + (f" ({reason})" if reason else ""))
        self.state = state
        self._state_reason = reason or ""

    def initialize(self, load_models=True):
        self.set_state(VoiceServiceLifecycle.STARTING)
        log("WAKE", f"Initializing NOVA voice service v{SERVICE_VERSION} "
                     f"(engine={self.engine_mode})...")

        enabled = [p for p in self.config.get("phrases", []) if p.get("enabled", True)]
        if not enabled:
            enabled = DEFAULT_CONFIG["phrases"]

        if load_models:
            self._load_detection_models()
        if self.engine_mode in ("openwakeword", "hybrid") and self.oww is None \
                and not self._oww_missing:
            # Injected-None means "not provided" in tests; on real runs the
            # loader above already tried. Only fatal when nothing can detect.
            pass

        self._activate_phrases(enabled)

        if self.engine_mode == "whisper" and self.whisper is None:
            self.set_state(VoiceServiceLifecycle.MODEL_ERROR, "whisper engine needs whisper")
            raise RuntimeError("engine='whisper' but faster-whisper is unavailable")
        if self.oww is None and self.whisper is None:
            self.set_state(VoiceServiceLifecycle.MODEL_ERROR, "no detection model available")
            raise RuntimeError("neither openWakeWord nor faster-whisper is available")

        if self.vad is None:
            if str(self.config.get("vad_engine", "energy")).lower() == "silero":
                try:
                    self.vad = SileroVAD()
                    log("WAKE", "VAD: silero")
                except Exception as e:
                    log("WAKE", f"silero VAD unavailable ({e}), energy fallback")
                    self.vad = self._energy_vad()
            else:
                self.vad = self._energy_vad()
        log("WAKE", f"VAD: {type(self.vad).__name__}")

        if self.mic is None:
            self.mic = ReconnectingMic(device_id=self.config.get("device_id"),
                                       device_name=self.config.get("device_name"))
        self.mic.open()
        self.actual_rate = self.mic.actual_rate
        self.mic_name = self.mic.mic_name
        log("WAKE", f"Microphone: [{self.mic.device_index}] {self.mic_name} "
                     f"@ {self.actual_rate}Hz")

        self._started_at = self._clock()
        self.set_state(VoiceServiceLifecycle.READY,
                       f"{len(self.active_phrases)} phrases, engine={self.engine_mode}")
        log("WAKE", f"READY. threshold={self.threshold} confirm>={self.confirm_threshold} "
                     f"cooldown={self.cooldown_sec * 1000:.0f}ms")
        if self.disabled_phrases:
            log("WAKE", "disabled (need whisper): "
                         + ", ".join(self.disabled_phrases))
        self._heartbeat(force=True)
        return self

    def _energy_vad(self):
        chunk_ms = 1000.0 * CHUNK / INPUT_RATE
        return EnergyVAD(threshold_rms=self.config.get("vad_rms", DEFAULT_VAD_RMS),
                         hangover_ms=self.config.get("vad_hangover_ms",
                                                     DEFAULT_VAD_HANGOVER_MS),
                         chunk_ms=chunk_ms)

    def _load_detection_models(self):
        if self.oww is None and self.engine_mode in ("openwakeword", "hybrid"):
            try:
                from openwakeword.utils import download_models  # noqa: F401 (side effect ok)
            except Exception:
                pass
            try:
                models = sorted({str(p.get("model")) for p in self.config.get("phrases", [])
                                 if p.get("model")})
                if not models:
                    models = ["hey_jarvis"]
                log("WAKE", f"Loading openWakeWord models: {', '.join(models)}...")
                self.oww = OpenWakeWordProvider(models)
                log("WAKE", "openWakeWord loaded.")
            except Exception as e:
                self._oww_missing = True
                log("WAKE", f"openWakeWord unavailable ({e})")
        if self.whisper is None and self.engine_mode in ("whisper", "hybrid"):
            try:
                log("WAKE", "Loading faster-whisper tiny.en...")
                self.whisper = WhisperProvider("tiny.en")
                log("WAKE", "faster-whisper loaded.")
            except Exception as e:
                self._whisper_missing = True
                log("WAKE", f"faster-whisper unavailable ({e})")

    def _activate_phrases(self, enabled):
        """Split enabled phrases into detectable vs disabled. Without whisper,
        only exact model/phrase pairs survive (Honesty Rule 2)."""
        self.active_phrases, self.disabled_phrases = [], []
        for p in enabled:
            phrase_text = str(p.get("phrase", ""))
            model = p.get("model")
            needs_whisper = not (model and model_matches_phrase(model, phrase_text))
            if needs_whisper and self.whisper is None and self.engine_mode != "whisper":
                self.disabled_phrases.append(phrase_text or p.get("name", "?"))
                continue
            self.active_phrases.append(p)
        if self.engine_mode == "whisper" and self.whisper is None:
            pass  # fatal handled by caller
        elif not self.active_phrases and enabled:
            log("WAKE", "WARNING: no phrase is detectable with the loaded models")

    # ── detection ──

    def _ring_append(self, audio_16k):
        self._ring.extend(int(v) for v in np.asarray(audio_16k, dtype=np.int16).tolist())

    def _ring_audio(self):
        return np.array(self._ring, dtype=np.int16)

    def _cooldown_ok(self, now):
        return (now - self.last_trigger) >= self.cooldown_sec

    def _poll_speaking(self, now):
        """True while the assistant is speaking (browser TTS posts the flag to
        /api/voice/status; the service suppresses confirmation meanwhile)."""
        if now - self._last_speaking_poll < self.speaking_poll_sec:
            return self._speaking
        self._last_speaking_poll = now
        try:
            st = fetch_status(self.status_url, get_fn=self._fetch_status)
            self._speaking = bool(st.get("speaking", False))
        except Exception:
            pass
        return self._speaking

    def process_chunk(self, raw):
        """One detection step over raw mic bytes. Returns the emitted event
        dict, or None. Pure w.r.t. injected fakes — this is what tests drive."""
        now = self._clock()
        if not raw or self.state == VoiceServiceLifecycle.PAUSED:
            return None
        self._chunks += 1

        try:
            audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32)
        except Exception:
            return None
        audio_16k = resample_to_16k(audio, source_rate=self.actual_rate)
        if len(audio_16k) == 0:
            return None
        self._ring_append(audio_16k)

        speaking = self._poll_speaking(now)

        # VAD gate: silence never reaches the models (CPU + false positives).
        try:
            is_speech = self.vad.is_speech(raw) if self.vad else True
        except Exception:
            is_speech = True
        if not is_speech:
            self._maybe_heartbeat(now)
            return None

        if self.engine_mode == "whisper" or self.oww is None:
            return self._whisper_scan(now, speaking)

        # openWakeWord candidate stage.
        try:
            scores = self.oww.predict(np.asarray(audio_16k, dtype=np.int16)) or {}
        except Exception as e:
            log("WAKE", f"predict failed: {e}")
            return None

        candidate, cand_score, cand_model = None, 0.0, None
        for phrase in self.active_phrases:
            m = phrase.get("model")
            if not m:
                continue
            s = float(scores.get(m, 0.0))
            thr = float(phrase.get("threshold", self.threshold))
            if s >= thr and s > cand_score:
                candidate, cand_score, cand_model = phrase, s, m
        if candidate is None:
            # No candidate: pure-custom phrases still get a periodic whisper
            # scan in hybrid mode so "nova"/"okay nova" work with no model.
            if self.engine_mode == "hybrid" and self.whisper is not None:
                return self._whisper_scan(now, speaking)
            return None
        if not self._cooldown_ok(now):
            return None

        self._candidates += 1
        self.set_state(VoiceServiceLifecycle.WAKE_CANDIDATE,
                       f"{cand_model}={cand_score:.2f}")
        if speaking:
            log("WAKE", f"candidate suppressed (assistant speaking): {cand_model}")
            self.set_state(VoiceServiceLifecycle.WAKE_LISTENING)
            return None

        # Confirmation stage (Honesty Rule 1).
        self.set_state(VoiceServiceLifecycle.CONFIRMING, cand_model)
        text = ""
        if self.whisper is not None:
            try:
                text = self.whisper.transcribe(self._ring_audio())
            except Exception as e:
                log("WAKE", f"confirm transcribe failed: {e}")
                text = ""
        if text:
            match, conf = match_phrase(text, self.active_phrases)
            if match is not None and conf >= self.confirm_threshold:
                return self._emit(now, match, cand_score, conf,
                                  "openwakeword+whisper", text)
            self._rejections += 1
            log("WAKE", f"REJECTED candidate {cand_model}={cand_score:.2f}: "
                         f"transcript {text!r} matches nothing "
                         f"(best: {(match or {}).get('phrase') if match else None} "
                         f"{conf:.2f} < {self.confirm_threshold})")
            self.set_state(VoiceServiceLifecycle.WAKE_LISTENING)
            return None
        # No transcript (whisper missing or empty): exact pairs only (Rule 3).
        phrase_text = str(candidate.get("phrase", ""))
        if self.whisper is None and model_matches_phrase(cand_model, phrase_text):
            return self._emit(now, candidate, cand_score, cand_score,
                              "openwakeword", "")
        self._rejections += 1
        log("WAKE", f"REJECTED candidate {cand_model}={cand_score:.2f}: no transcript "
                     f"and not an exact model/phrase pair")
        self.set_state(VoiceServiceLifecycle.WAKE_LISTENING)
        return None

    def _whisper_scan(self, now, speaking):
        """Pure-transcript detection for custom phrases (engine 'whisper', or
        hybrid top-up). Rate-limited: at most one scan per 1.2s of speech."""
        if self.whisper is None or speaking:
            return None
        if now - self._last_whisper_scan < 1.2:
            return None
        self._last_whisper_scan = now
        try:
            text = self.whisper.transcribe(self._ring_audio())
        except Exception:
            return None
        if not text:
            return None
        match, conf = match_phrase(text, self.active_phrases)
        if match is None or conf < self.confirm_threshold:
            return None
        if not self._cooldown_ok(now):
            return None
        self.set_state(VoiceServiceLifecycle.CONFIRMING, "whisper-scan")
        return self._emit(now, match, conf, conf, "whisper", text)

    def _emit(self, now, phrase, score, confidence, source, transcript):
        name = phrase.get("name") or phrase.get("phrase") or "Hey Nova"
        self.last_trigger = now
        self._emitted += 1
        event = {"type": "wake_detected", "phrase": name, "score": round(score, 4),
                 "confidence": round(confidence, 4), "source": source,
                 "transcript": transcript, "timestamp": now}
        log("WAKE", f"WAKE '{name}' (score={score:.2f} conf={confidence:.2f} "
                     f"src={source} transcript={transcript!r})")
        ok = send_wake_event(self.server_url, name, score, source=source,
                             transcript=transcript, confidence=confidence,
                             post_fn=self._post_event)
        self._server_ok = bool(ok)
        if not ok:
            self.set_state(VoiceServiceLifecycle.SERVER_UNAVAILABLE,
                           "wake POST failed (listening continues)")
        else:
            if self.state == VoiceServiceLifecycle.SERVER_UNAVAILABLE:
                self.set_state(VoiceServiceLifecycle.WAKE_LISTENING, "server back")
            else:
                self.set_state(VoiceServiceLifecycle.WAKE_LISTENING)
        self._heartbeat(force=True)
        return event

    # ── telemetry ──

    def status_dict(self):
        return {
            "status": self.state,
            "reason": self._state_reason,
            "version": SERVICE_VERSION,
            "engine": self.engine_mode + ("+whisper" if self.whisper else "")
                      + ("+oww" if self.oww else ""),
            "device": self.mic_name,
            "vad": type(self.vad).__name__ if self.vad else "none",
            "whisper_available": self.whisper is not None,
            "oww_available": self.oww is not None,
            "phrases": [p.get("phrase") for p in self.active_phrases],
            "disabled_phrases": list(self.disabled_phrases),
            "threshold": self.threshold,
            "confirm_threshold": self.confirm_threshold,
            "cooldown_ms": int(self.cooldown_sec * 1000),
            "speaking": self._speaking,
            "server_ok": self._server_ok,
            "chunks": self._chunks,
            "candidates": self._candidates,
            "rejections": self._rejections,
            "emitted": self._emitted,
            "uptime_sec": round(self._clock() - self._started_at, 1)
            if self._started_at else 0.0,
            "updated_at": self._clock(),
        }

    def _heartbeat(self, force=False):
        now = self._clock()
        if not force and (now - self._last_heartbeat) < self.heartbeat_sec:
            return
        self._last_heartbeat = now
        ok = post_status(self.status_url, self.status_dict(), post_fn=self._post_status)
        if not ok and self._server_ok:
            self._server_ok = False
            log("WAKE", "heartbeat failed — server unreachable (listening continues)")
        elif ok and not self._server_ok:
            self._server_ok = True
            if self.state == VoiceServiceLifecycle.SERVER_UNAVAILABLE:
                self.set_state(VoiceServiceLifecycle.WAKE_LISTENING, "server back")

    def _maybe_heartbeat(self, now):
        if (now - self._last_heartbeat) >= self.heartbeat_sec:
            self._heartbeat(force=True)

    # ── run loop ──

    def run(self):
        if self.state not in (VoiceServiceLifecycle.READY,
                              VoiceServiceLifecycle.WAKE_LISTENING):
            self.initialize()
        self.running = True
        self.set_state(VoiceServiceLifecycle.WAKE_LISTENING, self.mic_name)
        log("WAKE", f"Listening ({self.mic_name}, engine={self.engine_mode}, "
                     f"{len(self.active_phrases)} phrases)...")
        backoff = 1.0
        while self.running:
            try:
                raw = self.mic.read()
                if raw:
                    backoff = 1.0
                    if self.state == VoiceServiceLifecycle.WAKE_LISTENING:
                        pass  # steady state
                    elif self.state == VoiceServiceLifecycle.MIC_ERROR:
                        self.set_state(VoiceServiceLifecycle.WAKE_LISTENING,
                                       "mic recovered")
                    self.process_chunk(raw)
            except MicError as e:
                self.set_state(VoiceServiceLifecycle.MIC_ERROR, str(e))
                log("WAKE", f"mic error ({e}); re-opening in {backoff:.0f}s...")
                self._sleep(backoff)
                backoff = min(15.0, backoff * 2)
                try:
                    self.mic.open()
                    self.actual_rate = self.mic.actual_rate
                    self.set_state(VoiceServiceLifecycle.WAKE_LISTENING, "mic re-opened")
                except MicError as e2:
                    log("WAKE", f"re-open failed: {e2}")
            except KeyboardInterrupt:
                break
            except Exception as e:
                log("WAKE", f"loop warning: {e}")
                self._sleep(0.05)
        self.stop()

    def pause(self):
        self.set_state(VoiceServiceLifecycle.PAUSED, "explicit pause")

    def resume(self):
        self.set_state(VoiceServiceLifecycle.WAKE_LISTENING, "resumed")

    def stop(self):
        log("WAKE", "Shutting down voice service...")
        self.running = False
        try:
            if self.mic is not None:
                self.mic.close()
        except Exception:
            pass
        self.set_state(VoiceServiceLifecycle.STOPPED)
        log("WAKE", "Microphone released. Stopped.")


# ── CLI ───────────────────────────────────────────────────────────────────

def main(argv=None):
    parser = argparse.ArgumentParser(description="NOVA production wake-word service")
    parser.add_argument("--list-devices", action="store_true")
    parser.add_argument("--device-id", type=int, default=None)
    parser.add_argument("--device-name", default=None)
    parser.add_argument("--threshold", type=float, default=None)
    parser.add_argument("--confirm-threshold", type=float, default=None)
    parser.add_argument("--cooldown", type=int, default=None, help="Cooldown in ms")
    parser.add_argument("--engine", default=None,
                        help="'hybrid' (default) | 'openwakeword' | 'whisper'")
    parser.add_argument("--vad", type=float, default=None, help="Energy VAD RMS threshold")
    parser.add_argument("--server", default=None, help="Wake POST URL override")
    parser.add_argument("--test-mic", action="store_true",
                        help="Show mic levels for 5 seconds")
    parser.add_argument("--smoke-test", action="store_true",
                        help="Open the mic, read 40 chunks, report VAD/RMS, exit")
    args = parser.parse_args(argv)

    if args.list_devices:
        print("=" * 65)
        print("          NOVA :: AVAILABLE AUDIO INPUT DEVICES")
        print("=" * 65)
        for d in list_audio_devices():
            marker = " [DEFAULT]" if d["isDefault"] else ""
            print(f" [{d['index']:2d}] {d['name']} ({d['sampleRate']}Hz, {d['channels']}ch){marker}")
        return 0

    cfg = load_config()
    if args.device_id is not None:
        cfg["device_id"] = args.device_id
    if args.device_name:
        cfg["device_name"] = args.device_name
    if args.threshold is not None:
        cfg["threshold"] = args.threshold
    if args.confirm_threshold is not None:
        cfg["confirm_threshold"] = args.confirm_threshold
    if args.cooldown is not None:
        cfg["cooldown_ms"] = args.cooldown
    if args.engine:
        cfg["engine"] = args.engine
    if args.vad is not None:
        cfg["vad_rms"] = args.vad
    if args.server:
        cfg["server_url"] = args.server

    if args.smoke_test or args.test_mic:
        secs = 1.5 if args.smoke_test else 5.0
        print(f"[WAKE] Mic smoke test ({secs:.1f}s, no models loaded)...")
        mic = ReconnectingMic(device_id=cfg.get("device_id"),
                              device_name=cfg.get("device_name"))
        mic.open()
        vad = EnergyVAD(threshold_rms=cfg.get("vad_rms", DEFAULT_VAD_RMS))
        print(f"[WAKE] Opened [{mic.device_index}] {mic.mic_name} @ {mic.actual_rate}Hz")
        t_end, n, speech_n, peak = time.time() + secs, 0, 0, 0.0
        try:
            while time.time() < t_end:
                raw = mic.read()
                if not raw:
                    continue
                n += 1
                rms = pcm_rms_int16(raw)
                peak = max(peak, rms)
                if vad.is_speech(raw):
                    speech_n += 1
                if not args.smoke_test:
                    bars = int(min(50, rms / 200))
                    print(f"\rRMS: [{'#' * bars}{' ' * (50 - bars)}] {rms:.1f}",
                          end="", flush=True)
                    time.sleep(0.05)
        finally:
            mic.close()
        print(f"\n[WAKE] chunks={n} speech_chunks={speech_n} peak_rms={peak:.1f}")
        if n == 0:
            print("[WAKE] SMOKE FAIL: no audio read")
            return 1
        print("[WAKE] SMOKE PASS")
        return 0

    service = WakeWordService(cfg)
    try:
        service.initialize()
        service.run()
    except KeyboardInterrupt:
        service.stop()
    except Exception as e:
        log("WAKE", f"Fatal: {e}")
        try:
            service.stop()
        except Exception:
            pass
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

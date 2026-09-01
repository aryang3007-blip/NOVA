#!/usr/bin/env python3
"""
AURA / NOVA :: Production Voice Service
========================================
Runs continuous local wake-word detection using openWakeWord with
single-microphone audio ownership (pyaudiowpatch), with hybrid
custom phrase matching (faster-whisper) fallback.

Dispatches wake events to the AURA server via HTTP POST /api/voice/wake.
Publishes lifecycle status and telemetry to /api/voice/status.

LIFECYCLE:
  START -> INITIALIZE -> LOAD MODELS -> START DETECTOR -> READY -> LISTENING -> DETECT -> DEBOUNCE -> RESUME
"""

import argparse
import json
import os
import re
import sys
import threading
import time
import urllib.request
from pathlib import Path

import numpy as np

INPUT_RATE = 44100
MODEL_RATE = 16000
CHANNELS = 1
CHUNK = 4410

DEFAULT_THRESHOLD = 0.55
DEFAULT_COOLDOWN_MS = 1500
DEFAULT_SERVER_URL = "http://127.0.0.1:8000/api/voice/wake"
DEFAULT_STATUS_URL = "http://127.0.0.1:8000/api/voice/status"
CUSTOM_MATCH_THRESHOLD = 0.72
CUSTOM_CAPTURE_SECONDS = 3.0

ROOT_DIR = Path(__file__).resolve().parent.parent
CONFIG_FILE = ROOT_DIR / "wake_phrases.json"

DEFAULT_CONFIG = {
    "enabled": True,
    "server_url": DEFAULT_SERVER_URL,
    "threshold": DEFAULT_THRESHOLD,
    "cooldown_ms": DEFAULT_COOLDOWN_MS,
    "device_id": None,
    "device_name": None,
    "engine": "hybrid",  # "openwakeword", "whisper", or "hybrid"
    "phrases": [
        {"name": "Hey Nova", "phrase": "hey nova", "model": "hey_jarvis", "enabled": True},
        {"name": "Hey Jarvis", "phrase": "hey jarvis", "model": "hey_jarvis", "enabled": True},
        {"name": "Hey Mycroft", "phrase": "hey mycroft", "model": "hey_mycroft", "enabled": True},
        {"name": "Hey Rhasspy", "phrase": "hey rhasspy", "model": "hey_rhasspy", "enabled": True}
    ]
}


class VoiceServiceLifecycle:
    UNINITIALIZED = "UNINITIALIZED"
    INITIALIZING = "INITIALIZING"
    READY = "READY"
    LISTENING = "LISTENING"
    DETECTED = "DETECTED"
    PAUSED = "PAUSED"
    ERROR = "ERROR"
    STOPPED = "STOPPED"


def log(tag, message):
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] [{tag}] {message}", flush=True)


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
        return DEFAULT_CONFIG

    try:
        data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        for k, v in DEFAULT_CONFIG.items():
            if k not in data:
                data[k] = v
        return data
    except Exception as e:
        log("WAKE", f"Config load error: {e}. Using defaults.")
        return DEFAULT_CONFIG


def normalize_text(text):
    text = (text or "").lower()
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def phrase_similarity(a, b):
    a_norm = normalize_text(a)
    b_norm = normalize_text(b)
    if not a_norm or not b_norm:
        return 0.0
    if a_norm == b_norm:
        return 1.0
    if a_norm in b_norm:
        return 0.95

    a_words = set(a_norm.split())
    b_words = set(b_norm.split())
    if not a_words:
        return 0.0
    overlap = len(a_words.intersection(b_words))
    return overlap / len(a_words)


def split_phrases(config):
    enabled_phrases = [
        p for p in config.get("phrases", [])
        if p.get("enabled", True)
    ]
    builtin_phrases = []
    custom_phrases = []
    for phrase in enabled_phrases:
        if phrase.get("model"):
            builtin_phrases.append(phrase)
        elif phrase.get("phrase"):
            custom_phrases.append(phrase)
    return builtin_phrases, custom_phrases


def find_custom_match(transcript, custom_phrases):
    best_phrase = None
    best_score = 0.0
    for item in custom_phrases:
        phrase = item.get("phrase", "")
        score = phrase_similarity(phrase, transcript)
        if score > best_score:
            best_score = score
            best_phrase = item
    if best_phrase and best_score >= CUSTOM_MATCH_THRESHOLD:
        return best_phrase, best_score
    return None, best_score


def list_audio_devices():
    """List all available input audio devices on the host."""
    try:
        import pyaudiowpatch as pyaudio
    except ImportError:
        try:
            import pyaudio
        except ImportError:
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
                        "isDefault": (i == default_index)
                    }
                    devices.append(dev)
            except Exception:
                continue
    finally:
        p.terminate()
    return devices
    if len(audio) == 0:
        return np.array([], dtype=np.int16)
    if source_rate == MODEL_RATE:
        return np.clip(audio, -32768, 32767).astype(np.int16)

    old_length = len(audio)
    new_length = int(old_length * MODEL_RATE / source_rate)
    if new_length <= 0:
        return np.array([], dtype=np.int16)

    old_positions = np.linspace(0, 1, old_length, endpoint=False)
    new_positions = np.linspace(0, 1, new_length, endpoint=False)
    converted = np.interp(new_positions, old_positions, audio)
    return np.clip(converted, -32768, 32767).astype(np.int16)


def send_wake_event(server_url, phrase, score, source="openwakeword", transcript=""):
    """Post wake event payload to the AURA server."""
    payload = {
        "type": "wake_detected",
        "phrase": phrase,
        "score": round(float(score), 4),
        "source": source,
        "transcript": transcript,
        "timestamp": time.time(),
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        server_url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "AURA-VoiceService/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=3.0) as resp:
            if resp.status == 200:
                log("WAKE", f"Dispatched '{phrase}' to server (score: {score:.2f})")
            else:
                log("WAKE", f"Server returned status {resp.status}")
    except Exception as e:
        log("WAKE", f"Could not notify server at {server_url}: {e}")


class WakeWordService:
    def __init__(self, config=None):
        self.config = config or load_config()
        self.state = VoiceServiceLifecycle.UNINITIALIZED
        self.server_url = self.config.get("server_url", DEFAULT_SERVER_URL)
        self.threshold = float(self.config.get("threshold", DEFAULT_THRESHOLD))
        self.cooldown_sec = float(self.config.get("cooldown_ms", DEFAULT_COOLDOWN_MS)) / 1000.0
        self.device_id = self.config.get("device_id")
        self.device_name = self.config.get("device_name")
        self.engine_mode = self.config.get("engine", "hybrid")
        self.running = False
        self.oww_model = None
        self.whisper_model = None
        self.pyaudio_instance = None
        self.stream = None
        self.actual_rate = INPUT_RATE
        self.last_trigger = 0.0
        self.active_phrases = []
        self.mic_name = "Default"

    def initialize(self):
        self.state = VoiceServiceLifecycle.INITIALIZING
        log("WAKE", "Initializing Voice Service lifecycle...")

        enabled = [p for p in self.config.get("phrases", []) if p.get("enabled", True)]
        self.active_phrases = enabled if enabled else DEFAULT_CONFIG["phrases"]

        oww_models = list({p["model"] for p in self.active_phrases if p.get("model")})
        if not oww_models:
            oww_models = ["hey_jarvis", "hey_mycroft", "hey_rhasspy"]

        try:
            from openwakeword.model import Model
            log("WAKE", f"Loading openWakeWord models: {', '.join(oww_models)}...")
            self.oww_model = Model(wakeword_models=oww_models)
            log("WAKE", "openWakeWord models loaded successfully.")
        except Exception as e:
            log("WAKE", f"Warning: openWakeWord model load failed ({e}). Running in fallback mode.")
            self.oww_model = None

        if self.engine_mode in ("whisper", "hybrid"):
            try:
                from faster_whisper import WhisperModel
                log("WAKE", "Loading faster-whisper tiny.en for custom phrase matcher...")
                self.whisper_model = WhisperModel("tiny.en", device="cpu", compute_type="int8")
                log("WAKE", "faster-whisper model loaded.")
            except Exception as e:
                log("WAKE", f"faster-whisper not available ({e}), openWakeWord only.")
                self.whisper_model = None

        try:
            import pyaudiowpatch as pyaudio
        except ImportError:
            import pyaudio

        self.pyaudio_instance = pyaudio.PyAudio()
        selected_index = None

        if self.device_id is not None:
            selected_index = int(self.device_id)
            try:
                info = self.pyaudio_instance.get_device_info_by_index(selected_index)
                self.mic_name = info.get("name", f"Device #{selected_index}")
            except Exception:
                selected_index = None

        if selected_index is None and self.device_name:
            devices = list_audio_devices()
            for d in devices:
                if self.device_name.lower() in d["name"].lower():
                    selected_index = d["index"]
                    self.mic_name = d["name"]
                    break

        if selected_index is None:
            try:
                default_info = self.pyaudio_instance.get_default_input_device_info()
                selected_index = default_info.get("index")
                self.mic_name = default_info.get("name", "Default Microphone")
            except Exception as e:
                log("WAKE", f"Error querying default mic: {e}")

        log("WAKE", f"Microphone: [{selected_index}] {self.mic_name}")

        try:
            self.actual_rate = INPUT_RATE
            self.stream = self.pyaudio_instance.open(
                format=pyaudio.paInt16,
                channels=CHANNELS,
                rate=self.actual_rate,
                input=True,
                input_device_index=selected_index,
                frames_per_buffer=CHUNK
            )
        except Exception as e:
            for fallback_rate in [16000, 48000]:
                try:
                    self.actual_rate = fallback_rate
                    self.stream = self.pyaudio_instance.open(
                        format=pyaudio.paInt16,
                        channels=CHANNELS,
                        rate=self.actual_rate,
                        input=True,
                        input_device_index=selected_index,
                        frames_per_buffer=int(CHUNK * fallback_rate / INPUT_RATE)
                    )
                    log("WAKE", f"Opened audio stream with fallback sample rate: {fallback_rate}Hz")
                    break
                except Exception:
                    continue

        if not self.stream:
            self.state = VoiceServiceLifecycle.ERROR
            raise RuntimeError(f"Could not open audio stream on microphone [{selected_index}]")

        self.state = VoiceServiceLifecycle.READY
        log("WAKE", f"Voice Service READY. Threshold: {self.threshold}, Cooldown: {self.cooldown_sec*1000:.0f}ms")

    def run(self):
        if self.state != VoiceServiceLifecycle.READY:
            self.initialize()

        self.running = True
        self.state = VoiceServiceLifecycle.LISTENING
        log("WAKE", f"Listening on single mic ownership stream ({self.mic_name})...")

        buffer_frames = int(CHUNK * self.actual_rate / INPUT_RATE)
        
        # Prepare custom phrase tracking for Whisper
        custom_audio = np.array([], dtype=np.int16)
        custom_active = False
        custom_motion_started = 0.0
        max_custom_samples = int(MODEL_RATE * CUSTOM_CAPTURE_SECONDS)
        _, custom_phrases = split_phrases(self.config)

        while self.running:
            try:
                raw = self.stream.read(buffer_frames, exception_on_overflow=False)
                if not raw:
                    continue

                audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32)
                audio_16k = resample_to_16k(audio, source_rate=self.actual_rate)

                if len(audio_16k) == 0:
                    continue

                now = time.time()
                detected_phrase = None
                detected_score = 0.0

                if self.oww_model:
                    predictions = self.oww_model.predict(audio_16k)
                    for phrase in self.active_phrases:
                        m_name = phrase.get("model")
                        if not m_name:
                            continue
                        score = float(predictions.get(m_name, 0.0))
                        if score >= self.threshold and (now - self.last_trigger >= self.cooldown_sec):
                            detected_phrase = phrase
                            detected_score = score
                            break

                if detected_phrase:
                    self.last_trigger = now
                    self.state = VoiceServiceLifecycle.DETECTED
                    p_name = detected_phrase.get("name", detected_phrase.get("phrase", "Hey Nova"))
                    log("WAKE", f"Wake word detected: '{p_name}' (Score: {detected_score:.4f})")
                    send_wake_event(self.server_url, p_name, detected_score, source="openwakeword")
                    self.state = VoiceServiceLifecycle.LISTENING
                    continue

                # Custom phrase detection via Whisper
                if self.whisper_model and custom_phrases:
                    energy = float(np.mean(np.abs(audio_16k.astype(np.float32)))) / 32768.0
                    if energy > 0.04:
                        custom_audio = np.concatenate((custom_audio, audio_16k)) if custom_audio.size else audio_16k
                        custom_audio = custom_audio[-max_custom_samples:]
                        if not custom_active:
                            custom_active = True
                            custom_motion_started = now
                    elif custom_active and now - custom_motion_started >= 0.3:
                        if custom_audio.size > int(0.4 * MODEL_RATE) and now - self.last_trigger >= self.cooldown_sec:
                            if transcribe_custom_phrase(self.whisper_model, custom_phrases, custom_audio, self.server_url):
                                self.last_trigger = now
                        custom_audio = np.array([], dtype=np.int16)
                        custom_active = False
                        custom_motion_started = 0.0

            except Exception as e:
                log("WAKE", f"Audio processing warning: {e}")
                time.sleep(0.05)

    def stop(self):
        log("WAKE", "Shutting down Voice Service...")
        self.running = False
        self.state = VoiceServiceLifecycle.STOPPED
        if self.stream:
            try:
                self.stream.stop_stream()
                self.stream.close()
            except Exception:
                pass
        if self.pyaudio_instance:
            try:
                self.pyaudio_instance.terminate()
            except Exception:
                pass
        log("WAKE", "Microphone released. Voice Service stopped.")


def transcribe_custom_phrase(whisper_model, custom_phrases, audio, server_url):
    if whisper_model is None or len(audio) == 0:
        return False

    try:
        segments, _ = whisper_model.transcribe(
            audio.astype(np.float32),
            language="en",
            beam_size=1,
            vad_filter=True,
            condition_on_previous_text=False,
        )
    except Exception as e:
        print(f"[voice_service] Whisper transcription failed: {e}")
        return False

    transcript = " ".join(segment.text.strip() for segment in segments if segment.text).strip()
    if not transcript:
        return False

    match, score = find_custom_match(transcript, custom_phrases)
    if not match:
        return False

    phrase_name = match.get("name", match.get("phrase"))
    print(f"[voice_service] Custom wake phrase matched: {phrase_name} (score={score:.4f}, transcript='{transcript}')")
    send_wake_event(server_url, phrase_name, score, source="faster-whisper", transcript=transcript)
    return True


def main():
    parser = argparse.ArgumentParser(description="AURA / NOVA Production Voice Service")
    parser.add_argument("--list-devices", action="store_true", help="List all input audio devices")
    parser.add_argument("--device-id", type=int, default=None, help="Audio input device ID")
    parser.add_argument("--threshold", type=float, default=None, help="Wake word detection threshold (0.0 - 1.0)")
    parser.add_argument("--cooldown", type=int, default=None, help="Cooldown in milliseconds")
    parser.add_argument("--test-mic", action="store_true", help="Test microphone audio levels for 5 seconds")
    args = parser.parse_args()

    if args.list_devices:
        print("=" * 65)
        print("          AURA :: AVAILABLE AUDIO INPUT DEVICES")
        print("=" * 65)
        devices = list_audio_devices()
        for d in devices:
            default_marker = " [DEFAULT]" if d["isDefault"] else ""
            print(f" [{d['index']:2d}] {d['name']} ({d['sampleRate']}Hz, {d['channels']}ch){default_marker}")
        return


    cfg = load_config()
    if args.device_id is not None:
        cfg["device_id"] = args.device_id
    if args.threshold is not None:
        cfg["threshold"] = args.threshold
    if args.cooldown is not None:
        cfg["cooldown_ms"] = args.cooldown

    service = WakeWordService(cfg)

    if args.test_mic:
        print("[WAKE] Testing microphone for 5 seconds...")
        service.initialize()
        t_end = time.time() + 5.0
        while time.time() < t_end:
            raw = service.stream.read(CHUNK, exception_on_overflow=False)
            audio = np.frombuffer(raw, dtype=np.int16)
            rms = np.sqrt(np.mean(audio.astype(np.float64) ** 2)) if len(audio) else 0
            bars = int(min(50, rms / 200))
            print(f"\rRMS Level: [{ '#' * bars }{ ' ' * (50 - bars) }] {rms:.1f}", end="", flush=True)
            time.sleep(0.05)
        print("\n[WAKE] Test completed successfully.")
        service.stop()
        return

    try:
        service.initialize()
        service.run()
    except KeyboardInterrupt:
        service.stop()
    except Exception as e:
        log("WAKE", f"Fatal error in voice service: {e}")
        service.stop()
        sys.exit(1)


if __name__ == "__main__":
    main()


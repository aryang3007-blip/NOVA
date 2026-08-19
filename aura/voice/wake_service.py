#!/usr/bin/env python3
"""
AURA / NOVA :: Production Voice Service
========================================
Runs continuous local wake-word detection using openWakeWord with
single-microphone audio ownership (pyaudiowpatch).

Dispatches wake events to the AURA server via HTTP POST /api/voice/wake.
Does NOT run Whisper continuously to preserve low-power operation.
"""

import json
import re
import time
import urllib.request
from pathlib import Path

import numpy as np

try:
    import pyaudiowpatch as pyaudio
except Exception as e:  # pragma: no cover
    pyaudio = None
    print(f"[voice_service] pyaudiowpatch unavailable: {e}")

try:
    from openwakeword.model import Model as OpenWakeWordModel
except Exception as e:  # pragma: no cover
    OpenWakeWordModel = None
    print(f"[voice_service] openwakeword unavailable: {e}")

try:
    from faster_whisper import WhisperModel
except Exception as e:  # pragma: no cover
    WhisperModel = None
    print(f"[voice_service] faster_whisper unavailable: {e}")

CONFIG_FILE = Path("wake_phrases.json")
DEFAULT_SERVER_URL = "http://127.0.0.1:8000/api/voice/wake"

INPUT_RATE = 44100
MODEL_RATE = 16000
CHANNELS = 1
CHUNK = 4410
THRESHOLD = 0.50
COOLDOWN_SECONDS = 2.0
CUSTOM_MATCH_THRESHOLD = 0.72
CUSTOM_CAPTURE_SECONDS = 3.0

DEFAULT_CONFIG = {
    "enabled": True,
    "server_url": DEFAULT_SERVER_URL,
    "phrases": [
        {"name": "Hey Jarvis", "model": "hey_jarvis", "enabled": True},
        {"name": "Hey Mycroft", "model": "hey_mycroft", "enabled": True},
        {"name": "Hey Rhasspy", "model": "hey_rhasspy", "enabled": True},
        {"name": "Hey Nova", "phrase": "hey nova", "enabled": True},
        {"name": "Yo Nova", "phrase": "yo nova", "enabled": True},
        {"name": "Nova", "phrase": "nova", "enabled": True},
        {"name": "Okay Nova", "phrase": "okay nova", "enabled": True},
    ],
}


def load_config():
    if not CONFIG_FILE.exists():
        try:
            CONFIG_FILE.write_text(json.dumps(DEFAULT_CONFIG, indent=4), encoding="utf-8")
        except Exception:
            pass
        return DEFAULT_CONFIG

    try:
        data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return DEFAULT_CONFIG
        return data
    except Exception as e:
        print(f"[voice_service] Config load error: {e}. Using defaults.")
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


def resample_to_16k(audio):
    """Resample 44.1 kHz float32/int16 PCM audio array to 16 kHz int16."""
    if len(audio) == 0:
        return np.array([], dtype=np.int16)

    old_length = len(audio)
    new_length = int(old_length * MODEL_RATE / INPUT_RATE)
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
                print(f"[voice_service] Sent wake event '{phrase}' to server successfully.")
            else:
                print(f"[voice_service] Server returned status {resp.status}")
    except Exception as e:
        print(f"[voice_service] Could not notify server at {server_url}: {e}")


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
    config = load_config()
    if not config.get("enabled", True):
        print("[voice_service] Voice service is disabled in config.")
        return

    server_url = config.get("server_url", DEFAULT_SERVER_URL)
    built_in_phrases, custom_phrases = split_phrases(config)
    if not built_in_phrases and not custom_phrases:
        print("[voice_service] No wake phrases enabled.")
        return

    models = [phrase["model"] for phrase in built_in_phrases if phrase.get("model")]

    print("=" * 70)
    print("           AURA / NOVA :: PRODUCTION VOICE SERVICE")
    print("=" * 70)
    print(f"Target Server URL : {server_url}")
    print(f"Built-in phrases  : {', '.join(phrase.get('name', phrase.get('model')) for phrase in built_in_phrases) if built_in_phrases else 'none'}")
    print(f"Custom phrases    : {', '.join(phrase.get('name', phrase.get('phrase')) for phrase in custom_phrases) if custom_phrases else 'none'}")
    print(f"Input rate        : {INPUT_RATE} Hz")
    print(f"Threshold         : {THRESHOLD}")

    oww_model = None
    if models:
        print("[voice_service] Initialising openWakeWord model...")
        try:
            if OpenWakeWordModel is None:
                raise RuntimeError("openwakeword is unavailable")
            oww_model = OpenWakeWordModel(wakeword_models=models)
            print("[voice_service] openWakeWord model loaded.")
        except Exception as e:
            print(f"[voice_service] openWakeWord model unavailable: {e}")
            oww_model = None

    whisper_model = None
    if custom_phrases:
        print("[voice_service] Initialising Whisper custom phrase detection...")
        try:
            if WhisperModel is None:
                raise RuntimeError("faster_whisper is unavailable")
            whisper_model = WhisperModel("tiny", device="cpu", compute_type="int8")
            print("[voice_service] Whisper custom phrase detection ready.")
        except Exception as e:
            print(f"[voice_service] Whisper unavailable for custom phrases: {e}")
            whisper_model = None

    if oww_model is None and whisper_model is None:
        print("[voice_service] No wake detection backends are available. Exiting.")
        return

    if pyaudio is None:
        print("[voice_service] pyaudiowpatch is unavailable, so the microphone cannot be opened.")
        return

    p = pyaudio.PyAudio()
    device_index = None
    try:
        default_info = p.get_default_input_device_info()
        device_index = default_info.get("index")
        print(f"[voice_service] Selected mic [{device_index}]: {default_info.get('name')}")
    except Exception as e:
        print(f"[voice_service] Warning selecting default mic: {e}")

    try:
        stream = p.open(
            format=pyaudio.paInt16,
            channels=CHANNELS,
            rate=INPUT_RATE,
            input=True,
            input_device_index=device_index,
            frames_per_buffer=CHUNK,
        )
    except Exception as e:
        print(f"[voice_service] Error opening microphone stream: {e}")
        p.terminate()
        return

    print("[voice_service] Listening for wake words...")
    print("Press Ctrl+C to stop.")
    last_trigger = 0.0
    custom_audio = np.array([], dtype=np.int16)
    custom_active = False
    custom_motion_started = 0.0
    max_custom_samples = int(MODEL_RATE * CUSTOM_CAPTURE_SECONDS)

    try:
        while True:
            raw = stream.read(CHUNK, exception_on_overflow=False)
            audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32)
            audio_16k = resample_to_16k(audio)
            if len(audio_16k) == 0:
                continue

            now = time.time()
            detection_triggered = False

            if oww_model is not None:
                try:
                    predictions = oww_model.predict(audio_16k)
                except Exception as e:
                    predictions = {}
                    print(f"[voice_service] openWakeWord prediction error: {e}")

                highest_score = 0.0
                for phrase in built_in_phrases:
                    model_name = phrase.get("model")
                    if not model_name:
                        continue
                    score = float(predictions.get(model_name, 0.0))
                    if score > highest_score:
                        highest_score = score
                    if score >= THRESHOLD and now - last_trigger >= COOLDOWN_SECONDS:
                        last_trigger = now
                        p_name = phrase.get("name", model_name)
                        print()
                        print("+" + "-" * 66 + "+")
                        print(f"| WAKE DETECTED: {p_name:<49}|")
                        print(f"| Score: {score:.4f}{' ' * 49}|")
                        print("+" + "-" * 66 + "+")
                        send_wake_event(server_url, p_name, score, source="openwakeword")
                        detection_triggered = True
                        break

            if detection_triggered:
                continue

            if whisper_model is not None and custom_phrases:
                energy = float(np.mean(np.abs(audio_16k.astype(np.float32)))) / 32768.0
                if energy > 0.04:
                    custom_audio = np.concatenate((custom_audio, audio_16k)) if custom_audio.size else audio_16k
                    custom_audio = custom_audio[-max_custom_samples:]
                    if not custom_active:
                        custom_active = True
                        custom_motion_started = now
                elif custom_active and now - custom_motion_started >= 0.3:
                    if custom_audio.size > int(0.4 * MODEL_RATE) and now - last_trigger >= COOLDOWN_SECONDS:
                        if transcribe_custom_phrase(whisper_model, custom_phrases, custom_audio, server_url):
                            last_trigger = now
                    custom_audio = np.array([], dtype=np.int16)
                    custom_active = False
                    custom_motion_started = 0.0

    except KeyboardInterrupt:
        print("\n[voice_service] Stopping voice service...")
    finally:
        try:
            stream.stop_stream()
        except Exception:
            pass
        try:
            stream.close()
        except Exception:
            pass
        try:
            p.terminate()
        except Exception:
            pass
        print("[voice_service] Microphone released. Service stopped.")


if __name__ == "__main__":
    main()

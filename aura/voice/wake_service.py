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
import os
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np
import pyaudiowpatch as pyaudio
from openwakeword.model import Model

CONFIG_FILE = Path("wake_phrases.json")
DEFAULT_SERVER_URL = "http://127.0.0.1:8000/api/voice/wake"

# Audio capture defaults
INPUT_RATE = 44100
MODEL_RATE = 16000
CHANNELS = 1
CHUNK = 4410

THRESHOLD = 0.50
COOLDOWN_SECONDS = 2.0

DEFAULT_CONFIG = {
    "enabled": True,
    "server_url": DEFAULT_SERVER_URL,
    "phrases": [
        {
            "name": "Hey Jarvis",
            "model": "hey_jarvis",
            "enabled": True
        },
        {
            "name": "Hey Mycroft",
            "model": "hey_mycroft",
            "enabled": True
        },
        {
            "name": "Hey Rhasspy",
            "model": "hey_rhasspy",
            "enabled": True
        }
    ]
}


def load_config():
    if not CONFIG_FILE.exists():
        try:
            CONFIG_FILE.write_text(
                json.dumps(DEFAULT_CONFIG, indent=4),
                encoding="utf-8"
            )
        except Exception:
            pass
        return DEFAULT_CONFIG

    try:
        data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        return data
    except Exception as e:
        print(f"[voice_service] Config load error: {e}. Using defaults.")
        return DEFAULT_CONFIG


def resample_to_16k(audio):
    """Resample 44.1 kHz float32/int16 PCM audio array to 16 kHz int16."""
    if len(audio) == 0:
        return np.array([], dtype=np.int16)

    old_length = len(audio)
    new_length = int(old_length * MODEL_RATE / INPUT_RATE)

    old_positions = np.linspace(0, 1, old_length, endpoint=False)
    new_positions = np.linspace(0, 1, new_length, endpoint=False)

    converted = np.interp(new_positions, old_positions, audio)
    return np.clip(converted, -32768, 32767).astype(np.int16)


def send_wake_event(server_url, phrase, score, source="openwakeword", transcript=""):
    """Post wake event payload to AURA server endpoint."""
    payload = {
        "type": "wake_detected",
        "phrase": phrase,
        "score": round(score, 4),
        "source": source,
        "transcript": transcript,
        "timestamp": time.time()
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        server_url,
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": "AURA-VoiceService/1.0"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=3.0) as resp:
            if resp.status == 200:
                print(f"[voice_service] Sent wake event '{phrase}' to server successfully.")
            else:
                print(f"[voice_service] Server returned status {resp.status}")
    except Exception as e:
        print(f"[voice_service] Could not notify server at {server_url}: {e}")


def main():
    config = load_config()
    if not config.get("enabled", True):
        print("[voice_service] Voice service is disabled in config.")
        return

    server_url = config.get("server_url", DEFAULT_SERVER_URL)
    enabled_phrases = [
        p for p in config.get("phrases", [])
        if p.get("enabled", True)
    ]

    if not enabled_phrases:
        print("[voice_service] No wake phrases enabled.")
        return

    models = [p["model"] for p in enabled_phrases if p.get("model")]
    if not models:
        print("[voice_service] No openWakeWord models specified in config.")
        return

    print("=" * 70)
    print("           AURA / NOVA :: PRODUCTION VOICE SERVICE")
    print("=" * 70)
    print(f"Target Server URL : {server_url}")
    print(f"Active Models     : {', '.join(models)}")
    print(f"Threshold         : {THRESHOLD}")
    print("Initialising openWakeWord model...")

    try:
        oww_model = Model(wakeword_models=models)
        print("[voice_service] openWakeWord model loaded.")
    except Exception as e:
        print(f"[voice_service] Failed to load openWakeWord model: {e}")
        return

    # Select default input device with pyaudiowpatch
    p = pyaudio.PyAudio()
    device_index = None
    try:
        default_info = p.get_default_input_device_info()
        device_index = default_info.get("index")
        print(f"[voice_service] Selected default mic [{device_index}]: {default_info.get('name')}")
    except Exception as e:
        print(f"[voice_service] Warning selecting default mic: {e}")

    try:
        stream = p.open(
            format=pyaudio.paInt16,
            channels=CHANNELS,
            rate=INPUT_RATE,
            input=True,
            input_device_index=device_index,
            frames_per_buffer=CHUNK
        )
    except Exception as e:
        print(f"[voice_service] Error opening microphone stream: {e}")
        p.terminate()
        return

    print("[voice_service] Listening for wake words continuous stream...")
    print("Press Ctrl+C to stop.")
    last_trigger = 0.0

    try:
        while True:
            raw = stream.read(CHUNK, exception_on_overflow=False)
            audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32)
            audio_16k = resample_to_16k(audio)

            if len(audio_16k) == 0:
                continue

            predictions = oww_model.predict(audio_16k)
            now = time.time()

            detected_phrase = None
            highest_score = 0.0

            for phrase in enabled_phrases:
                m_name = phrase.get("model")
                if not m_name:
                    continue
                score = float(predictions.get(m_name, 0.0))
                if score > highest_score:
                    highest_score = score
                if score >= THRESHOLD and (now - last_trigger >= COOLDOWN_SECONDS):
                    detected_phrase = phrase
                    detected_score = score
                    break

            if detected_phrase:
                last_trigger = now
                p_name = detected_phrase.get("name", detected_phrase.get("model"))
                print()
                print("+" + "-" * 66 + "+")
                print(f"| WAKE DETECTED: {p_name:<49}|")
                print(f"| Score: {detected_score:.4f}{' ' * 49}|")
                print("+" + "-" * 66 + "+")
                send_wake_event(server_url, p_name, detected_score, source="openwakeword")

    except KeyboardInterrupt:
        print("\n[voice_service] Stopping voice service...")
    finally:
        stream.stop_stream()
        stream.close()
        p.terminate()
        print("[voice_service] Microphone released. Service stopped.")


if __name__ == "__main__":
    main()

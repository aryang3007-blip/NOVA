import json
import time
from pathlib import Path

import numpy as np
import pyaudiowpatch as pyaudio
from openwakeword.model import Model


# ============================================================
# NOVA MULTI-PHRASE WAKE ENGINE — STANDALONE TEST
# ============================================================

CONFIG_FILE = Path(__file__).resolve().parent.parent / "voice" / "wake_phrases.json"

# Your working USB microphone
DEVICE_INDEX = 1

INPUT_RATE = 44100
MODEL_RATE = 16000
CHANNELS = 1
CHUNK = 4410

# Detection threshold
THRESHOLD = 0.50

# Prevent one phrase from triggering repeatedly
COOLDOWN_SECONDS = 2.0


# ------------------------------------------------------------
# Config
# ------------------------------------------------------------

DEFAULT_CONFIG = {
    "enabled": True,

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
        CONFIG_FILE.write_text(
            json.dumps(DEFAULT_CONFIG, indent=4),
            encoding="utf-8"
        )
        return DEFAULT_CONFIG

    try:
        return json.loads(
            CONFIG_FILE.read_text(encoding="utf-8")
        )
    except Exception as e:
        print(f"Config error: {e}")
        print("Using default configuration.")
        return DEFAULT_CONFIG


# ------------------------------------------------------------
# Resampling
# ------------------------------------------------------------

def resample_to_16k(audio):
    """
    Simple 44.1 kHz -> 16 kHz resampling.

    Uses interpolation so we don't need another dependency
    just for this test.
    """

    if len(audio) == 0:
        return np.array([], dtype=np.int16)

    old_length = len(audio)

    new_length = int(
        old_length * MODEL_RATE / INPUT_RATE
    )

    old_positions = np.linspace(
        0,
        1,
        old_length,
        endpoint=False
    )

    new_positions = np.linspace(
        0,
        1,
        new_length,
        endpoint=False
    )

    converted = np.interp(
        new_positions,
        old_positions,
        audio
    )

    return np.clip(
        converted,
        -32768,
        32767
    ).astype(np.int16)


# ------------------------------------------------------------
# Main
# ------------------------------------------------------------

def main():

    config = load_config()

    if not config.get("enabled", True):
        print("NOVA wake engine is disabled.")
        return

    enabled_phrases = [
        p for p in config.get("phrases", [])
        if p.get("enabled", True)
    ]

    if not enabled_phrases:
        print("No wake phrases are enabled.")
        return

    models = [
        p["model"]
        for p in enabled_phrases
        if p.get("model")
    ]

    print()
    print("=" * 72)
    print("                    NOVA WAKE ENGINE")
    print("=" * 72)
    print()
    print("Enabled wake phrases:")

    for phrase in enabled_phrases:
        print(
            f"  [ON]  {phrase['name']:<25}"
            f" -> {phrase.get('model', 'custom')}"
        )

    print()
    print(f"Microphone device : {DEVICE_INDEX}")
    print(f"Input rate        : {INPUT_RATE} Hz")
    print(f"Model rate        : {MODEL_RATE} Hz")
    print(f"Threshold          : {THRESHOLD}")
    print()
    print("Listening...")
    print("Press Ctrl+C to stop.")
    print()

    # --------------------------------------------------------
    # Load ALL enabled openWakeWord models
    # --------------------------------------------------------

    model = Model(
        wakeword_models=models
    )

    # --------------------------------------------------------
    # Audio
    # --------------------------------------------------------

    p = pyaudio.PyAudio()

    stream = p.open(
        format=pyaudio.paInt16,
        channels=CHANNELS,
        rate=INPUT_RATE,
        input=True,
        input_device_index=DEVICE_INDEX,
        frames_per_buffer=CHUNK
    )

    last_trigger = 0.0

    try:

        while True:

            raw = stream.read(
                CHUNK,
                exception_on_overflow=False
            )

            audio = np.frombuffer(
                raw,
                dtype=np.int16
            ).astype(np.float32)

            audio_16k = resample_to_16k(audio)

            if len(audio_16k) == 0:
                continue

            predictions = model.predict(audio_16k)

            now = time.time()

            # ------------------------------------------------
            # Check every enabled phrase
            # ------------------------------------------------

            detected = None
            highest_score = 0.0

            for phrase in enabled_phrases:

                model_name = phrase.get("model")

                if not model_name:
                    continue

                score = float(
                    predictions.get(
                        model_name,
                        0.0
                    )
                )

                if score > highest_score:
                    highest_score = score

                if (
                    score >= THRESHOLD
                    and now - last_trigger >= COOLDOWN_SECONDS
                ):
                    detected = phrase
                    detected_score = score
                    break

            # ------------------------------------------------
            # Wake event
            # ------------------------------------------------

            if detected:

                last_trigger = now

                print()
                print()
                print("+" + "-" * 68 + "+")
                print(
                    f"|  WAKE DETECTED: "
                    f"{detected['name']:<43}|"
                )
                print(
                    f"|  Score: {detected_score:.4f}"
                    f"{' ' * 51}|"
                )
                print("+" + "-" * 68 + "+")
                print()

            else:

                # Lightweight status line
                print(
                    f"\rHighest score: "
                    f"{highest_score:.5f}",
                    end="",
                    flush=True
                )

    except KeyboardInterrupt:

        print()
        print()
        print("Stopping NOVA wake engine...")

    finally:

        stream.stop_stream()
        stream.close()
        p.terminate()

        print("Wake engine stopped.")


if __name__ == "__main__":
    main()
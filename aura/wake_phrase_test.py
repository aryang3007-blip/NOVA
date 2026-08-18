import json
import re
import time
import wave
import tempfile
import os
from pathlib import Path

import numpy as np
import sounddevice as sd
from faster_whisper import WhisperModel


# ============================================================
# NOVA — CUSTOM WAKE PHRASE TEST
# ============================================================

CONFIG_FILE = Path("wake_phrases.json")

SAMPLE_RATE = 16000
CHANNELS = 1

# Record a short window after speech activity is detected.
RECORD_SECONDS = 3

# Fuzzy matching threshold.
MATCH_THRESHOLD = 0.72


# ============================================================
# Configuration
# ============================================================

DEFAULT_CONFIG = {
    "enabled": True,
    "phrases": [
        {
            "name": "Hey Nova",
            "phrase": "hey nova",
            "enabled": True
        },
        {
            "name": "Yo Nova",
            "phrase": "yo nova",
            "enabled": True
        },
        {
            "name": "Nova",
            "phrase": "nova",
            "enabled": True
        },
        {
            "name": "Okay Nova",
            "phrase": "okay nova",
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
            CONFIG_FILE.read_text(
                encoding="utf-8"
            )
        )

    except Exception as e:

        print(f"Config error: {e}")
        return DEFAULT_CONFIG


# ============================================================
# Text normalization
# ============================================================

def normalize(text):

    text = text.lower()

    # Remove punctuation.
    text = re.sub(
        r"[^a-z0-9\s]",
        " ",
        text
    )

    # Collapse whitespace.
    text = re.sub(
        r"\s+",
        " ",
        text
    )

    return text.strip()


# ============================================================
# Fuzzy matching
# ============================================================

def similarity(a, b):

    a = normalize(a)
    b = normalize(b)

    if not a or not b:
        return 0.0

    if a == b:
        return 1.0

    # Exact phrase contained inside transcript.
    if a in b:
        return 0.95

    # Word-based overlap.
    a_words = set(a.split())
    b_words = set(b.split())

    if not a_words:
        return 0.0

    overlap = len(
        a_words.intersection(b_words)
    )

    return overlap / len(a_words)


def find_wake_phrase(transcript, phrases):

    best_phrase = None
    best_score = 0.0

    for item in phrases:

        if not item.get("enabled", True):
            continue

        phrase = item.get("phrase", "")

        score = similarity(
            phrase,
            transcript
        )

        if score > best_score:

            best_score = score
            best_phrase = item

    if best_phrase and best_score >= MATCH_THRESHOLD:

        return best_phrase, best_score

    return None, best_score


# ============================================================
# Whisper
# ============================================================

print()
print("=" * 68)
print("                 NOVA CUSTOM WAKE TEST")
print("=" * 68)
print()

print("Loading Whisper tiny...")

model = WhisperModel(
    "tiny",
    device="cpu",
    compute_type="int8"
)

print("Whisper loaded.")
print()

config = load_config()

phrases = [
    p for p in config.get("phrases", [])
    if p.get("enabled", True)
]

print("Configured wake phrases:")

for p in phrases:

    print(
        f"  [ON] {p.get('name', p.get('phrase'))}"
    )

print()
print("Speak a configured wake phrase.")
print("Examples:")
print("  Hey Nova")
print("  Yo Nova")
print("  Okay Nova")
print()
print("Press Ctrl+C to stop.")
print()


# ============================================================
# Recording loop
# ============================================================

try:

    while True:

        input(
            "Press ENTER, then speak..."
        )

        print()
        print(
            f"Recording for {RECORD_SECONDS} seconds..."
        )

        audio = sd.rec(
            int(
                SAMPLE_RATE *
                RECORD_SECONDS
            ),
            samplerate=SAMPLE_RATE,
            channels=CHANNELS,
            dtype="int16"
        )

        sd.wait()

        # ----------------------------------------------------
        # Save temporary WAV
        # ----------------------------------------------------

        with tempfile.NamedTemporaryFile(
            suffix=".wav",
            delete=False
        ) as temp:

            filename = temp.name

        with wave.open(
            filename,
            "wb"
        ) as wav:

            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(SAMPLE_RATE)
            wav.writeframes(
                audio.tobytes()
            )

        # ----------------------------------------------------
        # Whisper
        # ----------------------------------------------------

        print("Transcribing...")

        segments, info = model.transcribe(
            filename,
            language="en",
            beam_size=1,
            vad_filter=True
        )

        transcript = " ".join(
            segment.text.strip()
            for segment in segments
        )

        transcript = normalize(
            transcript
        )

        print()
        print(
            f"Transcript: {transcript}"
        )

        # ----------------------------------------------------
        # Match
        # ----------------------------------------------------

        phrase, score = find_wake_phrase(
            transcript,
            phrases
        )

        if phrase:

            print()
            print(
                "+" + "-" * 64 + "+"
            )

            print(
                f"| WAKE DETECTED: "
                f"{phrase.get('name', phrase.get('phrase')):<43}|"
            )

            print(
                f"| Match score: {score:.2f}"
                f"{' ' * 49}|"
            )

            print(
                f"| Transcript: "
                f"{transcript[:47]:<47}|"
            )

            print(
                "+" + "-" * 64 + "+"
            )

        else:

            print()
            print(
                f"No wake phrase "
                f"(best score: {score:.2f})"
            )

        print()

        try:
            os.unlink(filename)
        except Exception:
            pass


except KeyboardInterrupt:

    print()
    print("Stopping custom wake test.")
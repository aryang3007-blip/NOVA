from faster_whisper import WhisperModel
import sounddevice as sd
import numpy as np
import wave
import tempfile
import os

MODEL_SIZE = "tiny"
SAMPLE_RATE = 16000
SECONDS = 5

print("Loading Whisper tiny...")
model = WhisperModel(
    MODEL_SIZE,
    device="cpu",
    compute_type="int8"
)

print("Recording for 5 seconds...")
print("Say something like:")
print('  "Hey Nova, are you there?"')
print()

audio = sd.rec(
    int(SAMPLE_RATE * SECONDS),
    samplerate=SAMPLE_RATE,
    channels=1,
    dtype="int16"
)

sd.wait()

with tempfile.NamedTemporaryFile(
    suffix=".wav",
    delete=False
) as f:

    filename = f.name

    with wave.open(filename, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(audio.tobytes())

print("Transcribing...")

segments, info = model.transcribe(
    filename,
    language="en",
    beam_size=1,
    vad_filter=True
)

text = " ".join(
    segment.text.strip()
    for segment in segments
)

print()
print("=" * 60)
print("TRANSCRIPTION:")
print(text)
print("=" * 60)

os.unlink(filename)
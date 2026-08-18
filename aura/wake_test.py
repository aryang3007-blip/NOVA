import time
import numpy as np
import pyaudiowpatch as pyaudio
from scipy.signal import resample_poly
from openwakeword.model import Model

DEVICE_INDEX = 1

INPUT_RATE = 44100
OUTPUT_RATE = 16000

CHANNELS = 1
INPUT_CHUNK = 4410

print("Loading openWakeWord...")

model = Model(
    wakeword_models=["hey_jarvis"]
)

print("Loaded.")
print("Speak normally, then say: Hey Jarvis")
print("Printing detector scores...\n")

p = pyaudio.PyAudio()

stream = p.open(
    format=pyaudio.paInt16,
    channels=CHANNELS,
    rate=INPUT_RATE,
    input=True,
    input_device_index=DEVICE_INDEX,
    frames_per_buffer=INPUT_CHUNK,
)

last_print = 0

try:
    while True:
        data = stream.read(
            INPUT_CHUNK,
            exception_on_overflow=False
        )

        audio = np.frombuffer(
            data,
            dtype=np.int16
        ).astype(np.float32)

        # 44.1 kHz -> 16 kHz
        audio_16k = resample_poly(
            audio,
            OUTPUT_RATE,
            INPUT_RATE
        )

        audio_16k = np.clip(
            audio_16k,
            -32768,
            32767
        ).astype(np.int16)

        prediction = model.predict(audio_16k)

        score = float(
            prediction.get("hey_jarvis", 0)
        )

        now = time.time()

        if now - last_print >= 0.25:
            print(
                f"\rhey_jarvis score: {score:.5f}",
                end="",
                flush=True
            )
            last_print = now

except KeyboardInterrupt:
    print("\nStopping...")

finally:
    stream.stop_stream()
    stream.close()
    p.terminate()
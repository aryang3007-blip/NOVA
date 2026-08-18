import pyaudiowpatch as pyaudio
import math
import struct
import time

p = pyaudio.PyAudio()

DEVICE_INDEX = 5
RATE = 16000
CHANNELS = 1
CHUNK = 1280

info = p.get_device_info_by_index(DEVICE_INDEX)

print("Using:", info["name"])
print("Hardware rate:", info["defaultSampleRate"])
print("Starting microphone test...")
print("Speak into the microphone for 5 seconds.\n")

stream = p.open(
    format=pyaudio.paInt16,
    channels=CHANNELS,
    rate=RATE,
    input=True,
    input_device_index=DEVICE_INDEX,
    frames_per_buffer=CHUNK,
)

try:
    start = time.time()

    while time.time() - start < 5:
        data = stream.read(CHUNK, exception_on_overflow=False)

        samples = struct.unpack("<" + "h" * (len(data) // 2), data)

        rms = math.sqrt(
            sum(sample * sample for sample in samples) / len(samples)
        )

        print(f"\rAudio level: {rms:8.1f}", end="", flush=True)

finally:
    stream.stop_stream()
    stream.close()
    p.terminate()

print("\n\nMicrophone test finished.")
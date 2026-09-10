#!/usr/bin/env python3
"""
NOVA :: wake-service tests (no microphone, no models needed)
=============================================================
Drives voice/wake_service.py with synthetic PCM and injected fakes:

  python3 tests/test-wake-service.py   (from aura/)

Covers: phrase matching, exact-model gating, VAD gating, candidate ->
confirm flow, cooldown, speaking suppression, mic reconnect, heartbeat.
"""
import sys

sys.path.insert(0, ".")

import numpy as np

from voice.wake_service import (
    CHUNK,
    EnergyVAD,
    MicError,
    ReconnectingMic,
    VoiceServiceLifecycle as ST,
    WakeWordService,
    match_phrase,
    model_matches_phrase,
    normalize_text,
    phrase_confidence,
)

P = F = 0


def chk(name, cond, detail=""):
    global P, F
    if cond:
        P += 1
        print(f"  \x1b[32m✓\x1b[0m {name}")
    else:
        F += 1
        print(f"  \x1b[31m✗\x1b[0m {name}  \x1b[90m{detail}\x1b[0m")


def sec(t):
    print(f"\n\x1b[36m▸ {t}\x1b[0m")


# ── fakes ────────────────────────────────────────────────────────────────

def pcm16(value, n=CHUNK):
    return (np.full(n, int(value), dtype=np.int16)).tobytes()


SILENCE = pcm16(0)
LOUD = pcm16(3000)


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def time(self):
        return self.t

    def sleep(self, s):
        self.t += s


class FakeOWW:
    def __init__(self, scores_fn):
        self.scores_fn = scores_fn
        self.calls = 0

    def predict(self, audio):
        self.calls += 1
        return dict(self.scores_fn(self.calls))


class FakeWhisper:
    def __init__(self, texts):
        self.texts = list(texts)
        self.calls = 0
        self.input_lens = []

    def transcribe(self, audio):
        self.calls += 1
        self.input_lens.append(len(audio))
        return self.texts.pop(0) if self.texts else ""


class FakePyAudioMod:
    """Minimal pyaudio stand-in for ReconnectingMic tests."""

    paInt16 = 8

    def __init__(self, rates_ok=(44100,), reads=None, devices=None):
        self.rates_ok = set(rates_ok)
        self.reads = list(reads or [])
        self.devices = devices if devices is not None else [
            {"name": "Built-in Mic", "maxInputChannels": 2, "defaultSampleRate": 44100},
        ]
        self.opened_rates = []

    def PyAudio(self):  # noqa: N802 (matches pyaudio API)
        outer = self

        class _PA:
            def get_device_count(self):
                return len(outer.devices)

            def get_device_info_by_index(self, i):
                d = dict(outer.devices[i])
                d["index"] = i
                return d

            def get_default_input_device_info(self):
                d = dict(outer.devices[0])
                d["index"] = 0
                return d

            def open(self, format=None, channels=None, rate=None, input=None,
                     input_device_index=None, frames_per_buffer=None):
                outer.opened_rates.append(rate)
                if rate not in outer.rates_ok:
                    raise OSError(f"rate {rate} not supported")

                class _Stream:
                    def read(self, _n, exception_on_overflow=False):
                        if not outer.reads:
                            return SILENCE
                        item = outer.reads.pop(0)
                        if isinstance(item, Exception):
                            raise item
                        return item

                    def stop_stream(self):
                        pass

                    def close(self):
                        pass

                return _Stream()

            def terminate(self):
                pass

        return _PA()


def make_service(oww_scores=None, whisper_texts=None, engine="hybrid",
                 speaking=False, phrases=None, clock=None, **cfg):
    clock = clock or FakeClock()
    events, statuses = [], []
    svc = WakeWordService(
        config={
            "server_url": "http://127.0.0.1:9/api/voice/wake",
            "engine": engine,
            "threshold": 0.55,
            "confirm_threshold": 0.6,
            "cooldown_ms": 1500,
            "vad_rms": 220.0,
            "vad_hangover_ms": 350,
            "heartbeat_sec": 3600,
            "speaking_poll_sec": 0,
            "preroll_sec": 0.5,
            "phrases": phrases if phrases is not None else [
                {"name": "Hey Nova", "phrase": "hey nova", "model": "hey_jarvis"},
                {"name": "Hey Jarvis", "phrase": "hey jarvis", "model": "hey_jarvis"},
                {"name": "Nova", "phrase": "nova", "model": None},
            ],
            **cfg,
        },
        oww=FakeOWW(oww_scores or (lambda _c: {})),
        whisper=FakeWhisper(whisper_texts if whisper_texts is not None else []),
        vad=EnergyVAD(threshold_rms=220.0, hangover_ms=350, chunk_ms=100.0),
        post_event=lambda _u, p: events.append(p) or True,
        post_status=lambda _u, p: statuses.append(p) or True,
        fetch_status=lambda _u: {"speaking": speaking},
        time_fn=clock.time,
        sleep_fn=clock.sleep,
    )
    svc.active_phrases = [p for p in svc.config["phrases"] if p.get("enabled", True)]
    svc.state = ST.WAKE_LISTENING
    svc.actual_rate = 44100
    return svc, events, statuses, clock


# ── 1. text matching ─────────────────────────────────────────────────────

sec("phrase matching")
chk("normalize strips punctuation/case", normalize_text("  Hey, NOVA! ") == "hey nova")
chk("exact substring scores 1.0",
    phrase_confidence("hey nova open chrome", "hey nova") == 1.0)
chk("single token needs the token", phrase_confidence("play some jazz", "nova") == 0.0)
chk("single token present scores 1.0", phrase_confidence("ok nova go", "nova") == 1.0)
chk("near-miss stays below confirm threshold",
    phrase_confidence("hey no one is here", "hey nova") < 0.6,
    str(phrase_confidence("hey no one is here", "hey nova")))
chk("hey_jarvis IS hey jarvis", model_matches_phrase("hey_jarvis", "hey jarvis") is True)
chk("hey_jarvis is NOT hey nova", model_matches_phrase("hey_jarvis", "hey nova") is False)
chk("no model never exact", model_matches_phrase(None, "nova") is False)
m, c = match_phrase("yo nova what time is it",
                    [{"phrase": "hey nova"}, {"phrase": "yo nova"}])
chk("match picks best phrase", (m or {}).get("phrase") == "yo nova" and c == 1.0)

# ── 2. VAD ───────────────────────────────────────────────────────────────

sec("energy VAD gate")
vad = EnergyVAD(threshold_rms=220.0, hangover_ms=350, chunk_ms=100.0)
chk("silence is not speech", vad.is_speech(SILENCE) is False)
chk("loud chunk is speech", vad.is_speech(LOUD) is True)
chk("hangover holds over one quiet chunk", vad.is_speech(SILENCE) is True)
vad.is_speech(SILENCE)
vad.is_speech(SILENCE)
chk("hangover releases after ~350ms", vad.is_speech(SILENCE) is False)

# ── 3. candidate + confirm ───────────────────────────────────────────────

sec("hybrid candidate -> whisper confirm")
svc, events, _st, _clk = make_service(
    oww_scores=lambda _c: {"hey_jarvis": 0.9},
    whisper_texts=["hey nova open chrome"])
ev = svc.process_chunk(LOUD)
chk("confirmed wake emits", ev is not None and ev["phrase"] == "Hey Nova",
    str(ev and ev["phrase"]))
chk("source is hybrid", ev["source"] == "openwakeword+whisper", ev["source"])
chk("transcript forwarded", ev["transcript"] == "hey nova open chrome")
chk("event posted to server", len(events) == 1 and events[0]["phrase"] == "Hey Nova")
chk("state returns to listening", svc.state == ST.WAKE_LISTENING, svc.state)

sec("honesty: candidate alone never emits a custom phrase")
svc2, events2, _s, _c = make_service(
    oww_scores=lambda _c: {"hey_jarvis": 0.9},
    whisper_texts=["play some jazz"])
chk("unrelated transcript rejected", svc2.process_chunk(LOUD) is None)
chk("rejection counted", svc2._rejections == 1)
chk("nothing posted", len(events2) == 0)

sec("transcript picks the phrase, not the model")
svc3, _e3, _s, _c = make_service(
    oww_scores=lambda _c: {"hey_jarvis": 0.9},
    whisper_texts=["hey jarvis what time is it"])
ev3 = svc3.process_chunk(LOUD)
chk("hey jarvis detected (not nova)", ev3 is not None and ev3["phrase"] == "Hey Jarvis",
    str(ev3 and ev3["phrase"]))

# ── 4. exact fast path without whisper ───────────────────────────────────

sec("no-whisper: exact pairs live, customs disabled")
svc4 = WakeWordService(
    config={"engine": "hybrid", "threshold": 0.55, "confirm_threshold": 0.6,
            "cooldown_ms": 1500, "phrases": [
                {"name": "Hey Nova", "phrase": "hey nova", "model": "hey_jarvis"},
                {"name": "Hey Jarvis", "phrase": "hey jarvis", "model": "hey_jarvis"},
            ]},
    oww=FakeOWW(lambda _c: {"hey_jarvis": 0.9}), whisper=None,
    vad=EnergyVAD(threshold_rms=1.0),
    post_event=lambda _u, _p: True, post_status=lambda _u, _p: True,
    fetch_status=lambda _u: {}, time_fn=FakeClock().time)
svc4._activate_phrases(svc4.config["phrases"])
svc4.state = ST.WAKE_LISTENING
svc4.actual_rate = 44100
chk("custom phrase disabled without whisper", svc4.disabled_phrases == ["hey nova"],
    str(svc4.disabled_phrases))
chk("exact phrase stays active", [p["phrase"] for p in svc4.active_phrases] == ["hey jarvis"])
ev4 = svc4.process_chunk(LOUD)
chk("exact pair emits on candidate", ev4 is not None and ev4["source"] == "openwakeword",
    str(ev4 and ev4["source"]))

# ── 5. cooldown / VAD gate / speaking ────────────────────────────────────

sec("cooldown, VAD gate, speaking suppression")
clk5 = FakeClock()
svc5, events5, _s, _c = make_service(
    oww_scores=lambda _c: {"hey_jarvis": 0.9},
    whisper_texts=["hey nova", "hey nova", "hey nova"], clock=clk5)
chk("first candidate emits", svc5.process_chunk(LOUD) is not None)
clk5.sleep(0.5)
chk("second within 1.5s suppressed", svc5.process_chunk(LOUD) is None)
clk5.sleep(2.0)
chk("emits again after cooldown", svc5.process_chunk(LOUD) is not None)
chk("two events posted", len(events5) == 2, str(len(events5)))

oww6 = FakeOWW(lambda _c: {"hey_jarvis": 0.99})
svc6, _e6, _s, _c = make_service(oww_scores=lambda _c: {"hey_jarvis": 0.99})
svc6.oww = oww6
svc6.process_chunk(SILENCE)
svc6.process_chunk(SILENCE)
chk("silence never reaches the model", oww6.calls == 0, f"{oww6.calls} calls")

svc7, events7, _s, _c = make_service(
    oww_scores=lambda _c: {"hey_jarvis": 0.9},
    whisper_texts=["hey nova"], speaking=True)
chk("candidate suppressed while speaking", svc7.process_chunk(LOUD) is None)
chk("no whisper call while speaking", svc7.whisper.calls == 0)
chk("nothing posted while speaking", len(events7) == 0)

# ── 6. whisper-only engine + preroll ─────────────────────────────────────

sec("whisper-only engine and preroll ring")
svc8, _e8, _s, _c = make_service(whisper_texts=["okay nova"], engine="whisper")
svc8.oww = None
ev8 = svc8.process_chunk(LOUD)
chk("custom phrase via transcript only", ev8 is not None and ev8["phrase"] == "Nova",
    str(ev8 and (ev8["phrase"], ev8["source"])))
chk("source is whisper", ev8["source"] == "whisper")

svc9, _e9, _s, _c = make_service(
    oww_scores=lambda c: {"hey_jarvis": 0.9} if c >= 3 else {},
    whisper_texts=["hey nova"], engine="openwakeword")
svc9.process_chunk(LOUD)
svc9.process_chunk(LOUD)
svc9.process_chunk(LOUD)
one_chunk_16k = int(CHUNK * 16000 / 44100)
chk("confirmation hears pre-roll, not one chunk",
    svc9.whisper.input_lens and svc9.whisper.input_lens[0] > one_chunk_16k,
    str(svc9.whisper.input_lens[:1]))

# ── 7. mic reconnect ─────────────────────────────────────────────────────

sec("reconnecting mic")
mic = ReconnectingMic(pyaudio_module=FakePyAudioMod(rates_ok=(48000,)))
mic.open()
chk("falls back to a working rate", mic.actual_rate == 48000, str(mic.actual_rate))
chk("default device resolved", mic.device_index == 0 and "Built-in" in mic.mic_name)
mic.close()

flaky = FakePyAudioMod(reads=[Exception("unplugged")] * 10)
mic2 = ReconnectingMic(pyaudio_module=flaky, max_read_errors=3)
mic2.open()
chk("transient read error yields empty (no crash)", mic2.read() == b"")
mic2.read()
try:
    mic2.read()
    chk("persistent failure raises MicError", False, "no raise")
except MicError as e:
    chk("persistent failure raises MicError", "3x" in str(e), str(e)[:60])
mic2.close()

import voice.wake_service as _wsmod
_orig_pa = _wsmod._pyaudio_module
_wsmod._pyaudio_module = lambda: None
try:
    ReconnectingMic().open()
    chk("missing pyaudio raises MicError", False, "no raise")
except MicError:
    chk("missing pyaudio raises MicError", True)
except Exception as e:
    chk("missing pyaudio raises MicError", False, f"wrong exc: {e}")
finally:
    _wsmod._pyaudio_module = _orig_pa

# ── 8. telemetry ─────────────────────────────────────────────────────────

sec("telemetry")
svc10, _e10, statuses10, _c = make_service(oww_scores=lambda _c: {})
svc10._heartbeat(force=True)
hb = statuses10[-1]
for key in ("status", "engine", "device", "phrases", "threshold",
            "confirm_threshold", "chunks", "emitted", "updated_at", "version"):
    chk(f"heartbeat carries {key}", key in hb)
chk("heartbeat names oww+whisper fakes", hb["engine"] == "hybrid+whisper+oww", hb["engine"])

print(f"\n  PASS {P}  FAIL {F}\n")
sys.exit(1 if F else 0)

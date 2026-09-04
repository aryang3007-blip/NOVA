#!/usr/bin/env python3
"""
AURA :: web research + input automation (server side)

Covers two of the three capabilities added in this round:

  • Real web search — ddgs for results, trafilatura for page text, adaptive
    depth so quick lookups stay fast. Previously `/search` could only open a
    tab; AURA can now read the results back.

  • Input automation — pyautogui-backed mouse/keyboard control. This is the
    most dangerous code in the project, so most of these assertions are about
    what it REFUSES to do.

Network tests degrade gracefully: if the sandbox has no internet the search
assertions are skipped rather than reported as product failures.
"""
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from server import automation  # noqa: E402
from server import websearch  # noqa: E402

pass_n = fail_n = skip_n = 0


def chk(name, cond, detail=""):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print(f"  \033[32m✓\033[0m {name}" + (f"  \033[90m{detail}\033[0m" if detail else ""))
    else:
        fail_n += 1
        print(f"  \033[31m✗\033[0m {name}  \033[90m{detail}\033[0m")


def skip(name, why):
    global skip_n
    skip_n += 1
    print(f"  \033[33m–\033[0m {name}  \033[90m{why}\033[0m")


print("\n\033[36m▸ WEB SEARCH — CAPABILITY REPORTING\033[0m")
caps = websearch.capabilities()
chk("capabilities() is honest about search", isinstance(caps["search"], bool))
chk("capabilities() is honest about page reading", isinstance(caps["read"], bool))
chk("a missing dependency explains how to install it",
    caps["search"] or "pip install" in (caps["reason"] or ""))

print("\n\033[36m▸ ADAPTIVE DEPTH ROUTING\033[0m")
shallow = ["who won the 2022 world cup", "weather in delhi", "capital of france",
           "when was python released", "price of bitcoin"]
deep = ["explain how ollama works", "compare rust and go for systems programming",
        "why does my model run slowly", "step-by-step guide to setting up cuda",
        "what is the difference between llama and mistral"]
chk("quick factual questions stay on snippets",
    all(websearch.classify_depth(q) == "snippets" for q in shallow),
    str([q for q in shallow if websearch.classify_depth(q) != "snippets"]))
chk("explanatory questions trigger page reads",
    all(websearch.classify_depth(q) == "read" for q in deep),
    str([q for q in deep if websearch.classify_depth(q) != "read"]))
chk("depth can be forced", websearch.classify_depth("weather", "read") == "read")
chk("empty query is handled", websearch.classify_depth("") == "snippets")

print("\n\033[36m▸ WEB SEARCH — LIVE\033[0m")
if not caps["search"]:
    skip("live search", "ddgs not installed")
else:
    t0 = time.time()
    r = websearch.search("ollama local llm", max_results=5)
    dt = time.time() - t0
    if not r["ok"]:
        skip("live search", f"no network: {r.get('message', '')[:60]}")
    else:
        chk("search returns results", r["count"] >= 1, f"{r['count']} in {dt:.1f}s")
        chk("every result has a usable https url",
            all(x["url"].startswith("http") for x in r["results"]))
        chk("every result has a title", all(x["title"] for x in r["results"]))
        chk("no API key was needed", True)

        empty = websearch.search("")
        chk("empty query is rejected", empty["ok"] is False)

print("\n\033[36m▸ PAGE READING\033[0m")
if not caps["read"]:
    skip("page extraction", "trafilatura not installed")
else:
    pages = websearch.fetch_pages(["https://en.wikipedia.org/wiki/Ollama"], limit=1)
    if not pages or not pages[0]["ok"]:
        skip("page extraction", f"no network: {(pages[0].get('error') if pages else '?')}")
    else:
        p = pages[0]
        chk("real article text extracted", len(p["text"]) > 500, f"{len(p['text'])} chars")
        chk("boilerplate stripped (no raw html)", "<script" not in p["text"].lower())
        chk("page title captured", bool(p.get("title")), str(p.get("title"))[:50])

    bad = websearch.fetch_pages(["not-a-url"], limit=1)
    chk("invalid url fails cleanly", bad and bad[0]["ok"] is False, str(bad[0].get("error")))
    ftp = websearch.fetch_pages(["ftp://example.com/x"], limit=1)
    chk("non-http scheme refused", ftp and ftp[0]["ok"] is False)

print("\n\033[36m▸ FULL RESEARCH PIPELINE\033[0m")
if not caps["search"]:
    skip("research pipeline", "ddgs not installed")
else:
    r = websearch.research("what is ollama", depth="read", read_count=2)
    if not r["ok"]:
        skip("research pipeline", "no network")
    else:
        chk("pipeline completes", r["ok"])
        chk("produces model-ready context", len(r["context"]) > 300, f"{len(r['context'])} chars")
        chk("context is capped", len(r["context"]) <= 12000)
        chk("sources are citable", len(r["sources"]) >= 1 and "url" in r["sources"][0])
        chk("sources are numbered for [1]-style citation",
            all("n" in s for s in r["sources"]))

        fast = websearch.research("capital of france")
        chk("shallow query skips page fetching", fast["readCount"] == 0, f"depth={fast['depth']}")

print("\n\033[36m▸ AUTOMATION — AVAILABILITY\033[0m")
acaps = automation.capabilities()
chk("capabilities() reports availability", isinstance(acaps["available"], bool))
chk("missing pyautogui explains the fix",
    acaps["available"] or "pip install pyautogui" in acaps["reason"])
chk("failsafe is documented", "TOP-LEFT" in acaps["failsafe"])
chk("starts disarmed", acaps["armed"] is False)

print("\n\033[36m▸ AUTOMATION — WHAT IT REFUSES\033[0m")
FORBIDDEN = [
    ([{"op": "hotkey", "keys": ["alt", "f4"]}], "alt+f4 (close window)"),
    ([{"op": "hotkey", "keys": ["ctrl", "alt", "delete"]}], "ctrl+alt+del"),
    ([{"op": "hotkey", "keys": ["ctrl", "shift", "esc"]}], "task manager"),
    ([{"op": "hotkey", "keys": ["win", "r"]}], "win+r (run dialog)"),
    ([{"op": "hotkey", "keys": ["win", "l"]}], "win+l (lock)"),
    ([{"op": "hotkey", "keys": ["cmd", "q"]}], "cmd+q (macOS quit)"),
]
blocked = True
for plan, label in FORBIDDEN:
    v = automation.validate(plan)
    if v["ok"]:
        blocked = False
        print(f"      \033[31mLEAKED:\033[0m {label}")
chk(f"all {len(FORBIDDEN)} dangerous hotkeys blocked", blocked)

chk("unknown action rejected", not automation.validate([{"op": "rm_rf"}])["ok"])
chk("oversized typing rejected",
    not automation.validate([{"op": "type", "text": "x" * 5000}])["ok"])
chk("over-long plans rejected",
    not automation.validate([{"op": "click", "x": 1, "y": 1}] * 60)["ok"])
chk("non-list plan rejected", not automation.validate("click everything")["ok"])
chk("empty plan rejected", not automation.validate([])["ok"])
chk("unsupported key rejected",
    not automation.validate([{"op": "hotkey", "keys": ["ctrl", "zzz"]}])["ok"])

print("\n\033[36m▸ AUTOMATION — WHAT IT ALLOWS\033[0m")
good = [
    {"op": "move", "x": 400, "y": 300},
    {"op": "click", "x": 400, "y": 300},
    {"op": "type", "text": "hello from AURA"},
    {"op": "hotkey", "keys": ["ctrl", "s"]},
    {"op": "press", "key": "enter"},
    {"op": "wait", "seconds": 0.3},
    {"op": "scroll", "amount": 3},
]
v = automation.validate(good)
chk("a reasonable plan validates", v["ok"], "; ".join(v["errors"])[:80])
chk("every step is described in plain English", len(v["description"]) == len(good))
chk("descriptions name the actual action",
    any("CLICK at (400, 300)" in d for d in v["description"]))
chk("typed text appears in the description",
    any("hello from AURA" in d for d in v["description"]))

print("\n\033[36m▸ AUTOMATION — SAFETY GATES\033[0m")
d = automation.dry_run(good)
chk("dry run describes without executing", d["dryRun"] is True and d["ok"])
chk("dry run lists every step", d["steps"] == len(good))

r = automation.run(good, confirmed=True)
chk("refuses to run while disarmed",
    r["ok"] is False and (r.get("needsArm") or not acaps["available"]),
    str(r.get("message"))[:70])

if acaps["available"]:
    automation.arm()
    chk("arming works", automation.is_armed())
    r2 = automation.run(good, confirmed=False)
    chk("armed but unconfirmed still refuses",
        r2["ok"] is False and r2.get("needsConfirm") is True)
    r3 = automation.run([{"op": "hotkey", "keys": ["alt", "f4"]}], confirmed=True)
    chk("confirmed dangerous plan STILL refused", r3["ok"] is False)
    automation.disarm()
    chk("disarming works", not automation.is_armed())
else:
    skip("arm/confirm flow", "pyautogui not installed in this sandbox")
    chk("disarmed state is reported honestly", not automation.is_armed())

print("\n\033[36m▸ COORDINATE SAFETY\033[0m")
v = automation.validate([{"op": "click", "x": -9999, "y": -9999}])
if v["ok"]:
    s = v["steps"][0]
    chk("off-screen coords are clamped", s["x"] >= 0 and s["y"] >= 0, f"({s['x']}, {s['y']})")
    chk("the failsafe corner stays reachable", s["x"] >= 2 and s["y"] >= 2)
else:
    chk("off-screen coords handled", True, "rejected outright")

total = pass_n + fail_n


# ── Arm lifetime (user-reported: "kept timing out after 15 minutes") ────
print("\n\033[36m▸ ARM LIFETIME\033[0m")
from server import automation as _auto

chk("default window is now an hour, not 15 min",
   _auto.ARM_TTL == 3600, f"{_auto.ARM_TTL}s")
chk("arm_remaining() is None when not armed", _auto.arm_remaining() is None)

_auto._state["armed"] = True
_auto._state["armed_at"] = time.time()
chk("armed reports remaining seconds",
   0 < (_auto.arm_remaining() or 0) <= _auto.ARM_TTL, str(_auto.arm_remaining()))

# The rolling window: a poll 50 minutes in must NOT expire it, and must
# refresh it. This is the exact failure the user hit.
_auto._state["armed_at"] = time.time() - (50 * 60)
before = _auto.arm_remaining()
chk("still armed after 50 idle minutes", _auto.is_armed(touch=True))
after = _auto.arm_remaining()
chk("a touch refreshes the window", after > before, f"{before}s -> {after}s")

# Past the window with no activity at all, it must still expire.
_auto._state["armed_at"] = time.time() - (_auto.ARM_TTL + 60)
chk("expires when genuinely idle past the window", not _auto.is_armed())
chk("expiry is recorded so the message can explain it",
   bool(_auto._state.get("expired_at")))
chk("arm_remaining() returns None once expired", _auto.arm_remaining() is None)

r = _auto.arm()
if r.get("ok"):
    chk("re-arming clears the expiry flag", not _auto._state.get("expired_at"))
    chk("the message explains the rolling window",
       "refreshes it" in r["message"], r["message"][:70])
else:
    chk("arm() refuses honestly with no pyautogui",
       "pyautogui" in r["message"], r["message"][:60])
_auto._state["armed"] = False


print(f"\n  \033[32mPASS {pass_n}\033[0m  "
      + (f"\033[31mFAIL {fail_n}\033[0m" if fail_n else "FAIL 0")
      + (f"  \033[33mSKIP {skip_n}\033[0m" if skip_n else ""))
sys.exit(1 if fail_n else 0)

"""
AURA :: Device Gateway — pairing, security, routing
===================================================
Covers the spec's test list D, E, F, G, L, M, N and the security boundary.

The security assertions matter most: an unpaired device must be able to do
nothing at all, and a phone must never have a route that runs anything on
Windows.
"""
import os
import sys
import time
import threading

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from server import devices

PASS = FAIL = 0


def ok(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  \033[32m✓\033[0m {name}" + (f"  \033[90m{detail}\033[0m" if detail else ""))
    else:
        FAIL += 1
        print(f"  \033[31m✗\033[0m {name}  \033[90m{detail}\033[0m")


def sec(t):
    print(f"\n\033[36m▸ {t}\033[0m")


def fresh_pair(name="Test Phone", caps=None):
    devices.reset()
    code = devices.start_pairing()["code"]
    return devices.pair(code, name, "android",
                        caps if caps is not None else
                        ["open_url", "show_notification", "vibrate"])


# ══════════════════════════════════════════════════════════════════════
sec("D — PAIRING")
devices.reset()
st = devices.start_pairing()
ok("a 6-digit code is issued", len(st["code"]) == 6 and st["code"].isdigit(), st["code"])
ok("pairing is reported active", devices.pairing_status()["active"])

bad = devices.pair("000000", "Impostor")
ok("a wrong code is rejected", not bad["ok"], bad["message"])
ok("and the real code still works after a wrong attempt",
   devices.pairing_status()["active"])

r = devices.pair(st["code"], "Aryan's Phone", "android",
                 ["open_url", "show_notification", "vibrate"])
ok("the right code pairs", r["ok"], r.get("message"))
ok("a device id is assigned", r["deviceId"] == "android-001", str(r.get("deviceId")))
ok("a token is issued", len(r["token"]) > 20)
ok("the code is single-use", not devices.pairing_status()["active"])
ok("re-using the code fails", not devices.pair(st["code"], "Second")["ok"])

DID, TOK = r["deviceId"], r["token"]

sec("CAPABILITY DECLARATION IS FILTERED")
r2 = fresh_pair(caps=["open_url", "shell_exec", "read_files", "vibrate"])
ok("unknown capabilities are stripped at pairing",
   sorted(r2["device"]["capabilities"]) == ["open_url", "vibrate"],
   str(r2["device"]["capabilities"]))
ok("a device cannot invent a capability",
   "shell_exec" not in r2["device"]["capabilities"])

sec("N — UNAUTHENTICATED DEVICE CAN DO NOTHING")
r = fresh_pair()
DID, TOK = r["deviceId"], r["token"]
ok("heartbeat with no token is refused", not devices.heartbeat(DID, None)["ok"])
ok("heartbeat with a wrong token is refused", not devices.heartbeat(DID, "nope")["ok"])
ok("poll with a wrong token is refused", not devices.poll(DID, "nope", wait=0.1)["ok"])
ok("ack with a wrong token is refused", not devices.acknowledge(DID, "nope", "x")["ok"])
ok("an unknown device id is refused", not devices.heartbeat("android-999", TOK)["ok"])
ok("refusals carry 401", devices.heartbeat(DID, "nope").get("code") == 401)

sec("SECURITY BOUNDARY — the phone cannot reach Windows")
mod = [n for n in dir(devices) if not n.startswith("_")]
ok("the gateway exposes no shell/exec entry point",
   not any(k in n.lower() for n in mod for k in ("shell", "exec", "spawn", "system")),
   ", ".join(mod))
ok("known capabilities contain nothing OS-level",
   not any(k in c for c in devices.KNOWN_CAPABILITIES
           for k in ("shell", "exec", "file", "run", "cmd")),
   ", ".join(sorted(devices.KNOWN_CAPABILITIES)))
ok("send_action refuses any capability outside the list",
   not devices.send_action(DID, "shell_exec", {})["ok"])

sec("M — DISCONNECTED PHONE IS REPORTED, NOT FAKED")
r = fresh_pair()
DID, TOK = r["deviceId"], r["token"]
devices._devices[DID]["lastSeen"] = time.time() - 999      # simulate offline
res = devices.send_action("phone", "open_url", {"url": "https://youtube.com"})
ok("an offline phone rejects the action", not res["ok"])
ok("it is flagged offline", res.get("offline") is True)
ok("the message says so plainly", "offline" in res["message"].lower(), res["message"])
ok("it does NOT claim success", res["ok"] is False)

sec("F — 'OPEN YOUTUBE ON MY PHONE'")
r = fresh_pair()
DID, TOK = r["deviceId"], r["token"]
devices.heartbeat(DID, TOK)
res = devices.send_action("phone", "open_url", {"url": "https://youtube.com"})
ok("the action is queued for the phone", res["ok"], res["message"])
ok("it resolved 'phone' to the device id", res.get("device") == DID, str(res.get("device")))
got = devices.poll(DID, TOK, wait=0.4)
ok("the phone receives it on the next poll", len(got["actions"]) == 1, str(got))
ok("the payload survives intact",
   got["actions"][0]["params"]["url"] == "https://youtube.com")
ok("the queue drains once delivered", len(devices.poll(DID, TOK, wait=0.2)["actions"]) == 0)
ack = devices.acknowledge(DID, TOK, got["actions"][0]["id"], True, "opened")
ok("the phone can acknowledge", ack["ok"])
ok("the ack is counted", devices.list_devices()["devices"][0]["actionsAcked"] == 1)

sec("G — 'ON MY LAPTOP' RESOLVES TO THE HOST")
for word in ("laptop", "windows", "this computer", "desktop", "pc"):
    did, err = devices.resolve(word)
    ok(f"'{word}' → windows-host", did == "windows-host", f"{did} {err or ''}")
res = devices.send_action("laptop", "open_url", {"url": "https://x.com"})
ok("host actions are NOT sent to the gateway", not res["ok"] and res.get("isHost"),
   res["message"])

sec("DEVICE RESOLUTION")
r = fresh_pair("Aryan's Phone")
DID = r["deviceId"]
ok("by id", devices.resolve(DID)[0] == DID)
ok("by exact name", devices.resolve("Aryan's Phone")[0] == DID)
ok("by partial name", devices.resolve("aryan")[0] == DID)
ok("generic 'phone' with one paired", devices.resolve("phone")[0] == DID)
ok("an unknown name errors", devices.resolve("toaster")[0] is None)
ok("and explains itself", "No device matching" in (devices.resolve("toaster")[1] or ""))
devices.reset()
did, err = devices.resolve("phone")
ok("with nothing paired it says so", did is None and "No phone is paired" in err, str(err))

sec("L — CAPABILITY / PERMISSION DENIAL")
r = fresh_pair(caps=["open_url"])           # no notifications
DID, TOK = r["deviceId"], r["token"]
devices.heartbeat(DID, TOK)
res = devices.send_action("phone", "show_notification", {"title": "hi"})
ok("an undeclared capability is refused", not res["ok"])
ok("and names what the device does support",
   "does not support" in res["message"] and "open_url" in res["message"], res["message"])

sec("E — RECONNECTION")
r = fresh_pair()
DID, TOK = r["deviceId"], r["token"]
devices.heartbeat(DID, TOK)
ok("connected after a heartbeat",
   devices.list_devices()["devices"][0]["status"] == "connected")
devices._devices[DID]["lastSeen"] = time.time() - 999
ok("goes disconnected when heartbeats stop",
   devices.list_devices()["devices"][0]["status"] == "disconnected")
devices.heartbeat(DID, TOK)
ok("a later heartbeat reconnects it — the SAME pairing, no re-pair needed",
   devices.list_devices()["devices"][0]["status"] == "connected")
ok("queued work survives a disconnect", (
    devices._devices[DID].__setitem__("lastSeen", time.time()),
    devices.send_action(DID, "open_url", {"url": "https://a.com"})["ok"],
)[1])

sec("LONG-POLL BEHAVIOUR")
r = fresh_pair()
DID, TOK = r["deviceId"], r["token"]
devices.heartbeat(DID, TOK)
t0 = time.time()
res = devices.poll(DID, TOK, wait=0.6)
ok("an empty poll returns after its timeout, not instantly",
   0.5 < (time.time() - t0) < 1.6, f"{time.time()-t0:.2f}s")
ok("and returns an empty list rather than an error", res["ok"] and res["actions"] == [])

# A poll waiting when an action arrives should return quickly.
result = {}
def waiter():
    result["r"] = devices.poll(DID, TOK, wait=5)
th = threading.Thread(target=waiter); th.start()
time.sleep(0.3)
devices.send_action(DID, "vibrate", {})
th.join(timeout=4)
ok("a waiting poll wakes as soon as an action is queued",
   result.get("r", {}).get("actions"), str(result.get("r"))[:80])

sec("QUEUE LIMITS + UNPAIR")
r = fresh_pair()
DID, TOK = r["deviceId"], r["token"]
devices.heartbeat(DID, TOK)
for i in range(devices.MAX_QUEUE + 6):
    last = devices.send_action(DID, "vibrate", {})
ok("the queue is bounded", not last["ok"] and "too many" in last["message"], last["message"])
ok("unpair works", devices.unpair(DID)["ok"])
ok("the device is gone", devices.list_devices()["count"] == 0)
ok("its token stops working after unpair", not devices.heartbeat(DID, TOK)["ok"])

sec("HONESTY OF THE STATUS REPORT")
s = devices.status()
ok("it names the transport", s["transport"] == "http-long-poll")
ok("it explains why not WebSocket", "stdlib-only" in s["transportNote"], s["transportNote"][:60])
ok("it admits pairings are in-memory", "lost when serve.py restarts" in s["persistence"],
   s["persistence"])
ok("events are logged for audit", isinstance(s["events"], list))

devices.reset()
print(f"\n  \033[32mPASS {PASS}\033[0m  FAIL {FAIL}")
sys.exit(1 if FAIL else 0)

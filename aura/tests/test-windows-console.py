#!/usr/bin/env python3
"""
AURA :: Windows console encoding regression test
------------------------------------------------
The user's very first Windows run died before the server ever bound a port:

    File "serve.py", line 329, in main
        print("\\n" + "\\u2550" * 62)
    UnicodeEncodeError: 'charmap' codec can't encode characters in position
    2-63: character maps to <undefined>

Windows consoles default to cp1252, which has no box-drawing or arrow glyphs.
Every banner/log line that printed one was a crash waiting to happen.

This test simulates a cp1252 stdout that CANNOT be reconfigured (the worst
case: an old console host) and proves the module still imports and prints.
"""
import io
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

pass_n = fail_n = 0


def chk(name, cond, detail=""):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print(f"  \033[32m✓\033[0m {name}" + (f"  \033[90m{detail}\033[0m" if detail else ""))
    else:
        fail_n += 1
        print(f"  \033[31m✗\033[0m {name}  \033[90m{detail}\033[0m")


print("\n\033[36m▸ SOURCE SAFETY\033[0m")

# No bare print() may carry a non-ASCII literal — that is the crash pattern.
offenders = []
for fname in ("server/serve.py", "server/bridge.py", "server/ollama_proxy.py"):
    with open(os.path.join(ROOT, fname), encoding="utf-8") as fh:
        for i, line in enumerate(fh, 1):
            stripped = line.strip()
            if not stripped.startswith("print("):
                continue
            if any(ord(ch) > 127 for ch in stripped):
                offenders.append(f"{fname}:{i}")
chk("no print() emits non-ASCII directly", not offenders, ", ".join(offenders[:4]))


print("\n\033[36m▸ WORST-CASE cp1252 CONSOLE\033[0m")


class HardCp1252(io.TextIOBase):
    """A stdout that is cp1252 and refuses to be reconfigured."""
    encoding = "cp1252"

    def __init__(self):
        self.buf = []

    def write(self, s):
        s.encode("cp1252", "strict")      # raises exactly like Windows does
        self.buf.append(s)
        return len(s)

    def isatty(self):
        return False


real_stdout = sys.stdout
sys.stdout = HardCp1252()
err = None
try:
    import serve
    unicode_ok = serve.UNICODE_OK
    serve.say("banner " + serve.glyph("\u2550" * 8, "=" * 8))
    serve.say("arrow " + serve.glyph("\u2192", "->"))
    serve.say("tick " + serve.glyph("\u2713", "OK"))
    serve.say(serve.c(32, "coloured"))
    captured = "".join(sys.stdout.buf)
except Exception as e:                     # pragma: no cover - the bug itself
    captured = "".join(getattr(sys.stdout, "buf", []))
    unicode_ok = None
    err = repr(e)
finally:
    sys.stdout = real_stdout

chk("serve.py imports under cp1252", err is None, str(err))
chk("UNICODE_OK correctly detects no-unicode", unicode_ok is False, str(unicode_ok))
chk("banner degrades to ASCII", "========" in captured, captured.replace("\n", " | ")[:70])
chk("arrows degrade to ASCII", "->" in captured)
chk("no ANSI colour on a non-tty", "\033[" not in captured)


print("\n\033[36m▸ SERVER ACTUALLY BOOTS\033[0m")
env = dict(os.environ, PYTHONIOENCODING="cp1252")
proc = subprocess.run(
    [sys.executable, "-c",
     "import sys, io;"
     "sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='cp1252', errors='strict');"
     "sys.path.insert(0, r'%s');"
     "import serve; serve.say('BOOT-OK ' + serve.glyph(chr(0x2550), '='))" % ROOT],
    capture_output=True, text=True, timeout=30, env=env, cwd=ROOT)
chk("subprocess with cp1252 stdout survives",
    proc.returncode == 0, (proc.stderr or "")[-160:])
chk("it printed something", "BOOT-OK" in (proc.stdout or ""), (proc.stdout or "").strip()[:60])

print(f"\n  \033[32mPASS {pass_n}\033[0m  " + (f"\033[31mFAIL {fail_n}\033[0m" if fail_n else "FAIL 0"))
sys.exit(1 if fail_n else 0)

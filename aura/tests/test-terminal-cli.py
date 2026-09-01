#!/usr/bin/env python3
"""
AURA :: terminal CLI tests (Sept-01 batch: /model API picker, SSE streaming,
real-model /doc, /log gate)
==================================================
Pure-logic tests against serve.py helpers — no server socket, no network,
no real API key. Vault access is tested against a CredentialManager pointed
at a temp file.

    python3 tests/test-terminal-cli.py
"""
import io
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import serve  # noqa: E402
from persistence.vault import CredentialManager  # noqa: E402

P = F = 0


def rec(name, cond, detail=""):
    global P, F
    if cond:
        P += 1
        print(f"  \x1b[32m✓\x1b[0m {name}")
    else:
        F += 1
        print(f"  \x1b[31m✗\x1b[0m {name}  \x1b[90m{detail}\x1b[0m")


def S(t):
    print(f"\n\x1b[36m▸ {t}\x1b[0m")


S("SSE DELTA PARSING (all three wire formats)")
rec("openai-compat delta", serve._cli_parse_sse_delta(
    '{"choices":[{"delta":{"content":"Hi"}}]}', "openai") == "Hi")
rec("gemini delta", serve._cli_parse_sse_delta(
    '{"candidates":[{"content":{"parts":[{"text":"Hello"},{"text":"!"}]}}]}',
    "gemini") == "Hello!")
rec("anthropic content_block_delta", serve._cli_parse_sse_delta(
    '{"type":"content_block_delta","delta":{"text":"Yo"}}', "anthropic") == "Yo")
rec("anthropic non-content event is skipped", serve._cli_parse_sse_delta(
    '{"type":"message_start"}', "anthropic") is None)
rec("[DONE] terminates", serve._cli_parse_sse_delta("[DONE]", "openai") is None)
rec("garbage line is skipped, never raises", serve._cli_parse_sse_delta("not json", "openai") is None)

S("NON-STREAM RESPONSE TEXT")
rec("openai-compat body", serve._cli_api_response_text(
    "openai", '{"choices":[{"message":{"content":"full answer"}}]}') == "full answer")
rec("gemini body", serve._cli_api_response_text(
    "gemini", '{"candidates":[{"content":{"parts":[{"text":"a"},{"text":"b"}]}}]}') == "ab")
rec("anthropic body", serve._cli_api_response_text(
    "anthropic", '{"content":[{"type":"text","text":"x"},{"type":"text","text":"y"}]}') == "xy")

S("_cli_sse_lines — chunked SSE reassembly")
class FakeResp:
    def __init__(self, parts):
        self._parts = list(parts)

    def read(self, n=2048):
        return self._parts.pop(0) if self._parts else b""


lines = list(serve._cli_sse_lines(
    FakeResp([b'data: {"a":1}\n\nda', b'ta: {"b":2}\n', b'data: [DONE]\n'])))
rec("SSE lines reassembled across chunks", lines == ['data: {"a":1}', '', 'data: {"b":2}', 'data: [DONE]'],
    str(lines))

S("_cli_extract_json — TRUE CAUSES, NEVER THE BANNED PHRASE")
ban = "no usable json"
o, n = serve._cli_extract_json('```json\n{"a": 1}\n```')
rec("fenced JSON parses", o == {"a": 1} and n == "", f"{o} {n}")
o, n = serve._cli_extract_json('sure! {"slides": [{"title": "T"}]} thanks')
rec("JSON wrapped in prose parses", o == {"slides": [{"title": "T"}]} and n == "", f"{o} {n}")
o, n = serve._cli_extract_json('{"slides": [{"title": "T"')
rec("truncated JSON is called truncated", o is None and "TRUNCATED" in n, n[:70])
rec("truncated names the fix", "num_predict" in n or "output cap" in n, n)
o, n = serve._cli_extract_json("hello there")
rec("prose reply is named prose", o is None and "prose" in n, n[:50])
o, n = serve._cli_extract_json("   ")
rec("empty reply is named empty", o is None and "empty response" in n, n[:40])
o, n = serve._cli_extract_json('{"a": },,,')
rec("malformed JSON is named malformed", o is None and "malformed" in n.lower(), n[:60])
rec("banned phrase never appears", ban not in (str(n) + (" " + str(o) if o else "")).lower())

S("_cli_doc_kind — kind/topic/audience/details/slides")
cases = [
    ("ppt on quantum computing with: history, timeline",
     ("pptx", "quantum computing", 0, "", "history, timeline")),
    ("12 slide ppt on space travel that must include a table",
     ("pptx", "space travel", 12, "", "a table")),
    ("sheet of my monthly budget", ("xlsx", "my monthly budget", 0, "", "")),
    ("report on climate policy", ("docx", "climate policy", 0, "", "")),
    ("ppt on history for class 10", ("pptx", "history", 0, "class 10", "")),
    ("report for class 7", ("docx", "Analysis", 0, "class 7", "")),
]
for arg, want in cases:
    got = serve._cli_doc_kind(arg)
    rec(f"parses: {arg[:38]}…", got == want, str(got))
rec("no garbage topic: on/of/for never leaks", serve._cli_doc_kind("ppt on")[1] == "Analysis")

S("MODEL PICKER MENU — entries + selection")
serve._CLI_VAT = None
ents = serve._cli_menu_entries()
rec("5 API providers first, then Ollama + auto", [e["id"] for e in ents] ==
    ["gemini", "openrouter", "openai", "groq", "anthropic", "ollama", "ollama-auto"])
rec("API rows show key state", all("has_key" in e for e in ents[:5]))
rec("1-based pick works", serve._cli_pick_entry(ents, "3")["id"] == "openai")
rec("pick out of range → None", serve._cli_pick_entry(ents, "99") is None)
rec("pick garbage → None", serve._cli_pick_entry(ents, "abc") is None)

S("_cli_api_request — correct wire payloads")
p, h, u = serve._cli_api_request("gemini", "KEY", [{"role": "system", "content": "be short"}],
                                 "gemini-2.5-flash", True, 4096, 0.5)
rec("gemini streaming URL (alt=sse)", "streamGenerateContent?alt=sse" in u, u[:95])
rec("gemini maxOutputTokens from caller", p["generationConfig"]["maxOutputTokens"] == 4096)
rec("gemini disables thinking (budget 0) — the truncation fix",
    p["generationConfig"].get("thinkingConfig", {}).get("thinkingBudget") == 0,
    str(p["generationConfig"]))
rec("gemini systemInstruction separated", p.get("systemInstruction", {}).get("parts", [{}])[0].get("text") == "be short")
p, h, u = serve._cli_api_request("openai", "sk-x", [{"role": "user", "content": "hi"}],
                                 "gpt-4o-mini", False, 2048, 0.7)
rec("openai-compat bearer header", h.get("Authorization") == "Bearer sk-x")
rec("openai-compat endpoint", u == "https://api.openai.com/v1/chat/completions")
rec("openai max_tokens passthrough", p["max_tokens"] == 2048)
p, h, u = serve._cli_api_request("anthropic", "k", [{"role": "system", "content": "sys"}],
                                 "claude-x", False, 500, 0.7)
rec("anthropic version header", h.get("anthropic-version") == "2023-06-01")
rec("anthropic system field", p.get("system") == "sys")
rec("anthropic stream flag false for completion", p.get("stream") is False)

S("_cli_vault_key — REAL encrypted vault path (temp file)")
with tempfile.TemporaryDirectory() as td:
    tmp_vault = CredentialManager(Path(td) / "vault.json")
    saved = serve.credential_vault
    serve.credential_vault = tmp_vault
    serve._CLI_VAT = None
    try:
        rec("no key yet → empty", serve._cli_vault_key("gemini") == "")
        tmp_vault.set_key("gemini", "AIza-sandbox-test", profile="default")
        serve._CLI_VAT = None
        rec("key round-trips through the vault", serve._cli_vault_key("gemini") == "AIza-sandbox-test")
        tmp_vault.set_key("openai", "sk-sandbox", profile="work")
        serve._CLI_VAT = None
        rec("profile_names exposed", "work" in serve._cli_vault_profiles())
        serve._cli_set_api("gemini", "")
        rec("active backend follows the picker", serve._cli_active_backend()["provider"] == "gemini")
        serve._cli_set_api("", "")
        rec("reset returns to Ollama mode", serve._cli_active_backend()["mode"] == "ollama")
    finally:
        serve.credential_vault = saved
        serve._CLI_VAT = None

S("/log GATE — _CLI_LOGS suppresses server noise, never the reply")
old = serve._CLI_LOGS
try:
    serve._CLI_LOGS = False
    buf = io.StringIO()
    old_out = sys.stdout
    sys.stdout = buf
    try:
        serve._log("HIDDEN ACTION LINE")
    finally:
        sys.stdout = old_out
    rec("log line suppressed while OFF", buf.getvalue() == "", repr(buf.getvalue()))
    serve._CLI_LOGS = True
    buf = io.StringIO()
    sys.stdout = buf
    try:
        serve._log("VISIBLE ACTION LINE")
    finally:
        sys.stdout = old_out
    rec("log line prints while ON", "VISIBLE ACTION LINE" in buf.getvalue())
finally:
    serve._CLI_LOGS = old

S("_cli_doc_spec — validates REAL model output + honest failure")
spec, note = serve._cli_doc_spec(
    "pptx", "Test", 8, "class 10", "timeline",
    complete_fn=lambda m, max_tokens=4096: (
        {"title": "T", "slides": [{"title": "A", "bullets": ["one", "two"]}]}, ""))
rec("valid model outline accepted", spec is not None and spec["slides"][0]["title"] == "A", str(note))
spec, note = serve._cli_doc_spec(
    "pptx", "X", complete_fn=lambda m, max_tokens=4096: ({"title": "T"}, ""))
rec("outline without slides → rejected", spec is None and "no slides" in note, note)
spec, note = serve._cli_doc_spec(
    "docx", "X", complete_fn=lambda m, max_tokens=4096: (None, "The JSON was TRUNCATED mid-stream…"))
rec("truncation cause passes through honestly", spec is None and "TRUNCATED" in note, note)
rec("truncation note says it was retried with a tighter deck",
    "retried with a tighter deck" in note, note)

S("_cli_doc_spec — truncation retry saves the deck, cap raised to 8192")
calls = []
def _flaky(m, max_tokens=4096):
    calls.append(max_tokens)
    if len(calls) == 1:
        return None, "The JSON was TRUNCATED mid-stream — got 5842 chars."
    return {"title": "Fats", "slides": [{"kind": "title", "title": "Fats", "bullets": []},
            {"kind": "bullets", "title": "Key", "bullets": ["one", "two"],
             "notes": "short"}]}, ""
spec, note = serve._cli_doc_spec("pptx", "Fats", 8, complete_fn=_flaky)
rec("first attempt truncated → ONE compact retry succeeds", spec is not None and note == "", str(note))
rec("pptx outline asks for 8192 tokens", calls and max(calls) == 8192, str(calls))
rec("retry ran exactly twice", len(calls) == 2, str(len(calls)))
rec("the rescued deck is real model content",
    spec and spec["slides"][1]["bullets"] == ["one", "two"], "")

calls2 = []
def _always_bad(m, max_tokens=4096):
    calls2.append(1)
    return None, "The JSON was TRUNCATED mid-stream."
spec2, note2 = serve._cli_doc_spec("pptx", "X", complete_fn=_always_bad)
rec("still failing after retry → fallback note names the cause", spec2 is None and "TRUNCATED" in note2, note2)
rec("never retries more than once", len(calls2) == 2, str(len(calls2)))
rec("offline template always returns a real spec",
    bool(serve._cli_offline_spec("pptx", "Q")["slides"]) and
    bool(serve._cli_offline_spec("xlsx", "Q")["sheets"]) and
    bool(serve._cli_offline_spec("docx", "Q")["sections"]))

S("_cli_resolve_path — home-jail, same rule as the action bridge")

def _inside_home(val):
    h = str(Path.home())
    return val is not None and (val == h or val.startswith(h + "/"))


p, e = serve._cli_resolve_path("~/test-file.txt", must_exist=False)
rec("tilde path resolves inside home", p is not None and _inside_home(p), f"{p} {e}")
p, e = serve._cli_resolve_path("/etc/passwd", must_exist=False)
rec("outside-home path refused", p is None and "outside" in (e or ""), e)
# The jail is HOME-ONLY, so the temp dir must live under home.
td = Path.home() / ".aura-cli-test-tmp"
td.mkdir(exist_ok=True)
try:
    f = td / "ok.txt"
    f.write_text("x")
    p, e = serve._cli_resolve_path(str(f), must_exist=True)
    rec("existing file resolved", p == str(f), f"{p} {e}")
    p, e = serve._cli_resolve_path(str(f) + ".missing", must_exist=True)
    rec("missing file with must_exist → refused", p is None and "Not found" in (e or ""), e)
finally:
    f.unlink(missing_ok=True)
    td.rmdir()

S("_cli_complete_json — API path end-to-end with a fake urlopen")
class FakeResp:
    def __init__(self, body):
        self._body = body.encode()

    def read(self, n=4096):
        out, self._body = self._body[:n], self._body[n:]
        return out


class FakeCtx:
    def __init__(self, body):
        self._r = FakeResp(body)

    def __enter__(self):
        return self._r

    def __exit__(self, *a):
        return False


serve._cli_set_api("gemini", "")
serve._CLI_VAT = {"gemini": "fake-key"}
try:
    body = ('{"candidates":[{"content":{"parts":[{"text":'
            '"{\\"title\\":\\"T\\",\\"slides\\":[{\\"title\\":\\"A\\"}]}"}]}}]}')
    obj, note = serve._cli_complete_json(
        [{"role": "user", "content": "hi"}], urlopen_fn=lambda req, timeout=300: FakeCtx(body))
    rec("gemini completion parses JSON", obj == {"title": "T", "slides": [{"title": "A"}]},
        f"{obj} {note}")
finally:
    serve._cli_set_api("", "")
    serve._CLI_VAT = None

print(f"\n{'─'*56}\n  PASS {P}\tFAIL {F}")
sys.exit(1 if F else 0)

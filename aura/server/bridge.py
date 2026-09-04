"""
AURA :: Local Action Bridge
===========================
Lets AURA actually control the machine it is served from: open apps, open
URLs, control media keys, adjust volume, take screenshots.

SECURITY MODEL (read this before enabling)
------------------------------------------
This is genuinely powerful, so it is locked down by default:

  1. DISABLED unless you pass --allow-actions to serve.py.
  2. Server binds to 127.0.0.1 only — never reachable from your network.
  3. Every request needs the X-AURA-Token header. The token is random per
     launch and only served same-origin. Because the header forces a CORS
     preflight and we send no Access-Control-Allow-Origin, a malicious
     website cannot call this API from your browser.
  4. NO arbitrary shell execution. Apps come from a fixed allowlist and are
     invoked with subprocess arg-lists (never shell=True), so nothing the
     model emits can be injected as a command.
  5. Every action is logged to the terminal so you can see what ran.

If any of that is not acceptable for your threat model, simply don't pass
--allow-actions. AURA runs fully without it.
"""

import os
import platform
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import webbrowser

SYSTEM = platform.system()          # 'Windows' | 'Darwin' | 'Linux'

# ── App registry ──────────────────────────────────────────────────────────
# Resolution order per entry:
#   1. `uri`  — deep link, most reliable when the desktop app is installed
#   2. platform-specific binaries / bundle ids
#   3. `web`  — browser fallback so the intent still succeeds
APPS = {
    "whatsapp": {
        "label": "WhatsApp",
        "uri": "whatsapp://",
        "windows": ["whatsapp:", "WhatsApp.exe"],
        "darwin": ["WhatsApp"],
        "linux": ["whatsapp-for-linux", "whatsdesk", "whatsapp"],
        "web": "https://web.whatsapp.com",
    },
    "telegram": {
        "label": "Telegram", "uri": "tg://",
        "windows": ["Telegram.exe"], "darwin": ["Telegram"],
        "linux": ["telegram-desktop", "telegram"],
        "web": "https://web.telegram.org",
    },
    "spotify": {
        "label": "Spotify", "uri": "spotify://",
        "windows": ["Spotify.exe"], "darwin": ["Spotify"],
        "linux": ["spotify"], "web": "https://open.spotify.com",
    },
    "discord": {
        "label": "Discord", "uri": "discord://",
        "windows": ["Discord.exe"], "darwin": ["Discord"],
        "linux": ["discord"], "web": "https://discord.com/app",
    },
    "slack": {
        "label": "Slack", "uri": "slack://",
        "windows": ["slack.exe"], "darwin": ["Slack"],
        "linux": ["slack"], "web": "https://app.slack.com",
    },
    "vscode": {
        "label": "VS Code", "uri": "vscode://",
        "windows": ["Code.exe", "code"], "darwin": ["Visual Studio Code"],
        "linux": ["code", "codium"], "web": "https://vscode.dev",
    },
    "terminal": {
        "label": "Terminal",
        "windows": ["wt.exe", "powershell.exe", "cmd.exe"],
        "darwin": ["Terminal"],
        "linux": ["gnome-terminal", "konsole", "xfce4-terminal", "x-terminal-emulator", "xterm"],
    },
    "browser":    {"label": "Web Browser", "web": "https://duckduckgo.com"},
    "files": {
        "label": "File Manager",
        "windows": ["explorer.exe"], "darwin": ["Finder"],
        "linux": ["nautilus", "dolphin", "thunar", "nemo"],
    },
    "calculator": {
        "label": "Calculator",
        "windows": ["calc.exe"], "darwin": ["Calculator"],
        "linux": ["gnome-calculator", "kcalc", "galculator"],
    },
    "notes": {
        "label": "Notes / Editor",
        "windows": ["notepad.exe"], "darwin": ["Notes"],
        "linux": ["gedit", "kate", "mousepad"],
    },
    "settings": {
        "label": "System Settings",
        "windows": ["ms-settings:"], "darwin": ["System Settings"],
        "linux": ["gnome-control-center", "systemsettings5"],
    },
    "youtube":  {"label": "YouTube",  "web": "https://www.youtube.com"},
    "gmail":    {"label": "Gmail",    "web": "https://mail.google.com"},
    "calendar": {"label": "Calendar", "web": "https://calendar.google.com"},
    "maps":     {"label": "Maps",     "web": "https://maps.google.com"},
    "github":   {"label": "GitHub",   "web": "https://github.com"},
    "chatgpt":  {"label": "ChatGPT",  "web": "https://chat.openai.com"},
}

MEDIA_KEYS = {"playpause", "next", "previous", "stop"}


# ══════════════════════════════════════════════════════════════════════════
#  FILE SYSTEM + TERMINAL SECURITY MODEL
# ══════════════════════════════════════════════════════════════════════════
#
# These two plugins are the dangerous ones. The rules, in order:
#
#  1. PATH JAIL. Every filesystem path is resolved to an absolute real path
#     and must sit inside one of FS_ROOTS (home + a few user folders).
#     Symlinks are resolved BEFORE the check, so a link out of the jail is
#     rejected rather than followed. Windows drive roots, /etc, /System,
#     C:\Windows and friends are never reachable.
#
#  2. COMMAND ALLOWLIST. `run_command` matches the program against
#     SAFE_COMMANDS (read-only, informational). Anything else is refused at
#     this layer and must be explicitly confirmed by the user in the UI,
#     which then sends confirmed=True.
#
#  3. HARD BLOCKS. DESTRUCTIVE_PATTERNS can never run, confirmed or not.
#     This is what stops "reset my C: drive" — there is no code path, no
#     confirmation, and no AI decision that reaches it.
#
#  4. NO SHELL. Everything is argv arrays with shell=False, so quoting and
#     chaining (`&&`, `;`, `|`, backticks) cannot inject a second command.

FS_MAX_READ = 512 * 1024          # 512 KB read cap
FS_MAX_WRITE = 2 * 1024 * 1024    # 2 MB write cap
FS_MAX_ENTRIES = 500              # directory listing cap
CMD_TIMEOUT = 20                  # seconds


def _fs_roots():
    """Folders the file plugin may touch. Everything else is out of bounds."""
    home = os.path.expanduser("~")
    roots = [home]
    for sub in ("Desktop", "Documents", "Downloads", "Pictures", "Music", "Videos"):
        p = os.path.join(home, sub)
        if os.path.isdir(p):
            roots.append(p)
    return [os.path.realpath(r) for r in roots]


FS_ROOTS = _fs_roots()

# Names that must never be read, written or listed even inside the jail.
FS_DENY_NAMES = {
    ".ssh", ".aws", ".gnupg", ".kube", ".docker", "id_rsa", "id_ed25519",
    ".netrc", ".git-credentials", "credentials", ".env", "shadow", "sam",
}


def _resolve_path(target, must_exist=True):
    """
    Resolve a user/AI supplied path inside the jail.
    @returns (abspath, None) or (None, error_message)
    """
    if not target or not isinstance(target, str):
        return None, "No path given."
    raw = target.strip().strip('"').strip("'")
    if not raw:
        return None, "No path given."
    # Expand ~ and env vars, then make absolute against home.
    raw = os.path.expandvars(os.path.expanduser(raw))
    # A drive-letter or UNC path is absolute on Windows. On other systems it
    # would be silently treated as a relative filename and joined onto home,
    # which hides the rejection — catch it explicitly so behaviour matches.
    if re.match(r"^[A-Za-z]:[\\/]", raw) or raw.startswith("\\\\"):
        if SYSTEM != "Windows":
            return None, f"Refused: '{target}' is a Windows path and this machine is {SYSTEM}."
    elif not os.path.isabs(raw):
        raw = os.path.join(os.path.expanduser("~"), raw)
    # realpath resolves symlinks BEFORE we test containment.
    p = os.path.realpath(raw)

    if not any(p == r or p.startswith(r + os.sep) for r in FS_ROOTS):
        return None, (f"Refused: '{target}' is outside the allowed folders. "
                      f"AURA may only touch your home folder and its subfolders.")

    low = {part.lower() for part in p.split(os.sep) if part}
    hit = low & FS_DENY_NAMES
    if hit:
        return None, f"Refused: '{sorted(hit)[0]}' holds credentials and is never accessible."

    if must_exist and not os.path.exists(p):
        return None, f"Not found: {p}"
    return p, None


# Read-only / informational commands that may run after a normal permission
# grant. Deliberately small — this is an allowlist, not a denylist.
SAFE_COMMANDS = {
    "echo", "date", "whoami", "hostname", "pwd", "cd",
    "dir", "ls", "tree", "type", "cat", "head", "tail", "wc", "find", "where", "which",
    "git", "node", "npm", "python", "python3", "pip", "pip3",
    "systeminfo", "ver", "uname", "df", "du", "free", "ipconfig", "ifconfig",
    "ping", "curl", "tasklist", "ps", "code",
}

# Sub-commands that turn an otherwise-safe program destructive.
SAFE_SUBCOMMAND_DENY = {
    "git": {"push", "reset", "clean", "rebase", "filter-branch", "gc", "prune"},
    "npm": {"publish", "unpublish", "install", "uninstall", "update", "audit"},
    "pip": {"install", "uninstall"}, "pip3": {"install", "uninstall"},
}

# Never runnable. Not with confirmation, not by the AI, not by anyone.
DESTRUCTIVE_PATTERNS = [
    r"\brm\b", r"\brmdir\b", r"\bdel\b", r"\berase\b", r"\bformat\b",
    r"\bmkfs\b", r"\bdd\b", r"\bfdisk\b", r"\bdiskpart\b", r"\bcipher\b",
    r"\breg\b", r"\bregedit\b", r"\bbcdedit\b", r"\bvssadmin\b",
    r"\bshutdown\b", r"\breboot\b", r"\bhalt\b", r"\bpoweroff\b",
    r"\bkill\b", r"\btaskkill\b", r"\bchmod\b", r"\bchown\b", r"\bicacls\b",
    r"\btakeown\b", r"\bnet\s+user\b", r"\bsudo\b", r"\brunas\b",
    r"\bcurl\b.*\|\s*(ba)?sh", r"\bwget\b.*\|\s*(ba)?sh",
    # PowerShell cmdlets. NOTE: `\b` does NOT sit between "e" and "-", so
    # r"\bInvoke-Expression\b" failed to match "Invoke-Expression (...)".
    # Anchor on the start of a token instead — caught by the security test.
    r"(?:^|\s)invoke-expression", r"(?:^|\s)iex(?:\s|$)",
    r"(?:^|\s)start-process", r"(?:^|\s)remove-item",
    r"(?:^|\s)set-executionpolicy", r"(?:^|\s)invoke-webrequest",
    r"(?:^|\s)new-object\s+net\.webclient", r"(?:^|\s)downloadstring",
    r"(?:^|\s)add-mppreference", r"(?:^|\s)set-mppreference",
    r"(?:^|\s)stop-computer", r"(?:^|\s)restart-computer",
    r"(?:^|\s)clear-disk", r"(?:^|\s)format-volume",
    r":\(\)\s*\{.*\};:",                       # fork bomb
    r"\bc:\\?\s*$", r"^\s*/\s*$",              # bare drive/root targets
]

# CATASTROPHIC commands: refused under BOTH 'ask' and 'strict'. Only the
# fully-explicit 'open' policy can run them. Rationale: "ask before harmful"
# must never mean "one mis-click (or one convincing agent narration) erases
# the disk / kills the machine / opens the registry". Below this line, no
# confirmation exists that makes the blast radius acceptable.
CATASTROPHIC_PATTERNS = [
    # Disk erasure / repartition / secure-wipe
    r"\bformat\b", r"\bmkfs\b", r"\bdd\b", r"\bfdisk\b", r"\bdiskpart\b",
    r"\bcipher\b", r"\bsdelete\b", r"\bwbadmin\b",
    r"(?:^|\s)clear-disk", r"(?:^|\s)format-volume",
    # Registry / boot / execution policy / restore points
    r"\breg\b", r"\bregedit\b", r"\bbcdedit\b", r"\bvssadmin\b",
    r"(?:^|\s)set-executionpolicy", r"(?:^|\s)disable-computerrestore",
    # Power: losing the machine mid-task is data loss too
    r"\bshutdown\b", r"\breboot\b", r"\bhalt\b", r"\bpoweroff\b",
    r"(?:^|\s)stop-computer", r"(?:^|\s)restart-computer",
    # Account / credential tampering
    r"\bnet\s+user\b", r"\bnet\s+localgroup\b",
    # Weakening the antivirus so something worse can run
    r"(?:^|\s)add-mppreference", r"(?:^|\s)set-mppreference",
    r"(?:^|\s)remove-mppreference",
    r":\(\)\s*\{.*\};:",                 # fork bomb
]

# Shell metacharacters that would allow chaining a second command.
SHELL_META = re.compile(r"[;&|`$><\n\r]|\$\(|&&|\|\|")


# ── policy (set from the app, not hardcoded) ──────────────────────────────
#
# The user asked for this explicitly: rather than a fixed blocklist, AURA
# should ASK before anything harmful. TERMINAL_POLICY controls how strict the
# classifier is and is changed from Settings → Desktop → Terminal Policy.
#
#   'ask'    (default) read-only commands run straight away; anything that
#            could modify the system requires an explicit confirmation that
#            names what it will do. CATASTROPHIC commands (see that list) are
#            the one exception: refused outright, no confirmation possible.
#   'strict' the original behaviour — destructive verbs are refused outright
#            and cannot be confirmed. Choose this if AURA is unattended.
#   'open'   everything runs with no confirmation. You are on your own; the
#            UI makes you type CONFIRM before this can be selected.
#
# Whatever the policy, commands are still argv arrays with shell=False, and
# shell metacharacters are still rejected — that is injection protection, not
# a policy choice, so it is never disabled.
TERMINAL_POLICY = "ask"
VALID_POLICIES = ("ask", "strict", "open")


def set_policy(name):
    """Change the terminal policy. Returns the effective policy."""
    global TERMINAL_POLICY
    if name in VALID_POLICIES:
        TERMINAL_POLICY = name
    return {"ok": name in VALID_POLICIES, "policy": TERMINAL_POLICY,
            "message": f"Terminal policy: {TERMINAL_POLICY}"}


def get_policy():
    return {
        "ok": True,
        "policy": TERMINAL_POLICY,
        "options": [
            {"id": "ask", "label": "Ask before anything harmful",
             "detail": "Read-only commands run immediately. Anything that could change "
                       "your system asks first and tells you exactly what it will do. "
                       "Disk-erasing, power, registry and account commands are never "
                       "run at all. Recommended."},
            {"id": "strict", "label": "Block destructive commands entirely",
             "detail": "Destructive commands (format, del /f, diskpart, shutdown…) are "
                       "refused and cannot be confirmed. Safest for unattended use."},
            {"id": "open", "label": "Run everything without asking",
             "detail": "No confirmation at all. Injection protection still applies. "
                       "Only pick this if you fully trust every command."},
        ],
    }


def explain_command(argv):
    """Plain-English description of what a command will do, for the prompt."""
    prog = os.path.basename(argv[0]).lower()
    prog = prog[:-4] if prog.endswith(".exe") else prog
    joined = " ".join(argv).lower()
    if re.search(r"\b(rm|del|erase|rmdir)\b", joined):
        return "DELETE FILES — this permanently removes data."
    if re.search(r"\b(format|mkfs|diskpart|fdisk|clear-disk)\b", joined):
        return "ERASE A DISK — this destroys everything on the drive."
    if re.search(r"\b(shutdown|reboot|halt|poweroff|restart-computer)\b", joined):
        return "SHUT DOWN OR RESTART your computer."
    if re.search(r"\b(reg|regedit|bcdedit|set-executionpolicy)\b", joined):
        return "CHANGE SYSTEM CONFIGURATION — this can break Windows."
    if re.search(r"\b(chmod|chown|icacls|takeown)\b", joined):
        return "CHANGE FILE PERMISSIONS or ownership."
    if re.search(r"\b(kill|taskkill|stop-process)\b", joined):
        return "FORCE-CLOSE a running program — unsaved work may be lost."
    if re.search(r"\b(install|uninstall|pip|npm|choco|winget|apt)\b", joined):
        return "INSTALL OR REMOVE SOFTWARE."
    if re.search(r"\b(curl|wget|invoke-webrequest)\b", joined):
        return "DOWNLOAD SOMETHING FROM THE INTERNET."
    if re.search(r"\b(git)\b.*\b(push|reset|clean|rebase)\b", joined):
        return "MODIFY A GIT REPOSITORY — commits may be lost."
    return f"Run '{prog}'. AURA does not recognise it, so it may do anything."


def _classify_command(cmdline, policy=None):
    """
    Decide whether a command may run under the active policy.
    @returns dict(allowed, needs_confirm, reason, argv, danger)
    """
    pol = policy or TERMINAL_POLICY
    if not cmdline or not isinstance(cmdline, str):
        return {"allowed": False, "needs_confirm": False, "argv": [],
                "danger": None, "reason": "No command given."}
    s = cmdline.strip()
    low = s.lower()

    # ALWAYS enforced, under every policy: this is injection protection, not
    # a preference. Chaining would let a "safe" command smuggle a second one.
    if SHELL_META.search(s):
        return {"allowed": False, "needs_confirm": False, "argv": [], "danger": None,
                "reason": ("Blocked: shell operators (; & | > ` $) are not allowed — "
                           "they could chain a second, hidden command. Run one command "
                           "at a time.")}

    try:
        argv = shlex.split(s, posix=(SYSTEM != "Windows"))
    except ValueError as e:
        return {"allowed": False, "needs_confirm": False, "argv": [], "danger": None,
                "reason": f"Could not parse command: {e}"}
    if not argv:
        return {"allowed": False, "needs_confirm": False, "argv": [], "danger": None,
                "reason": "Empty command."}

    prog = os.path.basename(argv[0]).lower()
    prog = prog[:-4] if prog.endswith(".exe") else prog

    is_destructive = any(re.search(pat, low) for pat in DESTRUCTIVE_PATTERNS)
    is_catastrophic = any(re.search(pat, low) for pat in CATASTROPHIC_PATTERNS)
    deny = SAFE_SUBCOMMAND_DENY.get(prog)
    is_risky_sub = bool(deny and len(argv) > 1 and argv[1].lower() in deny)
    is_safe = prog in SAFE_COMMANDS and not is_risky_sub and not is_destructive

    if pol == "open":
        return {"allowed": True, "needs_confirm": False, "argv": argv,
                "danger": explain_command(argv) if is_destructive else None,
                "reason": "Policy is 'open' — running without confirmation."}

    # Hard stop underneath every policy except an explicit 'open'. This is
    # the guarantee that an agent loop — however persuasive its plan — can
    # never reach disk erasure, power kills, registry edits or account
    # tampering through AURA.
    if is_catastrophic:
        return {"allowed": False, "needs_confirm": False, "argv": argv,
                "danger": explain_command(argv),
                "reason": ("Hard-blocked for safety: this command can erase a disk, "
                           "shut the machine down, edit the registry/boot config or "
                           "tamper with accounts — no confirmation makes that safe, so "
                           "AURA refuses it under every policy except an explicit 'open'. "
                           f"What it tried to do: {explain_command(argv)}")}

    if pol == "strict" and is_destructive:
        return {"allowed": False, "needs_confirm": False, "argv": argv,
                "danger": explain_command(argv),
                "reason": ("Blocked by the 'strict' policy: this command can destroy data "
                           "or change system state. Switch to 'ask' in Settings if you want "
                           "to approve commands like this yourself.")}

    if is_safe:
        return {"allowed": True, "needs_confirm": False, "argv": argv, "danger": None,
                "reason": f"'{prog}' only reads information — running it."}

    # Everything else: ASK, and say plainly what it will do.
    return {"allowed": True, "needs_confirm": True, "argv": argv,
            "danger": explain_command(argv),
            "reason": f"{explain_command(argv)} Confirm to continue."}


def inspect_command(cmdline):
    """Public: what WOULD happen, without running anything. Used by the UI."""
    c = _classify_command(cmdline)
    return {"ok": True, "command": cmdline, "allowed": c["allowed"],
            "needsConfirm": c["needs_confirm"], "reason": c["reason"],
            "danger": c.get("danger"), "policy": TERMINAL_POLICY}


def run_command(cmdline, cwd=None, confirmed=False):
    """Run an allowlisted command. Captures output. Never uses a shell."""
    c = _classify_command(cmdline)
    if not c["allowed"]:
        return {"ok": False, "blocked": True, "message": c["reason"]}
    if c["needs_confirm"] and not confirmed:
        return {"ok": False, "needsConfirm": True, "command": cmdline,
                "danger": c.get("danger"), "policy": TERMINAL_POLICY,
                "message": c["reason"]}

    workdir = os.path.expanduser("~")
    if cwd:
        p, err = _resolve_path(cwd)
        if err:
            return {"ok": False, "message": err}
        if not os.path.isdir(p):
            return {"ok": False, "message": f"Not a folder: {p}"}
        workdir = p

    try:
        r = subprocess.run(c["argv"], cwd=workdir, shell=False,
                           capture_output=True, text=True, timeout=CMD_TIMEOUT)
        out = (r.stdout or "") + (("\n" + r.stderr) if r.stderr else "")
        out = out.strip()
        if len(out) > 8000:
            out = out[:8000] + f"\n… truncated ({len(out)} chars)"
        return {"ok": r.returncode == 0, "exitCode": r.returncode,
                "output": out or "(no output)", "command": " ".join(c["argv"]),
                "cwd": workdir,
                "message": f"exit {r.returncode} · {' '.join(c['argv'])}"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "message": f"Command timed out after {CMD_TIMEOUT}s."}
    except FileNotFoundError:
        return {"ok": False, "message": f"Program not found: {c['argv'][0]}"}
    except Exception as e:
        return {"ok": False, "message": f"Failed: {e}"}


def open_terminal(cwd=None):
    """Open a real terminal window at a folder."""
    workdir = os.path.expanduser("~")
    if cwd:
        p, err = _resolve_path(cwd)
        if err:
            return {"ok": False, "message": err}
        workdir = p
    if SYSTEM == "Windows":
        for cand in (["wt.exe", "-d", workdir], ["powershell.exe", "-NoExit", "-Command", f"Set-Location '{workdir}'"], ["cmd.exe", "/K", f"cd /d {workdir}"]):
            ok, d = _run(cand)
            if ok:
                return {"ok": True, "message": f"Terminal opened at {workdir}"}
        return {"ok": False, "message": "Could not open a terminal."}
    if SYSTEM == "Darwin":
        ok, d = _run(["open", "-a", "Terminal", workdir])
        return {"ok": ok, "message": f"Terminal opened at {workdir}" if ok else d}
    for term in ("x-terminal-emulator", "gnome-terminal", "konsole", "xfce4-terminal", "xterm"):
        if shutil.which(term):
            ok, d = _run([term], )
            if ok:
                return {"ok": True, "message": f"{term} opened"}
    return {"ok": False, "message": "No terminal emulator found."}


# ── file system actions ───────────────────────────────────────────────────
def list_directory(target=None):
    p, err = _resolve_path(target or "~")
    if err:
        return {"ok": False, "message": err}
    if not os.path.isdir(p):
        return {"ok": False, "message": f"Not a folder: {p}"}
    try:
        names = sorted(os.listdir(p))[:FS_MAX_ENTRIES]
    except PermissionError:
        return {"ok": False, "message": f"Permission denied: {p}"}
    entries = []
    for n in names:
        if n.lower() in FS_DENY_NAMES:
            continue
        full = os.path.join(p, n)
        try:
            isdir = os.path.isdir(full)
            entries.append({"name": n, "dir": isdir,
                            "size": 0 if isdir else os.path.getsize(full)})
        except OSError:
            continue
    dirs = sum(1 for e in entries if e["dir"])
    return {"ok": True, "path": p, "entries": entries,
            "message": f"{p} — {dirs} folders, {len(entries) - dirs} files"}


def read_file(target, max_bytes=FS_MAX_READ):
    p, err = _resolve_path(target)
    if err:
        return {"ok": False, "message": err}
    if not os.path.isfile(p):
        return {"ok": False, "message": f"Not a file: {p}"}
    size = os.path.getsize(p)
    cap = min(int(max_bytes or FS_MAX_READ), FS_MAX_READ)
    try:
        with open(p, "rb") as f:
            raw = f.read(cap + 1)
    except PermissionError:
        return {"ok": False, "message": f"Permission denied: {p}"}
    if b"\0" in raw[:4096]:
        return {"ok": False, "message": f"{os.path.basename(p)} looks binary — not shown."}
    truncated = len(raw) > cap
    text = raw[:cap].decode("utf-8", "replace")
    return {"ok": True, "path": p, "size": size, "truncated": truncated,
            "content": text,
            "message": f"{os.path.basename(p)} — {size} bytes{' (truncated)' if truncated else ''}"}


def write_file(target, content, confirmed=False):
    if not confirmed:
        return {"ok": False, "needsConfirm": True,
                "message": f"Writing to '{target}' needs your confirmation."}
    if content is None:
        return {"ok": False, "message": "No content given."}
    body = str(content)
    if len(body.encode("utf-8")) > FS_MAX_WRITE:
        return {"ok": False, "message": f"Refused: content exceeds {FS_MAX_WRITE // 1024} KB."}
    p, err = _resolve_path(target, must_exist=False)
    if err:
        return {"ok": False, "message": err}
    if os.path.isdir(p):
        return {"ok": False, "message": f"{p} is a folder."}
    parent = os.path.dirname(p)
    if not os.path.isdir(parent):
        return {"ok": False, "message": f"Folder does not exist: {parent}"}
    existed = os.path.exists(p)
    try:
        # Atomic: write a temp file in the same folder, then replace.
        fd, tmp = tempfile.mkstemp(dir=parent, prefix=".aura-", suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(body)
        os.replace(tmp, p)
    except Exception as e:
        try:
            os.unlink(tmp)
        except Exception:
            pass
        return {"ok": False, "message": f"Write failed: {e}"}
    return {"ok": True, "path": p, "bytes": len(body.encode("utf-8")),
            "message": f"{'Updated' if existed else 'Created'} {p} ({len(body)} chars)"}


def open_folder(target=None):
    p, err = _resolve_path(target or "~")
    if err:
        return {"ok": False, "message": err}
    if not os.path.isdir(p):
        p = os.path.dirname(p)
    if SYSTEM == "Windows":
        ok, d = _run(["explorer.exe", p])
    elif SYSTEM == "Darwin":
        ok, d = _run(["open", p])
    else:
        ok, d = _run(["xdg-open", p])
    return {"ok": ok, "path": p, "message": f"Opened {p}" if ok else d}


def clipboard_read():
    """Read the clipboard via the OS, for when the browser API is blocked."""
    try:
        if SYSTEM == "Windows":
            r = subprocess.run(["powershell.exe", "-NoProfile", "-Command", "Get-Clipboard"],
                               capture_output=True, text=True, timeout=8)
        elif SYSTEM == "Darwin":
            r = subprocess.run(["pbpaste"], capture_output=True, text=True, timeout=8)
        else:
            tool = "xclip" if shutil.which("xclip") else ("xsel" if shutil.which("xsel") else None)
            if not tool:
                return {"ok": False, "message": "Install xclip or xsel for clipboard access."}
            args = ["xclip", "-o", "-selection", "clipboard"] if tool == "xclip" else ["xsel", "-b"]
            r = subprocess.run(args, capture_output=True, text=True, timeout=8)
        text = (r.stdout or "").rstrip("\n")
        return {"ok": True, "text": text, "message": f"Clipboard: {text[:120]}" if text else "Clipboard is empty."}
    except Exception as e:
        return {"ok": False, "message": f"Clipboard read failed: {e}"}


def clipboard_write(text):
    try:
        data = str(text or "")
        if SYSTEM == "Windows":
            p = subprocess.Popen(["clip.exe"], stdin=subprocess.PIPE, text=True)
        elif SYSTEM == "Darwin":
            p = subprocess.Popen(["pbcopy"], stdin=subprocess.PIPE, text=True)
        else:
            tool = "xclip" if shutil.which("xclip") else ("xsel" if shutil.which("xsel") else None)
            if not tool:
                return {"ok": False, "message": "Install xclip or xsel for clipboard access."}
            args = ["xclip", "-selection", "clipboard"] if tool == "xclip" else ["xsel", "-b", "-i"]
            p = subprocess.Popen(args, stdin=subprocess.PIPE, text=True)
        p.communicate(data, timeout=8)
        return {"ok": True, "message": f"Copied {len(data)} chars to the clipboard."}
    except Exception as e:
        return {"ok": False, "message": f"Clipboard write failed: {e}"}


def _run(args, shell=False):
    """Launch detached, never blocking the server. Returns (ok, detail)."""
    try:
        kwargs = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
        if SYSTEM == "Windows":
            kwargs["creationflags"] = 0x00000008 | 0x00000200  # DETACHED | NEW_GROUP
        else:
            kwargs["start_new_session"] = True
        subprocess.Popen(args, shell=shell, **kwargs)
        return True, " ".join(args) if isinstance(args, list) else str(args)
    except Exception as e:
        return False, str(e)


def _open_uri(uri):
    """Hand a URI/deep-link to the OS handler."""
    if SYSTEM == "Windows":
        try:
            os.startfile(uri)  # type: ignore[attr-defined]
            return True, uri
        except Exception as e:
            return False, str(e)
    if SYSTEM == "Darwin":
        return _run(["open", uri])
    for opener in ("xdg-open", "gio"):
        if shutil.which(opener):
            return _run([opener, "open", uri] if opener == "gio" else [opener, uri])
    try:
        webbrowser.open(uri)
        return True, uri
    except Exception as e:
        return False, str(e)


def list_apps():
    """Report which allowlisted apps look installed on this machine."""
    out = []
    for key, spec in APPS.items():
        found = None
        if SYSTEM == "Windows":
            for b in spec.get("windows", []):
                if shutil.which(b) or b.endswith(":"):
                    found = b
                    break
        elif SYSTEM == "Darwin":
            for name in spec.get("darwin", []):
                for root in ("/Applications", os.path.expanduser("~/Applications"),
                             "/System/Applications"):
                    if os.path.exists(os.path.join(root, f"{name}.app")):
                        found = name
                        break
                if found:
                    break
        else:
            for b in spec.get("linux", []):
                if shutil.which(b):
                    found = b
                    break
        out.append({
            "id": key,
            "label": spec["label"],
            "installed": bool(found),
            "binary": found,
            "hasUri": bool(spec.get("uri")),
            "hasWeb": bool(spec.get("web")),
        })
    return out


def running_apps():
    """
    Which allowlisted apps are ACTUALLY running right now?

    The agent loop needs this to answer "is WhatsApp already open?" without
    taking a screenshot and asking a model — which is slow and unreliable.
    Matches process names against each app's known binaries.

    Requires psutil. Without it we say so rather than guessing, and the agent
    falls back to opening the app unconditionally (harmless: launching an
    already-running app just focuses it on every OS we support).
    """
    try:
        import psutil
    except Exception:
        return {"ok": False, "available": False, "running": [],
                "message": "psutil not installed - cannot see running processes. "
                           "pip install psutil"}

    names = set()
    for proc in psutil.process_iter(["name", "exe"]):
        try:
            n = (proc.info.get("name") or "").lower()
            if n:
                names.add(n)
                if n.endswith(".exe"):
                    names.add(n[:-4])
        except Exception:
            continue

    out = []
    for key, spec in APPS.items():
        cands = []
        for plat in ("windows", "darwin", "linux"):
            for b in spec.get(plat, []):
                b = b.lower().rstrip(":")
                if b:
                    cands.append(os.path.basename(b))
                    if b.endswith(".exe"):
                        cands.append(os.path.basename(b)[:-4])
        cands.append(key)
        if any(c in names for c in cands if c):
            out.append(key)
    return {"ok": True, "available": True, "running": sorted(out),
            "count": len(out)}


def open_app(app_id, arg=None):
    """
    Launch an allowlisted app. Never executes arbitrary strings.
    @returns dict(ok, message, method)
    """
    key = (app_id or "").strip().lower()
    spec = APPS.get(key)
    if not spec:
        close = [k for k in APPS if key and (key in k or k in key)]
        hint = f" Did you mean: {', '.join(close[:3])}?" if close else ""
        return {"ok": False, "message": f"'{app_id}' is not in the allowlist.{hint}",
                "available": sorted(APPS.keys())}

    # 1 — native binary / bundle
    if SYSTEM == "Windows":
        for b in spec.get("windows", []):
            if b.endswith(":"):
                ok, d = _open_uri(b)
                if ok:
                    return {"ok": True, "message": f"Opened {spec['label']}", "method": "uri", "detail": d}
            elif shutil.which(b):
                ok, d = _run([b] + ([arg] if arg else []))
                if ok:
                    return {"ok": True, "message": f"Opened {spec['label']}", "method": "binary", "detail": d}
    elif SYSTEM == "Darwin":
        for name in spec.get("darwin", []):
            for root in ("/Applications", os.path.expanduser("~/Applications"), "/System/Applications"):
                if os.path.exists(os.path.join(root, f"{name}.app")):
                    args = ["open", "-a", name] + (["--args", arg] if arg else [])
                    ok, d = _run(args)
                    if ok:
                        return {"ok": True, "message": f"Opened {spec['label']}", "method": "app", "detail": d}
    else:
        for b in spec.get("linux", []):
            if shutil.which(b):
                ok, d = _run([b] + ([arg] if arg else []))
                if ok:
                    return {"ok": True, "message": f"Opened {spec['label']}", "method": "binary", "detail": d}

    # 2 — deep link
    if spec.get("uri"):
        uri = spec["uri"]
        if arg and key == "whatsapp":
            import urllib.parse
            clean_msg = re.sub(r"^(message|text|send\s+message\s+to|send|saying)\s+", "", str(arg), flags=re.I).strip()
            uri = f"whatsapp://send?text={urllib.parse.quote(clean_msg)}"
        elif arg and key == "telegram":
            import urllib.parse
            uri = f"tg://msg_url?url=&text={urllib.parse.quote(str(arg))}"
        ok, d = _open_uri(uri)
        if ok:
            return {"ok": True, "message": f"Opened {spec['label']} via deep link", "method": "uri", "detail": d}

    # 3 — web fallback (still a real, useful result)
    if spec.get("web"):
        web_url = spec["web"]
        if arg and key == "whatsapp":
            import urllib.parse
            clean_msg = re.sub(r"^(message|text|send\s+message\s+to|send|saying)\s+", "", str(arg), flags=re.I).strip()
            web_url = f"https://web.whatsapp.com/send?text={urllib.parse.quote(clean_msg)}"
        ok, d = _open_uri(web_url)
        if ok:
            return {"ok": True, "method": "web", "detail": d,
                    "message": f"{spec['label']} desktop app not found — opened the web version instead."}

    return {"ok": False, "message": f"Could not find {spec['label']} on this {SYSTEM} machine."}


# Anything with a scheme that isn't http(s) is refused outright.
_BLOCKED_SCHEMES = ("file:", "javascript:", "data:", "vbscript:", "smb:",
                    "ftp:", "ssh:", "telnet:", "chrome:", "about:", "blob:")


def open_url(url):
    u = (url or "").strip()
    if not u:
        return {"ok": False, "message": "No URL given."}

    # Check the scheme FIRST. Prefixing https:// beforehand turned
    # "file:///etc/passwd" into "https://file:///etc/passwd" and slipped past
    # the filter — caught by the bridge security test.
    low = u.lower()
    if any(low.startswith(p) for p in _BLOCKED_SCHEMES):
        return {"ok": False, "message": f"Blocked non-web URL scheme in '{u[:40]}'."}

    if "://" in u:
        if not low.startswith(("http://", "https://")):
            return {"ok": False, "message": f"Only http/https URLs are allowed (got '{u.split('://')[0]}')."}
    else:
        # bare domain like "example.com" — must actually look like a hostname
        host = u.split("/")[0]
        if ":" in host or "." not in host:
            return {"ok": False, "message": f"'{u[:40]}' is not a valid web address."}
        u = "https://" + u

    ok, d = _open_uri(u)
    return {"ok": ok, "message": f"Opened {u}" if ok else f"Failed: {d}", "detail": d}


def search_web(query, engine="duckduckgo"):
    import urllib.parse
    engines = {
        "duckduckgo": "https://duckduckgo.com/?q=",
        "google": "https://www.google.com/search?q=",
        "youtube": "https://www.youtube.com/results?search_query=",
    }
    base = engines.get(engine, engines["duckduckgo"])
    return open_url(base + urllib.parse.quote(query))


def media_key(action):
    """Play/pause, next, previous via the OS media keys."""
    a = (action or "").lower()
    if a not in MEDIA_KEYS:
        return {"ok": False, "message": f"Unknown media action '{action}'."}
    if SYSTEM == "Darwin":
        code = {"playpause": 16, "next": 17, "previous": 18, "stop": 16}[a]
        script = (f'tell application "System Events" to key code {code}'
                  if False else
                  f'tell application "Spotify" to {"playpause" if a == "playpause" else a + " track"}')
        ok, d = _run(["osascript", "-e", script])
        return {"ok": ok, "message": f"Media: {a}" if ok else d}
    if SYSTEM == "Linux":
        if shutil.which("playerctl"):
            cmd = {"playpause": "play-pause", "next": "next", "previous": "previous", "stop": "stop"}[a]
            ok, d = _run(["playerctl", cmd])
            return {"ok": ok, "message": f"Media: {a}" if ok else d}
        return {"ok": False, "message": "Install playerctl for media control: sudo apt install playerctl"}
    if SYSTEM == "Windows":
        keys = {"playpause": 0xB3, "next": 0xB0, "previous": 0xB1, "stop": 0xB2}
        ps = (f"$s=New-Object -ComObject WScript.Shell;"
              f"[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');"
              f"$sig='[DllImport(\"user32.dll\")]public static extern void keybd_event(byte b,byte s,int f,int e);';"
              f"$t=Add-Type -MemberDefinition $sig -Name K -PassThru;"
              f"$t::keybd_event({keys[a]},0,0,0);")
        ok, d = _run(["powershell", "-NoProfile", "-Command", ps])
        return {"ok": ok, "message": f"Media: {a}" if ok else d}
    return {"ok": False, "message": f"Media keys unsupported on {SYSTEM}."}


def set_volume(level):
    """level: 0-100, or 'up' / 'down' / 'mute'."""
    try:
        if SYSTEM == "Darwin":
            if level == "mute":
                ok, d = _run(["osascript", "-e", "set volume output muted true"])
            elif level in ("up", "down"):
                delta = 10 if level == "up" else -10
                ok, d = _run(["osascript", "-e",
                              f"set volume output volume (output volume of (get volume settings) + {delta})"])
            else:
                v = max(0, min(100, int(level)))
                ok, d = _run(["osascript", "-e", f"set volume output volume {v}"])
            return {"ok": ok, "message": f"Volume: {level}" if ok else d}
        if SYSTEM == "Linux":
            if not shutil.which("pactl"):
                return {"ok": False, "message": "pactl not found (PulseAudio/PipeWire required)."}
            sink = "@DEFAULT_SINK@"
            if level == "mute":
                ok, d = _run(["pactl", "set-sink-mute", sink, "toggle"])
            elif level in ("up", "down"):
                ok, d = _run(["pactl", "set-sink-volume", sink, "+10%" if level == "up" else "-10%"])
            else:
                ok, d = _run(["pactl", "set-sink-volume", sink, f"{max(0, min(100, int(level)))}%"])
            return {"ok": ok, "message": f"Volume: {level}" if ok else d}
        if SYSTEM == "Windows":
            if level == "mute":
                key = 0xAD
            elif level == "up":
                key = 0xAF
            elif level == "down":
                key = 0xAE
            else:
                return {"ok": False, "message": "Windows supports up/down/mute only."}
            sig = '[DllImport("user32.dll")]public static extern void keybd_event(byte b,byte s,int f,int e);'
            ps = (f"$t=Add-Type -MemberDefinition '{sig}' -Name V -PassThru;"
                  f"$t::keybd_event({key},0,0,0);")
            ok, d = _run(["powershell", "-NoProfile", "-Command", ps])
            return {"ok": ok, "message": f"Volume: {level}" if ok else d}
    except Exception as e:
        return {"ok": False, "message": str(e)}
    return {"ok": False, "message": f"Volume control unsupported on {SYSTEM}."}


def screenshot(path=None):
    import time
    out = path or os.path.join(os.path.expanduser("~"), f"aura-screen-{int(time.time())}.png")
    try:
        if SYSTEM == "Darwin":
            subprocess.run(["screencapture", "-x", out], check=True, timeout=15)
        elif SYSTEM == "Linux":
            for tool, args in (("gnome-screenshot", ["-f", out]), ("scrot", [out]),
                               ("import", ["-window", "root", out]), ("spectacle", ["-b", "-o", out])):
                if shutil.which(tool):
                    subprocess.run([tool] + args, check=True, timeout=15)
                    break
            else:
                return {"ok": False, "message": "No screenshot tool (install gnome-screenshot or scrot)."}
        elif SYSTEM == "Windows":
            ps = ("Add-Type -AssemblyName System.Windows.Forms,System.Drawing;"
                  "$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;"
                  "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;"
                  "$g=[System.Drawing.Graphics]::FromImage($bmp);"
                  f"$g.CopyFromScreen(0,0,0,0,$bmp.Size);$bmp.Save('{out}');")
            subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=True, timeout=25)
        else:
            return {"ok": False, "message": f"Unsupported OS {SYSTEM}"}
        return {"ok": True, "message": f"Screenshot saved to {out}", "path": out}
    except Exception as e:
        return {"ok": False, "message": f"Screenshot failed: {e}"}


def system_info():
    return {
        "ok": True,
        "os": SYSTEM,
        "release": platform.release(),
        "machine": platform.machine(),
        "python": platform.python_version(),
        "hostname": platform.node(),
        "cpus": os.cpu_count(),
    }


# ══════════════════════════════════════════════════════════════════════════
#  INSTALLED APPLICATION DETECTION
# ══════════════════════════════════════════════════════════════════════════
#
# Finds what is ACTUALLY installed so you can choose which apps AURA may
# touch, instead of relying on a built-in catalogue.
#
# Windows  : Start Menu .lnk shortcuts + the uninstall registry keys.
#            Shortcuts are the best signal — they are what the user sees.
# macOS    : /Applications and ~/Applications bundles.
# Linux    : .desktop entries in the standard XDG locations.
#
# Detection is READ-ONLY and grants nothing: every app comes back
# `approved: False` and the UI is where you allow individual apps.

def _win_start_menu_apps():
    out = []
    roots = [
        os.path.join(os.environ.get("APPDATA", ""), r"Microsoft\Windows\Start Menu\Programs"),
        os.path.join(os.environ.get("PROGRAMDATA", ""), r"Microsoft\Windows\Start Menu\Programs"),
    ]
    for root in roots:
        if not root or not os.path.isdir(root):
            continue
        for dirpath, _dirs, files in os.walk(root):
            for f in files:
                if not f.lower().endswith(".lnk"):
                    continue
                name = os.path.splitext(f)[0]
                low = name.lower()
                if any(w in low for w in ("uninstall", "readme", "help", "website",
                                          "documentation", "release notes", "license")):
                    continue
                out.append({"name": name, "path": os.path.join(dirpath, f), "source": "start-menu"})
    return out


def _win_registry_apps():
    out = []
    try:
        import winreg
    except ImportError:
        return out
    keys = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    ]
    for hive, path in keys:
        try:
            with winreg.OpenKey(hive, path) as k:
                for i in range(winreg.QueryInfoKey(k)[0]):
                    try:
                        sub = winreg.EnumKey(k, i)
                        with winreg.OpenKey(k, sub) as sk:
                            name = winreg.QueryValueEx(sk, "DisplayName")[0]
                            try:
                                icon = winreg.QueryValueEx(sk, "DisplayIcon")[0]
                            except OSError:
                                icon = ""
                            exe = icon.split(",")[0].strip('"') if icon else ""
                            if exe and not exe.lower().endswith(".exe"):
                                exe = ""
                            out.append({"name": name, "path": exe, "source": "registry"})
                    except OSError:
                        continue
        except OSError:
            continue
    return out


def _mac_apps():
    out = []
    for root in ("/Applications", os.path.expanduser("~/Applications")):
        if not os.path.isdir(root):
            continue
        try:
            for entry in os.listdir(root):
                if entry.endswith(".app"):
                    out.append({"name": entry[:-4], "path": os.path.join(root, entry),
                                "source": "applications"})
        except OSError:
            continue
    return out


def _linux_apps():
    out = []
    roots = ["/usr/share/applications", "/var/lib/flatpak/exports/share/applications",
             os.path.expanduser("~/.local/share/applications")]
    for root in roots:
        if not os.path.isdir(root):
            continue
        try:
            names = os.listdir(root)
        except OSError:
            continue
        for f in names:
            if not f.endswith(".desktop"):
                continue
            full = os.path.join(root, f)
            name, exe, nodisplay = None, "", False
            try:
                with open(full, "r", encoding="utf-8", errors="replace") as fh:
                    for line in fh:
                        line = line.strip()
                        if line.startswith("Name=") and name is None:
                            name = line[5:]
                        elif line.startswith("Exec=") and not exe:
                            exe = line[5:].split()[0] if len(line) > 5 else ""
                        elif line.startswith("NoDisplay=true"):
                            nodisplay = True
            except OSError:
                continue
            if name and not nodisplay:
                out.append({"name": name, "path": exe, "source": "desktop-entry"})
    return out


def detect_installed_apps():
    """
    Scan the machine for installed applications.
    Read-only. Returns candidates for the user to approve — nothing is
    granted access by being detected.
    """
    try:
        if SYSTEM == "Windows":
            found = _win_start_menu_apps() + _win_registry_apps()
        elif SYSTEM == "Darwin":
            found = _mac_apps()
        else:
            found = _linux_apps()
    except Exception as e:
        return {"ok": False, "message": f"Scan failed: {e}", "apps": []}

    # De-duplicate on lowercase name, preferring an entry that has a real path.
    best = {}
    for a in found:
        key = a["name"].strip().lower()
        if not key or len(key) > 60:
            continue
        prev = best.get(key)
        if prev is None or (not prev.get("path") and a.get("path")):
            best[key] = a

    apps = []
    for key, a in sorted(best.items()):
        apps.append({
            "id": re.sub(r"[^a-z0-9]+", "-", key).strip("-")[:40] or "app",
            "name": a["name"].strip(),
            "path": a.get("path") or "",
            "source": a.get("source"),
            "approved": False,          # detection grants NOTHING
        })
    return {"ok": True, "os": SYSTEM, "count": len(apps), "apps": apps[:400],
            "message": f"Found {len(apps)} installed applications on {SYSTEM}."}


# ── dispatcher ────────────────────────────────────────────────────────────
def dispatch(action, params):
    """Route a validated action. Returns a JSON-serialisable dict."""
    p = params or {}
    if action == "open_app":
        return open_app(p.get("app"), p.get("arg"))
    if action == "open_url":
        return open_url(p.get("url"))
    if action == "search":
        return search_web(p.get("query", ""), p.get("engine", "duckduckgo"))
    if action == "media":
        return media_key(p.get("action"))
    if action == "volume":
        return set_volume(p.get("level"))
    if action == "screenshot":
        return screenshot()
    if action == "list_apps":
        return {"ok": True, "apps": list_apps(), "os": SYSTEM}

    if action == "running_apps":
        return running_apps()

    # ── desktop overlay: AURA's real, visible reticle ────────────────────
    if action.startswith("overlay_"):
        try:
            from server import overlay
        except Exception as e:
            return {"ok": False, "message": f"overlay module unavailable: {e}"}
        sub = action[len("overlay_"):]
        if sub == "status":
            return overlay.status()
        if sub == "show":
            return overlay.show(p.get("x", 0), p.get("y", 0),
                                color=p.get("color"), label=p.get("label"),
                                style=p.get("style"), size=p.get("size"),
                                thickness=p.get("thickness"))
        if sub == "hide":
            return overlay.hide()
        if sub == "config":
            return overlay.configure(color=p.get("color"), style=p.get("style"),
                                     size=p.get("size"), thickness=p.get("thickness"))
        return {"ok": False, "message": f"Unknown overlay action '{sub}'."}

    # ── paired devices (phone companion) ─────────────────────────────────
    if action.startswith("device_"):
        try:
            from server import devices as _dev
        except Exception as e:
            return {"ok": False, "message": f"device gateway unavailable: {e}"}
        sub = action[len("device_"):]
        if sub == "list":
            return _dev.status()
        if sub == "send":
            return _dev.send_action(p.get("device"), p.get("action"), p.get("params"))
        if sub == "pair_start":
            return _dev.start_pairing()
        if sub == "pair_cancel":
            return _dev.cancel_pairing()
        if sub == "unpair":
            return _dev.unpair(p.get("deviceId"))
        return {"ok": False, "message": f"Unknown device action '{sub}'."}

    # ── window management (real OS API, never coordinates) ───────────────
    if action.startswith("window_"):
        try:
            from server import windows_mgr
        except Exception as e:
            return {"ok": False, "message": f"windows_mgr unavailable: {e}"}
        sub = action[len("window_"):]
        if sub == "status":
            return windows_mgr.status()
        if sub == "active":
            return windows_mgr.get_active_window()
        if sub == "minimize_active":
            return windows_mgr.minimize_active_window()
        if sub == "minimize":
            return windows_mgr.minimize_window(p.get("windowId"))
        if sub == "restore":
            return windows_mgr.restore_window(p.get("windowId"))
        return {"ok": False, "message": f"Unknown window action '{sub}'."}

    # ── virtual desktops (Windows) ───────────────────────────────────────
    if action.startswith("vdesk_"):
        try:
            from server import vdesk
        except Exception as e:
            return {"ok": False, "message": f"vdesk module unavailable: {e}"}
        sub = action[len("vdesk_"):]
        fns = {
            "status": lambda: vdesk.status(),
            "create": lambda: vdesk.create(),
            "setup": lambda: vdesk.setup_aura_desktop(),
            "go_aura": lambda: vdesk.go_aura(),
            "go_home": lambda: vdesk.go_home(),
            "next": lambda: vdesk.switch("next"),
            "prev": lambda: vdesk.switch("prev"),
            "close": lambda: vdesk.close_current(),
            "task_view": lambda: vdesk.task_view(),
            "resync": lambda: vdesk.resync(p.get("index", 0), p.get("count")),
        }
        fn = fns.get(sub)
        return fn() if fn else {"ok": False, "message": f"Unknown vdesk action '{sub}'."}
    if action == "system_info":
        return system_info()

    # ── file system (path-jailed, see _resolve_path) ──────────────────────
    if action == "list_directory":
        return list_directory(p.get("target"))
    if action == "read_file":
        return read_file(p.get("target"), p.get("maxBytes"))
    if action == "write_file":
        return write_file(p.get("target"), p.get("content"), bool(p.get("confirmed")))
    if action == "open_folder":
        return open_folder(p.get("target"))

    # ── terminal (allowlisted, shell=False, destructive verbs hard-blocked)
    if action == "run_command":
        return run_command(p.get("target") or p.get("command"),
                           p.get("cwd"), bool(p.get("confirmed")))
    if action == "inspect_command":
        return inspect_command(p.get("target") or p.get("command"))
    if action == "open_terminal":
        return open_terminal(p.get("cwd"))
    if action == "get_policy":
        return get_policy()
    if action == "set_policy":
        return set_policy(p.get("policy"))
    if action == "detect_apps":
        return detect_installed_apps()

    # ── document generation (pptx / xlsx / docx) ──────────────────────────
    # The AI produces the OUTLINE (browser doc-agent, or the terminal's
    # shared services.docgen.outline); the CANONICAL services.docgen.service
    # renders it — same function for the app, the terminal and the tests.
    # Options carry the feature knobs (theme/transition/animation/images),
    # and the jail resolver is injected so there is exactly one path rule.
    if action.startswith("doc_"):
        try:
            from services.docgen import service as docgen_service
        except Exception as e:
            return {"ok": False, "message": f"docgen service unavailable: {e}"}
        sub = action[len("doc_"):]
        if sub == "capabilities":
            return docgen_service.capabilities()
        if sub == "build":
            return docgen_service.generate(
                p.get("kind"), p.get("spec"),
                folder=p.get("folder"), resolver=_resolve_path,
                options=p.get("options") or {})
        return {"ok": False, "message": f"Unknown document action '{sub}'."}

    # ── file organiser (preview -> confirm -> undo) ───────────────────────
    if action.startswith("organize_"):
        try:
            from server import organizer
        except Exception as e:
            return {"ok": False, "message": f"organizer unavailable: {e}"}
        sub = action[len("organize_"):]
        if sub == "capabilities":
            return organizer.capabilities()
        if sub == "plan":
            return organizer.plan(p.get("target") or p.get("folder"),
                                  _resolve_path,
                                  include_hidden=bool(p.get("includeHidden")))
        if sub == "apply":
            return organizer.apply(p.get("target") or p.get("folder"),
                                   p.get("token"), _resolve_path)
        if sub == "undo":
            return organizer.undo(p.get("target") or p.get("folder"), _resolve_path)
        return {"ok": False, "message": f"Unknown organize action '{sub}'."}

    # ── web search / research (offline-first: only runs when asked) ───────
    if action in ("web_search", "web_research", "web_capabilities", "read_page"):
        try:
            from server import websearch
        except Exception as e:
            return {"ok": False, "message": f"websearch module unavailable: {e}"}
        if action == "web_capabilities":
            return websearch.capabilities()
        if action == "web_search":
            return websearch.search(p.get("query", ""), p.get("maxResults", 6))
        if action == "read_page":
            pages = websearch.fetch_pages([p.get("url", "")], limit=1)
            return {"ok": bool(pages and pages[0].get("ok")), **(pages[0] if pages else {})}
        return websearch.research(p.get("query", ""), p.get("depth"),
                                  p.get("maxResults", 6), p.get("readCount", 3))

    # ── input automation (highest risk — see automation.py) ──────────────
    if action.startswith("automation_"):
        try:
            from server import automation
        except Exception as e:
            return {"ok": False, "message": f"automation module unavailable: {e}"}
        sub = action[len("automation_"):]
        if sub == "capabilities":
            return automation.capabilities()
        if sub == "arm":
            return automation.arm()
        if sub == "disarm":
            return automation.disarm()
        if sub == "cursor":
            return automation.cursor_position()
        if sub == "dry_run":
            return automation.dry_run(p.get("plan") or [])
        if sub == "run":
            return automation.run(p.get("plan") or [], bool(p.get("confirmed")))
        return {"ok": False, "message": f"Unknown automation action '{sub}'."}

    # ── window management (Win32 enumeration + window control) ───────────
    if action in ("list_windows", "window_list"):
        try:
            from server import windows_mgr
            return windows_mgr.list_all_windows()
        except Exception as e:
            return {"ok": False, "message": f"windows_mgr unavailable: {e}"}
    if action == "window_action":
        try:
            from server import windows_mgr
            op = p.get("op", "focus")
            wid = p.get("windowId") or p.get("hwnd")
            if op == "focus":
                return windows_mgr.focus_window(wid)
            elif op == "minimize":
                return windows_mgr.minimize_window(wid)
            elif op == "maximize":
                return windows_mgr.maximize_window(wid)
            elif op == "restore":
                return windows_mgr.restore_window(wid)
            elif op == "close":
                return windows_mgr.close_window(wid)
            return {"ok": False, "message": f"Unknown window operation '{op}'."}
        except Exception as e:
            return {"ok": False, "message": f"windows_mgr unavailable: {e}"}

    # ── clipboard (OS-level, for when the browser API is blocked) ─────────
    if action == "clipboard_read":
        return clipboard_read()
    if action == "clipboard_write":
        return clipboard_write(p.get("text"))

    return {"ok": False, "message": f"Unknown action '{action}'."}

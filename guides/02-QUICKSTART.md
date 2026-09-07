# 02 · QUICKSTART — run it, flags, requirements, terminal

## Requirements

- **Python 3.8+** (the server is pure stdlib — it boots with nothing installed)
- **Chrome or Edge** recommended (Web Speech API; Firefox lacks it)
- **Ollama** optional (`ollama pull gemma2:2b`) — without it an honest offline
  core runs
- **Optional pip packages** (`aura/requirements.txt`) unlock per-feature:
  - `psutil` — live CPU/RAM in System center
  - `ddgs` + `trafilatura` — web research/search
  - `pyautogui` — desktop input automation (high risk, off by default)
  - `python-pptx`, `openpyxl`, `python-docx` — document generation
  - `qrcode` — QR pairing

## Launch

```bash
cd aura
python server/serve.py                        # chat/vision/voice/avatar only
python server/serve.py --allow-actions        # + desktop control (open apps, media)
python server/serve.py --allow-actions --allow-lan   # + LAN (phone pairing)
python server/serve.py 8080                   # any bare number = port
python server/serve.py --ollama http://localhost:11434
```

Opens `http://localhost:8000` automatically.

### Flags (parsed manually in `serve.py`)

| Flag | Effect |
|------|--------|
| *(none)* | Core only |
| `--allow-actions` | Enables the Local Action Bridge (all `bridge.dispatch` calls) |
| `--allow-lan` | Bind `0.0.0.0` instead of `127.0.0.1` |
| `8080` | Port (default 8000) |
| `--ollama URL` | Override `AURA_OLLAMA` env / default `http://localhost:11434` |
| `AURA_OLLAMA` env | Same as above |
| `AURA_DB_PATH` env | Override SQLite DB path |

Arguments are read from `sys.argv` by simple `in` checks — not argparse.

## The terminal REPL (inside the server window)

| Command | Effect |
|---------|--------|
| `/doc` | List docgen capabilities (pptx/xlsx/docx) |
| `/doc ppt on X` | Build a real .pptx (asks knobs; `--theme`, `--transition`, `--animation`, `--visual-source smart|web|ai|none`, `--source auto|nasa|wikimedia|openverse|general` are parsed in the args string) |
| `/doc sheet of X` | Build .xlsx |
| `/doc report on X` | Build .docx |
| `/organize` | Preview/apply/undo file organisation in a folder |
| `/apps` | List installed apps (with `--allow-actions`) |
| `/devices` *(chat)* | **Full device command family** — `list`, `pair`, `battery`, `apps` (shortcut catalog), `open <device> <name\|url>` (device optional → the phone), `notify`, `vibrate`, `locate`, `camera`, `mic`, `ping`, `caps`, `unpair` (canonical `server/devices.command`) |
| `/motd` `/ping` *(chat)* | Version + management-page shortcuts; server round-trip + subsystem health |
| `/phone` | Terminal alias for the same device commands |
| `/status` `/sys` | Banner, flags, AI state, desktop actions, LAN |
| `/policy` | Show/set the action permission policy |
| `/help` `/clear` `/exit` | Help, clear, shutdown |

## The health / debug endpoints

| URL | What |
|-----|------|
| `/api/health` | Subsystem health (core, ollama, wake, stt, tts, vision, devices, docgen) |
| `/api/status` | Status incl. DB path, integrity, sizeBytes, vault |
| `/api/version` | Version, codename, release notes |
| `/api/metrics` | Uptime, request counters |

## First-run sanity checklist

1. `python server/serve.py 8001 --allow-actions --allow-lan`
2. Open `http://localhost:8001/` → avatar + chat work.
3. Open `/db` → status green, tables listed.
4. Open `/controls` → 35 toggles all ON.
5. If you turned something off for a demo, press **RESET ALL** before you
   forget — the flag state lives in the DB and survives restarts.

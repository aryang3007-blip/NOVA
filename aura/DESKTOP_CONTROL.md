# Screen, Mouse & Keyboard Control — Setup

Everything here runs on **your** machine, via `serve.py`. Nothing is sent
anywhere. This is the most powerful thing AURA can do, so it is deliberately
gated at four separate points.

---

## Why you only saw UI changes

Three separate things must all be true. Running `python serve.py` alone
satisfies **none** of them:

| # | Requirement | Symptom when missing |
|---|---|---|
| 1 | Start with `--allow-actions` | Every desktop action refuses: *"Actions disabled"* |
| 2 | `pip install pyautogui` | Badge reads **NOT INSTALLED**; mouse/keyboard do nothing |
| 3 | **Arm** the session | Badge reads **DISARMED**; plans are refused |

Screenshots (`/screen`) need only **#1** — they use PowerShell on Windows,
not pyautogui.
Mouse and keyboard need **all three**.

---

## Setup (Windows)

### 1. Install the dependency

```
pip install pyautogui
```

`serve.py` itself needs nothing but the standard library. This one package
is what unlocks real input control.

### 2. Start with actions enabled

```
python serve.py --allow-actions
```

Confirm the console says:

```
   > DESKTOP ACTIONS: ENABLED (Windows)
     Bound to 127.0.0.1, token-authenticated, allowlist only.
```

If it says *"Desktop actions: disabled"*, the flag did not take.

### 3. Grant the permissions

**Settings → Desktop → Permissions**, or click **GRANT RECOMMENDED**.
The three that matter here:

- `mouse_automation` — move the cursor and click
- `keyboard_automation` — send keystrokes
- `screen_capture` — take screenshots

### 4. Arm it

Either type `/automation arm`, or use
**Settings → Desktop → Input Automation → ARM AUTOMATION**.

The badge should turn **ARMED**. Check any time with:

```
/automation
```

```
**INPUT AUTOMATION**

• Status: 🟢 ARMED
• Screen: 1920×1080
• Limits: 40 steps per plan · arming lapses after 15 min
• Plans run: 0

🛑 Move the mouse to the TOP-LEFT corner to abort instantly.
```

---

## Commands

| Command | What it does |
|---|---|
| `/screen` | Screenshot the desktop → saved to your home folder |
| `/automation` | Show status |
| `/automation arm` · `/automation disarm` | Enable / disable |
| `/cursor` | Report the current pointer coordinate |
| `/click <x> <y>` | Real mouse click. Add `right` or `double` |
| `/type <text>` | Type into whatever window has focus |
| `/press <key>` | One key — `enter`, `tab`, `esc` |
| `/hotkey <combo>` | e.g. `ctrl+s`, `alt+tab` |
| `/scroll <n>` | Positive = up, negative = down |

### A first run

```
/automation arm
/cursor                  → 🖱 Pointer is at (840, 512).
/click 840 512
/type Hello Commander
/hotkey ctrl+s
```

Every command previews the plan and asks before touching anything.

---

## The safety model

Four independent layers. All are enforced **server-side**, in `automation.py`
— never in the browser, which the AI can influence.

1. **Off by default.** Needs `--allow-actions`, the permission, *and* arming.
2. **Kill switch.** Slam the pointer into the **top-left corner** to abort
   instantly. pyautogui's FAILSAFE — never disabled.
3. **Auto-expiry.** Arming lapses after 15 minutes of inactivity.
4. **Preview + confirm.** Every plan is described in plain English and needs
   your approval. The server rejects unconfirmed plans regardless.

Also enforced:

- **Step budget** — max 40 steps. No loops, no recursion.
- **Typed text is data.** It is typed literally and can never contain key
  combinations; `hotkey` is a separate, allowlisted step type.
- **Hotkey blocklist**, permanent and unconditional:
  `alt+f4`, `ctrl+alt+del`, `ctrl+shift+esc`, `win+r`, `win+l`, `win+x`,
  `win+e`, `cmd+q`, `cmd+option+esc`, `alt+shift+delete`.

```
/hotkey alt+f4
⚠ Plan rejected:
Step 1: blocked combination (alt+f4) — it can close windows or lock the machine.
```

---

## Honest limitations

- **`/click` needs absolute screen coordinates.** AURA cannot yet look at
  the screen and decide where to click on its own. Use `/cursor` to read a
  coordinate off your own pointer. Screenshot → vision model → "click the
  Save button" is the natural next step now that `/look` works, but it is
  **not built**.
- **Typing goes to whatever window has focus** — AURA does not choose the
  target window. Focus it yourself first.
- **No `close_app` or window management.** Those need a native companion
  process; the browser cannot do it.
- **Not verified on real hardware.** The sandbox this was developed in has
  no display, so pyautogui could not be installed there. Validation, the
  blocklist, arming and every refusal path are tested (17 assertions in
  `tests/test-automation-ui.py`, deliberately run *without* pyautogui). The
  actual pixel-level clicking has only ever run on your machine — tell me
  what breaks.

---

## Troubleshooting

**Badge says NOT INSTALLED**
`pip install pyautogui`, then restart `serve.py`. Confirm with
`python -c "import pyautogui; print(pyautogui.size())"`.

**"No action bridge"**
You started without `--allow-actions`.

**"Input automation is not armed"**
`/automation arm`. Note it expires after 15 minutes.

**Clicks land in the wrong place**
Windows display scaling (125%/150%) makes reported coordinates differ from
physical pixels. Compare `/cursor` against the real pointer; if they
disagree, set Scale to 100% or use `/cursor` to sample coordinates.

**Nothing happens, no error**
Check the `serve.py` console — server-side refusals are printed there.

---

# Screen Awareness (Copilot-Vision style)

## Why not a floating overlay

AURA runs on `localhost` in a browser. A web page **cannot draw itself on
top of other applications** — only a native process can. Rather than fake
it, AURA uses the browser's own screen-capture API:

- **The browser** shows the picker. AURA never chooses what to capture.
- **You** pick: a browser tab, an application window, or an entire screen.
- A persistent "sharing" indicator stays visible the whole time.
- One click stops it, from the browser chrome, at any moment.

Practical setup: keep AURA on a second monitor (or a second window) and
share the app you are working in.

## Commands

| Command | Does |
|---|---|
| `/watch` | Start sharing — the browser asks which surface |
| `/watch ask <question>` | Ask about what is currently shared |
| `/watch status` | What is shared, which model reads it, is clicking possible |
| `/watch stop` | Stop |
| `/screenmode auto\|ocr\|vision` | How the screen gets read |
| `/find <text>` | Locate an element and park the pointer on it |
| `/do <instruction>` | Plan an ordered set of UI actions, preview, confirm |

Or just type `@screen` in the composer.

## The two-stage pipeline (fast by default)

```
screen ──▶ small image→text model ──▶ text ──▶ fast chat model ──▶ answer
           (moondream 1.7B)                    (gemma2:2b)
```

Most screen questions are really **text** questions — "what does this error
say", "summarise this page". Running a 12B multimodal model for those is
waste. A 1.7B read plus a 2B answer is dramatically faster on a modest
machine.

| Mode | Behaviour |
|---|---|
| `auto` *(default)* | Text questions take the cheap path; colour/layout/icon questions go to full vision |
| `ocr` | Always transcribe first. Lowest latency. |
| `vision` | Always send the picture to a multimodal model. Highest fidelity. |

Reader models are picked smallest-first from what you **actually** have:
`moondream` → `smolvlm` → `granite3.2-vision` → `minicpm-v` → `qwen-vl` →
`llava`. Nothing is assumed or auto-pulled.

If you want the fastest possible setup: `ollama pull moondream` (1.7 GB).

## Frame rate

1 fps requested, and frames are **pulled** only when something asks. A screen
is nearly static; capturing at 30 fps would burn CPU for nothing.

Watch mode adds a 16×16 luma hash and only reacts when ≥6% of cells change,
so an idle screen costs almost nothing. Frames go out as JPEG downscaled to
≤1280px — about **12 KB**, versus 2–4 MB for a raw PNG screenshot.

## How AURA decides where to click

This was the hard part, and here is the honest answer.

**Language models are bad at pixel coordinates.** Ask one for "the x,y of the
Save button" and you get confident, wrong numbers. So AURA never asks.

Instead the frame is overlaid with a **labelled 12×8 grid** before it is sent.
The model only has to name a *cell* — "C4" — which is a far easier judgement
than a pixel. AURA then computes the centre of that cell itself. The
arithmetic is ours; only the coarse identification is the model's.

```
/find Save
🎯 "Save" is around cell C4 → screen (1173, 472).
🖱 Pointer moved there — check it is right before clicking.
```

Three safeguards on top:

1. **`/find` never clicks.** It moves the pointer so you can see where AURA
   thinks the target is.
2. **Accuracy is reported as coarse**, not presented as exact.
3. **`/do` shows every resolved coordinate** before executing, and still
   requires automation to be armed and confirmed.

### It refuses when it cannot be sure

Coordinates are only mapped when you share an **entire monitor**. A window or
tab capture has no fixed relationship to desktop pixels, so:

```
/find Save
⚠ You are sharing an application window. Coordinates from a window or tab
  do not map to desktop pixels, so AURA will not guess where to click.
  Re-share and choose "Entire Screen" to enable clicking.
```

## Acting on the screen

```
/automation arm
/watch                      → choose "Entire Screen"
/do save the file and close the dialog
```

`/do` runs: transcribe screen → ask the chat model for an ordered JSON step
list (max 8) → resolve every click target via the grid → show the plan →
confirm → execute through the same validated automation pipeline.

```
AURA plans to do this on your screen:
1. Click "Save" — cell C4, screen (1173, 472)
2. Press CTRL+S
Targets were located with a coarse grid — verify they look right.
Kill switch: slam the pointer into the TOP-LEFT corner.
```

## Honest limitations

- **Grid accuracy is unmeasured on real applications.** The sandbox has no
  real desktop. Expect to tune `GRID_COLS`/`GRID_ROWS` in
  `js/ai/screen-agent.js`. Small dense UI elements are the weak case.
- **Small OCR models miss things.** If `/watch ask` gives a poor answer, try
  `/screenmode vision` — slower, more accurate.
- **No true overlay**, for the reason at the top of this section.
- **`/do` is capped at 8 steps** and cannot loop.

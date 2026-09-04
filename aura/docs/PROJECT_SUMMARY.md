# AURA — Project Summary

## Overview
AURA is a desktop AI assistant with voice, vision, gestures, and device awareness. It runs locally with Ollama as the default engine and can optionally connect to cloud AI providers. The system is architected in 5 layers: Frontend → Application Core → Action/Tool → Local Runtime → Platform.

## How to Run
```powershell
python server/serve.py                    # http://localhost:8000
python server/serve.py --allow-actions    # + desktop control, web search, automation
python server/serve.py --allow-actions --allow-lan   # + reachable from your phone
```

## Available Pages & Routes

### Main Application (`/`)
The primary AURA interface at `http://localhost:8000` (`index.html`). Contains:
- **Top bar**: System status, FPS, avator, statistics
- **Left dock**: Module shortcuts (CHAT, VISION, LIVE, DEV, SYSTEM, WARDROBE)
- **Center stage**: Avatar with HUD, live captions, activity feed
- **Right panels**: Collapsible panels (CHAT, VISION, GESTURES, COMMAND CENTER, WARDROBE, INNOVATIONS)
- **MIC & VOICE toggles** at the dock

### AURA Live (`/screen` or `/live`)
Full-screen control & vision interface at `http://localhost:8000/screen` (`live.html`). Contains:
- **Hero section**: Screen sharing controls, statistics, reticle marker
- **ASK view**: Ask questions about the current screen
- **FIND view**: Locate elements on screen with 12×8 grid
- **ACT view**: Run one-shot tasks or agent loops
- **DESKTOP view**: Active windows, virtual workspaces, capabilities
- **TRACE view**: Activity log of model calls and decisions
- **SETTINGS view**: Vision AI engine, capture settings, marker style

### Android Companion (`/phone` or `/companion`)
Phone pairing and control interface at `http://localhost:8000/phone`. Features:
- Device pairing with 6-digit code
- Paired device list
- File generation folder settings

### Developer (`/dev`)
Development and diagnostics page at `http://localhost:8000/dev`. Contains:
- Runtime pipeline trace (USER → INTENT → PLANNER → VISION → RUNTIME → DESKTOP)
- Event logs and command monitoring
- Ollama live capabilities

## API Endpoints (`/api/*`)

### Voice & Wake Word
- `/api/voice/status` - Voice service status
- `/api/voice/devices` - Audio input devices
- `/api/voice/events` - Wake word event stream
- `/api/voice/wake` - POST endpoint for wake word detection

### AI & Models
- `/api/version` - Version info + actions status + Ollama status
- `/api/status` - Consolidated subsystem health check
- `/api/health` - Subsystem health
- `/api/ollama/status` - Ollama proxy status
- `/api/ollama/catalog` - Available Ollama models

### Desktop & Actions
- `/api/apps` - List detected applications (requires auth)
- `/api/action` - Dispatch desktop actions (requires auth)
- `/api/devices` - Device gateway (host token authenticated)
- `/api/device/pair` - Device pairing
- `/api/fetch` - CORS-proxied fetch for allowed hosts

### System & Metrics
- `/api/metrics` - CPU, RAM, disk, GPU telemetry (requires psutil)
- `/api/token` - Authentication token for action bridges

## Key Configuration Files

| File | Purpose |
|---|---|
| `../js/core/config.js` | Client-side persistent config (localStorage) |
| `../voice/wake_phrases.json` | Wake word phrases and settings |
| `../voice/wake_service.py` | Python wake word detection service |
| `../server/serve.py` | Main HTTP server with all API routes |
| `../js/config.js` (DEFAULTS) | Default configuration values |

## Voice System
- **STT**: Web Speech API (Chrome/Edge/Safari) with faster-whisper fallback
- **TTS**: Web Speech Synthesis with viseme lip-sync
- **Wake Word**: openWakeWord (Porcupine) + custom phrase matching (faster-whisper)
- **Half-duplex**: Microphone automatically mutes during TTS to prevent echo
- **Auto-send**: `autoSendOnFinal` config option — when enabled, AURA automatically sends final transcripts to AI and stops listening

## Test Suite
- 64 test files with 2685 assertions
- Run all: `../tests/run-all.sh` (from this folder) or `tests/run-all.sh` from `aura/`
- Node tests: `node ../tests/test-core.mjs` (no browser needed)
- Python tests: `python ../tests/test-bridge-security.py`

## Architecture Layers
1. **Frontend** (../js/main.js, ui/, avatar/, ../css/) — UI, avatar, visualisations
2. **Application Core** (../js/core/, ../js/ai/) — bus, state, config, plugins, AI orchestration
3. **Action/Tool** (../js/desktop/action-manager.js) — schema validation, permissions, rate limits
4. **Local Runtime** (../js/runtime/) — OS boundary, hardware providers, local services
5. **Platform** (../server/serve.py, ../server/bridge.py) — Windows-specific implementations

## Security Model
- All dangerous decisions made server-side in server/serve.py
- Browser proposes, Python disposes
- AI layer never imports platform code directly — goes through tool layer
- Action bridge requires authentication token
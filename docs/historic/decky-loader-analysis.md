# Decky Loader Analysis

## How Decky Loader Works

Decky Loader is a three-layer system:

### 1. Python Backend (systemd Service)

- Python process using `aiohttp` for async HTTP + WebSocket
- Runs as a systemd service on ports 1337/8080
- Connects to CEF debug endpoint on startup
- Injects compiled frontend bundle into the `SharedJSContext` tab
- Hosts local HTTP/WebSocket server for plugin communication
- Manages plugin lifecycle (load, unload, reload)
- Runs each plugin's Python backend in its own isolated process

### 2. Frontend Injection (TypeScript/React)

- Injected into Steam's `SharedJSContext` tab (a non-visual tab where `window.SteamClient` lives)
- Accesses Valve's internal React component tree and router
- Hooks into the QAM (Quick Access Menu) using monkey-patching
- Original approach: overwrites `Array.push` to intercept QAM list entries and inject the Decky plug icon

### 3. Python-React Bridge

Communication flow:
1. TSX calls Decky API
2. HTTP/WebSocket request to Python backend on localhost
3. Python routes to correct plugin subprocess
4. JSON result returned to frontend

## Why Python Was Chosen

**Pragmatism, not architecture.** The original developer was working with Python at the time and has acknowledged it as one of the project's biggest tech debts, noting it might be more elegant if backends were TypeScript like the frontends.

**Side benefits:**
- Easy for plugin authors to pick up
- Huge ecosystem for system-level work
- Good async support via asyncio/aiohttp

**Cost:**
- Mixed-language plugin model: TSX for UI + Python for backend with JSON serialisation between them
- Plugin authors must know both languages
- No shared types between frontend and backend

## How the React Layer Works

Steam's UI is a full React app compiled with webpack. Decky exploits this:

1. **Webpack chunk registry** — Finds Valve's internal `webpackChunksteamui` at runtime
2. **Component extraction** — The `@decky/ui` library re-exports discovered internal components (SliderField, Router, etc.)
3. **QAM patching** — Patches the QAM's render function to include Decky's plugin tab
4. **Known fragility** — A Valve update once broke router/navigation code, requiring wrapper fixes. QAM patches at one point caused Steam to recreate the QAM surface on every open, triggering a Gamescope bug that could crash the Deck

## Decky's Limitations

### Structural

- **Mixed-language plugins** — Python backend + TSX frontend creates friction and prevents shared types
- **Single-process Python backend** — A crashed plugin can take down the whole loader
- **No inter-plugin API/event bus** — Plugin subprocess model makes communication awkward
- **No plugin permissions model** — Any plugin can access anything
- **No tree-shaking or code splitting** per plugin
- **Python version pinned to SteamOS** — Causes dependency conflicts
- **Frontend and backend loosely coupled** by convention, not contract
- **Update model is Decky-controlled** — No independent plugin release cadence

### Fragility

- Every SteamOS update risks breaking injected hooks
- Sometimes disappears entirely on SteamOS updates, requiring reinstallation
- CEF remote debugging port conflicts with other services (e.g., Syncthing on port 8080)
- CEF injection is fire-and-forget — no loader-level reaction to Steam state changes

### Capability Constraints

- Plugins largely constrained to **QAM sidebar panel** and **CSS overrides**
- Toast notifications required heroic effort — Valve's toast notifier uses pre-formatted Protobuf messages; Decky had to inject a custom generic toast component (extremely fragile)
- No direct access to game processes or Gamescope compositor state

## Millennium Comparison

[Millennium](https://github.com/nicholascioli/Millennium) takes a deeper injection approach:

- **Pre-process injection** — Loads into process memory before Steam even starts
- **Native code layer** — Exists before CEF process initialises, enabling I/O blocking and hooks
- **Port randomisation** — Can virtually enable and randomise the CEF remote debugger port without writing files to disk
- **HTTP interception** — Supports overwriting and modifying HTTP requests through Steam's web browser
- **Better webpack hooks** — More robust approach to finding and patching webpack modules than Decky
- **Cross-platform** — Works on both Windows and Linux desktop Steam
- **Best documentation** — Best publicly available documentation of Steam's internal component structure
- **Same plugin model** — TypeScript frontend + Python backend with proper React hooks into Steam's module system

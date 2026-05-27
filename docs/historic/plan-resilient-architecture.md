# Plan: Loadout — Resilient Plugin Architecture

## Context

Decky Loader just broke again with a Steam client update. This happens every few months because Decky injects directly into Steam's minified webpack bundles, and any code change invalidates its heuristic finders. Loadout (this project) already has better foundations — but we went further and explored fundamentally different architectural approaches that reduce or eliminate dependence on Steam's internals.

## Research Findings

### Why Decky Breaks
1. Webpack module IDs shift between builds
2. Minified prop/variable names change, breaking search heuristics
3. React component structure changes break fiber walking
4. No fallback — total failure when any injection point breaks
5. Fire-and-forget — no recovery when Steam state changes

### What We Explored (Non-CEF Approaches)
We investigated 10+ alternative approaches: transparent overlays (X11/Wayland), Gamescope atoms, Vulkan layers, LD_PRELOAD, D-Bus, AT-SPI, Electron overlays, Steam shortcuts, file watching, network proxying.

**Conclusion**: On Steam Deck, CEF injection is the **only viable path** for integrated plugin UI. Gamescope is intentionally locked down, Vulkan layers are stripped, wlr_layer_shell isn't exposed. However, the research surfaced a radical architectural shift that dramatically reduces injection fragility.

## The Architecture: Standalone Overlay + Thin Bridge

Instead of injecting entire React apps into Steam's CEF context, we built a **standalone overlay app** (WebKitGTK window) with a **thin CEF bridge** for SteamClient API access and CSS injection.

### How It Works

```
Standalone Overlay (resilient, never breaks)
    │
    ├── Plugin UI rendering (full React, always works)
    ├── Plugin management (install, enable, configure)
    │
    └── Bridge to Steam (optional enhancement)
         ├── SteamClient API calls (stable API surface)
         ├── CSS injection (stable, class-name based)
         ├── DOM injection (fragile, for deep integration)
         └── Component discovery (best-effort)
```

### Why This Is Better Than Decky

| Dimension | Loadout | Decky |
|-----------|-------------|-------|
| Survives Steam updates | Always (overlay), mostly (bridge) | Breaks every few months |
| Plugin DX | Normal React app | Requires webpack/Steam internals knowledge |
| Plugin isolation | Full (error boundary + separate process) | Poor (shared context) |
| Failure mode | Graceful degradation | Total failure |

### Advantages

1. **Immune to Steam updates** — overlay runs in own process, never touches Steam internals
2. **Dramatically simpler codebase** — server went from 560 to 180 lines
3. **Normal plugin developer experience** — write a React app, export a component, done
4. **Real plugin isolation** — crashes show error UI, don't kill Steam
5. **Full UI freedom** — not constrained to QAM sidebar panel
6. **Works everywhere** — any Linux distro, desktop or Deck
7. **Tiered architecture** — CEF injection is optional Tier 2, overlay is always-on Tier 1

### Remaining Challenges

1. **Gamescope overlay integration** — registering as overlay surface in gaming mode via X11 atoms
2. **Show/hide trigger UX** — needs a natural activation gesture
3. **WebKitGTK dependency** — not pre-installed on SteamOS
4. **Two rendering contexts** — if plugins want both overlay and QAM presence
5. **SteamClient API latency** — calls go through bridge (2-3 hops vs direct)
6. **DOM injection fragility** — CSS injection is stable, structural DOM changes are not

### Critical Insight

The bridge failing is **non-fatal**. If Steam updates break DOM injection:
- The overlay still works
- SteamClient API calls still work (Valve's own stable API)
- CSS injection still works (`[class*="readable_prefix"]` selectors)
- Only deep DOM structural changes break — same thing that breaks Decky, except here it's a degraded feature, not total system failure.

## The "Thin Bridge + Iframe" Alternative (Explored, Not Implemented)

We also explored a more radical idea: instead of the standalone overlay, inject only a tiny bridge (~80 lines) into Steam's CEF and render plugin UIs in iframes from localhost. This eliminates all webpack dependency but has postMessage serialization overhead and callback limitations. The standalone overlay approach was chosen as more practical.

## Prior Art

- **YAL**: Desktop launcher with Bun-compiled TSX plugins. Proves "compile plugins on the fly" model.
- **CSS Loader**: Decky plugin for CSS theming. Proves `[class*=]` selectors work for Steam styling.
- **Millennium**: Pre-process injection, more resilient than Decky but requires native code.

## Sources

Research conducted March 2026. Key sources:
- Decky Loader GitHub (SteamDeckHomebrew/decky-loader)
- Millennium GitHub (SteamClientHomebrew/Millennium)
- Gamescope GitHub (ValveSoftware/gamescope)
- MangoHud GitHub (flightlessmango/MangoHud)
- DeckThemes documentation (docs.deckthemes.com)
- Steam browser protocol (Valve Developer Community)
- Chrome DevTools Protocol documentation
- wlr-layer-shell protocol specification

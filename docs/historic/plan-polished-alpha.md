# Plan: Polished Alpha Release

Generated 2026-03-31 via /office-hours + /plan-ceo-review + /plan-eng-review

## Direction

Reversed from Decky DX toolkit (SDK) back to building the loader itself. The SDK approach requires Decky's stability as a target platform. Decky's fragility means an SDK on top of it inherits that fragility. The better path: build the resilient loader first. The SDK work already done (TypeScript plugin API, hot reload, typed RPC) IS the SDK, it just targets our loader.

## Problem Statement

Decky Loader breaks every few months when Valve pushes Steam UI updates. Loadout takes a different approach: standalone overlay for plugin UIs and system control, with optional CEF injection for Steam UI augmentation. The overlay always works. Injection degrades gracefully.

InputPlumber is the successor for input handling on Bazzite. This project fills the gap for plugin extensibility.

## What Makes This Cool

1. **Immune to Steam updates.** Overlay runs in its own WebKitGTK process. Zero dependency on Steam internals for core functionality.
2. **Full-screen plugin UIs.** Decky constrains plugins to a tiny QAM sidebar. We get a full-screen canvas.
3. **Unified hardware + software control.** TDP, fan curves, RGB, CSS theming, ProtonDB badges — all in one system.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Bun Server (hub)                         │
│                     localhost:33820                          │
│                                                             │
│  HTTP Server ─── WebSocket RPC ─── Plugin Manager ─── CEF  │
│  (assets)        (typed)           (lifecycle)       Bridge │
│                                                      (CDP)  │
│  Polkit Helper    Auto-Updater     Input Trigger            │
│  (sysfs TDP)     (GitHub Releases) (keyboard btn)           │
│                                                             │
│  Per-Game TDP Engine                                        │
│  └─ SteamClient.GameSessions → auto-apply TDP on launch    │
└───────────────────────────┬─────────────────────────────────┘
                            │ HTTP/WS
┌───────────────────────────▼─────────────────────────────────┐
│              WebKitGTK Overlay Window                         │
│  Full Overlay (plugin pages, settings, error boundaries)    │
│  Slide-Out Quick Menu (TDP slider, temps, plugin toggles)   │
│  Gamepad Navigation (D-pad=arrows, A=enter, B=back)         │
└──────────────────────────────────────────────────────────────┘
```

## Alpha Scope

### Alpha features — ALL COMPLETE (2026-03-31)

1. **Slide-out quick menu** — `QuickMenu.tsx`, backdrop blur, F10 toggle, auto-dismiss on game launch, gamepad zones
2. **Polkit TDP helper** — `packages/tdp-helper/` with polkit policy, sysfs + ryzenadj backends, 3-30W validation
3. **Per-game TDP profiles** — `tdp-profiles.ts` with debounced writes, game lifecycle (launch/exit), 8 API endpoints _(loader-side dropped in PR #100; live in `plugins/tdp-control/`)_
4. **Gamepad navigation** — Physical gamepad polling (`navigator.getGamepads()`), D-pad/A/B, zone-based focus, Focusable component
5. **Auto-updater** — SHA256 hash verification, atomic replace + rollback, blocked while gaming, 3 API endpoints _(removed in PR #102 — unused; deferred until self-update actually ships)_
6. **Installer + uninstaller** — Two-phase install, distro detection (apt/dnf/pacman/zypper/rpm-ostree), systemd service
7. **Flatpak wrapper** — `flatpak/org.steamloader.Overlay.yml` for WebKitGTK on SteamOS
8. **Error reporting** — `error-reporter.ts` utility, clipboard copy, save to ~/Downloads, global error handlers
9. **CORS + session token auth** — `auth.ts` with Bearer/query param, CORS headers, public/protected routes
10. **Overlay polish** — Error boundaries per plugin, expanded Settings (boot/update/version), CEF status indicator
11. **`bun build --compile` packaging** — `scripts/build.sh` with version stamping from git tags
12. **Tests** — auth.spec (27), tdp-helper.spec, updater.spec (14 new), tdp-profiles.spec (33), atomic-write.spec, install tests (89) _(tdp-helper.spec + updater.spec + tdp-profiles.spec removed in PR #100/#102 with their modules)_

### What was already done (before alpha sprint)

- CSS Theme Editor (full GUI with color pickers, sliders, 7 presets)
- ProtonDB plugin (727-line backend)
- RGB control (working on OneXPlayer Apex)
- Music player with folder browser
- Game browser
- Bun server + WebSocket RPC + hot reload
- File logger with plugin-scoped loggers
- Overlay window + Gamescope atoms (Python/WebKitGTK)
- CEF injector (CDP, component discovery, QAM patching)
- Plugin SDK (useBackend, Steam.* component proxies, typed RPC)
- Permission sandboxing (AsyncLocalStorage-based fetch scoping)
- Storage cleaner path traversal fix (P1 security)

### What NOT to build for alpha

- Companion app
- Plugin store/marketplace (manual install)
- QAM injection into Steam's side panel
- Webpack patching (CSS + SteamClient only)
- Config sync / cloud backup
- D-Bus portal model
- Plugin process isolation (deferred, see below)
- HLTB integration
- First-run onboarding

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| Keyboard button trigger | Steam holds EVIOCGRAB on QAM button. Keyboard button avoids conflict. |
| Honest messaging | "Core never breaks. Steam features reconnect after updates." Not "doesn't break." |
| Hardcoded sysfs path in polkit helper | Prevents path injection. Only writes to `/sys/class/hwmon/*/power*_cap`. |
| Atomic writes for all persistence | Power loss on battery handhelds is common. Write to .tmp, rename. |
| No timeline pressure | Ship when it ships. No artificial deadline. |
| Plugin process isolation deferred | In-process fine for first-party alpha. Full rewrite needed for child processes (RPC, hot reload, sandboxing). P1 for community plugin support. |
| CORS + session token on RPC | Any website can POST to localhost:33820. Security fix required before alpha. |

## Graceful Degradation

| Feature | CEF connected | CEF unavailable |
|---------|---------------|-----------------|
| CSS themes | Injected into Steam | "Themes will apply when Steam connects" |
| ProtonDB badges | Visible on game tiles | "View ratings in the overlay" |
| SteamClient API | Live data | Cached data + "Last synced: {timestamp}" |
| Per-game TDP | Auto-apply on launch | "Auto-profiles paused: Steam not connected" |
| Overall | Green dot "Connected" | Yellow dot "Bridge offline" |

## Edge Cases Addressed

- Quick menu auto-dismisses when game launches
- TDP slider debounced (100ms, no sysfs flooding)
- Auto-update blocked while game is running
- Game crash restores TDP to default (not just clean exit)
- Hash mismatch on update: keep old binary
- Systemctl restart failure: rollback to old binary

## Security Notes

- Polkit helper: compiled binary, hardcoded path, value-bounds validation only
- RPC endpoint: origin checking + per-session auth token (new for alpha)
- Storage cleaner: validate appId is numeric before constructing paths (TODO P1)
- Plugin sandbox: network fetch scoped per-plugin via AsyncLocalStorage
- All plugins first-party for alpha; process isolation deferred to post-alpha

## Remaining Work (TODOS.md)

| Priority | Item | Effort |
|----------|------|--------|
| P1 | Plugin process isolation (child processes, IPC, hot reload rewrite) | L |
| P2 | First-run onboarding screen | S |
| P2 | Pluggable input trigger backend (InputPlumber awareness) | S |

## Validation

Step 0 (do first): Test Flatpak wrapper on real SteamOS Deck. Goals:
1. Overlay renders
2. Connects to localhost:33820
3. Gamescope atoms work (overlay above games)
4. Survives SteamOS update

If Flatpak fails: try AppImage. If that fails: revisit architecture.

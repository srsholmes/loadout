# TODOS

## P1: Plugin Process Isolation
Spawn plugin backends as child processes instead of in-process imports. Currently `plugin-manager.ts` uses `import(backendPath)` — a crashed plugin kills the server. Requires rewriting: plugin-manager.ts (child process spawn + IPC), rpc-handler.ts (process-level routing), hot-reload (send signals to child processes), and removing AsyncLocalStorage fetch sandboxing (each child has its own fetch).
**Why:** Community plugins need isolation. A third-party plugin crash shouldn't take down the loader.
**Effort:** XL (week+) | **Depends on:** A-001 (loader god-fetch decomposition — see #87)
**Context:** Outside voice correctly identified this as a core infrastructure rewrite, not a parallel task. Deferred from alpha scope after reassessment. **2026-05-12 update**: deferred until community plugins are on the horizon. A-001 unblocks this; both tracked in [#87](https://github.com/srsholmes/linux-gaming-plugin-manager/issues/87) with the 7 design questions that need maintainer decisions before P1 code starts.
**Added:** 2026-03-31 via /plan-eng-review | **Updated:** 2026-05-12 (#87)

## P2: First-Run Onboarding Screen
Welcome screen with 3-step quick tour on first overlay open: quick menu trigger, plugins, settings.
**Why:** Reduces "I installed it but I'm confused" friction for new users.
**Effort:** S (CC: ~15min) | **Depends on:** Overlay polish
**Added:** 2026-03-31 via /plan-ceo-review

## P2: Pluggable Input Trigger Backend — IN PROGRESS
InputPlumber D-Bus client added (`input_plumber.rs`). Detects InputPlumber on the system bus, subscribes to input events via `org.shadowblip.Input.DBusDevice` signals, and manages intercept mode on composite devices. When InputPlumber is active, EVIOCGRAB is skipped and OXP hidraw listeners are bypassed. Evdev/hidraw remain as fallback for non-InputPlumber systems.
**Status:** Code complete, needs testing with live InputPlumber (build from source with OXP PR #567).
**Why:** InputPlumber is the successor on Bazzite (Open Gaming Collective). HHD is deprecated.
**Effort:** S (CC: ~10min) | **Depends on:** Nothing
**Added:** 2026-03-31 via /plan-ceo-review | **Updated:** 2026-04-04

## P2: apex-fixes + input-plumber 5-second sudo poll spam
Both plugins poll the system every ~5s with a flurry of `sudo`-gated
calls: `lsusb -d <vendor>:<product>`, `which inputplumber`,
`inputplumber --version`, `systemctl is-active inputplumber.service`,
`systemctl is-enabled ...`, plus the apex-resume-recover service
checks. The journal becomes essentially unreadable past a few minutes
and authentication-related callsites (pkexec / polkit caches) get
churned harder than they should. Probes are stable per session —
cache the result for at least 30-60 seconds, or move to a
SIGUSR1/inotify-driven refresh path. Surfaced by maintainer
2026-05-12 while inspecting a loadout.service journal slice.
**Effort:** S (per plugin — cap the probe call sites behind a TTL'd cache)
**Depends on:** Nothing
**Added:** 2026-05-12 via runtime journal inspection

## P2: HLTB plugin doesn't render on Steam game pages
HLTB pill never appears on the actual Steam BPM game page even though the plugin loads and the wave-5 audit work (E-013) confirmed the auxiliary fetch paths work in tests. Pre-dates wave-5 — the rename in `E-019` (getCurrentAppId → getCurrentRouteAppId) is not the cause; bug existed before.
**Likely areas to investigate:**
  - The BPM-injected script: is `STEAM_HOOK_SCRIPT` actually patching the right webpack module on current Steam? Check `getElementByXpath` selector + injection target.
  - CDP eval round-trip: `pushBadgeDataToBPM` runs `Runtime.evaluate` against the BPM tab. Confirm the tab discovery resolves the right `webSocketDebuggerUrl` (BPM tab vs SharedJSContext mismatch is the usual culprit — see `project_steam_running_app_detection.md`).
  - Pixel-side: is the badge DOM node mounted but offscreen / behind another element? Inspect via `http://localhost:9222` against the BPM tab.
**Why:** core feature regression; backend looks healthy in tests but never reaches the user.
**Effort:** M (investigation) | **Depends on:** Nothing
**Added:** 2026-05-12 via runtime test after wave-5 build-and-install

## COMPLETED (2026-03-31)

- ~~P1: Storage Cleaner Path Traversal Fix~~ — Fixed. Added `isValidAppId()` numeric validation in `cleanShaderCache()` and `cleanCompatData()`.
- ~~Slide-out Quick Menu~~ — Built with backdrop blur, gamepad zones, auto-dismiss on game launch.
- ~~Gamepad Navigation~~ — Physical gamepad polling + keyboard D-pad/A/B, zone-based focus management.
- ~~Polkit TDP Helper~~ — Shell script + polkit policy in `packages/tdp-helper/`, sysfs + ryzenadj backends.
- ~~Per-Game TDP Profiles~~ — `tdp-profiles.ts` with debounced writes, game lifecycle, 8 API endpoints.
- ~~Auto-Updater~~ — SHA256 hash verification, 3 API endpoints, periodic checks, game-blocking.
- ~~CORS + Session Token Auth~~ — Already existed; confirmed wired correctly.
- ~~Error Reporting~~ — `error-reporter.ts` utility, clipboard copy, save to ~/Downloads, global handlers.
- ~~Overlay Polish~~ — Error boundaries, expanded Settings (boot/update/version), CEF status indicator.
- ~~Installer + Uninstaller~~ — Two-phase install, distro detection, systemd service, idempotent.
- ~~`bun build --compile` Packaging~~ — `scripts/build.sh` with version stamping.

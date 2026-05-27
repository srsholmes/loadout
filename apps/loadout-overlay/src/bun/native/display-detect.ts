// Pick the X11 display this overlay should run on. Must be called BEFORE
// `new BrowserWindow(...)` because Electrobun's GTK/CEF init reads DISPLAY
// via getenv() during window construction — anything later is too late.
//
// Port of overlay_display.rs::detect_gamescope_display from the Tauri
// overlay, minus the /tmp/.X11-unix socket scan (which only matters in
// obscure fallback cases where no session env is around).
//
// Detection order:
//   1. $GAMESCOPE_DISPLAY          (gamescope-session-plus sets this on
//                                    its own process; rarely in systemd
//                                    user env unless imported)
//   2. /proc/<steam-pid>/environ's GAMESCOPE_DISPLAY — Steam inherits
//      the gamescope inner X display, this is the reliable signal when
//      we're running under gamescope-session
//   3. Current $DISPLAY — regular desktop session path
//   4. ":0" — last-resort fallback
//
// We log the chosen value (and why) so it's obvious from the journal
// which branch fired on a given boot.

import { readFileSync, readdirSync } from "node:fs";

function fromGamescopeEnv(): string | null {
  const v = process.env.GAMESCOPE_DISPLAY;
  return v && v.length > 0 ? v : null;
}

function fromSteamEnviron(): string | null {
  // Use /proc instead of `pgrep` so we don't depend on procps being
  // installed (unlikely to be missing, but a spawn every boot is waste).
  let steamPid: number | null = null;
  try {
    for (const entry of readdirSync("/proc")) {
      const pid = Number(entry);
      if (!Number.isFinite(pid)) continue;
      try {
        const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
        if (comm === "steam") {
          steamPid = pid;
          break;
        }
      } catch {
        // Process might have exited between readdir and readFileSync.
      }
    }
  } catch {
    return null;
  }
  if (steamPid === null) return null;

  try {
    const raw = readFileSync(`/proc/${steamPid}/environ`);
    // NUL-separated key=value list.
    for (const entry of raw.toString("utf8").split("\0")) {
      if (entry.startsWith("GAMESCOPE_DISPLAY=")) {
        const value = entry.slice("GAMESCOPE_DISPLAY=".length);
        if (value.length > 0) return value;
      }
    }
  } catch {
    // /proc/<pid>/environ is readable by the owner; if systemd runs us
    // under a different user this will fail silently — fine, fall through.
  }
  return null;
}

export function detectOverlayDisplay(): string {
  const gs = fromGamescopeEnv();
  if (gs) {
    console.log(`[display-detect] using $GAMESCOPE_DISPLAY=${gs}`);
    return gs;
  }

  const fromSteam = fromSteamEnviron();
  if (fromSteam) {
    console.log(
      `[display-detect] using GAMESCOPE_DISPLAY=${fromSteam} from steam /proc env`,
    );
    return fromSteam;
  }

  const display = process.env.DISPLAY;
  if (display) {
    console.log(`[display-detect] using $DISPLAY=${display}`);
    return display;
  }

  console.log("[display-detect] no X display found in env, defaulting to :0");
  return ":0";
}

/**
 * Run detection and mutate process.env.DISPLAY so Electrobun's GTK/CEF
 * init sees the right value when BrowserWindow is constructed. Call this
 * at the top of bun/index.ts, before importing electrobun/bun.
 */
export function applyDetectedDisplay(): string {
  const display = detectOverlayDisplay();
  process.env.DISPLAY = display;
  return display;
}

// ---- Side-effect import hook ------------------------------------------------
//
// ES module semantics resolve imports in source order BEFORE any of the
// importer's own top-level code runs. Electrobun's `electrobun/bun` entry
// dlopens libNativeWrapper.so during its module load, which triggers the
// X11 connection through GTK's ctor path. If we only expose functions
// here, the importer has no opportunity to run them before the electrobun
// import happens.
//
// So we run detection eagerly on module load. `import "./native/display-detect"`
// (before the electrobun import) is all the caller needs — this block fires
// and DISPLAY is already set by the time libNativeWrapper dlopens.
//
// DECK_OVERLAY_DISPLAY_DETECT_SKIP=1 skips it — useful in tests or if the
// caller wants to control detection order manually.
if (process.env.DECK_OVERLAY_DISPLAY_DETECT_SKIP !== "1") {
  applyDetectedDisplay();
}

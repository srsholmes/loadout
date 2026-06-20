// Detect the gamescope display resolution so the overlay window can be
// *born* at the right size. This matters because under gamescope the
// X11 window's coordinate space is the inner (Xwayland) screen: if the
// window is larger than the screen, gamescope scales the visual down to
// fit but routes pointer input in the unscaled window space, so the
// cursor only reaches a corner of the window and clicks land far from
// where they're drawn (issue #106).
//
// We size the window correctly up front rather than resizing it live on
// show(): the gamescope pointer-mapping fix needs the right size *before*
// `new BrowserWindow(...)`, which is why the probe here is synchronous —
// it runs once, inline, at startup. (Historically live resize was also
// unsafe because `GDK_GL=disable` forced software rendering and
// reallocating that surface segfaulted CEF — PR #113; that flag has since
// been removed, so user-driven resize is fine.)
//
// xrandr is the right source (not /sys/class/drm): we want the inner X
// server's screen size — the same space `_positionOnPrimary` queries —
// not the physical panel mode, which can differ from gamescope's
// internal render resolution.

import { spawnSync } from "node:child_process";

export interface ScreenGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ScreenSize {
  width: number;
  height: number;
}

/**
 * Parse an `xrandr --query` dump into the chosen monitor's geometry.
 * Prefers the line marked `primary`; otherwise the first connected
 * output with a concrete `<W>x<H>+<X>+<Y>`. Returns null when no
 * connected output exposes a geometry. Pure — unit-testable directly.
 */
export function parseScreenGeometry(xrandr: string): ScreenGeometry | null {
  // Each monitor line looks roughly:
  //   "<name> connected [primary] <W>x<H>+<X>+<Y> ..."
  const geomRe = /(\d+)x(\d+)\+(\d+)\+(\d+)/;
  let primary: RegExpMatchArray | null = null;
  let firstConnected: RegExpMatchArray | null = null;
  for (const line of xrandr.split("\n")) {
    if (!line.includes(" connected")) continue;
    const m = line.match(geomRe);
    if (!m) continue;
    if (line.includes(" primary ")) {
      primary = m;
      break;
    }
    if (!firstConnected) firstConnected = m;
  }
  const m = primary ?? firstConnected;
  if (!m) return null;
  return {
    w: Number(m[1]),
    h: Number(m[2]),
    x: Number(m[3]),
    y: Number(m[4]),
  };
}

/**
 * Query the gamescope inner-X screen size synchronously via xrandr.
 * Returns null on any failure (xrandr missing, non-zero exit, or no
 * connected geometry) so the caller can fall back to a sane default.
 * Mirrors the env-prefixed invocation `_positionOnPrimary` uses so both
 * talk to the same display.
 */
export function detectGamescopeScreenSizeSync(
  display: string,
): ScreenSize | null {
  try {
    const res = spawnSync(
      "env",
      [`DISPLAY=${display}`, "xrandr", "--current", "--query"],
      { encoding: "utf8", timeout: 2000 },
    );
    if (res.status !== 0 || !res.stdout) return null;
    const geom = parseScreenGeometry(res.stdout);
    if (!geom || geom.w <= 0 || geom.h <= 0) return null;
    return { width: geom.w, height: geom.h };
  } catch {
    return null;
  }
}

// Diagnostic logger for the overlay hot path.
//
// Under Electrobun's CEF-integrated event loop, Bun's stdout is block-
// buffered against the systemd journal socket — `console.log` from the
// toggle / reclaim / input-intercept hot path doesn't flush for minutes.
// `process.stderr.write` had the same fate on-device. `fs.appendFileSync`
// via `require("fs")` is the one path empirically verified to land
// immediately, so we use that.
//
// Trace file lives in the repo root by default so the dev workflow
// keeps a copy in the working tree for diagnosis. Also echoed to
// stdout for the off chance someone's reading journalctl.
//
// `LOADOUT_TRACE_FILE` env var overrides the path; otherwise
// fall back to `${tmpdir}/loadout-overlay.trace` so the appendSync
// doesn't silently ENOENT on machines without the maintainer's repo
// layout (audit B-021).
//
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TRACE_FILE =
  process.env.LOADOUT_TRACE_FILE ??
  join(tmpdir(), "loadout-overlay.trace");

export function trace(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`;
  // stdout for anyone watching journalctl. Buffered but harmless.
  try {
    console.log(msg);
  } catch {}
  // File sink — the reliable one.
  try {
    appendFileSync(TRACE_FILE, line);
  } catch {}
}

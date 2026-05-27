// Suspend / resume the Steam process while the overlay is open, so
// gamepad and keyboard events can't bleed through to the game underneath.
// Port of src-tauri/src/process_control.rs from the Tauri overlay.
//
// Only the main `steam` PID is frozen — NOT the game process, NOT
// steamwebhelper (a child of steam that shows the UI). Game continues
// running in the background; the OS just stops delivering input events
// while its parent Steam is in TASK_STOPPED state.
//
// Pair this with native/f16-watcher.ts (+ the upcoming controller grab)
// so input is blocked at two layers: evdev-grab on the controller
// device AND process-level SIGSTOP on Steam.

import { readdirSync, readFileSync } from "node:fs";
import { libc } from "./ffi";

// From <signal.h> on Linux amd64/arm64. Don't use kill(2)'s string
// names via a spawn — we're already in a hot path during overlay
// toggle, and bun:ffi kill() is a direct syscall.
const SIGTERM = 15;
const SIGKILL = 9;
const SIGCONT = 18;
const SIGSTOP = 19;

/**
 * Scan /proc for a process whose comm is exactly "steam". Steam's
 * kernel comm name is 5 chars, so the 15-char TASK_COMM_LEN limit
 * is a non-issue. We deliberately ignore steamwebhelper (15-char
 * truncated to "steamwebhelper" — no match) and anything starting
 * with "steam" that isn't exact.
 */
export function findSteamPid(): number | null {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return null;
  }
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    let comm: string;
    try {
      comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    } catch {
      // Process gone between readdir and readFile — normal, skip.
      continue;
    }
    if (comm === "steam") return pid;
  }
  return null;
}

/**
 * Send a signal to a pid via libc kill(2). Returns true on success.
 * Non-throwing: on permission error or ESRCH we log and return false
 * so the caller can continue (overlay should NOT become unusable just
 * because we failed to freeze Steam — input grab is the backup).
 */
function sendSignal(pid: number, sig: number, label: string): boolean {
  if (pid <= 0) return false;
  const rc = libc.symbols.kill(pid, sig);
  if (rc !== 0) {
    console.warn(
      `[process-control] kill(${pid}, ${label}) failed (rc=${rc})`,
    );
    return false;
  }
  return true;
}

/** SIGSTOP the given PID. Caller is responsible for remembering it
 *  and calling resume() later — an unpaired suspend leaves Steam
 *  frozen for the rest of the session. */
export function suspendSteam(pid: number): boolean {
  const ok = sendSignal(pid, SIGSTOP, "SIGSTOP");
  if (ok) console.log(`[process-control] suspended Steam (PID ${pid})`);
  return ok;
}

/** SIGCONT the given PID. Safe to call even when the process was
 *  never suspended (kernel no-ops) — useful on overlay-service
 *  shutdown to ensure we don't leave users with a frozen Steam. */
export function resumeSteam(pid: number): boolean {
  const ok = sendSignal(pid, SIGCONT, "SIGCONT");
  if (ok) console.log(`[process-control] resumed Steam (PID ${pid})`);
  return ok;
}

/** SIGTERM the given PID. Used by the "Restart Steam" maintenance
 *  action when `steam -shutdown` doesn't clean up in time. */
export function terminateSteam(pid: number): boolean {
  const ok = sendSignal(pid, SIGTERM, "SIGTERM");
  if (ok) console.log(`[process-control] terminated Steam (PID ${pid})`);
  return ok;
}

/** SIGKILL the given PID. Last-resort path for a fully wedged Steam
 *  that ignored both `steam -shutdown` and SIGTERM. */
export function killSteam(pid: number): boolean {
  const ok = sendSignal(pid, SIGKILL, "SIGKILL");
  if (ok) console.log(`[process-control] killed Steam (PID ${pid})`);
  return ok;
}

/** kill(pid, 0) probes whether a PID is still deliverable without
 *  actually signaling it. Returns false on ESRCH / dead process. */
export function isPidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  return libc.symbols.kill(pid, 0) === 0;
}

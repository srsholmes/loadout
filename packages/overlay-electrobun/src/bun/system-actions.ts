// System-level RPCs that shell out to systemctl. Extracted from index.ts
// so the polkit-gated side (poweroff / reboot) is in one place rather
// than threaded through the much larger RPC handlers block. The
// `restartServer` RPC also lives here because it's the same shape —
// systemctl --user restart loadout — even though it doesn't go
// through polkit.
//
// runSystemctl() is exported so the smaller handlers (systemShutdown /
// systemReboot) can stay one-liners in the index.ts handler builder.

import { runFull } from "@loadout/exec";

/**
 * Run `systemctl <args…>` and report success/stderr. Used by the
 * shutdown / reboot RPC handlers. System-scope (no --user), so it
 * relies on polkit allowing the session user to power off — default
 * on Bazzite and any sane desktop distro.
 */
export async function runSystemctl(
  args: readonly string[],
): Promise<{ success: boolean; error?: string }> {
  try {
    const { stderr, exitCode } = await runFull(["systemctl", ...args]);
    if (exitCode !== 0) {
      console.warn(`[overlay] systemctl ${args.join(" ")} failed:`, stderr);
      return { success: false, error: stderr.trim() || `exit ${exitCode}` };
    }
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[overlay] systemctl ${args.join(" ")} threw:`, err);
    return { success: false, error: msg };
  }
}

/**
 * Power off the machine via `systemctl poweroff`. Delegated to systemd
 * — relies on polkit letting the session user authorize a system-level
 * operation (default on Bazzite/Deckify).
 */
export async function systemShutdown(): Promise<{
  success: boolean;
  error?: string;
}> {
  return runSystemctl(["poweroff"]);
}

/**
 * Reboot the machine via `systemctl reboot`. Same polkit caveat as
 * `systemShutdown`.
 */
export async function systemReboot(): Promise<{
  success: boolean;
  error?: string;
}> {
  return runSystemctl(["reboot"]);
}

/**
 * Restart the backend loadout.service so plugins rescan their
 * hardware from scratch. Useful when a plugin (e.g. fan-control)
 * ended up in a degraded state — stuck on a fallback backend, missed
 * a kernel module that loaded late, etc. Runs `systemctl --user
 * restart loadout` and reports whether the command exited 0.
 * The overlay itself isn't restarted; the webview will show the
 * WebSocket disconnecting and reconnecting on its own.
 */
export async function restartServer(): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const { stderr, exitCode } = await runFull([
      "systemctl",
      "--user",
      "restart",
      "loadout",
    ]);
    if (exitCode !== 0) {
      console.warn("[overlay] restartServer failed:", stderr);
      return { success: false, error: stderr.trim() || `exit ${exitCode}` };
    }
    console.log("[overlay] loadout.service restarted via RPC");
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[overlay] restartServer threw:", err);
    return { success: false, error: msg };
  }
}

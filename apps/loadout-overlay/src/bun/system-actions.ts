// System-level RPCs that shell out to systemctl. Extracted from index.ts
// so the polkit-gated side (poweroff / reboot) is in one place rather
// than threaded through the much larger RPC handlers block. The
// `restartServer` RPC also lives here because it's the same shape —
// systemctl --user restart loadout — even though it doesn't go
// through polkit.
//
// runSystemctl() is exported so the smaller handlers (systemShutdown /
// systemReboot) can stay one-liners in the index.ts handler builder.

import { runFull, spawn } from "@loadout/exec";

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
 * a kernel module that loaded late, etc.
 *
 * The backend has been a root SYSTEM unit since the installer moved
 * it out of the user session, so the old `systemctl --user restart
 * loadout` here silently stopped working on real installs. We now ask
 * the (root) backend to restart itself via `POST /api/restart`; the
 * legacy systemctl call remains as a fallback for pre-migration
 * user-unit installs where the backend predates that route.
 * The overlay itself isn't restarted; the webview will show the
 * WebSocket disconnecting and reconnecting on its own.
 */
export async function restartServer(): Promise<{
  success: boolean;
  error?: string;
}> {
  const base = `http://127.0.0.1:${process.env.LOADOUT_PORT || 33820}`;
  try {
    // /api/token is the unauthenticated loopback bootstrap — same
    // dance the webview does at boot.
    const tokenRes = await fetch(`${base}/api/token`);
    const { token } = (await tokenRes.json()) as { token?: string };
    if (!token) throw new Error("no session token");
    const res = await fetch(`${base}/api/restart`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      console.log("[overlay] loadout.service restart requested via /api/restart");
      return { success: true };
    }
    // 409 is the route REFUSING (self-update in flight — restarting
    // mid-swap could strand the install), not the route being absent.
    // Surface it instead of falling through to the legacy systemctl
    // path, which on a box with a leftover pre-migration user unit
    // would perform exactly the restart the refusal exists to prevent.
    if (res.status === 409) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return { success: false, error: body?.error ?? "an update is in progress — try again when it finishes" };
    }
    throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.warn(
      "[overlay] /api/restart unavailable, falling back to systemctl --user:",
      err,
    );
  }
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

/**
 * Schedule a restart of the overlay's own user unit via a transient
 * systemd-run unit — a plain child process would die with our cgroup
 * mid-restart. Delayed so the RPC response (and any last status poll)
 * reaches the webview before CEF goes down with us. Shared by the
 * self-updater and restartApp().
 */
export function scheduleOverlayRestart(delayMs = 1200): void {
  setTimeout(() => {
    try {
      spawn(
        ["systemd-run", "--user", "--collect", "systemctl", "--user", "restart", "loadout-overlay"],
        { stdout: "ignore", stderr: "ignore" },
      );
    } catch (err) {
      console.error("[overlay] failed to schedule overlay restart:", err);
    }
  }, delayMs);
}

/**
 * Restart the whole app: the backend loadout.service AND the overlay
 * unit. Used when the user disables plugins — a loaded plugin can't be
 * unloaded in place, and restarting only the backend would sever the
 * overlay's WebSocket, so both go down together and come back clean.
 * The overlay restart is scheduled (not awaited) so this RPC can still
 * resolve to the webview before CEF dies.
 */
export async function restartApp(): Promise<{
  success: boolean;
  error?: string;
}> {
  const res = await restartServer();
  if (!res.success) return res;
  scheduleOverlayRestart();
  return { success: true };
}

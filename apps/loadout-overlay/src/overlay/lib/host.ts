// Overlay RPC shim. Talks to the Electrobun host's Bun side via the
// `__electroview` global installed by overlay-electrobun's webview
// main.tsx. When that global isn't present (standalone `vite dev` or
// unit tests) every call returns a safe default so the UI keeps
// rendering and callers don't need to branch.

const isElectrobun = typeof window.__electrobun !== "undefined";

async function rpcInvoke(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  if (!isElectrobun) return undefined;
  // overlay-electrobun/src/webview/main.tsx constructs an Electroview
  // and stashes it on window. Without it there's no WebSocket
  // transport to the Bun side — rpc.request is a closed-loop stub.
  const requester = window.__electroview?.rpc?.request;
  if (!requester) return;
  const fn = requester[cmd];
  if (typeof fn !== "function") return;
  return await fn(args);
}

/** Liveness ping for the bun-side freeze watchdog. Fire-and-forget — if the
 *  renderer wedges and these stop arriving while Steam is frozen, bun thaws
 *  Steam and force-closes. No-op outside Electrobun. */
export function sendOverlayHeartbeat(): void {
  void rpcInvoke("overlayHeartbeat");
}

export async function showOverlay() {
  return rpcInvoke("show");
}

export async function hideOverlay() {
  return rpcInvoke("hide");
}

export async function toggleOverlay() {
  return rpcInvoke("toggle");
}

export async function isGamescopeMode(): Promise<boolean> {
  const result = await rpcInvoke("isGamescopeMode");
  return result === true;
}


/**
 * Restart the backend `loadout.service` via the Bun host's
 * `systemctl --user restart`. Resolves with whether the restart
 * succeeded. No-op (returns `{ success: false }`) when running outside
 * Electrobun — there's no host to talk to.
 */
export async function restartServer(): Promise<{ success: boolean; error?: string }> {
  const result = await rpcInvoke("restartServer");
  if (!result || typeof result !== "object") {
    return { success: false, error: "Host did not respond" };
  }
  return result as { success: boolean; error?: string };
}

/**
 * Dump the overlay UI's captured console logs and the backend server
 * log into a timestamped file in the user's Downloads folder (#130).
 * The UI logs are collected here from the in-webview ring buffer and
 * shipped to the Bun host, which combines them with the server log on
 * disk and writes the file. No-op (returns `{ success: false }`)
 * outside Electrobun — there's no host to write the file.
 */
export async function exportLogs(): Promise<{
  success: boolean;
  error?: string;
  path?: string;
}> {
  const { getCapturedLogs } = await import("./logBuffer");
  const result = await rpcInvoke("exportLogs", { uiLogs: getCapturedLogs() });
  if (!result || typeof result !== "object") {
    return { success: false, error: "Host did not respond" };
  }
  return result as { success: boolean; error?: string; path?: string };
}

async function rpcResultOrError(
  cmd: string,
): Promise<{ success: boolean; error?: string }> {
  const result = await rpcInvoke(cmd);
  if (!result || typeof result !== "object") {
    return { success: false, error: "Host did not respond" };
  }
  return result as { success: boolean; error?: string };
}

/** SIGCONT the main `steam` process — recovers from a frozen Steam
 *  whose SIGSTOP wasn't paired with a SIGCONT (crashed overlay, etc). */
export async function forceUnfreezeSteam(): Promise<{ success: boolean; error?: string }> {
  return rpcResultOrError("forceUnfreezeSteam");
}

/** Restart the `steam` process. gamescope-session-plus respawns it
 *  via its `--steam` flag, so the overlay and gamescope keep running.
 *  Use after the theme-loader crashes Steam's CEF and SIGCONT alone
 *  isn't enough. */
export async function restartSteam(): Promise<{ success: boolean; error?: string }> {
  return rpcResultOrError("restartSteam");
}

// -- Self-update (issue #173) --------------------------------------------------

export interface UpdateCheckResult {
  available: boolean;
  /** Release tag, e.g. "v0.7.0". */
  tag?: string;
  /** Bare version of the tag, e.g. "0.7.0". */
  latestVersion?: string;
  error?: string;
}

export interface UpdateStatus {
  phase:
    | "idle"
    | "downloading"
    | "verifying"
    | "backend"
    | "swapping"
    | "restarting"
    | "error";
  pct?: number;
  message?: string;
  tag?: string;
}

/**
 * Ask the Bun host whether a newer release is published on GitHub.
 * `installedVersion` should be the backend's `/api/status` version
 * when reachable, else `OVERLAY_VERSION`. Outside Electrobun this
 * reports "not available" so standalone dev keeps rendering.
 */
export async function checkForUpdate(
  installedVersion: string,
): Promise<UpdateCheckResult> {
  const result = await rpcInvoke("checkForUpdate", { installedVersion });
  if (!result || typeof result !== "object") {
    return { available: false, error: "Host did not respond" };
  }
  return result as UpdateCheckResult;
}

/**
 * Start the full self-update to `tag` (download + verify + backend
 * swap + overlay swap + restart). Resolves as soon as the update is
 * ACCEPTED; poll {@link getUpdateStatus} for progress. Terminal
 * phases: "restarting" (success — the overlay is about to bounce)
 * and "error".
 */
export async function applyUpdate(
  tag: string,
): Promise<{ success: boolean; error?: string }> {
  const result = await rpcInvoke("applyUpdate", { tag });
  if (!result || typeof result !== "object") {
    return { success: false, error: "Host did not respond" };
  }
  return result as { success: boolean; error?: string };
}

/** Poll the in-flight update's status. `{ phase: "idle" }` outside
 *  Electrobun or when no update is running. */
export async function getUpdateStatus(): Promise<UpdateStatus> {
  const result = await rpcInvoke("getUpdateStatus");
  if (!result || typeof result !== "object") {
    return { phase: "idle" };
  }
  return result as UpdateStatus;
}

/** `systemctl poweroff`. Polkit-gated on the host side. */
export async function systemShutdown(): Promise<{ success: boolean; error?: string }> {
  return rpcResultOrError("systemShutdown");
}

/** `systemctl reboot`. Polkit-gated on the host side. */
export async function systemReboot(): Promise<{ success: boolean; error?: string }> {
  return rpcResultOrError("systemReboot");
}

// -- Controller shortcut types ------------------------------------------------

export interface ShortcutAction {
  type:
    | "None"
    | "ToggleOverlay"
    | "OpenPlugin"
    /** Show overlay (if hidden) and navigate to /settings. Closes #135. */
    | "OpenSettings"
    /** Show overlay (if hidden) and navigate to home dashboard. Closes #141's
     *  "quick jump out of a plugin" case. */
    | "OpenHome"
    /** Show overlay (if hidden) and flip the on-screen keyboard. From a
     *  game with overlay hidden, this opens both in one press. Closes
     *  #141's "open / close keyboard" case. */
    | "ToggleKeyboard";
  value?: string;
}

export interface ControllerShortcuts {
  guide_a: ShortcutAction;
  guide_b: ShortcutAction;
  guide_x: ShortcutAction;
  guide_y: ShortcutAction;
}

import { getConfigValue, setConfigValue } from "./userConfig";

const CONFIG_KEY = "controllerShortcuts";

export async function getControllerShortcuts(): Promise<ControllerShortcuts> {
  if (!isElectrobun) return loadShortcutsFromStorage();
  const result = await rpcInvoke("getControllerShortcuts");
  return (result as ControllerShortcuts) ?? loadShortcutsFromStorage();
}

export async function setControllerShortcuts(
  shortcuts: ControllerShortcuts,
): Promise<void> {
  // Cache in the user config file so the UI has a value immediately on
  // next open even before the Bun side responds. The Bun side is still
  // the source of truth when running under Electrobun.
  setConfigValue(CONFIG_KEY, shortcuts);
  if (!isElectrobun) return;
  await rpcInvoke("setControllerShortcuts", { shortcuts });
}

function loadShortcutsFromStorage(): ControllerShortcuts {
  const fromConfig = getConfigValue<ControllerShortcuts | undefined>(
    CONFIG_KEY,
    undefined,
  );
  if (fromConfig) return fromConfig;
  return {
    // Guide+A and Guide+Y are reserved by Steam / InputPlumber on Bazzite
    // (QAM and guide menu respectively); binding them causes a focus
    // flicker between our overlay and Steam's UI. Default to None and
    // hide them from the Settings UI.
    guide_a: { type: "None" },
    guide_b: { type: "ToggleOverlay" },
    guide_x: { type: "None" },
    guide_y: { type: "None" },
  };
}

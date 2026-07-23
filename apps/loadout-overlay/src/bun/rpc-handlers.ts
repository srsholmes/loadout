// RPC handler factory for the overlay's BrowserView.defineRPC surface.
// Extracted from index.ts so the wire-up entry point stays focussed on
// constructing the singletons (state, atoms, overlay window, intercept
// handle, shortcuts ref) and threading them through the
// `buildRpcHandlers` factory below.
//
// Why a factory: every handler captures one or more pieces of
// module-global state index.ts owns. Rather than reach back into
// orchestrator bindings (which would couple the two files at the wrong
// seam), the factory takes a `deps` bag and the closures capture that.
// Mutable singletons (`steamPid`, `shortcuts`) are passed as
// `{ current: T }` refs so handlers can read AND write them — same
// pattern lib/ uses elsewhere and shutdown.ts/lifecycle.ts adopts.
//
// `toggleOverlay` is intentionally NOT extracted (B-030 audit note):
// it has the tightest state coupling — reads state, writes state,
// dispatches to atoms+overlay+intercept, and the open/close ordering
// is load-bearing. It stays in index.ts and is forwarded in as a dep
// so the management loop + RPC handlers all dispatch through the same
// closure.

import { readFile } from "node:fs/promises";
import type { Ref } from "./lifecycle";
import {
  findSteamPid,
  resumeSteam,
  terminateSteam,
  killSteam,
  isPidAlive,
} from "./native/process-control";
import { spawn } from "@loadout/exec";
import type { ControllerShortcuts } from "../webview/lib/electrobun";
import {
  validateSetControllerShortcutsParams,
  validateReadSoundFileFilename,
  validateCheckForUpdateParams,
  validateApplyUpdateTag,
} from "./rpc-validation";
import {
  requestShow,
  requestHide,
  requestToggle,
  type OverlayState,
} from "./lib/overlay-state";
import { runRestartSteamLadder } from "./lib/restart-steam";
import {
  checkForUpdate,
  startUpdate,
  getUpdateStatus,
  type UpdateCheckResult,
  type UpdateStatus,
} from "./lib/updater";
import {
  restartServer,
  restartApp,
  systemReboot,
  systemShutdown,
} from "./system-actions";
import { exportLogs } from "./export-logs";

export interface RpcHandlerDeps {
  /** Triple-flag overlay state — read by getOverlayVisibility, mutated
   *  by requestShow/requestHide/requestToggle. */
  state: OverlayState;
  /** User-configurable Guide+A/B/X/Y bindings. Wrapped because the
   *  setControllerShortcuts RPC mutates the value index.ts's onWake()
   *  also reads — both need to see the same instance. */
  shortcuts: Ref<ControllerShortcuts>;
  /** True when running under Gamescope (env var detection). */
  gamescopeMode: boolean;
  /** Resolved Steam UI sounds dir, or null if no Steam install found.
   *  Constant for the session. */
  cachedSteamSoundsPath: string | null;
  /** Cached Steam PID — mutated by forceUnfreezeSteam (sets it on
   *  successful SIGCONT) and restartSteam (clears it after kill so
   *  the next toggle rediscovers the respawned PID). */
  steamPid: Ref<number | null>;
  /** Last time the webview sent an `overlayHeartbeat` (Date.now() ms). The
   *  freeze watchdog in index.ts reads this to detect a hung overlay. */
  lastHeartbeat: Ref<number>;
  /** Flips true on the FIRST real webview heartbeat and stays true.
   *  Gates the `.old` rollback-generation reap in index.ts: unlike
   *  `lastHeartbeat` (which the freeze watchdog re-seeds on every
   *  overlay OPEN, "assume alive"), this can only be set by a webview
   *  that actually rendered and ran JS — the proof the post-update
   *  overlay works. A Guide-press on a crash-looping CEF must NOT
   *  close the rollback window. */
  webviewEverAlive: Ref<boolean>;
}

/**
 * Build the handlers object passed to BrowserView.defineRPC. The
 * return value is shaped to match Electrobun's defineRPC schema
 * (`{ requests: { ... }, messages: { ... } }`). Typed loosely on
 * purpose — defineRPC itself is generic at runtime.
 */
export function buildRpcHandlers(deps: RpcHandlerDeps) {
  return {
    requests: {
      show: async () => {
        requestShow(deps.state);
      },
      hide: async () => {
        requestHide(deps.state);
      },
      toggle: async (): Promise<boolean> => requestToggle(deps.state),
      isGamescopeMode: async () => deps.gamescopeMode,
      // Liveness ping from the webview (~1×/s). The freeze watchdog uses the
      // last-seen time to tell a healthy overlay from a hung one. Fire-and-
      // forget: returns nothing, never throws.
      overlayHeartbeat: async () => {
        deps.lastHeartbeat.current = Date.now();
        deps.webviewEverAlive.current = true;
      },
      getControllerShortcuts: async () => deps.shortcuts.current,
      // BrowserView.defineRPC types every handler as (params?: unknown) => unknown,
      // so we accept unknown and validate the real shape inside. A
      // malformed CEF payload previously crashed the wake path with an
      // opaque TypeError across IPC (audit B-001).
      setControllerShortcuts: async (params?: unknown) => {
        const next = validateSetControllerShortcutsParams(params);
        if (next === null) {
          console.warn(
            "[overlay] setControllerShortcuts ignored — malformed payload",
            params,
          );
          return;
        }
        console.log("[overlay] controller shortcuts updated", next);
        deps.shortcuts.current = next;
      },
      // Restart the backend loadout.service so plugins rescan
      // their hardware from scratch. See system-actions.ts for the
      // /api/restart call.
      restartServer: async (): Promise<{ success: boolean; error?: string }> =>
        restartServer(),
      // Restart the backend AND the overlay unit together. Used when the
      // user disables plugins: a loaded plugin can't be unloaded in place,
      // and a backend-only restart would strand the overlay's WebSocket —
      // so both bounce and come back with the disabled plugin's code gone.
      restartApp: async (): Promise<{ success: boolean; error?: string }> =>
        restartApp(),
      // -- Self-update surface (issue #173) --------------------------------
      // The webview drives the whole flow: check → applyUpdate →
      // poll getUpdateStatus until "restarting" or "error". All the
      // heavy lifting lives in lib/updater.ts.
      checkForUpdate: async (params?: unknown): Promise<UpdateCheckResult> => {
        const installedVersion = validateCheckForUpdateParams(params);
        if (installedVersion === null) {
          return { available: false, error: "malformed checkForUpdate payload" };
        }
        return checkForUpdate(installedVersion);
      },
      applyUpdate: async (
        params?: unknown,
      ): Promise<{ success: boolean; error?: string }> => {
        const tag = validateApplyUpdateTag(params);
        if (tag === null) {
          return { success: false, error: "malformed applyUpdate payload" };
        }
        return startUpdate(tag);
      },
      getUpdateStatus: async (): Promise<UpdateStatus> => getUpdateStatus(),
      // Dump the overlay UI's captured console logs (sent over in the
      // payload) plus the backend server log file into a timestamped
      // file in the user's Downloads folder. See export-logs.ts. Used
      // to collect diagnostics from users reporting issues (#130).
      exportLogs: async (
        params?: unknown,
      ): Promise<{ success: boolean; error?: string; path?: string }> =>
        exportLogs(params),
      // Emergency SIGCONT — finds the "steam" comm PID and resumes it.
      // Exposed as a maintenance button so a user stuck with frozen
      // Steam (e.g. crashed overlay left it TASK_STOPPED, or the
      // close-path SIGCONT landed before the PID got cached) can
      // recover without a reboot. SIGCONT on a running process is
      // harmless, so this is safe to click when nothing is wrong.
      forceUnfreezeSteam: async (): Promise<{ success: boolean; error?: string }> => {
        try {
          const pid = findSteamPid();
          if (pid === null) {
            return { success: false, error: "Steam process not found" };
          }
          deps.steamPid.current = pid;
          const ok = resumeSteam(pid);
          if (!ok) return { success: false, error: `SIGCONT to PID ${pid} failed` };
          return { success: true };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[overlay] forceUnfreezeSteam threw:", err);
          return { success: false, error: msg };
        }
      },
      // Restart the steam process without touching gamescope. Used
      // when applying CSS via the theme-loader plugin crashes Steam's
      // CEF or wedges the steam process and SIGCONT alone can't
      // recover it. gamescope-session-plus runs Steam with --steam,
      // so exiting the process causes the session manager to respawn
      // it; the overlay window and the loader's plugin backends keep
      // running across the restart. Strategy is graceful → forceful:
      // `steam -shutdown` (lets Steam flush library / cloud-sync
      // state) → SIGTERM after 3s → SIGKILL after another 2s.
      //
      // Audit B-022: the ladder itself is in lib/restart-steam.ts so
      // the timing tradeoff is unit-tested without a real Steam.
      restartSteam: async (): Promise<{ success: boolean; error?: string }> => {
        const pid = findSteamPid();
        if (pid === null) {
          return { success: false, error: "Steam process not found" };
        }
        await runRestartSteamLadder({
          trySpawnShutdown: () => {
            try {
              // Fire-and-forget — Steam handles its own shutdown asynchronously.
              spawn(["steam", "-shutdown"], {
                stdout: "ignore",
                stderr: "ignore",
              });
              return true;
            } catch (err) {
              console.warn(
                "[overlay] steam -shutdown spawn failed; jumping to SIGTERM:",
                err,
              );
              return false;
            }
          },
          isPidAlive: () => isPidAlive(pid),
          terminate: () => {
            terminateSteam(pid);
          },
          kill: () => {
            killSteam(pid);
          },
          delay: (ms: number) => new Promise((r) => setTimeout(r, ms)),
        });
        // gamescope-session-plus respawns Steam with a new PID — drop
        // the cached one so the next overlay-open's SIGSTOP/SIGCONT
        // cycle rediscovers it.
        deps.steamPid.current = null;
        console.log(`[overlay] restartSteam fired (old PID ${pid})`);
        return { success: true };
      },
      // Power off / reboot the machine. Delegated to systemd via
      // `systemctl poweroff` / `systemctl reboot` — no --user here,
      // these are system-level operations and rely on polkit letting
      // the session user authorize them (default on Bazzite/Deckify).
      systemShutdown: async (): Promise<{ success: boolean; error?: string }> =>
        systemShutdown(),
      systemReboot: async (): Promise<{ success: boolean; error?: string }> =>
        systemReboot(),
      // Read the current overlay open/close state. Webview calls this
      // on boot, then subscribes to `overlay-visibility` messages for
      // updates. Used to gate in-webview gamepad polling (see
      // packages/overlay/src/hooks/useGamepadInput.ts) — under gamescope
      // overlay.minimize() doesn't flip document.hidden on the page, so
      // rAF keeps running and the Web Gamepad API keeps firing synthetic
      // keyboard events into spatial-nav even though the window is
      // invisible.
      getOverlayVisibility: async (): Promise<{ isOpen: boolean }> => ({
        isOpen: deps.state.isOpen,
      }),
      // Safe reads for Steam UI sounds — ported from commands.rs.
      getSteamSoundsPath: async (): Promise<string | null> =>
        deps.cachedSteamSoundsPath,
      readSoundFile: async (params?: unknown): Promise<Uint8Array> => {
        // Audit B-002: previously called .includes() on `params.filename`
        // without typechecking, throwing an opaque TypeError if a caller
        // passed e.g. `{ filename: 123 }`. Validate up-front instead.
        const filename = validateReadSoundFileFilename(params);
        if (filename === null) {
          throw new Error("Invalid filename");
        }
        if (
          filename.includes("/") ||
          filename.includes("\\") ||
          filename.includes("..")
        ) {
          throw new Error("Invalid filename");
        }
        const ext = filename.split(".").pop() ?? "";
        if (!["wav", "m4a", "mp3", "ogg"].includes(ext)) {
          throw new Error("Unsupported audio format");
        }
        if (!deps.cachedSteamSoundsPath) {
          throw new Error(`Sound file not found: ${filename}`);
        }
        return new Uint8Array(
          await readFile(`${deps.cachedSteamSoundsPath}/${filename}`),
        );
      },
    },
    messages: {},
  };
}

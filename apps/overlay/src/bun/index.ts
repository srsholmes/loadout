// Bun main process for the Loadout overlay. Owns:
//   - the single overlay BrowserWindow (hidden on boot)
//   - the @loadout/server Bun.serve instance (spawned in-process)
//   - RPC handlers registered via Electrobun's defineRPC
//   - the evdev input interceptor (F16 toggle, EVIOCGRAB, NavController)
//   - the X11 / Gamescope atom loop
//   - SIGINT/SIGTERM shutdown
//
// DISPLAY detection must run BEFORE `electrobun/bun` is imported — the
// native wrapper dlopens libNativeWrapper.so on module load and that
// triggers GTK's X11 connection via its ctor. ES module imports run in
// source order, so this side-effect import is first.

import "./native/display-detect";
import { detectOverlayDisplay } from "./native/display-detect";
const DISPLAY = detectOverlayDisplay();

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — resolved at runtime once electrobun is installed.
import { BrowserWindow, BrowserView, GlobalShortcut } from "electrobun/bun";
import type { ControllerShortcuts } from "../webview/lib/electrobun";
import { GamescopeAtoms } from "./native/gamescope-atoms";
import {
  startInputIntercept,
  type InputInterceptHandle,
  type WakeEvent,
} from "./native/input-intercept";
import type { WebviewMessages } from "@loadout/types";
import { findSteamPid, suspendSteam, resumeSteam } from "./native/process-control";
import { trace } from "./native/trace";
import { createOverlayState } from "./lib/overlay-state";
import { routeWake } from "./lib/wake-routing";
import { buildRpcHandlers } from "./rpc-handlers";
import { overlayManagementLoop, shutdown } from "./lifecycle";
import { startServer } from "@loadout/server";
import { join } from "node:path";

// ---- Server (in-process) ---------------------------------------------------
// Boot the HTTP+WS server before opening the window so the webview's first
// fetch of /api/token succeeds.

const projectRoot = process.env.LOADOUT_PROJECT_ROOT ?? process.cwd();
const pluginsDir = process.env.LOADOUT_PLUGINS_DIR ?? join(projectRoot, "plugins");

const serverPromise = startServer({ projectRoot, pluginsDir }).catch((err) => {
  console.error("[overlay] server failed to start:", err);
  process.exit(1);
});

// ---- Desktop dev shortcut ---------------------------------------------------
// Set LOADOUT_OVERLAY_DESKTOP_DEV=1 to start the window visible immediately
// without a QAM press. Gaming-mode / Gamescope uses the hidden+toggle flow.
const DESKTOP_DEV = process.env.LOADOUT_OVERLAY_DESKTOP_DEV === "1";

const state = createOverlayState(DESKTOP_DEV);

const shortcuts: { current: ControllerShortcuts } = {
  current: {
    guide_a: { type: "None" },
    guide_b: { type: "None" },
    guide_x: { type: "ToggleOverlay" },
    guide_y: { type: "None" },
  },
};

function detectGamescopeMode(): boolean {
  return !!process.env.GAMESCOPE_DISPLAY || !!process.env.GAMESCOPE_WAYLAND_DISPLAY;
}
const gamescopeMode = detectGamescopeMode();

// ---- Singleton refs --------------------------------------------------------
const steamPid: { current: number | null } = { current: null };
const pendingResumeTimer: { current: ReturnType<typeof setTimeout> | null } = { current: null };
const intercept: { current: InputInterceptHandle | null } = { current: null };

// ---- RPC + Window ----------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — defineRPC schema is typed generically at runtime.
const rpc = BrowserView.defineRPC({
  handlers: buildRpcHandlers({ state, shortcuts, gamescopeMode }),
});

type RpcSendable = { send?: (name: string, payload: unknown) => void };
function sendToWebview<K extends keyof WebviewMessages>(
  name: K,
  payload: WebviewMessages[K],
): void {
  try {
    (rpc as unknown as RpcSendable).send?.(name, payload);
  } catch (err) {
    console.warn(`[overlay] rpc.send(${name}) failed:`, err);
  }
}

const overlay = new BrowserWindow({
  title: "Loadout Overlay",
  frame: { x: 0, y: 0, width: 1280, height: 800 },
  titleBarStyle: "default",
  transparent: false,
  hidden: !DESKTOP_DEV,
  url: process.env.ELECTROBUN_DEV_URL ?? "views://overlay/index.html",
  rpc,
});

// ---- Gamescope atoms -------------------------------------------------------
const atoms = new GamescopeAtoms({
  display: DISPLAY,
  windowName: "Loadout Overlay",
  forceXprop: process.env.LOADOUT_OVERLAY_FORCE_XPROP === "1",
});

setTimeout(() => {
  atoms.prepare().catch((e) => console.warn("[overlay] atoms.prepare:", e));
}, 500);

// ---- Toggle ----------------------------------------------------------------

function broadcastOverlayVisibility(): void {
  sendToWebview("overlay-visibility", { isOpen: state.isOpen });
}

const SUSPEND_STEAM_ENABLED = process.env.LOADOUT_OVERLAY_SUSPEND_STEAM === "1";
const TOGGLE_DEBOUNCE_MS = 600;
let lastToggleAt = 0;

function toggleOverlay(source: string) {
  const now = performance.now();
  if (now - lastToggleAt < TOGGLE_DEBOUNCE_MS) {
    trace(`[toggle] ${source} → IGNORED (debounced, ${Math.round(now - lastToggleAt)}ms)`);
    return;
  }
  lastToggleAt = now;

  if (state.isOpen) {
    overlay.minimize();
    atoms.hide().catch((e) => console.warn("[overlay] atoms.hide:", e));
    intercept.current?.release();
    if (steamPid.current === null) steamPid.current = findSteamPid();
    if (steamPid.current !== null) {
      const pid = steamPid.current;
      if (pendingResumeTimer.current !== null) clearTimeout(pendingResumeTimer.current);
      pendingResumeTimer.current = setTimeout(() => {
        pendingResumeTimer.current = null;
        resumeSteam(pid);
      }, 250);
    }
    state.isOpen = false;
    broadcastOverlayVisibility();
    trace(`[toggle] ${source} → MINIMIZE`);
  } else {
    if (SUSPEND_STEAM_ENABLED) {
      if (steamPid.current === null) steamPid.current = findSteamPid();
      if (steamPid.current !== null) suspendSteam(steamPid.current);
    }
    intercept.current?.grab();
    overlay.show();
    atoms.show().catch((e) => console.warn("[overlay] atoms.show:", e));
    state.isOpen = true;
    broadcastOverlayVisibility();
    trace(`[toggle] ${source} → SHOW`);
  }
}

// ---- Wake event routing ----------------------------------------------------
function onWake(event: WakeEvent): void {
  const action = routeWake(event, shortcuts.current);
  if (action.kind === "ignore") return;
  if (action.kind === "toggle") {
    toggleOverlay(action.reason);
    return;
  }
  if (!state.isOpen) toggleOverlay(action.reason);
  if (action.kind === "open-plugin") {
    sendToWebview("overlay-open-plugin", { pluginId: action.pluginId });
    return;
  }
  if (action.kind === "open-settings") {
    sendToWebview("overlay-open-settings", {});
    return;
  }
  if (action.kind === "open-home") {
    sendToWebview("overlay-open-home", {});
    return;
  }
  if (action.kind === "toggle-keyboard") {
    sendToWebview("overlay-toggle-keyboard", {});
    return;
  }
}

// ---- Input intercept -------------------------------------------------------
startInputIntercept({
  onWake,
  onAction: (action) => sendToWebview("overlay-action", { action }),
  onAxis: (axis, value) => sendToWebview("overlay-scroll", { axis, value }),
  onReady: (c) =>
    console.log(
      `[overlay] input intercept ready — ${c.controllers} controller(s), ${c.keyboards} keyboard(s), ${c.qam} qam device(s)`,
    ),
})
  .then((handle) => {
    intercept.current = handle;
  })
  .catch((err) => {
    console.error("[overlay] input intercept failed to start:", err);
  });

// ---- Desktop global shortcut backup ----------------------------------------
const TOGGLE_ACCELERATOR =
  process.env.LOADOUT_OVERLAY_TOGGLE ?? "CommandOrControl+Shift+O";
const shortcutRegistered = GlobalShortcut.register(TOGGLE_ACCELERATOR, () =>
  toggleOverlay(TOGGLE_ACCELERATOR),
);
if (!shortcutRegistered) {
  console.warn(
    `[overlay] failed to register ${TOGGLE_ACCELERATOR} global shortcut — ` +
      "another process may already have it grabbed.",
  );
}

// ---- Management loop + shutdown --------------------------------------------
const managementLoopRunning: { current: boolean } = { current: true };

overlayManagementLoop({
  state,
  running: managementLoopRunning,
  toggleOverlay,
}).catch((e) => {
  console.error("[overlay] management loop crashed:", e);
  process.exit(1);
});

function runShutdown(): Promise<void> {
  return shutdown({
    running: managementLoopRunning,
    pendingResumeTimer,
    steamPid,
    atoms,
    intercept,
    globalShortcut: GlobalShortcut,
  });
}
process.on("SIGINT", runShutdown);
process.on("SIGTERM", runShutdown);

// Hold the server reference so it's not GC'd. Server lifecycle is bound
// to the process — shutdown above lets it die with the parent.
serverPromise.then((srv) => {
  if (srv) {
    process.on("exit", () => srv.close());
  }
});

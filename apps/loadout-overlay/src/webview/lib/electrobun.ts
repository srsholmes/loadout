// Electrobun RPC shim. Public API matches @overlay/lib/host so the
// shared React tree can call the same functions regardless of which
// entry point mounted it.

import { getElectroRpc } from "./get-electro-rpc";

const isElectrobun = typeof globalThis.__electrobun !== "undefined";

type OverlayRpc = {
  // Matches the Tauri command names defined in
  // packages/overlay-electrobun/src/bun/index.ts registerRpc().
  show(): Promise<void>;
  hide(): Promise<void>;
  toggle(): Promise<boolean>;
  isGamescopeMode(): Promise<boolean>;
  getControllerShortcuts(): Promise<ControllerShortcuts>;
  setControllerShortcuts(args: { shortcuts: ControllerShortcuts }): Promise<void>;
  getOverlayVisibility(): Promise<{ isOpen: boolean }>;
};

async function rpc(): Promise<OverlayRpc | undefined> {
  if (!isElectrobun) return undefined;
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — resolved at runtime inside the Electrobun webview process.
  const mod = await import("electrobun/view");
  // `Electroview.rpc` is attached at runtime by defineRPC() — its static
  // type doesn't expose it.
  return (mod.Electroview as unknown as { rpc: OverlayRpc }).rpc;
}

export async function showOverlay() {
  return (await rpc())?.show();
}

export async function hideOverlay() {
  return (await rpc())?.hide();
}

export async function toggleOverlay() {
  return (await rpc())?.toggle();
}

export async function isGamescopeMode(): Promise<boolean> {
  const r = await rpc();
  if (!r) return false;
  return r.isGamescopeMode();
}

// -- Controller shortcut types ------------------------------------------------
// Identical to the Tauri version so the UI keeps working unchanged.

export interface ShortcutAction {
  type:
    | "None"
    | "ToggleOverlay"
    | "OpenPlugin"
    | "OpenSettings"
    | "OpenHome"
    | "ToggleKeyboard";
  value?: string;
}

export interface ControllerShortcuts {
  guide_a: ShortcutAction;
  guide_b: ShortcutAction;
  guide_x: ShortcutAction;
  guide_y: ShortcutAction;
}

import { getConfigValue, setConfigValue } from "@overlay/lib/userConfig";

const CONFIG_KEY = "controllerShortcuts";

export async function getControllerShortcuts(): Promise<ControllerShortcuts> {
  const r = await rpc();
  if (!r) return loadShortcutsFromStorage();
  return r.getControllerShortcuts();
}

export async function setControllerShortcuts(
  shortcuts: ControllerShortcuts,
): Promise<void> {
  setConfigValue(CONFIG_KEY, shortcuts);
  const r = await rpc();
  if (!r) return;
  return r.setControllerShortcuts({ shortcuts });
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
    guide_b: { type: "None" },
    guide_x: { type: "ToggleOverlay" },
    guide_y: { type: "None" },
  };
}

// -- Event subscription -------------------------------------------------------
// The Bun-side input interceptor calls `rpc.send("overlay-action", {action})`
// on every NavController emission; we subscribe here and main.tsx turns the
// action into a synthetic KeyboardEvent for norigin-spatial-navigation.

export type OverlayAction =
  | "up" | "down" | "left" | "right" | "a" | "b" | "x" | "x_up" | "y"
  | "lb" | "rb";

/**
 * Subscribe to Bun → webview `overlay-action` messages. Resolves to an
 * unsubscribe function. No-op when running outside Electrobun (webview dev
 * via vite, unit tests, etc).
 */
export async function onOverlayAction(
  handler: (action: OverlayAction) => void,
): Promise<() => void> {
  if (!isElectrobun) return () => {};
  // Electroview instance is stashed on window by main.tsx — reusing it
  // avoids a second bun-socket connection.
  const rpc = getElectroRpc();
  if (!rpc) {
    console.warn("[electrobun] __electroview.rpc missing addMessageListener");
    return () => {};
  }
  const wrapped = (payload: { action: string }) =>
    handler(payload.action as OverlayAction);
  rpc.addMessageListener("overlay-action", wrapped);
  return () => rpc.removeMessageListener?.("overlay-action", wrapped);
}

/**
 * Subscribe to Bun → webview `overlay-scroll` messages emitted on every
 * change of the right-stick analog axes. The webview entry runs a rAF
 * loop with momentum to translate these into smooth scrollBy() on the
 * main content area, independent of which element has spatial-nav focus.
 */
export interface OverlayScrollPayload {
  axis: "RightStickX" | "RightStickY";
  value: number;
}

export async function onOverlayScroll(
  handler: (payload: OverlayScrollPayload) => void,
): Promise<() => void> {
  if (!isElectrobun) return () => {};
  const rpc = getElectroRpc();
  if (!rpc) return () => {};
  const wrapped = (payload: OverlayScrollPayload) => handler(payload);
  rpc.addMessageListener("overlay-scroll", wrapped);
  return () => rpc.removeMessageListener?.("overlay-scroll", wrapped);
}

/** Fetch the current overlay open/close state from the Bun host. */
export async function getOverlayVisibility(): Promise<boolean> {
  const r = await rpc();
  if (!r) return true;
  const { isOpen } = await r.getOverlayVisibility();
  return isOpen;
}

/**
 * Subscribe to Bun → webview `overlay-open-plugin` messages emitted
 * when a controller shortcut bound to OpenPlugin fires. Resolves to
 * an unsubscribe function. No-op outside Electrobun.
 */
export async function onOverlayOpenPlugin(
  handler: (pluginId: string) => void,
): Promise<() => void> {
  if (!isElectrobun) return () => {};
  const rpc = getElectroRpc();
  if (!rpc) return () => {};
  const wrapped = (payload: { pluginId: string }) => handler(payload.pluginId);
  rpc.addMessageListener("overlay-open-plugin", wrapped);
  return () => rpc.removeMessageListener?.("overlay-open-plugin", wrapped);
}

/**
 * Subscribe to `overlay-open-settings`. Fires when the user's
 * controller shortcut is bound to `OpenSettings`. Webview navigates
 * to /settings on receipt; the host already opened the overlay if
 * it was hidden, so the user lands on Settings in one press.
 */
export async function onOverlayOpenSettings(
  handler: () => void,
): Promise<() => void> {
  if (!isElectrobun) return () => {};
  const rpc = getElectroRpc();
  if (!rpc) return () => {};
  const wrapped = () => handler();
  rpc.addMessageListener("overlay-open-settings", wrapped);
  return () => rpc.removeMessageListener?.("overlay-open-settings", wrapped);
}

/**
 * Subscribe to `overlay-open-home`. Fires when the user's controller
 * shortcut is bound to `OpenHome`. Webview navigates to the home
 * dashboard.
 */
export async function onOverlayOpenHome(
  handler: () => void,
): Promise<() => void> {
  if (!isElectrobun) return () => {};
  const rpc = getElectroRpc();
  if (!rpc) return () => {};
  const wrapped = () => handler();
  rpc.addMessageListener("overlay-open-home", wrapped);
  return () => rpc.removeMessageListener?.("overlay-open-home", wrapped);
}

/**
 * Subscribe to `overlay-toggle-keyboard`. Fires when the user's
 * controller shortcut is bound to `ToggleKeyboard`. Webview flips
 * the on-screen-keyboard visibility on receipt.
 */
export async function onOverlayToggleKeyboard(
  handler: () => void,
): Promise<() => void> {
  if (!isElectrobun) return () => {};
  const rpc = getElectroRpc();
  if (!rpc) return () => {};
  const wrapped = () => handler();
  rpc.addMessageListener("overlay-toggle-keyboard", wrapped);
  return () => rpc.removeMessageListener?.("overlay-toggle-keyboard", wrapped);
}

/**
 * Subscribe to Bun → webview `overlay-visibility` messages emitted on
 * every overlay open/close transition. Unsubscribe via the returned fn.
 */
export async function onOverlayVisibility(
  handler: (isOpen: boolean) => void,
): Promise<() => void> {
  if (!isElectrobun) return () => {};
  const rpc = getElectroRpc();
  if (!rpc) return () => {};
  const wrapped = (payload: { isOpen: boolean }) => handler(payload.isOpen);
  rpc.addMessageListener("overlay-visibility", wrapped);
  return () => rpc.removeMessageListener?.("overlay-visibility", wrapped);
}

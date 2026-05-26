// Electrobun RPC shim — typed wrapper around the Bun↔webview message
// channels declared in @loadout/types/webview-messages.
//
// For M1 controller-shortcuts persistence is in-memory only on the Bun side
// (no user config layer yet). Gains disk persistence when @loadout/user-config
// lands in M2.

import { getElectroRpc } from "./get-electro-rpc";

const isElectrobun = typeof globalThis.__electrobun !== "undefined";

type OverlayRpc = {
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

export interface ShortcutAction {
  type: "None" | "ToggleOverlay" | "OpenPlugin" | "OpenSettings" | "OpenHome" | "ToggleKeyboard";
  value?: string;
}
export interface ControllerShortcuts {
  guide_a: ShortcutAction;
  guide_b: ShortcutAction;
  guide_x: ShortcutAction;
  guide_y: ShortcutAction;
}

const DEFAULT_SHORTCUTS: ControllerShortcuts = {
  guide_a: { type: "None" },
  guide_b: { type: "None" },
  guide_x: { type: "ToggleOverlay" },
  guide_y: { type: "None" },
};

export async function getControllerShortcuts(): Promise<ControllerShortcuts> {
  const r = await rpc();
  if (!r) return DEFAULT_SHORTCUTS;
  return r.getControllerShortcuts();
}

export async function setControllerShortcuts(shortcuts: ControllerShortcuts): Promise<void> {
  const r = await rpc();
  if (!r) return;
  return r.setControllerShortcuts({ shortcuts });
}

export type OverlayAction =
  | "up" | "down" | "left" | "right" | "a" | "b" | "x" | "x_up" | "y" | "lb" | "rb";

export async function onOverlayAction(
  handler: (action: OverlayAction) => void,
): Promise<() => void> {
  if (!isElectrobun) return () => {};
  const r = getElectroRpc();
  if (!r) return () => {};
  const wrapped = (payload: { action: string }) => handler(payload.action as OverlayAction);
  r.addMessageListener("overlay-action", wrapped);
  return () => r.removeMessageListener?.("overlay-action", wrapped);
}

export interface OverlayScrollPayload {
  axis: "RightStickX" | "RightStickY";
  value: number;
}

export async function onOverlayScroll(
  handler: (payload: OverlayScrollPayload) => void,
): Promise<() => void> {
  if (!isElectrobun) return () => {};
  const r = getElectroRpc();
  if (!r) return () => {};
  r.addMessageListener("overlay-scroll", handler);
  return () => r.removeMessageListener?.("overlay-scroll", handler);
}

export async function getOverlayVisibility(): Promise<boolean> {
  const r = await rpc();
  if (!r) return true;
  const { isOpen } = await r.getOverlayVisibility();
  return isOpen;
}

export async function onOverlayOpenPlugin(
  handler: (pluginId: string) => void,
): Promise<() => void> {
  if (!isElectrobun) return () => {};
  const r = getElectroRpc();
  if (!r) return () => {};
  const wrapped = (p: { pluginId: string }) => handler(p.pluginId);
  r.addMessageListener("overlay-open-plugin", wrapped);
  return () => r.removeMessageListener?.("overlay-open-plugin", wrapped);
}

export async function onOverlayOpenSettings(handler: () => void): Promise<() => void> {
  if (!isElectrobun) return () => {};
  const r = getElectroRpc();
  if (!r) return () => {};
  r.addMessageListener("overlay-open-settings", handler);
  return () => r.removeMessageListener?.("overlay-open-settings", handler);
}

export async function onOverlayOpenHome(handler: () => void): Promise<() => void> {
  if (!isElectrobun) return () => {};
  const r = getElectroRpc();
  if (!r) return () => {};
  r.addMessageListener("overlay-open-home", handler);
  return () => r.removeMessageListener?.("overlay-open-home", handler);
}

export async function onOverlayToggleKeyboard(handler: () => void): Promise<() => void> {
  if (!isElectrobun) return () => {};
  const r = getElectroRpc();
  if (!r) return () => {};
  r.addMessageListener("overlay-toggle-keyboard", handler);
  return () => r.removeMessageListener?.("overlay-toggle-keyboard", handler);
}

export async function onOverlayVisibility(
  handler: (isOpen: boolean) => void,
): Promise<() => void> {
  if (!isElectrobun) return () => {};
  const r = getElectroRpc();
  if (!r) return () => {};
  const wrapped = (p: { isOpen: boolean }) => handler(p.isOpen);
  r.addMessageListener("overlay-visibility", wrapped);
  return () => r.removeMessageListener?.("overlay-visibility", wrapped);
}

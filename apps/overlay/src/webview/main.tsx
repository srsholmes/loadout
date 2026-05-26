// Electrobun webview entry. Wires:
//   - Electroview instance (so window.__electroview exists for the RPC shim)
//   - Session token fetch → window.__LOADOUT_TOKEN__ → WS connect
//   - Spatial-nav singleton install (shell + plugins share the same focus tree)
//   - Bun→webview channel bridges: visibility, action, scroll, open-plugin, etc.
//   - React root rendering @loadout/overlay-shell's <App/>

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — electrobun/view resolves at runtime.
import { Electroview } from "electrobun/view";

import "@loadout/ui/styles.css";
import "./index.css";

import { createRoot } from "react-dom/client";
import * as React from "react";
import * as ReactJsxRuntime from "react/jsx-runtime";
import * as ReactJsxDevRuntime from "react/jsx-dev-runtime";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as LoadoutUi from "@loadout/ui";

import { App, installSpatialNav } from "@loadout/overlay-shell";
import { ensureConnected, subscribe } from "@loadout/ui";
import {
  onOverlayAction,
  onOverlayOpenPlugin,
  onOverlayOpenSettings,
  onOverlayOpenHome,
  onOverlayToggleKeyboard,
  onOverlayScroll,
  onOverlayVisibility,
  getOverlayVisibility,
  type OverlayAction,
} from "./lib/electrobun";

// Expose React + @loadout/ui as globals so plugin bundles compiled with
// `vendorGlobalsPlugin` resolve to the SAME React instance — sharing hooks
// across plugin React roots requires one canonical React.
window.__LOADOUT_REACT = React;
window.__LOADOUT_REACT_JSX_RUNTIME = ReactJsxRuntime;
window.__LOADOUT_REACT_JSX_DEV_RUNTIME = ReactJsxDevRuntime;
window.__LOADOUT_REACT_DOM = ReactDOM;
window.__LOADOUT_REACT_DOM_CLIENT = ReactDOMClient;
window.__LOADOUT_UI = LoadoutUi;

// Install the shared spatial-navigation singleton on window.__LOADOUT_SPATIAL_NAV.
installSpatialNav();

// Electroview MUST exist so window.__electroview is non-null for the RPC shim.
const electro = new Electroview({
  rpc: Electroview.defineRPC({ handlers: { requests: {}, messages: {} } }),
});
window.__electroview = electro;

// Catch-all error logging so screen-captures + log greps land on a known prefix.
window.addEventListener("error", (e) => {
  console.error(`[window.error] ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`, e.error);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error(`[unhandledrejection]`, e.reason);
});

async function fetchToken(): Promise<string> {
  const res = await fetch("http://127.0.0.1:33820/api/token");
  if (!res.ok) throw new Error(`token fetch failed: ${res.status}`);
  const data = (await res.json()) as { token: string };
  return data.token;
}

async function navigate(hash: string) {
  if (window.location.hash !== hash) window.location.hash = hash;
}

async function boot() {
  console.log("[overlay] boot");
  const token = await fetchToken();
  window.__LOADOUT_TOKEN__ = token;

  const root = createRoot(document.getElementById("root")!);
  root.render(<App />);

  ensureConnected();
  subscribe({
    plugin: "__system",
    event: "reload",
    handler: () => {
      // Plugin source changed on disk — reload to pick up the new bundle.
      location.reload();
    },
  });

  // Bridge Bun→webview channels.
  const actionKeyMap: Record<OverlayAction, { key: string; keyCode: number } | undefined> = {
    up: { key: "ArrowUp", keyCode: 38 },
    down: { key: "ArrowDown", keyCode: 40 },
    left: { key: "ArrowLeft", keyCode: 37 },
    right: { key: "ArrowRight", keyCode: 39 },
    a: { key: "Enter", keyCode: 13 },
    b: { key: "Escape", keyCode: 27 },
    lb: { key: "PageUp", keyCode: 33 },
    rb: { key: "PageDown", keyCode: 34 },
    x: undefined,
    x_up: undefined,
    y: undefined,
  };

  function dispatchVisibility(isOpen: boolean): void {
    window.dispatchEvent(new CustomEvent("loadout:overlay-visibility", { detail: { isOpen } }));
  }
  getOverlayVisibility().then(dispatchVisibility).catch(() => {});
  onOverlayVisibility(dispatchVisibility);

  onOverlayOpenPlugin((pluginId) => navigate(`#/plugin/${pluginId}`));
  onOverlayOpenSettings(() => navigate("#/settings"));
  onOverlayOpenHome(() => navigate("#/"));
  onOverlayToggleKeyboard(() => {
    // M1: no OSK yet. Wire to @loadout/ui keyboard module when it lands.
  });

  await onOverlayAction((action) => {
    window.dispatchEvent(new CustomEvent("loadout:overlay-action", { detail: { action } }));
    const mapping = actionKeyMap[action];
    if (!mapping) return;
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: mapping.key, keyCode: mapping.keyCode, bubbles: true }),
    );
  });

  await startRightStickScroll();
}

// ---- Right-stick scroll engine -------------------------------------------------

const RIGHT_STICK_DEADZONE = 0.15;
const RIGHT_STICK_SPEED = 14;
const SCROLL_FRICTION = 0.85;
const SCROLL_MIN_VELOCITY = 0.5;
const SCROLL_TARGET_TTL_MS = 500;

function isScrollable(node: HTMLElement): boolean {
  const s = getComputedStyle(node);
  return (
    (s.overflowY === "auto" || s.overflowY === "scroll") &&
    node.scrollHeight > node.clientHeight
  );
}

function findMainScrollTarget(): Element | null {
  const main = document.querySelector("main");
  if (!main) return null;
  const candidates = main.querySelectorAll<HTMLElement>("*");
  for (const node of candidates) {
    if (isScrollable(node)) return node;
  }
  return null;
}

async function startRightStickScroll(): Promise<() => void> {
  let stickY = 0;
  let velocity = 0;
  let target: Element | null = null;
  let targetResolvedAt = 0;
  let overlayOpen = true;
  let cancelled = false;
  let rafId = 0;

  function invalidateTarget(): void {
    target = null;
  }

  function onVisibility(e: Event): void {
    const detail = (e as CustomEvent<{ isOpen: boolean }>).detail;
    overlayOpen = detail?.isOpen ?? true;
    if (!overlayOpen) {
      stickY = 0;
      velocity = 0;
      invalidateTarget();
    }
  }

  window.addEventListener("loadout:overlay-visibility", onVisibility as EventListener);
  window.addEventListener("hashchange", invalidateTarget);

  const offScroll = await onOverlayScroll(({ axis, value }) => {
    if (axis === "RightStickY") stickY = value;
  });

  function tick(): void {
    if (cancelled) return;
    if (overlayOpen) {
      if (Math.abs(stickY) > RIGHT_STICK_DEADZONE) {
        velocity = stickY * RIGHT_STICK_SPEED;
      } else {
        velocity *= SCROLL_FRICTION;
        if (Math.abs(velocity) < SCROLL_MIN_VELOCITY) velocity = 0;
      }
      if (velocity !== 0) {
        const now = performance.now();
        if (!target || now - targetResolvedAt > SCROLL_TARGET_TTL_MS) {
          target = findMainScrollTarget();
          targetResolvedAt = now;
        }
        if (target) target.scrollBy({ top: velocity });
      }
    }
    rafId = requestAnimationFrame(tick);
  }
  rafId = requestAnimationFrame(tick);

  return () => {
    cancelled = true;
    cancelAnimationFrame(rafId);
    window.removeEventListener("loadout:overlay-visibility", onVisibility as EventListener);
    window.removeEventListener("hashchange", invalidateTarget);
    offScroll();
  };
}

boot().catch((e) => console.error("[overlay] boot crashed:", e));

// Electrobun webview entry. Pulls the shared React tree in via the
// `@overlay/*` path alias — same App component, same theme, same
// plugin host. Built with Vite (not Electrobun's internal Bun.build) so
// the vite aliases, tailwind, CSS, and JSX pipeline Just Work.
//
// Critical: we must construct an Electroview instance at boot. Without
// it, there's no WebSocket transport to the Bun side and every
// `rpc.request.<cmd>` call dead-ends. The shared React tree's
// lib/host.ts reads the instance off `window.__electroview`.

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — electrobun/view resolves at runtime / via vite.
import { Electroview } from "electrobun/view";

import "@overlay/shared-modules";
import "@overlay/index.css";

import { createRoot } from "react-dom/client";
import { App, navigateOverlay } from "@overlay/App";
import { applyTheme } from "@overlay/components/Settings";
import { initBackend } from "@overlay/lib/backend";
import { getConfigValue, loadUserConfig } from "@overlay/lib/userConfig";
import { runStartupInits } from "@overlay/lib/pluginInit";
import { ensureConnected, subscribe } from "@loadout/ui/ws-client";
import { showOverlay } from "@overlay/lib/host";
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
import { setKeyboardVisible, isKeyboardVisible } from "@loadout/ui";
import {
  RIGHT_STICK_DEADZONE,
  RIGHT_STICK_SPEED,
  SCROLL_FRICTION,
  SCROLL_MIN_VELOCITY,
} from "@overlay/lib/scroll-tuning";

// Outgoing RPC schema — mirrors the handlers.requests surface declared
// in src/bun/index.ts. Electrobun doesn't require us to redeclare names
// here at runtime; the transport forwards whatever we call. We leave
// handlers.requests/messages empty because the webview doesn't receive
// requests (only fires them) and we treat overlay-action events as
// DOM-dispatched KeyboardEvents, not Electroview messages.
const electro = new Electroview({
  // Electroview is imported via @ts-ignore (its module is resolved at
  // runtime), so it's effectively `any` here — `defineRPC` is a static
  // method that lives on the runtime class.
  rpc: Electroview.defineRPC({
    handlers: {
      requests: {},
      messages: {},
    },
  }),
});
// Stashed so @overlay/lib/host can find it without having
// to import `electrobun/view` itself (that module needs browser globals
// that are only set by this file's own import chain).
window.__electroview = electro;

// Apply the persisted theme before first render. `getConfigValue` reads
// from the userConfig in-memory cache, seeded from its localStorage
// mirror at module load — instant on any boot after the first.
applyTheme(getConfigValue<string>("theme", "dark"));

// Catch-all error surfaces — we want every uncaught error to reach the
// dev console with a consistent prefix so `scripts/capture-screenshots`
// and grep over the log can pinpoint the crash site. The PluginHost /
// PluginHeaderHost already log their own lifecycle; this catches
// anything outside that path (async work in plugin code, window-level
// event handlers, etc.).
window.addEventListener("error", (e) => {
  console.error(`[window.error] ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`, e.error);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error(`[unhandledrejection]`, e.reason);
});

/** Payload shape for the `__system / reload` event broadcast by the loader
 *  when a watched plugin / SDK file changes on disk. */
type ReloadEvent = { plugin: string };

function isReloadEvent(value: unknown): value is ReloadEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { plugin?: unknown }).plugin === "string"
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);

async function boot() {
  console.log("[main] booting (electrobun)...");

  initBackend().then(() => {
    ensureConnected();
    // Pull the persisted user config (favorites, theme, scale, …) off
    // ~/.config/loadout/config.json once the backend auth token is
    // available. Re-apply theme after load in case the on-disk value
    // differed from the mirror (post-reinstall first boot, etc.).
    loadUserConfig()
      .then(() => applyTheme(getConfigValue<string>("theme", "dark")))
      .catch((err) => console.warn("[main] loadUserConfig failed:", err));
    subscribe({
      plugin: "__system",
      event: "reload",
      handler: (data: unknown) => {
        if (isReloadEvent(data) && (data.plugin === "__overlay" || data.plugin === "__sdk")) {
          location.reload();
        }
      },
    });

    // Pop the overlay on demand: the loader broadcasts this when something
    // hits its GET/POST /show endpoint (the installer's first-run setup,
    // or a desktop launcher). The loader can't reach the overlay's Bun
    // main process directly, so it routes through here → the show() RPC.
    subscribe({
      plugin: "__overlay",
      event: "show",
      handler: () => {
        void showOverlay();
      },
    });
    runStartupInits().catch((err) => {
      console.error("[main] runStartupInits crashed:", err);
    });
  });

  // Bridge Bun-side NavController events → synthetic KeyboardEvents so
  // norigin-spatial-navigation + useGamepadInput keep working unchanged.
  const actionKeyMap: Record<OverlayAction, { key: string; keyCode: number } | undefined> = {
    up:    { key: "ArrowUp",    keyCode: 38 },
    down:  { key: "ArrowDown",  keyCode: 40 },
    left:  { key: "ArrowLeft",  keyCode: 37 },
    right: { key: "ArrowRight", keyCode: 39 },
    a:     { key: "Enter",      keyCode: 13 },
    b:     { key: "Escape",     keyCode: 27 },
    lb:    { key: "PageUp",     keyCode: 33 },
    rb:    { key: "PageDown",   keyCode: 34 },
    x:     undefined,
    x_up:  undefined,
    y:     undefined,
  };
  // Bridge Bun-side open/close state → DOM CustomEvent. useGamepadInput
  // listens and stops polling the Web Gamepad API while the overlay
  // window is hidden — otherwise spatial-nav keeps receiving synthetic
  // keyboard events and plays select sounds while the user is back in
  // the game, because gamescope's minimize doesn't flip document.hidden.
  function dispatchVisibility(isOpen: boolean): void {
    window.dispatchEvent(
      new CustomEvent("loadout:overlay-visibility", {
        detail: { isOpen },
      }),
    );
  }
  getOverlayVisibility()
    .then(dispatchVisibility)
    .catch((err) =>
      console.warn("[main] getOverlayVisibility failed:", err),
    );
  onOverlayVisibility(dispatchVisibility);

  // Bun-side ControllerShortcuts → OpenPlugin lands here. Route straight
  // into the App's hash-based router; the webview is persistent so the
  // listener is always live, even before the App component mounts.
  onOverlayOpenPlugin((pluginId) => {
    navigateOverlay({ view: "plugin", pluginId });
  });

  // Bun-side ControllerShortcuts → OpenSettings / OpenHome /
  // ToggleKeyboard land here. Each bridges into the existing overlay
  // primitives: hash router for routes, the keyboard store's
  // stateless setter for OSK toggling. The host already opened the
  // overlay before sending these (per index.ts:onWake), so the user
  // lands on the destination in one press from anywhere.
  onOverlayOpenSettings(() => {
    navigateOverlay({ view: "settings" });
  });
  onOverlayOpenHome(() => {
    navigateOverlay({ view: "home" });
  });
  onOverlayToggleKeyboard(() => {
    setKeyboardVisible(!isKeyboardVisible());
  });

  await onOverlayAction((action) => {
    // Always surface the raw action name so plugins can subscribe to
    // actions that aren't mapped to keyboard (x / y / x_up). Namespaced
    // to avoid colliding with the RPC-layer "overlay-action" name.
    window.dispatchEvent(
      new CustomEvent("loadout:overlay-action", { detail: { action } }),
    );

    const mapping = actionKeyMap[action];
    if (!mapping) return;
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: mapping.key,
        keyCode: mapping.keyCode,
        bubbles: true,
      }),
    );
  });

  scrollTeardown = await startRightStickScroll();
}

// ---- Right-stick scroll engine --------------------------------------------
// Bun-side input-intercept forwards right-stick analog values to us via
// overlay-scroll. We translate the held stick value into smooth per-frame
// scroll on the main content area, with friction-based momentum after the
// stick re-centers. The Web Gamepad API equivalent in useGamepadInput.ts
// runs only in standalone dev (no evdev grab) — this is the production
// path when the overlay is grabbing devices.
//
// "Regardless of what is focused": the scroll target is the visible
// scrollable descendant of <main>, not the focused element's ancestor.
// That way pushing the right stick while focus is on the sidebar still
// scrolls the main content the user is looking at.

/**
 * Cache lifetime for the resolved scroll target. Long enough to amortize
 * lookup cost across a continuous scroll, short enough that a layout
 * change (sidebar collapse, panel reflow) within the same view is picked
 * up promptly. Hashchange invalidates explicitly so this is just a
 * belt-and-braces fallback.
 */
const SCROLL_TARGET_TTL_MS = 500;

/** Stash the unsubscribers so the webview can clean up on hot-reload. */
let scrollTeardown: (() => void) | null = null;

function isScrollable(node: HTMLElement): boolean {
  const s = getComputedStyle(node);
  return (
    (s.overflowY === "auto" || s.overflowY === "scroll") &&
    node.scrollHeight > node.clientHeight
  );
}

/**
 * Find the live scrollable container inside `<main>`. We rely on shells
 * marking their scroll root with `data-scroll-root`:
 *   - Settings + Homepage tag their own scroll containers directly.
 *   - PluginHost tags its mount container with `data-scroll-root="plugin"`;
 *     the plugin's own React tree provides a scrollable child inside that
 *     (typical pattern: `<div className="h-full overflow-y-auto">`).
 *
 * The keep-alive shell in App.tsx puts `aria-hidden="true"` on inactive
 * plugin wrappers, so `closest('[aria-hidden="true"]')` is the gate.
 *
 * This used to walk every descendant of `<main>` — orders of magnitude
 * more nodes with multiple keep-alive plugins mounted. Querying by
 * attribute keeps the candidate set bounded by the number of mounted
 * views (~1-5), not the total DOM size.
 */
function findMainScrollTarget(): Element | null {
  const main = document.querySelector("main");
  if (!main) return null;

  const roots = main.querySelectorAll<HTMLElement>("[data-scroll-root]");
  for (const root of roots) {
    if (root.closest('[aria-hidden="true"]')) continue;

    // Settings / Homepage: the tagged element is itself the scroll root.
    if (isScrollable(root)) return root;

    // Plugin: tagged element is the mount container (overflow-clip);
    // the plugin's React tree provides a scrollable element inside.
    // 95% case is a direct child — try that first to avoid the full
    // descendant scan.
    for (const child of Array.from(root.children) as HTMLElement[]) {
      if (isScrollable(child)) return child;
    }
    // Deeper-nested fallback: still scoped to this one plugin's subtree,
    // not all of <main>.
    const descendants = root.querySelectorAll<HTMLElement>("*");
    for (const node of descendants) {
      if (isScrollable(node)) return node;
    }
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

  window.addEventListener(
    "loadout:overlay-visibility",
    onVisibility as EventListener,
  );
  // Drop the cached target the moment the user navigates between
  // plugins / Settings / Home. Without this we'd send up to 500 ms of
  // scroll input to the now-hidden previous view.
  window.addEventListener("hashchange", invalidateTarget);

  const offScroll = await onOverlayScroll(({ axis, value }) => {
    // Horizontal scroll is intentionally out of scope; keep the bridge
    // symmetric so the Bun side doesn't have to know which axes the
    // webview cares about.
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
    window.removeEventListener(
      "loadout:overlay-visibility",
      onVisibility as EventListener,
    );
    window.removeEventListener("hashchange", invalidateTarget);
    offScroll();
  };
}

boot().catch((e) => console.error("[main] boot crashed:", e));

// Vite HMR: tear down the rAF loop + listeners before the new module
// takes over so we don't accumulate duplicates across reloads.
// `import.meta.hot` is typed via root `types/window-augmentations.d.ts`.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    scrollTeardown?.();
    scrollTeardown = null;
  });
}

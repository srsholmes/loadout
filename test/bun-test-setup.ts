// Bun test preload — the all-bun equivalent of the old vitest happy-dom
// env. Wired via the `--preload ./test/bun-test-setup.ts` flag on the
// `test:ui` script (package.json); applied only to the UI test invocation
// (bun test <spec.tsx>), never to backend tests.
import { afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createElement } from "react";

// DOM out of the box for React component tests. This preload is applied
// ONLY to the UI invocation (bun test <spec.tsx>), never to backend
// tests — they run in bun's native env (no DOM, native fetch).
GlobalRegistrator.register();

// Stub window.__SPATIAL_NAV__ so the spatial-nav hooks resolve in tests.
(globalThis as any).__SPATIAL_NAV__ = null;
if (typeof globalThis.window !== "undefined") {
  (globalThis.window as any).__SPATIAL_NAV__ = null;
}

// Stub Steam components so the lazy proxies in @loadout/ui/steam resolve to
// simple React elements instead of returning null in tests.
const stubComponent = (name: string) =>
  function SteamStub({ children, onClick, ...props }: any) {
    return createElement("button", { onClick, "data-steam": name, ...props }, children);
  };

(globalThis as any).__STEAM_COMPONENTS = {
  DialogButton: stubComponent("DialogButton"),
  DialogButtonPrimary: stubComponent("DialogButtonPrimary"),
  DialogButtonSecondary: stubComponent("DialogButtonSecondary"),
  Focusable: ({ children }: any) => createElement("div", null, children),
  ScrollPanel: ({ children }: any) => createElement("div", null, children),
};

// Cleanup DOM after each test.
afterEach(() => {
  document.body.innerHTML = "";
});

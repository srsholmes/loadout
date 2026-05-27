import { afterEach } from "vitest";
import { createElement } from "react";

// Stub window.__SPATIAL_NAV__ for UI component tests
(globalThis as any).__SPATIAL_NAV__ = null;
if (typeof globalThis.window !== "undefined") {
  (globalThis.window as any).__SPATIAL_NAV__ = null;
}

// Stub Steam components so the lazy proxies in @loadout/ui/steam resolve
// to simple React elements instead of returning null in tests.
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

// Cleanup DOM after each test
afterEach(() => {
  document.body.innerHTML = "";
});

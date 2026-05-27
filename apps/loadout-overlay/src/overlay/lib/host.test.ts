// Unit tests for the non-trivial behaviour left in lib/host.ts after
// the Electrobun + user-config migration: the config-file fallback
// that keeps controller shortcuts working even when no host RPC bridge
// is present (e.g. standalone `vite dev` of the shared React tree, or
// during the split-second between webview boot and Electroview.init).
//
// The thin RPC dispatcher (showOverlay/hideOverlay/toggleOverlay) is
// one branch of an if — not worth unit testing in isolation. The CDP
// smoke test in packages/overlay-electrobun/e2e/smoke.spec.ts exercises
// it end-to-end instead.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type * as HostModule from "./host";

// Minimal localStorage fake — userConfig.ts uses localStorage as a sync
// cache/mirror, so the tests need it available even though we don't
// care about the exact keys.
function makeFakeLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    key: (i) => [...store.keys()][i] ?? null,
  };
}

let origWindow: unknown;
let origLocalStorage: unknown;
let origFetch: unknown;

beforeEach(() => {
  origWindow = (globalThis as { window?: unknown }).window;
  origLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;
  origFetch = (globalThis as { fetch?: unknown }).fetch;
  (globalThis as { localStorage: Storage }).localStorage = makeFakeLocalStorage();
  // No Electrobun bridge — forces the config-fallback path in tauri.ts.
  (globalThis as { window: object }).window = {
    localStorage: (globalThis as unknown as { localStorage: Storage }).localStorage,
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  // Stub fetch so setConfigValue's fire-and-forget PATCH doesn't try to
  // hit a real server during unit tests.
  (globalThis as { fetch: typeof fetch }).fetch = (async () => new Response("{}")) as unknown as typeof fetch;
});

afterEach(() => {
  (globalThis as { window?: unknown }).window = origWindow;
  (globalThis as { localStorage?: unknown }).localStorage = origLocalStorage;
  (globalThis as { fetch?: unknown }).fetch = origFetch;
});

// lib/host.ts captures `isElectrobun` at module-load time, so we
// must import AFTER the fake window is installed. Dynamic import
// inside a test does that cleanly.
async function loadLib(): Promise<typeof HostModule> {
  return (await import(`./host?cb=${Math.random()}`)) as typeof HostModule;
}

describe("lib/host — config-file fallback (no host bridge)", () => {
  it("getControllerShortcuts returns hard-coded defaults when nothing is stored", async () => {
    const lib = await loadLib();
    const shortcuts = await lib.getControllerShortcuts();
    expect(shortcuts).toEqual({
      guide_a: { type: "ToggleOverlay" },
      guide_b: { type: "None" },
      guide_x: { type: "ToggleOverlay" },
      guide_y: { type: "None" },
    });
  });

  it("getControllerShortcuts round-trips what set put there", async () => {
    const lib = await loadLib();
    const saved = {
      guide_a: { type: "ToggleOverlay" as const },
      guide_b: { type: "ToggleOverlay" as const },
      guide_x: { type: "None" as const },
      guide_y: { type: "None" as const },
    };
    await lib.setControllerShortcuts(saved);
    const loaded = await lib.getControllerShortcuts();
    expect(loaded).toEqual(saved);
  });

  it("rpcInvoke-backed calls (showOverlay/etc) are safe no-ops when no host bridge is present", async () => {
    const lib = await loadLib();
    await expect(lib.showOverlay()).resolves.toBeUndefined();
    await expect(lib.hideOverlay()).resolves.toBeUndefined();
    await expect(lib.toggleOverlay()).resolves.toBeUndefined();
    await expect(lib.isGamescopeMode()).resolves.toBe(false);
  });
});

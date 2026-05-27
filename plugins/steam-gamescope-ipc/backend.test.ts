import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import type { EmitPayload } from "@loadout/types";

import SteamGamescopeIpcBackend from "./backend";

/**
 * Steam Gamescope IPC backend tests.
 *
 * This backend is intentionally trivial: game-detection state was
 * lifted to the loader's `__core:game-detection` service. The only
 * surface left here is the `onLoad` lifecycle hook, which exists to
 * keep the plugin manifest happy and to leave a console breadcrumb
 * pointing at the new home of the logic.
 *
 * The tests guard that "no surface" property — adding methods later
 * without thinking about RPC exposure would be a regression.
 */

describe("SteamGamescopeIpcBackend", () => {
  let backend: SteamGamescopeIpcBackend;
  let emitted: EmitPayload[];

  beforeEach(() => {
    backend = new SteamGamescopeIpcBackend();
    emitted = [];
    backend.emit = (p) => {
      emitted.push(p);
    };
  });

  it("constructs with no emit attached by default", () => {
    const fresh = new SteamGamescopeIpcBackend();
    expect(fresh.emit).toBeUndefined();
  });

  it("onLoad resolves without emitting any events", async () => {
    await expect(backend.onLoad()).resolves.toBeUndefined();
    expect(emitted).toEqual([]);
  });

  it("onLoad logs a breadcrumb pointing at the core game-detection service", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await backend.onLoad();
      const calls = logSpy.mock.calls.flat().join(" ");
      expect(calls).toContain("steam-gamescope-ipc");
      expect(calls).toContain("__core:game-detection");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("does not implement onUnload — lifecycle is idempotent", () => {
    // No state, no timers, no subscriptions — nothing to tear down.
    // PluginBackend allows onUnload to be optional; assert we kept it
    // that way so future maintainers don't accidentally bind state
    // here without wiring the matching cleanup.
    expect(backend.onUnload).toBeUndefined();
  });

  it("exposes no enumerable RPC methods beyond the lifecycle hook", () => {
    // Anything new on the prototype gets reflected to the RPC layer,
    // so we lock the surface down to just `onLoad`. If a future
    // change needs an RPC method, it should also update this list.
    const proto = Object.getPrototypeOf(backend) as object;
    const methods = Object.getOwnPropertyNames(proto).filter(
      (n) => n !== "constructor" && typeof (backend as never)[n] === "function",
    );
    expect(methods).toEqual(["onLoad"]);
  });

  it("survives onLoad being invoked multiple times", async () => {
    await backend.onLoad();
    await backend.onLoad();
    await backend.onLoad();
    expect(emitted).toEqual([]);
  });

  it("preserves the emit reference across calls", async () => {
    const captured = backend.emit;
    await backend.onLoad();
    expect(backend.emit).toBe(captured);
  });
});

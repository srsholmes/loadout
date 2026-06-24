import { describe, it, expect } from "bun:test";
import type { PluginBackend } from "@loadout/types";
import { callPluginMethod, type LoadedPlugin } from "./plugin-manager";

/**
 * Cross-plugin dispatch (`callPluginMethod`) — the in-process path behind
 * the injected `callPlugin` handle. We assert it resolves + invokes the
 * target's method, forwards args/return, and throws clearly when the
 * target plugin or method is absent (so callers can fall back).
 */

function makeEntry(instance: PluginBackend): LoadedPlugin {
  return {
    meta: { id: "x", name: "x", version: "0.0.0", description: "", author: "" },
    instance,
    sandboxedFetch: globalThis.fetch,
    hasApp: false,
  };
}

function makePlugins(map: Record<string, PluginBackend>): Map<string, LoadedPlugin> {
  const entries = new Map<string, LoadedPlugin>();
  for (const [id, instance] of Object.entries(map)) entries.set(id, makeEntry(instance));
  return entries;
}

describe("callPluginMethod", () => {
  it("invokes the target method and forwards args + return value", async () => {
    const seen: unknown[] = [];
    const plugins = makePlugins({
      "input-plumber": {
        // @ts-expect-error — ad-hoc method on a bare backend for the test.
        restartInputPlumber(a: unknown, b: unknown) {
          seen.push(a, b);
          return { ok: true };
        },
      },
    });

    const r = await callPluginMethod(plugins, "input-plumber", "restartInputPlumber", [1, 2]);
    expect(r).toEqual({ ok: true });
    expect(seen).toEqual([1, 2]);
  });

  it("throws when the target plugin is not loaded", async () => {
    const plugins = makePlugins({});
    await expect(
      callPluginMethod(plugins, "input-plumber", "restartInputPlumber", []),
    ).rejects.toThrow(/not loaded/);
  });

  it("throws when the method does not exist on the target", async () => {
    const plugins = makePlugins({ "input-plumber": {} as PluginBackend });
    await expect(
      callPluginMethod(plugins, "input-plumber", "restartInputPlumber", []),
    ).rejects.toThrow(/not found/);
  });

  it("refuses to dispatch blocked lifecycle methods", async () => {
    const plugins = makePlugins({
      "input-plumber": { onLoad() {} } as PluginBackend,
    });
    await expect(
      callPluginMethod(plugins, "input-plumber", "onLoad", []),
    ).rejects.toThrow(/not found/);
  });
});

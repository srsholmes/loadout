import { describe, it, expect } from "bun:test";
import type { PluginBackend } from "@loadout/types";
import { createRpcHandler, type RpcPluginEntry } from "./rpc-handler";

/** Helper: wraps bare PluginBackend instances into RpcPluginEntry with a permissive fetch. */
function makePlugins(map: Record<string, PluginBackend>) {
  const entries = new Map<string, RpcPluginEntry>();
  for (const [id, instance] of Object.entries(map)) {
    entries.set(id, { instance, sandboxedFetch: globalThis.fetch });
  }
  return entries;
}

describe("createRpcHandler", () => {
  it("returns null for invalid JSON", async () => {
    const handler = createRpcHandler(new Map());
    const result = await handler("not json");
    expect(result).toBeNull();
  });

  it("returns null for messages missing required fields", async () => {
    const handler = createRpcHandler(new Map());
    const result = await handler(JSON.stringify({ id: "1" }));
    expect(result).toBeNull();
  });

  it("returns error for unknown plugin", async () => {
    const handler = createRpcHandler(new Map());
    const result = await handler(
      JSON.stringify({ id: "1", plugin: "nope", method: "foo", args: [] }),
    );
    const parsed = JSON.parse(result!);
    expect(parsed.id).toBe("1");
    expect(parsed.error).toContain("not found");
  });

  it("reports a disabled plugin distinctly from a missing one", async () => {
    const handler = createRpcHandler(new Map(), {
      isDisabled: (id) => id === "tdp-control",
    });
    const disabled = JSON.parse(
      (await handler(
        JSON.stringify({ id: "1", plugin: "tdp-control", method: "foo", args: [] }),
      ))!,
    );
    expect(disabled.error).toContain("is disabled");
    const missing = JSON.parse(
      (await handler(
        JSON.stringify({ id: "2", plugin: "ghost", method: "foo", args: [] }),
      ))!,
    );
    expect(missing.error).toContain("not found");
  });

  it("returns error for unknown method", async () => {
    const plugins = makePlugins({ test: {} as PluginBackend });
    const handler = createRpcHandler(plugins);
    const result = await handler(
      JSON.stringify({ id: "1", plugin: "test", method: "missing", args: [] }),
    );
    const parsed = JSON.parse(result!);
    expect(parsed.error).toContain("not found");
  });

  it("calls plugin method and returns result", async () => {
    const plugin = {
      // RPC spreads args positionally into plugin methods
      add(...args: unknown[]) {
        return (args[0] as number) + (args[1] as number);
      },
    } as unknown as PluginBackend;
    const plugins = makePlugins({ test: plugin });
    const handler = createRpcHandler(plugins);
    const result = await handler(
      JSON.stringify({ id: "1", plugin: "test", method: "add", args: [2, 3] }),
    );
    const parsed = JSON.parse(result!);
    expect(parsed.id).toBe("1");
    expect(parsed.result).toBe(5);
  });

  it("catches errors from plugin methods", async () => {
    const plugin = {
      boom() {
        throw new Error("kaboom");
      },
    } as unknown as PluginBackend;
    const plugins = makePlugins({ test: plugin });
    const handler = createRpcHandler(plugins);
    const result = await handler(
      JSON.stringify({ id: "1", plugin: "test", method: "boom", args: [] }),
    );
    const parsed = JSON.parse(result!);
    expect(parsed.error).toBe("kaboom");
  });

  it("handles async plugin methods", async () => {
    const plugin = {
      async greet(name: unknown) {
        return `hello ${name}`;
      },
    } as unknown as PluginBackend;
    const plugins = makePlugins({ test: plugin });
    const handler = createRpcHandler(plugins);
    const result = await handler(
      JSON.stringify({ id: "1", plugin: "test", method: "greet", args: ["world"] }),
    );
    const parsed = JSON.parse(result!);
    expect(parsed.result).toBe("hello world");
  });

  describe("__broadcast", () => {
    it("fans the call out to every plugin that implements the method", async () => {
      const calls: string[] = [];
      const a = {
        async clearExternalCache() {
          calls.push("a");
        },
      } as unknown as PluginBackend;
      const b = {
        async clearExternalCache() {
          calls.push("b");
        },
      } as unknown as PluginBackend;
      // c doesn't implement the method — should be skipped silently.
      const c = {} as PluginBackend;
      const plugins = makePlugins({ a, b, c });
      const handler = createRpcHandler(plugins);
      const result = await handler(
        JSON.stringify({
          id: "1",
          plugin: "__broadcast",
          method: "clearExternalCache",
          args: [],
        }),
      );
      const parsed = JSON.parse(result!);
      expect(parsed.id).toBe("1");
      expect(parsed.result).toEqual({ called: 2, errors: [] });
      // Order is the plugins map's insertion order; we just need both.
      expect(calls.sort()).toEqual(["a", "b"]);
    });

    it("returns called: 0 when no plugin implements the method", async () => {
      const plugins = makePlugins({
        a: {} as PluginBackend,
        b: {} as PluginBackend,
      });
      const handler = createRpcHandler(plugins);
      const result = await handler(
        JSON.stringify({
          id: "1",
          plugin: "__broadcast",
          method: "nope",
          args: [],
        }),
      );
      const parsed = JSON.parse(result!);
      expect(parsed.result).toEqual({ called: 0, errors: [] });
    });

    it("collects per-plugin errors instead of failing the whole broadcast", async () => {
      const a = {
        async clearExternalCache() {
          /* ok */
        },
      } as unknown as PluginBackend;
      const b = {
        async clearExternalCache() {
          throw new Error("disk dead");
        },
      } as unknown as PluginBackend;
      const plugins = makePlugins({ a, b });
      const handler = createRpcHandler(plugins);
      const result = await handler(
        JSON.stringify({
          id: "1",
          plugin: "__broadcast",
          method: "clearExternalCache",
          args: [],
        }),
      );
      const parsed = JSON.parse(result!);
      expect(parsed.result.called).toBe(2);
      expect(parsed.result.errors).toHaveLength(1);
      expect(parsed.result.errors[0]).toEqual({
        plugin: "b",
        error: "disk dead",
      });
    });
  });
});

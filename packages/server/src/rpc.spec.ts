import { describe, it, expect } from "bun:test";
import { createRpcHandler } from "./rpc";
import type { PluginBackend } from "@loadout/types";

function entry(instance: PluginBackend) {
  return { instance };
}

describe("createRpcHandler", () => {
  it("returns null for invalid JSON", async () => {
    const h = createRpcHandler(new Map());
    expect(await h("not json")).toBeNull();
  });

  it("returns null when required fields are missing", async () => {
    const h = createRpcHandler(new Map());
    expect(await h(JSON.stringify({ id: "1" }))).toBeNull();
  });

  it("returns plugin-not-found error", async () => {
    const h = createRpcHandler(new Map());
    const raw = await h(JSON.stringify({ id: "1", plugin: "x", method: "y", args: [] }));
    const res = JSON.parse(raw!);
    expect(res.error).toMatch(/not found/);
  });

  it("returns method-not-found error", async () => {
    const h = createRpcHandler(new Map([["p", entry({})]]));
    const raw = await h(JSON.stringify({ id: "1", plugin: "p", method: "missing", args: [] }));
    const res = JSON.parse(raw!);
    expect(res.error).toMatch(/Method "missing"/);
  });

  it("dispatches and returns method result", async () => {
    const plugin: PluginBackend & { add: (a: number, b: number) => number } = {
      add: (a, b) => a + b,
    };
    const h = createRpcHandler(new Map([["math", entry(plugin)]]));
    const raw = await h(JSON.stringify({ id: "7", plugin: "math", method: "add", args: [2, 3] }));
    const res = JSON.parse(raw!);
    expect(res).toEqual({ id: "7", result: 5 });
  });

  it("captures thrown errors as error strings", async () => {
    const plugin: PluginBackend & { boom: () => never } = {
      boom: () => {
        throw new Error("kaboom");
      },
    };
    const h = createRpcHandler(new Map([["p", entry(plugin)]]));
    const raw = await h(JSON.stringify({ id: "1", plugin: "p", method: "boom", args: [] }));
    const res = JSON.parse(raw!);
    expect(res.error).toBe("kaboom");
  });

  it("awaits async methods", async () => {
    const plugin: PluginBackend & { ping: () => Promise<string> } = {
      ping: async () => "pong",
    };
    const h = createRpcHandler(new Map([["p", entry(plugin)]]));
    const raw = await h(JSON.stringify({ id: "1", plugin: "p", method: "ping", args: [] }));
    const res = JSON.parse(raw!);
    expect(res.result).toBe("pong");
  });
});

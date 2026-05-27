import { describe, it, expect } from "bun:test";
import { resolveMethod } from "./plugin";
import type { PluginBackend } from "./plugin";

describe("resolveMethod", () => {
  it("returns a bound function for existing methods", () => {
    const backend = {
      onLoad: async () => {},
      greet() {
        return "hello";
      },
    } satisfies PluginBackend & { greet(): string };

    const fn = resolveMethod({ instance: backend, name: "greet" });
    expect(fn).toBeDefined();
    expect(fn!()).toBe("hello");
  });

  it("returns undefined for non-existent methods", () => {
    const backend: PluginBackend = {};
    const fn = resolveMethod({ instance: backend, name: "nope" });
    expect(fn).toBeUndefined();
  });

  it("returns undefined for non-function properties", () => {
    const backend = { value: 42 } as unknown as PluginBackend;
    const fn = resolveMethod({ instance: backend, name: "value" });
    expect(fn).toBeUndefined();
  });

  it("preserves `this` context via bind", () => {
    class MyPlugin {
      private name = "test";
      getName() {
        return this.name;
      }
    }

    const instance = new MyPlugin() as unknown as PluginBackend;
    const fn = resolveMethod({ instance, name: "getName" });
    expect(fn).toBeDefined();
    expect(fn!()).toBe("test");
  });

  it("blocks lifecycle methods (onLoad, onUnload, emit)", () => {
    const backend = {
      onLoad: async () => {},
      onUnload: async () => {},
      emit: () => {},
      greet() { return "hi"; },
    } as unknown as PluginBackend;

    expect(resolveMethod({ instance: backend, name: "onLoad" })).toBeUndefined();
    expect(resolveMethod({ instance: backend, name: "onUnload" })).toBeUndefined();
    expect(resolveMethod({ instance: backend, name: "emit" })).toBeUndefined();
    expect(resolveMethod({ instance: backend, name: "greet" })).toBeDefined();
  });

  it("blocks Object.prototype methods", () => {
    const backend = { greet() { return "hi"; } } as unknown as PluginBackend;

    expect(resolveMethod({ instance: backend, name: "constructor" })).toBeUndefined();
    expect(resolveMethod({ instance: backend, name: "toString" })).toBeUndefined();
    expect(resolveMethod({ instance: backend, name: "hasOwnProperty" })).toBeUndefined();
  });

  it("blocks underscore-prefixed methods", () => {
    const backend = {
      _internal() { return "secret"; },
      publicMethod() { return "ok"; },
    } as unknown as PluginBackend;

    expect(resolveMethod({ instance: backend, name: "_internal" })).toBeUndefined();
    expect(resolveMethod({ instance: backend, name: "publicMethod" })).toBeDefined();
  });
});

import { describe, it, expect } from "bun:test";
import { resolveMethod, type PluginBackend } from "./plugin";

describe("resolveMethod", () => {
  it("returns a bound function for a public method", () => {
    const instance: PluginBackend & { ping: () => string } = {
      ping() {
        return "pong";
      },
    };
    const fn = resolveMethod(instance, "ping");
    expect(fn).toBeDefined();
    expect(fn?.()).toBe("pong");
  });

  it("blocks lifecycle methods", () => {
    const instance: PluginBackend = {
      onLoad: () => {},
      onUnload: () => {},
      emit: () => {},
    };
    expect(resolveMethod(instance, "onLoad")).toBeUndefined();
    expect(resolveMethod(instance, "onUnload")).toBeUndefined();
    expect(resolveMethod(instance, "emit")).toBeUndefined();
  });

  it("blocks underscore-prefixed methods", () => {
    const instance = { _secret: () => "no" } as unknown as PluginBackend;
    expect(resolveMethod(instance, "_secret")).toBeUndefined();
  });

  it("blocks Object.prototype methods", () => {
    const instance: PluginBackend = {};
    expect(resolveMethod(instance, "toString")).toBeUndefined();
    expect(resolveMethod(instance, "hasOwnProperty")).toBeUndefined();
  });

  it("returns undefined for non-functions and missing keys", () => {
    const instance = { value: 42 } as unknown as PluginBackend;
    expect(resolveMethod(instance, "value")).toBeUndefined();
    expect(resolveMethod(instance, "missing")).toBeUndefined();
  });

  it("binds `this` to the instance", () => {
    const instance: PluginBackend & { state: number; get: () => number } = {
      state: 7,
      get() {
        return this.state;
      },
    };
    const fn = resolveMethod(instance, "get");
    expect(fn?.()).toBe(7);
  });
});

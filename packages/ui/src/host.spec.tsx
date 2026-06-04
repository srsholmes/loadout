import { describe, it, expect, mock, afterEach } from "bun:test";
import { hideOverlay } from "./host";

afterEach(() => {
  delete (globalThis as { __electroview?: unknown }).__electroview;
});

describe("hideOverlay", () => {
  it("calls the host hide RPC when __electroview is present", async () => {
    const hide = mock(() => Promise.resolve(undefined));
    (globalThis as { __electroview?: unknown }).__electroview = {
      rpc: { request: { hide } },
    };
    await hideOverlay();
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it("no-ops (no throw) when __electroview is absent", async () => {
    delete (globalThis as { __electroview?: unknown }).__electroview;
    await expect(hideOverlay()).resolves.toBeUndefined();
  });

  it("no-ops when the rpc bridge is partially present", async () => {
    (globalThis as { __electroview?: unknown }).__electroview = { rpc: {} };
    await expect(hideOverlay()).resolves.toBeUndefined();
  });
});

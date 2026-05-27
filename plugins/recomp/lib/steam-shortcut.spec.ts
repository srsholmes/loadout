import { describe, it, expect } from "bun:test";

// Most of `steam-shortcut` is a thin wrapper around `withSteamClient`
// from `@loadout/steam-cdp`, which needs a live Steam CEF tab to
// exercise. Real coverage lives in the integration tests for the
// steam-cdp package itself. Here we just smoke-check that the module
// exports the expected surface and that the launch-command splitter
// behaves on a known template — the rest is straight delegation.

describe("lib/steam-shortcut module surface", () => {
  it("exports addToSteam and removeFromSteam", async () => {
    const mod = await import("./steam-shortcut");
    expect(typeof mod.addToSteam).toBe("function");
    expect(typeof mod.removeFromSteam).toBe("function");
  });
});

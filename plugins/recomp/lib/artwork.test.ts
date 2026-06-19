import { describe, it, expect } from "bun:test";

// `applyArtwork` integrates with the SteamGridDB HTTP API, the
// loader-managed plugin storage (to read the steamgriddb plugin's
// stored key), the external-cache package, and the filesystem
// (writing into `~/.local/share/Steam/userdata/*/config/grid/`).
// Driving all four of those in unit tests gives no more confidence
// than a smoke test, so we just check the module shape here and
// rely on the end-to-end test plan (install dusklight on a real box)
// for the behaviour assertions.

describe("lib/artwork module surface", () => {
  it("exports applyArtwork", async () => {
    const mod = await import("./artwork");
    expect(typeof mod.applyArtwork).toBe("function");
  });
});

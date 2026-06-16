import { describe, it, expect, beforeEach } from "bun:test";
import type { EmitPayload } from "@loadout/types";
import RecompBackend from "./backend";

// The bundled `games.json` is the source of truth for these tests —
// no fetch mocking needed. We assert on the shape of well-known
// entries (zelda64-recomp, dusklight) rather than on counts that
// could drift as the catalog grows.

describe("RecompBackend", () => {
  let backend: RecompBackend;
  let emittedEvents: EmitPayload[];

  beforeEach(() => {
    backend = new RecompBackend();
    emittedEvents = [];
    backend.emit = (payload: EmitPayload) => {
      emittedEvents.push(payload);
    };
  });

  describe("onLoad", () => {
    it("loads state and registry without throwing", async () => {
      await backend.onLoad();
    });

    it("populates games after load", async () => {
      await backend.onLoad();
      const games = await backend.getGames();
      expect(games.length).toBeGreaterThan(0);
    });
  });

  describe("getGames", () => {
    it("returns GameInfo[] with the expected fields", async () => {
      await backend.onLoad();
      const games = await backend.getGames();

      for (const game of games) {
        expect(game.id).toBeDefined();
        expect(game.name).toBeDefined();
        expect(game.gameStatus).toBeDefined();
        expect(typeof game.hasNativeBuild).toBe("boolean");
        expect(typeof game.hasUpdate).toBe("boolean");
        expect(typeof game.addedToSteam).toBe("boolean");
      }
    });

    it("uninstalled games are 'available' / 'unavailable' / 'in_progress'", async () => {
      await backend.onLoad();
      const games = await backend.getGames();
      // Real state may contain installed games on a dev box; only
      // assert on the catalog entries that aren't currently
      // installed in the user's persisted state.
      const uninstalled = games.filter((g) => g.installedVersion == null);
      for (const game of uninstalled) {
        expect(["available", "unavailable", "in_progress"]).toContain(
          game.gameStatus,
        );
      }
    });

    it("includes dusklight as the posterchild prebuilt entry", async () => {
      await backend.onLoad();
      const games = await backend.getGames();
      const dusklight = games.find((g) => g.id === "dusklight");
      expect(dusklight).toBeDefined();
      expect(dusklight!.installType).toBe("prebuilt");
    });

    it("includes zelda64-recomp with the expected platform", async () => {
      await backend.onLoad();
      const games = await backend.getGames();
      const zelda = games.find((g) => g.id === "zelda64-recomp");
      expect(zelda).toBeDefined();
      expect(zelda!.platform).toBe("n64");
    });
  });

  describe("getGameDetail", () => {
    it("returns a single game by id", async () => {
      await backend.onLoad();
      const game = await backend.getGameDetail("dusklight");
      expect(game).not.toBeNull();
      expect(game!.id).toBe("dusklight");
    });

    it("returns null for unknown id", async () => {
      await backend.onLoad();
      const game = await backend.getGameDetail("nonexistent-game");
      expect(game).toBeNull();
    });
  });

  describe("getSettings / updateSettings", () => {
    it("returns settings with defaults", async () => {
      await backend.onLoad();
      const settings = await backend.getSettings();
      expect(typeof settings.autoAddToSteam).toBe("boolean");
      expect(typeof settings.updateCheckInterval).toBe("number");
      expect(settings.updateCheckInterval).toBeGreaterThan(0);
    });

    it("updates settings partially", async () => {
      await backend.onLoad();
      await backend.updateSettings({ romDirectory: "/test/roms" });
      const settings = await backend.getSettings();
      expect(settings.romDirectory).toBe("/test/roms");
      expect(typeof settings.autoAddToSteam).toBe("boolean");
    });
  });

  describe("suggestRomFiles (system-wide discovery)", () => {
    let sandboxHome: string;
    const origHome = process.env.HOME;
    const origXdg = process.env.XDG_CONFIG_HOME;

    beforeEach(async () => {
      const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      sandboxHome = await mkdtemp(join(tmpdir(), "recomp-rom-"));
      process.env.HOME = sandboxHome;
      process.env.XDG_CONFIG_HOME = join(sandboxHome, ".config");
      // Drop a ROM that fuzzy-matches "The Legend of Zelda: Majora's
      // Mask" into a default scan root (~/ROMs) — no romDirectory set.
      await mkdir(join(sandboxHome, "ROMs"), { recursive: true });
      await writeFile(
        join(sandboxHome, "ROMs", "Legend of Zelda - Majoras Mask (USA).z64"),
        "stub",
      );
      // Unrelated file that should NOT outrank the match.
      await writeFile(join(sandboxHome, "ROMs", "random-notes.txt"), "x");
    });

    afterEach(async () => {
      const { rm } = await import("node:fs/promises");
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = origXdg;
      await rm(sandboxHome, { recursive: true, force: true });
    });

    it("auto-discovers a matching ROM in ~/ROMs when no romDirectory is set", async () => {
      const fresh = new RecompBackend();
      await fresh.onLoad();
      // Ensure no rom directory is configured (sandbox state is empty).
      const settings = await fresh.getSettings();
      expect(settings.romDirectory ?? null).toBeNull();

      const suggestions = await fresh.suggestRomFiles("zelda64-recomp");
      expect(suggestions.length).toBeGreaterThan(0);
      expect(
        suggestions.some((s) => s.basename.includes("Majoras Mask")),
      ).toBe(true);
    });

    it("returns [] for an unknown game id", async () => {
      const fresh = new RecompBackend();
      await fresh.onLoad();
      expect(await fresh.suggestRomFiles("nonexistent")).toEqual([]);
    });
  });

  describe("installGame", () => {
    it("throws for unknown game id", async () => {
      await backend.onLoad();
      await expect(backend.installGame("nonexistent")).rejects.toThrow(
        "not found",
      );
    });

    it("prevents concurrent operations on the same game", async () => {
      await backend.onLoad();

      // Hang the first install via a fetch that never resolves —
      // resolveAssetUrl hits api.github.com which we mock here.
      const realFetch = globalThis.fetch;
      globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;

      try {
        backend.installGame("dusklight").catch(() => {});
        await new Promise((r) => setTimeout(r, 10));
        await expect(backend.installGame("dusklight")).rejects.toThrow(
          "already in progress",
        );
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });

  describe("uninstallGame", () => {
    it("removes from state without throwing when not installed", async () => {
      await backend.onLoad();
      await backend.uninstallGame("dusklight");
    });

    it("emits gameStatusChanged event", async () => {
      await backend.onLoad();
      emittedEvents = [];
      await backend.uninstallGame("dusklight");

      const event = emittedEvents.find((e) => e.event === "gameStatusChanged");
      expect(event).toBeDefined();
      expect((event!.data as { gameId: string }).gameId).toBe("dusklight");
    });
  });

  describe("launchGame", () => {
    it("throws for unknown game", async () => {
      await backend.onLoad();
      await expect(backend.launchGame("nonexistent")).rejects.toThrow(
        "not found",
      );
    });

    it("throws for non-installed game", async () => {
      await backend.onLoad();
      await expect(backend.launchGame("dusklight")).rejects.toThrow(
        "not installed",
      );
    });
  });

  describe("mod RPCs — security + routing", () => {
    it("getMods returns [] for a game that has no mods catalog", async () => {
      await backend.onLoad();
      const r = await backend.getMods("zelda64-recomp");
      expect(r).toEqual([]);
    });

    it("getMods returns [] for an unknown gameId", async () => {
      await backend.onLoad();
      expect(await backend.getMods("nonexistent")).toEqual([]);
    });

    it("getMods surfaces dusklight's mods catalog with not_installed status", async () => {
      await backend.onLoad();
      const r = await backend.getMods("dusklight");
      expect(r.length).toBeGreaterThan(0);
      // Dusklight isn't installed in the test sandbox, so every mod
      // is not_installed and carries no installedAt.
      for (const mod of r) {
        expect(mod.status).toBe("not_installed");
        expect(mod.installedAt).toBeUndefined();
      }
    });

    it("installMod throws when the base game isn't installed", async () => {
      await backend.onLoad();
      // The test machine may already have dusklight installed
      // (developer's real state.json); force the "not installed"
      // case by clearing the in-memory state record.
      delete backend["state"].games["dusklight"];
      await expect(
        backend.installMod("dusklight", "henriko-4k"),
      ).rejects.toThrow(/can't be applied to a not-installed game/);
    });

    it("installMod rejects manual-import sources (importModFromDisk is their path)", async () => {
      await backend.onLoad();
      // Spoof an installed dusklight so the per-game gate passes.
      backend["state"].games["dusklight"] = {
        installedVersion: "v1.2.0",
        installedAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        installDir: "/tmp/test-dusklight",
        addedToSteam: false,
      };
      // henriko-4k is manual-import.
      await expect(
        backend.installMod("dusklight", "henriko-4k"),
      ).rejects.toThrow(/manual-import/);
    });

    it("importModFromDisk refuses a path outside the allowed roots", async () => {
      await backend.onLoad();
      backend["state"].games["dusklight"] = {
        installedVersion: "v1.2.0",
        installedAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        installDir: "/tmp/test-dusklight",
        addedToSteam: false,
      };
      await expect(
        backend.importModFromDisk(
          "dusklight",
          "henriko-4k",
          "/etc/shadow",
        ),
      ).rejects.toThrow(/outside the allowed roots/);
    });

    it("importModFromDisk refuses a path with no archive extension", async () => {
      await backend.onLoad();
      backend["state"].games["dusklight"] = {
        installedVersion: "v1.2.0",
        installedAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        installDir: "/tmp/test-dusklight",
        addedToSteam: false,
      };
      // Create the file so realpath() succeeds; the gate must
      // still refuse the .txt extension.
      const { writeFile, mkdtemp } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");
      const dir = await mkdtemp(join(tmpdir(), "backend-import-ext-"));
      const nonArchive = join(dir, "not-an-archive.txt");
      await writeFile(nonArchive, "not an archive");
      await expect(
        backend.importModFromDisk("dusklight", "henriko-4k", nonArchive),
      ).rejects.toThrow(/supported archive extension/);
    });

    it("importModFromDisk reports a clear error when the file doesn't exist", async () => {
      await backend.onLoad();
      backend["state"].games["dusklight"] = {
        installedVersion: "v1.2.0",
        installedAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        installDir: "/tmp/test-dusklight",
        addedToSteam: false,
      };
      await expect(
        backend.importModFromDisk(
          "dusklight",
          "henriko-4k",
          "/tmp/this/path/does/not/exist.zip",
        ),
      ).rejects.toThrow(/not found/);
    });

    it("getModUrl returns the manifest's externalUrl for a manual-import mod", async () => {
      await backend.onLoad();
      const url = await backend.getModUrl("dusklight", "henriko-4k");
      expect(typeof url).toBe("string");
      expect(url).toMatch(/^https?:\/\//);
    });

    it("listDirectory refuses a path outside the allowed roots", async () => {
      await backend.onLoad();
      await expect(backend.listDirectory("/etc")).rejects.toThrow(
        /outside the allowed roots/,
      );
    });
  });
});

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import type { EmitPayload } from "@loadout/types";
import * as fsp from "node:fs/promises";
import StorageCleanerBackend from "./backend";

/**
 * StorageCleanerBackend tests.
 *
 * Two mock surfaces:
 *  - `Bun.spawn` for everything that shells out: `df -h` and the now
 *    single-batched `du -sb path1 path2 ...` per RPC.
 *  - `fsp.rm` for the cache-deletion path, which now goes through
 *    `node:fs/promises#rm` directly (no subprocess) — also spied so
 *    tests can never trash a real Steam install on the dev machine.
 *
 * Both spies are set up in `beforeEach` and restored in `afterEach`
 * per `docs/test-mock-contamination.md`.
 */

interface StubSpawn {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

function makeSpawnStub({ stdout = "", stderr = "", exitCode = 0 }: StubSpawn) {
  return {
    stdout: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(stdout));
        c.close();
      },
    }),
    stderr: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(stderr));
        c.close();
      },
    }),
    exited: Promise.resolve(exitCode),
    exitCode,
  };
}

describe("StorageCleanerBackend", () => {
  let backend: StorageCleanerBackend;
  let emittedEvents: EmitPayload[];
  let spawnSpy: ReturnType<typeof spyOn>;
  let rmSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    backend = new StorageCleanerBackend();
    emittedEvents = [];
    backend.emit = (payload: EmitPayload) => {
      emittedEvents.push(payload);
    };

    // Default: every external command succeeds with empty stdout.
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(
      () => makeSpawnStub({}) as unknown as ReturnType<typeof Bun.spawn>,
    );
    // Default: fs.rm is a no-op. Tests that need an error reassign via
    // `.mockImplementation` (per the spy-stacking gotcha in
    // test-mock-contamination.md).
    rmSpy = spyOn(fsp, "rm").mockImplementation(async () => {});
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    rmSpy.mockRestore();
  });

  // ── Lifecycle ─────────────────────────────────────────────────────

  describe("lifecycle", () => {
    it("onLoad and onUnload run without error", async () => {
      await backend.onLoad();
      await backend.onUnload();
    });
  });

  // ── Numeric appId validation (path traversal prevention) ──────────

  describe("cleanShaderCache - appId validation", () => {
    it("rejects non-numeric appIds to prevent path traversal", async () => {
      const result = await backend.cleanShaderCache([
        "../../../etc/passwd",
        "../../root",
        "valid123notreally/",
        "730; rm -rf /",
      ]);
      expect(result.deleted).toEqual([]);
      expect(result.errors).toHaveLength(4);
      for (const error of result.errors) {
        expect(error).toContain("invalid app ID");
      }
      // None of the rejected appIds should have reached fs.rm.
      expect(rmSpy).not.toHaveBeenCalled();
    });

    it("accepts purely numeric appIds", async () => {
      const result = await backend.cleanShaderCache(["730", "440", "570"]);
      for (const error of result.errors) {
        expect(error).not.toContain("invalid app ID");
      }
      expect(result.deleted).toEqual(["730", "440", "570"]);
      expect(rmSpy).toHaveBeenCalledTimes(3);
    });

    it("emits cacheCleared event for shadercache", async () => {
      await backend.cleanShaderCache(["730"]);
      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].event).toBe("cacheCleared");
      expect((emittedEvents[0].data as { type: string }).type).toBe("shadercache");
    });

    it("surfaces fs.rm failures as per-appId errors", async () => {
      rmSpy.mockImplementation(async () => {
        throw new Error("EACCES: permission denied");
      });
      const result = await backend.cleanShaderCache(["730"]);
      expect(result.deleted).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("730:");
      expect(result.errors[0]).toContain("EACCES");
    });

    it("uses recursive + force so a missing dir isn't an error", async () => {
      await backend.cleanShaderCache(["730"]);
      const opts = rmSpy.mock.calls[0]?.[1] as { recursive?: boolean; force?: boolean } | undefined;
      expect(opts?.recursive).toBe(true);
      expect(opts?.force).toBe(true);
    });
  });

  describe("cleanCompatData - appId validation", () => {
    it("rejects non-numeric appIds", async () => {
      const result = await backend.cleanCompatData(["../hack", "abc"]);
      expect(result.deleted).toEqual([]);
      expect(result.errors).toHaveLength(2);
      for (const error of result.errors) {
        expect(error).toContain("invalid app ID");
      }
    });

    it("handles mix of valid and invalid appIds", async () => {
      const result = await backend.cleanCompatData([
        "730",
        "../etc",
        "440",
        "hello",
      ]);
      const validationErrors = result.errors.filter((e) =>
        e.includes("invalid app ID"),
      );
      expect(validationErrors).toHaveLength(2);
      expect(result.deleted).toEqual(["730", "440"]);
    });

    it("emits cacheCleared event for compatdata", async () => {
      await backend.cleanCompatData(["730"]);
      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].event).toBe("cacheCleared");
      expect((emittedEvents[0].data as { type: string }).type).toBe("compatdata");
    });
  });

  // ── Shader cache / compat data detection ──────────────────────────

  describe("getShaderCacheSize", () => {
    it("returns structured result with total and games array", async () => {
      const result = await backend.getShaderCacheSize();
      expect(result).toHaveProperty("total");
      expect(result).toHaveProperty("totalFormatted");
      expect(result).toHaveProperty("games");
      expect(typeof result.total).toBe("number");
      expect(typeof result.totalFormatted).toBe("string");
      expect(Array.isArray(result.games)).toBe(true);
    });

    it("games are sorted by size descending", async () => {
      const result = await backend.getShaderCacheSize();
      for (let i = 1; i < result.games.length; i++) {
        expect(result.games[i - 1].sizeBytes).toBeGreaterThanOrEqual(
          result.games[i].sizeBytes,
        );
      }
    });
  });

  describe("getCompatDataSize", () => {
    it("returns structured result", async () => {
      const result = await backend.getCompatDataSize();
      expect(result).toHaveProperty("total");
      expect(result).toHaveProperty("totalFormatted");
      expect(result).toHaveProperty("games");
      expect(Array.isArray(result.games)).toBe(true);
    });
  });

  describe("getOrphanedData", () => {
    it("returns structured result with entries", async () => {
      const result = await backend.getOrphanedData();
      expect(result).toHaveProperty("total");
      expect(result).toHaveProperty("totalFormatted");
      expect(result).toHaveProperty("entries");
      expect(Array.isArray(result.entries)).toBe(true);
    });

    it("entries are sorted by size descending", async () => {
      const result = await backend.getOrphanedData();
      for (let i = 1; i < result.entries.length; i++) {
        expect(result.entries[i - 1].sizeBytes).toBeGreaterThanOrEqual(
          result.entries[i].sizeBytes,
        );
      }
    });

    it("batches du into a single subprocess per RPC, not one per dir", async () => {
      // Pre-populate two shadercache dirs by stubbing readdir.
      const readdirSpy = spyOn(fsp, "readdir").mockImplementation(
        async (path: unknown) => {
          const p = String(path);
          if (p.endsWith("shadercache")) return ["111", "222"] as never;
          if (p.endsWith("compatdata")) return ["333"] as never;
          return [] as never;
        },
      );
      try {
        spawnSpy.mockClear();
        await backend.getOrphanedData();
        const duCalls = spawnSpy.mock.calls.filter((args) => {
          const argv = (args[0] as string[] | undefined) ?? [];
          return argv[0] === "du";
        });
        // One batched du call for all candidates — not 3.
        expect(duCalls.length).toBeLessThanOrEqual(1);
      } finally {
        readdirSpy.mockRestore();
      }
    });
  });

  // ── getDiskUsage ──────────────────────────────────────────────────

  describe("getDiskUsage", () => {
    it("returns an array of partitions", async () => {
      spawnSpy.mockImplementation(
        () =>
          makeSpawnStub({
            stdout:
              "Filesystem      Size  Used Avail Use% Mounted on\n" +
              "/dev/sda1       500G  200G  300G  40% /\n",
            exitCode: 0,
          }) as unknown as ReturnType<typeof Bun.spawn>,
      );
      const result = await backend.getDiskUsage();
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        filesystem: "/dev/sda1",
        size: "500G",
        used: "200G",
        available: "300G",
        usePercent: "40%",
        mountpoint: "/",
      });
    });

    it("dedupes a multi-library setup (root + home + extra library on same FS)", async () => {
      spawnSpy.mockImplementation(
        () =>
          makeSpawnStub({
            stdout:
              "Filesystem      Size  Used Avail Use% Mounted on\n" +
              "/dev/nvme0n1p2  500G  200G  300G  40% /\n" +
              "/dev/nvme0n1p2  500G  200G  300G  40% /home\n" +
              "/dev/sdb1       1.0T  500G  500G  50% /run/media/mmcblk0p1\n",
            exitCode: 0,
          }) as unknown as ReturnType<typeof Bun.spawn>,
      );
      const result = await backend.getDiskUsage();
      // Two distinct filesystems: the system root and the SD-card lib.
      expect(result.map((r) => r.filesystem)).toEqual([
        "/dev/nvme0n1p2",
        "/dev/sdb1",
      ]);
    });

    it("returns empty array when df returns no rows", async () => {
      const result = await backend.getDiskUsage();
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });
  });
});

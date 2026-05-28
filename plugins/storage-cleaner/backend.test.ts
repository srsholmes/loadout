import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import type { EmitPayload } from "@loadout/types";
import StorageCleanerBackend from "./backend";

/**
 * StorageCleanerBackend tests.
 *
 * run / runFull (from @loadout/exec) internally call Bun.spawn, so we
 * spy on Bun.spawn to intercept all external commands (df / du / rm).
 * Spec files are exempt from the no-Bun.spawn eslint rule.
 *
 * Each test stubs Bun.spawn with a specific stdout/exitCode to verify
 * parsing, sorting, error handling, and the emit/event contract. The
 * underlying filesystem isn't touched.
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
  });

  afterEach(() => {
    spawnSpy.mockRestore();
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
      // All should be in errors, none in deleted
      expect(result.deleted).toEqual([]);
      expect(result.errors).toHaveLength(4);
      for (const error of result.errors) {
        expect(error).toContain("invalid app ID");
      }
    });

    it("accepts purely numeric appIds", async () => {
      const result = await backend.cleanShaderCache(["730", "440", "570"]);
      for (const error of result.errors) {
        expect(error).not.toContain("invalid app ID");
      }
      expect(result.deleted).toEqual(["730", "440", "570"]);
    });

    it("emits cacheCleared event for shadercache", async () => {
      await backend.cleanShaderCache(["730"]);
      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].event).toBe("cacheCleared");
      expect((emittedEvents[0].data as { type: string }).type).toBe("shadercache");
    });

    it("surfaces non-zero exit codes as per-appId errors", async () => {
      spawnSpy.mockImplementation(
        () =>
          makeSpawnStub({
            stderr: "rm: no such file",
            exitCode: 1,
          }) as unknown as ReturnType<typeof Bun.spawn>,
      );
      const result = await backend.cleanShaderCache(["730"]);
      expect(result.deleted).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("730:");
      expect(result.errors[0]).toContain("rm: no such file");
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
      // 2 should fail validation
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

    it("returns empty array when df returns no rows", async () => {
      const result = await backend.getDiskUsage();
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });
  });
});

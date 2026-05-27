import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import type { EmitPayload } from "@loadout/types";
import StorageCleanerBackend from "./backend";

/**
 * StorageCleanerBackend tests.
 *
 * Most public methods depend on reading actual Steam directories and
 * running system commands (du, df, rm). We test the aspects we can
 * exercise in a test environment: input validation, error handling,
 * and the emit/event contract. Methods that need the real filesystem
 * gracefully degrade (empty results or thrown errors).
 */

describe("StorageCleanerBackend", () => {
  let backend: StorageCleanerBackend;
  let emittedEvents: EmitPayload[];

  beforeEach(() => {
    backend = new StorageCleanerBackend();
    emittedEvents = [];
    backend.emit = (payload: EmitPayload) => {
      emittedEvents.push(payload);
    };
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
      // These will attempt to delete but the paths won't exist in test,
      // which is fine — rm -rf on non-existent paths succeeds.
      const result = await backend.cleanShaderCache(["730", "440", "570"]);
      // In test env the rm -rf call may succeed (path just doesn't exist)
      // or fail if the steam dir doesn't exist, either way no validation error.
      for (const error of result.errors) {
        expect(error).not.toContain("invalid app ID");
      }
    });

    it("emits cacheCleared event for shadercache", async () => {
      await backend.cleanShaderCache(["730"]);
      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].event).toBe("cacheCleared");
      expect(emittedEvents[0].data.type).toBe("shadercache");
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
    });

    it("emits cacheCleared event for compatdata", async () => {
      await backend.cleanCompatData(["730"]);
      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].event).toBe("cacheCleared");
      expect(emittedEvents[0].data.type).toBe("compatdata");
    });
  });

  // ── Shader cache / compat data detection ──────────────────────────

  describe("getShaderCacheSize", () => {
    it("returns structured result with total and games array", async () => {
      const result = await backend.getShaderCacheSize();
      // In test env, the Steam dir won't exist so we get zero/empty
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
      const result = await backend.getDiskUsage();
      expect(Array.isArray(result)).toBe(true);
      // On any system with df available, we should get at least one partition
      if (result.length > 0) {
        expect(result[0]).toHaveProperty("filesystem");
        expect(result[0]).toHaveProperty("size");
        expect(result[0]).toHaveProperty("used");
        expect(result[0]).toHaveProperty("available");
        expect(result[0]).toHaveProperty("usePercent");
        expect(result[0]).toHaveProperty("mountpoint");
      }
    });
  });
});

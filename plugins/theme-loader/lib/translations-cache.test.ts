import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetForTests,
  ensureTranslations,
  getCachePath,
  getTranslationsStatus,
  refreshTranslations,
} from "./translations-cache";

const SAMPLE: Record<string, string[]> = {
  // Two entries with old → current variants we expect mapped.
  ButtonClass: ["_OldButtonHash", "_NewButtonHash"],
  TitleClass: ["_OldTitleHash", "_MidTitleHash", "_CurrentTitleHash"],
  // No translation needed (single entry).
  Singleton: ["_StableOnly"],
};

const realFetch = globalThis.fetch;

let cacheDir: string;

async function makeTempCacheDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "theme-loader-cache-"));
}

function mockFetchOk(body: unknown): void {
  globalThis.fetch = mock(async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
}

function mockFetchFail(message = "network down"): void {
  globalThis.fetch = mock(async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

describe("translations-cache", () => {
  beforeEach(async () => {
    cacheDir = await makeTempCacheDir();
    _resetForTests({ cacheDir });
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    try { await rm(cacheDir, { recursive: true, force: true }); } catch { /* nothing to remove */ }
  });

  describe("ensureTranslations", () => {
    it("starts in pending and transitions to ready after a successful fetch", async () => {
      mockFetchOk(SAMPLE);
      expect(getTranslationsStatus().state).toBe("pending");

      const map = await ensureTranslations();

      // ButtonClass: only one old → new
      expect(map.get("_OldButtonHash")).toBe("_NewButtonHash");
      // TitleClass: both old hashes map forward to the latest
      expect(map.get("_OldTitleHash")).toBe("_CurrentTitleHash");
      expect(map.get("_MidTitleHash")).toBe("_CurrentTitleHash");
      // Singleton: no entry produced (no old → current pair)
      expect(map.has("_StableOnly")).toBe(false);

      const status = getTranslationsStatus();
      expect(status.state).toBe("ready");
      expect(status.entryCount).toBe(map.size);
      expect(status.syncedAt).not.toBeNull();
      expect(status.lastError).toBeNull();
    });

    it("uses an existing fresh cache without hitting the network", async () => {
      // Seed cache file directly.
      await writeFile(getCachePath(), JSON.stringify(SAMPLE));
      let fetchCalls = 0;
      globalThis.fetch = mock(async () => {
        fetchCalls++;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;

      const map = await ensureTranslations();
      expect(map.get("_OldButtonHash")).toBe("_NewButtonHash");
      expect(fetchCalls).toBe(0);
      expect(getTranslationsStatus().state).toBe("ready");
    });

    it("falls back to a stale on-disk cache when the upstream is unreachable", async () => {
      await writeFile(getCachePath(), JSON.stringify(SAMPLE));
      // Backdate the cache to 30 hours ago so it is treated as stale.
      const stale = new Date(Date.now() - 30 * 60 * 60 * 1000);
      await utimes(getCachePath(), stale, stale);
      mockFetchFail();

      const map = await ensureTranslations();
      expect(map.size).toBeGreaterThan(0);
      // We are "ready" because we still have a usable map, even though
      // the background revalidate failed.
      expect(getTranslationsStatus().state).toBe("ready");
    });

    it("ends in error state when there is no cache and the fetch fails", async () => {
      mockFetchFail("DNS failure");

      const map = await ensureTranslations();
      expect(map.size).toBe(0);
      const status = getTranslationsStatus();
      expect(status.state).toBe("error");
      expect(status.lastError).toContain("DNS failure");
    });
  });

  describe("refreshTranslations", () => {
    it("force-refresh re-fetches even when the in-memory map is fresh", async () => {
      mockFetchOk(SAMPLE);
      await ensureTranslations();
      expect(getTranslationsStatus().state).toBe("ready");

      let secondFetched = false;
      globalThis.fetch = mock(async () => {
        secondFetched = true;
        return new Response(JSON.stringify(SAMPLE), { status: 200 });
      }) as unknown as typeof fetch;

      await refreshTranslations({ force: true });
      expect(secondFetched).toBe(true);
    });

    it("non-force returns immediately when the cache is fresh", async () => {
      mockFetchOk(SAMPLE);
      await ensureTranslations();

      let fetched = false;
      globalThis.fetch = mock(async () => {
        fetched = true;
        return new Response(JSON.stringify(SAMPLE), { status: 200 });
      }) as unknown as typeof fetch;

      await refreshTranslations();
      expect(fetched).toBe(false);
    });
  });

  describe("on-disk persistence", () => {
    it("writes the fetched payload to the cache directory", async () => {
      mockFetchOk(SAMPLE);
      await ensureTranslations();
      const onDisk = JSON.parse(await readFile(getCachePath(), "utf-8")) as Record<string, string[]>;
      expect(onDisk.ButtonClass).toEqual(["_OldButtonHash", "_NewButtonHash"]);
    });

    it("does not rewrite the cache file when the upstream payload is unchanged (sha256 dedupe)", async () => {
      mockFetchOk(SAMPLE);
      await ensureTranslations();
      const beforeMtime = (await stat(getCachePath())).mtimeMs;

      // Wait a tiny bit so any rewrite would visibly bump mtime.
      await new Promise((r) => setTimeout(r, 30));

      // Force a refresh; same body.
      await refreshTranslations({ force: true });

      const afterMtime = (await stat(getCachePath())).mtimeMs;
      expect(afterMtime).toBe(beforeMtime);
    });
  });
});

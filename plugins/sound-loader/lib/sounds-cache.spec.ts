import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetForTests,
  ensureCommunityPacks,
  getCachePath,
  getCommunityPacksStatus,
  refreshCommunityPacks,
} from "./sounds-cache";

const SAMPLE = [
  {
    id: "uuid-a",
    name: "Pack A",
    version: "v1.0",
    author: "AuthorA",
    description: "first pack",
    target: "Audio",
    download_url: "https://api.deckthemes.com/blobs/aaa",
    preview_image: "https://api.deckthemes.com/blobs/img-a",
    source: "https://github.com/foo/bar @ deadbeef",
    manifest_version: 2,
    music: false,
    last_changed: "01/01/2024 00:00:00 +00:00",
  },
  {
    id: "uuid-b",
    name: "Pack B",
    version: "v0.5",
    author: "AuthorB",
    description: "second pack",
    target: "Audio",
    download_url: "https://api.deckthemes.com/blobs/bbb",
    preview_image: null,
    source: "[Zip Deploy]",
    manifest_version: 1,
    music: true,
    last_changed: "02/02/2024 00:00:00 +00:00",
  },
];

const realFetch = globalThis.fetch;

let cacheDir: string;

async function makeTempCacheDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "sound-loader-cache-"));
}

function mockFetchPaged(items: unknown[]): void {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("page=1")) {
      return new Response(JSON.stringify(items), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("[]", { status: 200 });
  }) as unknown as typeof fetch;
}

function mockFetchFail(message = "network down"): void {
  globalThis.fetch = mock(async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

describe("sounds-cache", () => {
  beforeEach(async () => {
    cacheDir = await makeTempCacheDir();
    _resetForTests({ cacheDir });
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    try { await rm(cacheDir, { recursive: true, force: true }); } catch {}
  });

  describe("ensureCommunityPacks", () => {
    it("starts in pending and transitions to ready after a successful fetch", async () => {
      mockFetchPaged(SAMPLE);
      expect(getCommunityPacksStatus().state).toBe("pending");

      const packs = await ensureCommunityPacks();
      expect(packs).toHaveLength(2);

      const a = packs.find((p) => p.id === "uuid-a");
      expect(a?.name).toBe("Pack A");
      expect(a?.downloadUrl).toBe("https://api.deckthemes.com/blobs/aaa");
      expect(a?.previewImageUrl).toBe("https://api.deckthemes.com/blobs/img-a");
      // Source with trailing @sha is parsed cleanly.
      expect(a?.githubUrl).toBe("https://github.com/foo/bar");

      const b = packs.find((p) => p.id === "uuid-b");
      expect(b?.music).toBe(true);
      // "[Zip Deploy]" sources don't yield a github URL.
      expect(b?.githubUrl).toBeNull();
      expect(b?.previewImageUrl).toBeNull();

      const status = getCommunityPacksStatus();
      expect(status.state).toBe("ready");
      expect(status.entryCount).toBe(2);
      expect(status.syncedAt).not.toBeNull();
      expect(status.lastError).toBeNull();
    });

    it("uses an existing fresh cache without hitting the network", async () => {
      const cached = SAMPLE.map((s) => ({
        id: s.id,
        name: s.name,
        author: s.author,
        description: s.description,
        version: s.version,
        downloadUrl: s.download_url,
        previewImageUrl: s.preview_image,
        githubUrl: null,
        lastChanged: s.last_changed,
        manifestVersion: s.manifest_version,
        music: s.music,
      }));
      await writeFile(getCachePath(), JSON.stringify(cached));
      let fetchCalls = 0;
      globalThis.fetch = mock(async () => {
        fetchCalls++;
        return new Response("[]", { status: 200 });
      }) as unknown as typeof fetch;

      const packs = await ensureCommunityPacks();
      expect(packs).toHaveLength(2);
      expect(fetchCalls).toBe(0);
      expect(getCommunityPacksStatus().state).toBe("ready");
    });

    it("falls back to a stale on-disk cache when the upstream is unreachable", async () => {
      const cached = [
        {
          id: "uuid-a",
          name: "Pack A",
          author: "AuthorA",
          description: "",
          version: "v1.0",
          downloadUrl: "https://api.deckthemes.com/blobs/aaa",
          previewImageUrl: null,
          githubUrl: null,
          lastChanged: "",
          manifestVersion: 2,
          music: false,
        },
      ];
      await writeFile(getCachePath(), JSON.stringify(cached));
      // Backdate the cache to 30 hours ago so it is treated as stale.
      const stale = new Date(Date.now() - 30 * 60 * 60 * 1000);
      await utimes(getCachePath(), stale, stale);
      mockFetchFail();

      const packs = await ensureCommunityPacks();
      expect(packs).toHaveLength(1);
      // We are "ready" because we still have a usable list, even though
      // the background revalidate failed.
      expect(getCommunityPacksStatus().state).toBe("ready");
    });

    it("ends in error state when there is no cache and the fetch fails", async () => {
      mockFetchFail("DNS failure");

      const packs = await ensureCommunityPacks();
      expect(packs).toHaveLength(0);
      const status = getCommunityPacksStatus();
      expect(status.state).toBe("error");
      expect(status.lastError).toContain("DNS failure");
    });
  });

  describe("refreshCommunityPacks", () => {
    it("force-refresh re-fetches even when the in-memory list is fresh", async () => {
      mockFetchPaged(SAMPLE);
      await ensureCommunityPacks();
      expect(getCommunityPacksStatus().state).toBe("ready");

      let secondFetched = false;
      globalThis.fetch = mock(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("page=1")) {
          secondFetched = true;
          return new Response(JSON.stringify(SAMPLE), { status: 200 });
        }
        return new Response("[]", { status: 200 });
      }) as unknown as typeof fetch;

      await refreshCommunityPacks({ force: true });
      expect(secondFetched).toBe(true);
    });

    it("non-force returns immediately when the cache is fresh", async () => {
      mockFetchPaged(SAMPLE);
      await ensureCommunityPacks();

      let fetched = false;
      globalThis.fetch = mock(async () => {
        fetched = true;
        return new Response("[]", { status: 200 });
      }) as unknown as typeof fetch;

      await refreshCommunityPacks();
      expect(fetched).toBe(false);
    });
  });

  describe("on-disk persistence", () => {
    it("writes the fetched payload to the cache directory", async () => {
      mockFetchPaged(SAMPLE);
      await ensureCommunityPacks();
      const onDisk = JSON.parse(await readFile(getCachePath(), "utf-8")) as Array<{ id: string }>;
      expect(onDisk).toHaveLength(2);
      expect(onDisk.map((p) => p.id)).toContain("uuid-a");
    });

    it("does not rewrite the cache file when the upstream payload is unchanged (sha256 dedupe)", async () => {
      mockFetchPaged(SAMPLE);
      await ensureCommunityPacks();
      const beforeMtime = (await stat(getCachePath())).mtimeMs;

      // Wait a tiny bit so any rewrite would visibly bump mtime.
      await new Promise((r) => setTimeout(r, 30));

      // Force a refresh; same body.
      await refreshCommunityPacks({ force: true });

      const afterMtime = (await stat(getCachePath())).mtimeMs;
      expect(afterMtime).toBe(beforeMtime);
    });
  });

  describe("pagination", () => {
    it("terminates when an empty page is returned", async () => {
      let pageCount = 0;
      globalThis.fetch = mock(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        const m = url.match(/page=(\d+)/);
        const page = m ? Number(m[1]) : 1;
        pageCount = Math.max(pageCount, page);
        if (page === 1) return new Response(JSON.stringify(SAMPLE), { status: 200 });
        return new Response("[]", { status: 200 });
      }) as unknown as typeof fetch;

      await ensureCommunityPacks();
      // Should have fetched page 1 then page 2 (empty), and stopped.
      expect(pageCount).toBe(2);
    });
  });
});

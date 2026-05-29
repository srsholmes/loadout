import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import type { EmitPayload } from "@loadout/types";
import SoundLoaderBackend from "./backend";
import { _resetForTests, getCachePath } from "./lib/sounds-cache";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Tests for the Sound Loader backend.
 *
 * The backend resolves all on-disk paths from process.env.HOME (lazily,
 * per call), so each test sandbox just points HOME + XDG_CONFIG_HOME at
 * a tmpdir and restores them in afterEach. That keeps the public RPC
 * surface (listPacks, getActivePack, setActivePack, ...) testable
 * without monkey-patching module-level constants.
 */

const originalHome = process.env.HOME;
const originalXdg = process.env.XDG_CONFIG_HOME;

describe("SoundLoaderBackend", () => {
  let backend: SoundLoaderBackend;
  let emittedEvents: EmitPayload[];
  let sandboxHome: string;

  beforeEach(async () => {
    sandboxHome = await mkdtemp(join(tmpdir(), "sound-loader-test-"));
    process.env.HOME = sandboxHome;
    process.env.XDG_CONFIG_HOME = join(sandboxHome, ".config");

    backend = new SoundLoaderBackend();
    emittedEvents = [];
    backend.emit = (payload: EmitPayload) => {
      emittedEvents.push(payload);
    };
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdg;
    }
    await rm(sandboxHome, { recursive: true, force: true });
  });

  it("starts with null active pack (default mode)", async () => {
    const active = await backend.getActivePack();
    expect(active).toBeNull();
  });

  it("setActivePack to synthesized mode succeeds", async () => {
    const result = await backend.setActivePack("synthesized");
    expect(result.success).toBe(true);

    const active = await backend.getActivePack();
    expect(active).toBe("synthesized");
  });

  it("setActivePack to null (default) succeeds", async () => {
    await backend.setActivePack("synthesized");
    const result = await backend.setActivePack(null);
    expect(result.success).toBe(true);

    const active = await backend.getActivePack();
    expect(active).toBeNull();
  });

  it("setActivePack emits activePackChanged event", async () => {
    await backend.setActivePack("synthesized");
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].event).toBe("activePackChanged");
    expect(emittedEvents[0].data).toEqual({ activePack: "synthesized" });
  });

  it("setActivePack rejects unknown pack IDs", async () => {
    const result = await backend.setActivePack("nonexistent-pack");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("getActivePackMappings returns empty for default mode", async () => {
    const result = await backend.getActivePackMappings();
    expect(result.packId).toBeNull();
    expect(result.mappings).toEqual({});
    expect(result.ignore).toEqual([]);
  });

  it("getActivePackMappings returns empty for synthesized mode", async () => {
    await backend.setActivePack("synthesized");
    const result = await backend.getActivePackMappings();
    expect(result.packId).toBe("synthesized");
    expect(result.mappings).toEqual({});
  });
});

const SAMPLE_API_RESPONSE = [
  {
    id: "pack-uuid-1",
    name: "PSP Sounds",
    version: "v1.0",
    author: "SGL-Galaxy",
    description: "PlayStation Portable menu sounds",
    target: "Audio",
    download_url: "https://api.deckthemes.com/blobs/blob-1",
    preview_image: "https://api.deckthemes.com/blobs/img-1",
    source: "https://github.com/example/psp @ deadbeef",
    manifest_version: 2,
    music: false,
    last_changed: "07/29/2023 02:25:47 +00:00",
  },
  {
    id: "pack-uuid-2",
    name: "Lo-Fi Beats",
    version: "v0.5",
    author: "DJ Test",
    description: "music pack",
    target: "Audio",
    download_url: "https://api.deckthemes.com/blobs/blob-2",
    preview_image: null,
    source: "[Zip Deploy]",
    manifest_version: 2,
    music: true,
    last_changed: "01/01/2024 00:00:00 +00:00",
  },
];

describe("SoundLoaderBackend community packs (live API)", () => {
  const realFetch = globalThis.fetch;
  let backend: SoundLoaderBackend;
  let cacheDir: string;
  let packsDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "sound-loader-cache-"));
    packsDir = await mkdtemp(join(tmpdir(), "sound-loader-packs-"));
    _resetForTests({ cacheDir });
    backend = new SoundLoaderBackend();
    backend.emit = () => {};
    // Tests bypass disk side-effects: listCommunityPacks reads
    // SOUND_PACKS_DIR for installed-status, but a mismatch (always empty)
    // is fine for these assertions.
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    await rm(cacheDir, { recursive: true, force: true });
    await rm(packsDir, { recursive: true, force: true });
  });

  it("listCommunityPacks fetches the live API on first call", async () => {
    let pageCalls = 0;
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      pageCalls++;
      // Page 1 returns the sample. Page 2 returns empty to terminate the loop.
      if (url.includes("page=1")) {
        return new Response(JSON.stringify(SAMPLE_API_RESPONSE), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;

    const packs = await backend.listCommunityPacks();
    expect(pageCalls).toBeGreaterThan(0);
    expect(packs).toHaveLength(2);

    const first = packs.find((p) => p.id === "pack-uuid-1");
    expect(first).toBeDefined();
    expect(first?.name).toBe("PSP Sounds");
    expect(first?.author).toBe("SGL-Galaxy");
    expect(first?.downloadUrl).toBe("https://api.deckthemes.com/blobs/blob-1");
    expect(first?.previewImageUrl).toBe("https://api.deckthemes.com/blobs/img-1");
    expect(first?.githubUrl).toBe("https://github.com/example/psp");
    expect(first?.installed).toBe(false);
  });

  it("getCommunityPacksStatus reflects pending → ready transition", async () => {
    expect((await backend.getCommunityPacksStatus()).state).toBe("pending");

    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      return url.includes("page=1")
        ? new Response(JSON.stringify(SAMPLE_API_RESPONSE), { status: 200 })
        : new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;

    await backend.listCommunityPacks();
    const status = await backend.getCommunityPacksStatus();
    expect(status.state).toBe("ready");
    expect(status.entryCount).toBe(2);
    expect(status.lastError).toBeNull();
  });

  it("ends in error state when fetch fails and no cache exists", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("DNS failure");
    }) as unknown as typeof fetch;

    const packs = await backend.listCommunityPacks();
    expect(packs).toEqual([]);
    const status = await backend.getCommunityPacksStatus();
    expect(status.state).toBe("error");
    expect(status.lastError).toContain("DNS failure");
  });

  it("writes the fetched payload to the cache directory", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      return url.includes("page=1")
        ? new Response(JSON.stringify(SAMPLE_API_RESPONSE), { status: 200 })
        : new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;

    await backend.listCommunityPacks();
    const onDisk = JSON.parse(await readFile(getCachePath(), "utf-8"));
    expect(onDisk).toHaveLength(2);
    expect(onDisk[0].id).toBe("pack-uuid-1");
  });

  it("installCommunityPack rejects unknown ids", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      return url.includes("page=1")
        ? new Response(JSON.stringify(SAMPLE_API_RESPONSE), { status: 200 })
        : new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;

    const result = await backend.installCommunityPack("nonexistent-uuid");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("installCommunityPack rejects ids that look like path traversal", async () => {
    const result = await backend.installCommunityPack("../etc/passwd");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid pack id");
  });
});

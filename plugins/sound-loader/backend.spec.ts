import { describe, it, expect, beforeEach, mock, afterEach } from "bun:test";
import type { EmitPayload } from "@loadout/types";
import SoundLoaderBackend from "./backend";
import { _resetForTests, getCachePath } from "./lib/sounds-cache";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Tests for the Sound Loader backend.
 *
 * We test the public RPC methods (listPacks, getActivePack, setActivePack,
 * getActivePackMappings, listCommunityPacks, getCommunityPacksStatus) by
 * pointing the backend at a temp directory and mocking the deckthemes API.
 */

// Helper: create a minimal WAV file (44-byte RIFF header + 1 sample)
function minimalWav(): Buffer {
  const buf = Buffer.alloc(46);
  // RIFF header
  buf.write("RIFF", 0);
  buf.writeUInt32LE(38, 4); // file size - 8
  buf.write("WAVE", 8);
  // fmt chunk
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(44100, 24); // sample rate
  buf.writeUInt32LE(88200, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  // data chunk
  buf.write("data", 36);
  buf.writeUInt32LE(2, 40); // data size
  buf.writeInt16LE(0, 44); // one silent sample
  return buf;
}

describe("SoundLoaderBackend", () => {
  let backend: SoundLoaderBackend;
  let emittedEvents: EmitPayload[];
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sound-loader-test-"));

    // Patch the backend's paths using a subclass approach
    backend = new SoundLoaderBackend();
    emittedEvents = [];
    backend.emit = (payload: EmitPayload) => {
      emittedEvents.push(payload);
    };

    // Override private paths for testing (using Object.defineProperty)
    // We need to monkey-patch the module-level constants, so instead
    // we'll test via the public API and create packs in the expected location.
    // For unit tests, we test the logic by directly accessing internals.
    (backend as any)._testOverridePaths = {
      soundPacksDir: tempDir,
      configPath: join(tempDir, "config.json"),
    };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
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

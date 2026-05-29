import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import type { EmitPayload } from "@loadout/types";
import SoundLoaderBackend from "./backend";
import { _resetForTests, getCachePath } from "./lib/sounds-cache";
import { mkdtemp, rm, readFile, mkdir, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

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

  it("listCommunityPacks drops packs whose downloadUrl is off the host allow-list", async () => {
    const hostile = [
      ...SAMPLE_API_RESPONSE,
      {
        id: "evil-uuid",
        name: "Evil",
        version: "1",
        author: "Bad",
        description: "Compromised registry payload",
        target: "Audio",
        // Not on the allow-list (`api.deckthemes.com` / `cdn.deckthemes.com`).
        download_url: "https://evil.example.com/blobs/payload",
        preview_image: null,
        source: "[Zip Deploy]",
        manifest_version: 2,
        music: false,
        last_changed: "01/01/2024",
      },
    ];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      return url.includes("page=1")
        ? new Response(JSON.stringify(hostile), { status: 200 })
        : new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;

    const packs = await backend.listCommunityPacks();
    expect(packs.find((p) => p.id === "evil-uuid")).toBeUndefined();
    expect(packs.find((p) => p.id === "pack-uuid-1")).toBeDefined();
  });

  it("listCommunityPacks scrubs previewImageUrl that isn't on the host allow-list", async () => {
    const sneaky = [
      {
        ...SAMPLE_API_RESPONSE[0],
        // downloadUrl stays clean, but the preview is a hostile tracker.
        preview_image: "https://tracker.example/pixel.png",
      },
    ];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      return url.includes("page=1")
        ? new Response(JSON.stringify(sneaky), { status: 200 })
        : new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;

    const packs = await backend.listCommunityPacks();
    expect(packs).toHaveLength(1);
    expect(packs[0].previewImageUrl).toBeNull();
  });

  it("installCommunityPack happy path: downloads, extracts, maps Decky filenames, writes pack.json", async () => {
    // Build a real on-disk zip we can hand the install path. The pack
    // contains a couple of Decky-canonical filenames; the install path
    // must rewrite the manifest to map our event names to those files.
    const packBuildDir = await mkdtemp(join(tmpdir(), "sound-loader-build-"));
    const zipDir = await mkdtemp(join(tmpdir(), "sound-loader-zip-"));
    const zipPath = join(zipDir, "pack.zip");

    // Tiny silent WAVs (RIFF header + zero data — enough to satisfy
    // ext-based discovery, no audio playback in tests).
    const silentWav = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.from([0x24, 0, 0, 0]),
      Buffer.from("WAVEfmt ", "ascii"),
      Buffer.from([16, 0, 0, 0, 1, 0, 1, 0, 0x44, 0xAC, 0, 0, 0x88, 0x58, 1, 0, 2, 0, 16, 0]),
      Buffer.from("data", "ascii"),
      Buffer.from([0, 0, 0, 0]),
    ]);
    await writeFile(join(packBuildDir, "deck_ui_navigation.wav"), silentWav);
    await writeFile(join(packBuildDir, "deck_ui_default_activation.wav"), silentWav);

    const zipResult = spawnSync("zip", ["-r", zipPath, "."], { cwd: packBuildDir });
    expect(zipResult.status).toBe(0);
    const zipBytes = await readFile(zipPath);

    // Point HOME at a sandbox so SOUND_PACKS_DIR() lands somewhere we
    // can inspect + clean up.
    const installSandbox = await mkdtemp(join(tmpdir(), "sound-loader-install-"));
    const originalHomeLocal = process.env.HOME;
    process.env.HOME = installSandbox;

    try {
      globalThis.fetch = mock(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/blobs/blob-1")) {
          return new Response(zipBytes, {
            status: 200,
            headers: { "content-length": String(zipBytes.byteLength) },
          });
        }
        if (url.includes("page=1")) {
          return new Response(JSON.stringify(SAMPLE_API_RESPONSE), { status: 200 });
        }
        return new Response("[]", { status: 200 });
      }) as unknown as typeof fetch;

      const result = await backend.installCommunityPack("pack-uuid-1");
      expect(result.success).toBe(true);

      // Pack landed in SOUND_PACKS_DIR.
      const installedDir = join(installSandbox, ".local/share/loadout/sound-packs/pack-uuid-1");
      const installed = await readdir(installedDir);
      expect(installed).toContain("deck_ui_navigation.wav");
      expect(installed).toContain("pack.json");
      expect(installed).toContain("pack-meta.json");

      // pack.json maps `nav` + `select` to the bundled Decky filenames.
      const manifest = JSON.parse(
        await readFile(join(installedDir, "pack.json"), "utf-8"),
      );
      expect(manifest.name).toBe("PSP Sounds");
      expect(manifest.mappings.nav).toBe("deck_ui_navigation.wav");
      expect(manifest.mappings.select).toBe("deck_ui_default_activation.wav");

      // Attribution captured.
      const meta = JSON.parse(
        await readFile(join(installedDir, "pack-meta.json"), "utf-8"),
      );
      expect(meta.id).toBe("pack-uuid-1");
      expect(meta.author).toBe("SGL-Galaxy");
    } finally {
      if (originalHomeLocal === undefined) delete process.env.HOME;
      else process.env.HOME = originalHomeLocal;
      await rm(packBuildDir, { recursive: true, force: true });
      await rm(zipDir, { recursive: true, force: true });
      await rm(installSandbox, { recursive: true, force: true });
    }
  });

  it("installCommunityPack rejects zips containing path-traversal entries", async () => {
    // Build a zip with a `../escape.txt` entry — must be rejected by
    // the pre-extraction listing check.
    const packBuildDir = await mkdtemp(join(tmpdir(), "sound-loader-evil-"));
    const zipDir = await mkdtemp(join(tmpdir(), "sound-loader-evil-zip-"));
    const zipPath = join(zipDir, "evil.zip");

    await writeFile(join(packBuildDir, "innocent.wav"), Buffer.from([0]));
    // zip -y carries paths literally; jam in a traversal entry by
    // constructing it inside a parent dir.
    await mkdir(join(packBuildDir, "sub"));
    await writeFile(join(packBuildDir, "sub", "innocent.wav"), Buffer.from([0]));
    // zip the parent dir; then doctor the entry name by running zip
    // with --symlinks won't add `..` — instead we use printf to write
    // a relative path zip directly. Simpler: use Node's archive via shell.
    // `zip` itself sanitises paths. Use `zip --junk-paths`? No — we
    // need `..` in the path. Build a synthetic zip with `printf` + zip
    // helper from python if available; fall back to skipping if not.
    const python = spawnSync(
      "python3",
      [
        "-c",
        "import zipfile,sys\n" +
          "z=zipfile.ZipFile(sys.argv[1],'w')\n" +
          "z.writestr('../escape.txt','pwned')\n" +
          "z.writestr('innocent.wav', b'\\x00')\n" +
          "z.close()",
        zipPath,
      ],
    );
    if (python.status !== 0) {
      // Skip — no python3 in the env.
      await rm(packBuildDir, { recursive: true, force: true });
      await rm(zipDir, { recursive: true, force: true });
      return;
    }
    const zipBytes = await readFile(zipPath);

    const installSandbox = await mkdtemp(join(tmpdir(), "sound-loader-evil-install-"));
    const originalHomeLocal = process.env.HOME;
    process.env.HOME = installSandbox;

    try {
      globalThis.fetch = mock(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/blobs/blob-1")) {
          return new Response(zipBytes, {
            status: 200,
            headers: { "content-length": String(zipBytes.byteLength) },
          });
        }
        if (url.includes("page=1")) {
          return new Response(JSON.stringify(SAMPLE_API_RESPONSE), { status: 200 });
        }
        return new Response("[]", { status: 200 });
      }) as unknown as typeof fetch;

      const result = await backend.installCommunityPack("pack-uuid-1");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/unsafe entry|escape/i);
    } finally {
      if (originalHomeLocal === undefined) delete process.env.HOME;
      else process.env.HOME = originalHomeLocal;
      await rm(packBuildDir, { recursive: true, force: true });
      await rm(zipDir, { recursive: true, force: true });
      await rm(installSandbox, { recursive: true, force: true });
    }
  });

  it("installCommunityPack refuses packs whose downloadUrl is off the host allow-list", async () => {
    const hostile = [
      {
        ...SAMPLE_API_RESPONSE[0],
        id: "evil-uuid",
        download_url: "https://evil.example.com/blobs/payload",
      },
    ];
    // Drive the registry via the cache directly so we don't get filtered
    // out by `listCommunityPacks`'s host-pin (which is itself the
    // first line of defense — this asserts the second).
    _resetForTests({ cacheDir });
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      return url.includes("page=1")
        ? new Response(JSON.stringify(hostile), { status: 200 })
        : new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;

    const result = await backend.installCommunityPack("evil-uuid");
    expect(result.success).toBe(false);
    expect(result.error).toContain("disallowed host");
  });
});

/**
 * Lifecycle tests for `_applySteamState`.
 *
 * The injector is mocked at the field level — we swap a stub object that
 * captures each method invocation so we can assert the apply chain is
 * serialized and stale-injector calls bail out cleanly.
 */
type ApplyCallable = () => Promise<void>;

interface InjectorStub {
  calls: string[];
  /** Promise to await inside `tryConnect` so tests can pace the lifecycle. */
  connectGate?: Promise<void>;
  tryConnect: () => Promise<{ ok: boolean; error?: string }>;
  injectHook: () => Promise<{ ok: boolean; error?: string }>;
  refreshOverrides: (
    map: Record<string, string>,
  ) => Promise<{ ok: boolean; error?: string }>;
  removeOverrides: () => Promise<void>;
  startMonitor: (onReinject: () => void | Promise<void>) => void;
  stop: () => Promise<void>;
}

function makeInjectorStub(opts: { connectGate?: Promise<void> } = {}): InjectorStub {
  const stub: InjectorStub = {
    calls: [],
    connectGate: opts.connectGate,
    async tryConnect() {
      stub.calls.push("tryConnect");
      if (stub.connectGate) await stub.connectGate;
      return { ok: true };
    },
    async injectHook() {
      stub.calls.push("injectHook");
      return { ok: true };
    },
    async refreshOverrides() {
      stub.calls.push("refreshOverrides");
      return { ok: true };
    },
    async removeOverrides() {
      stub.calls.push("removeOverrides");
    },
    startMonitor() {
      stub.calls.push("startMonitor");
    },
    async stop() {
      stub.calls.push("stop");
    },
  };
  return stub;
}

describe("SoundLoaderBackend _applySteamState lifecycle", () => {
  let backend: SoundLoaderBackend;
  let sandboxHome: string;
  let emittedEvents: EmitPayload[];

  beforeEach(async () => {
    sandboxHome = await mkdtemp(join(tmpdir(), "sound-loader-apply-"));
    process.env.HOME = sandboxHome;
    backend = new SoundLoaderBackend();
    emittedEvents = [];
    backend.emit = (p: EmitPayload) => {
      emittedEvents.push(p);
    };
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(sandboxHome, { recursive: true, force: true });
  });

  it("noOverride path: clears staging + removes overrides + emits null steamError", async () => {
    const stub = makeInjectorStub();
    // Cast through unknown because the stub is structurally compatible.
    (backend as unknown as { steamInjector: unknown }).steamInjector = stub;

    // useInSteam=false → noOverride branch.
    await (backend as unknown as { _applySteamState: ApplyCallable })._applySteamState();

    expect(stub.calls).toContain("removeOverrides");
    expect(stub.calls).not.toContain("tryConnect");
    const last = emittedEvents.at(-1);
    expect(last?.event).toBe("steamError");
    expect((last?.data as { error: string | null }).error).toBeNull();
  });

  it("serializes concurrent apply calls so they don't interleave", async () => {
    // Gate the first call's tryConnect so we can fire a second call
    // while it's mid-flight. Without the inflightApply chain the
    // second call would run its `removeOverrides` against a stub
    // mid-tryConnect, producing an interleaved call order.
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const stub = makeInjectorStub({ connectGate: gate });
    (backend as unknown as { steamInjector: unknown }).steamInjector = stub;

    // Pre-seed config so the first call hits the connect path, the
    // second falls back to noOverride. Use private-field access for
    // the pack cache so we don't depend on `_scanPacks` finding a
    // real pack on disk.
    (backend as unknown as {
      config: { activePack: string; useInSteam: boolean; useInOverlay: boolean };
    }).config = {
      activePack: "test-pack",
      useInSteam: true,
      useInOverlay: false,
    };
    (backend as unknown as {
      packsCache: Map<string, { manifest: { mappings: object }; dir: string }>;
    }).packsCache.set("test-pack", { manifest: { mappings: {} }, dir: "/tmp/x" });

    const apply = (backend as unknown as { _applySteamState: ApplyCallable })._applySteamState.bind(backend);
    const first = apply();
    // Second call: toggle off useInSteam so it follows the noOverride path.
    (backend as unknown as {
      config: { activePack: string; useInSteam: boolean; useInOverlay: boolean };
    }).config.useInSteam = false;
    const second = apply();

    // Let the first call progress past tryConnect.
    releaseGate();
    await Promise.all([first, second]);

    // The first call must fully run its connect → injectHook chain
    // BEFORE the second call's removeOverrides lands. If the chain
    // interleaved, removeOverrides would appear before refreshOverrides.
    const tryIdx = stub.calls.indexOf("tryConnect");
    const refreshIdx = stub.calls.indexOf("refreshOverrides");
    const removeIdx = stub.calls.indexOf("removeOverrides");
    expect(tryIdx).toBeGreaterThanOrEqual(0);
    expect(refreshIdx).toBeGreaterThan(tryIdx);
    expect(removeIdx).toBeGreaterThan(refreshIdx);
  });

  it("stale injector bails out without driving the closed CDP socket", async () => {
    // First call: gate connect so we can simulate a reconnect mid-call.
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const staleStub = makeInjectorStub({ connectGate: gate });
    (backend as unknown as { steamInjector: unknown }).steamInjector = staleStub;
    (backend as unknown as {
      config: { activePack: string; useInSteam: boolean; useInOverlay: boolean };
    }).config = { activePack: "test-pack", useInSteam: true, useInOverlay: false };
    (backend as unknown as {
      packsCache: Map<string, { manifest: { mappings: object }; dir: string }>;
    }).packsCache.set("test-pack", { manifest: { mappings: {} }, dir: "/tmp/x" });

    const apply = (backend as unknown as { _applySteamState: ApplyCallable })._applySteamState.bind(backend);
    const first = apply();

    // Mid-flight reconnect: swap the injector + bump generation.
    const freshStub = makeInjectorStub();
    (backend as unknown as { steamInjector: unknown }).steamInjector = freshStub;
    (backend as unknown as { injectorGeneration: number }).injectorGeneration++;

    releaseGate();
    await first;

    // The stale call must NOT have proceeded to injectHook /
    // refreshOverrides — those would have raced the new injector's
    // own lifecycle.
    expect(staleStub.calls).toContain("tryConnect");
    expect(staleStub.calls).not.toContain("refreshOverrides");
  });
});

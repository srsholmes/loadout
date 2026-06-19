import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  GameEntry,
  InstalledGame,
  ModEntry,
  PipelineEvent,
} from "./types";

// Sandbox the temp dir so the install pipeline writes into a
// per-test scratch space.
let sandbox = "";
mock.module("./platform", () => ({
  configDir: () => join(sandbox, "config"),
  gamesDir: () => join(sandbox, "games"),
  currentPlatform: () => "linux",
  getPlatformValue: () => undefined,
  getEffectivePlatformValue: () => undefined,
  dataDir: () => sandbox,
  tempDir: () => join(sandbox, "tmp"),
  modCacheDir: (gameId: string, modId: string) =>
    join(sandbox, "cache", "mods", gameId, modId),
}));

// Mock the heavy collaborators so we can drive each install path
// without touching the network / running unzip.
let downloadCalls: Array<{ url: string; dest: string }> = [];
let downloadProducer: ((dest: string) => Promise<void>) = async () => {};
mock.module("./github", () => ({
  downloadFile: async (
    url: string,
    dest: string,
    onProgress?: (downloaded: number, total: number) => void,
  ) => {
    downloadCalls.push({ url, dest });
    onProgress?.(50, 100);
    await downloadProducer(dest);
    onProgress?.(100, 100);
  },
  githubToken: async () => undefined,
}));

let extractCalls: Array<{ archive: string; dest: string }> = [];
let extractProducer: ((dest: string) => Promise<void>) = async (dest) => {
  // Default: drop a sentinel file into the staged dir so the copy
  // step has something to read.
  await mkdir(dest, { recursive: true });
  await writeFile(join(dest, "texture.bin"), "fake texture bytes");
};
mock.module("./pipeline-archive", () => ({
  extractArchive: async (archive: string, dest: string) => {
    extractCalls.push({ archive, dest });
    await extractProducer(dest);
  },
}));

// Resolve setupModule paths into the per-test sandbox. The mod
// spec needs to drop a fake setup.ts on disk and have the pipeline
// resolve it.
mock.module("./registry", () => ({
  setupModulePathFor: (gameId: string, modId: string, filename: string) => {
    const p = join(sandbox, "games-fake", gameId, "mods", modId, filename);
    return existsSync(p) ? p : null;
  },
}));

let globalFetch: typeof fetch;
beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "recomp-mods-spec-"));
  downloadCalls = [];
  extractCalls = [];
  extractProducer = async (dest) => {
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, "texture.bin"), "fake texture bytes");
  };
  downloadProducer = async () => {};
  globalFetch = globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = globalFetch;
  await rm(sandbox, { recursive: true, force: true });
});

function makeGame(overrides?: Partial<GameEntry>): GameEntry {
  return {
    id: "alba",
    name: "Alba",
    project: "Alba",
    platform: "gc",
    repo: "x/y",
    description: "",
    installType: "prebuilt",
    releaseAssets: {},
    launchCommand: {},
    tags: [],
    ...overrides,
  };
}

function makeInstalled(overrides?: Partial<InstalledGame>): InstalledGame {
  return {
    installedVersion: "v1.0.0",
    installedAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    installDir: join(sandbox, "install", "alba"),
    addedToSteam: false,
    ...overrides,
  };
}

describe("resolveModDest", () => {
  const installDir = join(sandbox || "/games", "install", "alba");

  it("resolves a relative installSubdir under the install dir", async () => {
    const { resolveModDest } = await import("./mods");
    expect(resolveModDest(makeGame(), installDir, "textures/")).toBe(
      join(installDir, "textures"),
    );
  });

  it("rejects a relative installSubdir that escapes via ..", async () => {
    const { resolveModDest } = await import("./mods");
    expect(() =>
      resolveModDest(makeGame(), installDir, "../../../../etc/cron.d"),
    ).toThrow(/escapes the install directory/);
  });

  it("substitutes {userDataDir} and keeps it under $HOME", async () => {
    const { resolveModDest } = await import("./mods");
    const game = makeGame({
      userDataDir: "~/.local/share/TwilitRealm/Dusklight",
    });
    const dest = resolveModDest(
      game,
      installDir,
      "{userDataDir}/texture_replacements/",
    );
    expect(dest).toBe(
      join(
        process.env.HOME ?? "",
        ".local/share/TwilitRealm/Dusklight/texture_replacements",
      ),
    );
  });

  it("rejects an absolute installSubdir outside $HOME", async () => {
    const { resolveModDest } = await import("./mods");
    expect(() => resolveModDest(makeGame(), installDir, "/etc/cron.d")).toThrow(
      /outside \$HOME/,
    );
  });
});

describe("installMod — github-release default-copy path", () => {
  it("downloads release asset → extracts → copies into installSubdir, emitting mod:<id>:* stages", async () => {
    // Stub fetch for the release lookup.
    (globalThis as { fetch: typeof fetch }).fetch = (async (_url: string) =>
      new Response(
        JSON.stringify({
          tag_name: "v1.0.0",
          prerelease: false,
          assets: [
            {
              name: "pack.zip",
              browser_download_url: "https://example.test/pack.zip",
              size: 12345,
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const { installMod } = await import("./mods");
    const mod: ModEntry = {
      id: "test-pack",
      name: "Test Pack",
      description: "",
      source: { kind: "github-release", repo: "x/y", assetPattern: "*.zip" },
      installSubdir: "textures/",
    };
    const game = makeGame();
    const installed = makeInstalled();
    await mkdir(installed.installDir, { recursive: true });

    const events: PipelineEvent[] = [];
    const result = await installMod(game, installed, mod, (e) => events.push(e));

    expect(typeof result.installedAt).toBe("string");

    // Download was hit with the asset URL.
    expect(downloadCalls).toHaveLength(1);
    expect(downloadCalls[0].url).toBe("https://example.test/pack.zip");

    // Extract was invoked.
    expect(extractCalls).toHaveLength(1);

    // The staged file ended up in installDir/textures/.
    const dropped = await readFile(
      join(installed.installDir, "textures", "texture.bin"),
      "utf-8",
    );
    expect(dropped).toBe("fake texture bytes");

    // Stages mention mod:test-pack:download / :extract / :install.
    const stages = events.map((e) => e.stage).filter(Boolean) as string[];
    expect(stages.some((s) => s.startsWith("mod:test-pack:download"))).toBe(true);
    expect(stages.some((s) => s.startsWith("mod:test-pack:extract"))).toBe(true);
    expect(stages.some((s) => s.startsWith("mod:test-pack:install"))).toBe(true);
  });

  it("throws when no asset matches the pattern", async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response(
        JSON.stringify({
          tag_name: "v1.0.0",
          prerelease: false,
          assets: [
            { name: "binary.bin", browser_download_url: "x", size: 1 },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const { installMod } = await import("./mods");
    const mod: ModEntry = {
      id: "test-pack",
      name: "Test Pack",
      description: "",
      source: { kind: "github-release", repo: "x/y", assetPattern: "*.zip" },
      installSubdir: "textures/",
    };
    await expect(
      installMod(makeGame(), makeInstalled(), mod, () => {}),
    ).rejects.toThrow(/No asset matching/);
  });
});

describe("installMod — scripted path", () => {
  it("dynamic-imports setupModule and calls install(ctx); script writes its own files", async () => {
    // Drop a fake setup module on disk that the path resolver will
    // find. Use a Bun-importable .ts that calls the SDK helpers.
    const modDir = join(sandbox, "games-fake", "alba", "mods", "scripted");
    await mkdir(modDir, { recursive: true });
    const setupSource =
      `import { modSdk } from "${join(
        process.cwd(),
        "plugins",
        "recomp",
        "lib",
        "sdk",
        "mod.ts",
      ).replace(/\\/g, "\\\\")}";\n` +
      `export async function install() {\n` +
      `  modSdk.emit({ message: "script ran", percent: 42 });\n` +
      `  const { writeFile, mkdir } = await import("node:fs/promises");\n` +
      `  const { join } = await import("node:path");\n` +
      `  await mkdir(join(modSdk.installDir, "scripted-out"), { recursive: true });\n` +
      `  await writeFile(join(modSdk.installDir, "scripted-out", "from-script.txt"), "hello from script");\n` +
      `}\n`;
    await writeFile(join(modDir, "setup.ts"), setupSource);

    // Direct-url so we exercise the download path WITHOUT going to
    // the GitHub release-lookup network call.
    downloadProducer = async (dest) => {
      await writeFile(dest, "fake archive bytes");
    };

    const { installMod } = await import("./mods");
    const mod: ModEntry = {
      id: "scripted",
      name: "Scripted Mod",
      description: "",
      source: { kind: "direct-url", url: "https://example.test/archive.zip" },
      setupModule: "setup.ts",
    };
    const game = makeGame();
    const installed = makeInstalled();
    await mkdir(installed.installDir, { recursive: true });

    const events: PipelineEvent[] = [];
    await installMod(game, installed, mod, (e) => events.push(e));

    // The script's own write landed.
    const wrote = await readFile(
      join(installed.installDir, "scripted-out", "from-script.txt"),
      "utf-8",
    );
    expect(wrote).toBe("hello from script");

    // The script's emit({ message: "script ran" }) reached the
    // pipeline.
    expect(events.some((e) => e.message === "script ran")).toBe(true);
  });

  it("a throwing setupModule aborts the install (no further state writes downstream)", async () => {
    const modDir = join(sandbox, "games-fake", "alba", "mods", "broken");
    await mkdir(modDir, { recursive: true });
    const setupSource =
      `export async function install() { throw new Error("script blew up"); }\n`;
    await writeFile(join(modDir, "setup.ts"), setupSource);

    downloadProducer = async (dest) => {
      await writeFile(dest, "fake archive bytes");
    };

    const { installMod } = await import("./mods");
    const mod: ModEntry = {
      id: "broken",
      name: "Broken",
      description: "",
      source: { kind: "direct-url", url: "https://example.test/archive.zip" },
      setupModule: "setup.ts",
    };
    await expect(
      installMod(makeGame(), makeInstalled(), mod, () => {}),
    ).rejects.toThrow(/script blew up/);
  });
});

describe("installModFromArchive — manual-import", () => {
  it("extracts the user-picked archive and copies into installSubdir", async () => {
    const archivePath = join(sandbox, "user-download.zip");
    await writeFile(archivePath, "fake zip bytes");

    const { installModFromArchive } = await import("./mods");
    const mod: ModEntry = {
      id: "manual",
      name: "Manual Mod",
      description: "",
      source: { kind: "manual-import", acceptExtensions: ["zip"] },
      installSubdir: "textures/",
      externalUrl: "https://example.test/mod",
    };
    const installed = makeInstalled();
    await mkdir(installed.installDir, { recursive: true });

    const events: PipelineEvent[] = [];
    await installModFromArchive(makeGame(), installed, mod, archivePath, (e) =>
      events.push(e),
    );

    // No download — manual-import skips the network.
    expect(downloadCalls).toHaveLength(0);

    const dropped = await readdir(join(installed.installDir, "textures"));
    expect(dropped).toContain("texture.bin");
  });

  it("rejects when the user-picked file doesn't exist", async () => {
    const { installModFromArchive } = await import("./mods");
    const mod: ModEntry = {
      id: "manual",
      name: "Manual",
      description: "",
      source: { kind: "manual-import" },
      installSubdir: "textures/",
      externalUrl: "https://x",
    };
    await expect(
      installModFromArchive(
        makeGame(),
        makeInstalled(),
        mod,
        join(sandbox, "missing-file.zip"),
        () => {},
      ),
    ).rejects.toThrow(/not found/);
  });
});

describe("resolveModDest — path resolution + security gate", () => {
  // The function reads `homedir()` from node:os which in turn reads
  // `$HOME`. Override HOME for the duration of each case so the
  // gate compares against a known root.
  const originalHome = process.env.HOME;
  const SANDBOX_HOME = "/tmp/recomp-resolve-home-test";

  beforeEach(() => {
    process.env.HOME = SANDBOX_HOME;
  });
  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
  });

  function makeGameWithUserData(userDataDir?: string): GameEntry {
    return {
      id: "test-game",
      name: "Test Game",
      project: "Test",
      platform: "gc",
      repo: "x/y",
      description: "",
      installType: "prebuilt",
      releaseAssets: {},
      launchCommand: {},
      tags: [],
      ...(userDataDir ? { userDataDir } : {}),
    };
  }

  it("resolves a relative subdir under the install dir without the $HOME gate", async () => {
    const { resolveModDest } = await import("./mods");
    const result = resolveModDest(
      makeGameWithUserData(),
      "/var/lib/install-dir",
      "textures/",
    );
    expect(result).toBe("/var/lib/install-dir/textures");
  });

  it("expands ~/ against $HOME and accepts it when the result lives under $HOME", async () => {
    const { resolveModDest } = await import("./mods");
    const result = resolveModDest(
      makeGameWithUserData(),
      "/var/lib/install-dir",
      "~/.local/share/Foo/textures/",
    );
    expect(result).toBe(`${SANDBOX_HOME}/.local/share/Foo/textures`);
  });

  it("refuses an absolute path outside $HOME (e.g. /etc)", async () => {
    const { resolveModDest } = await import("./mods");
    expect(() =>
      resolveModDest(makeGameWithUserData(), "/var/lib/install-dir", "/etc"),
    ).toThrow(/outside \$HOME/);
  });

  it("refuses a tilde-traversal path that escapes $HOME via /..", async () => {
    const { resolveModDest } = await import("./mods");
    // `~/../etc/passwd` normalises to `/etc/passwd` once $HOME is
    // resolved + node:path's resolve normalises the `..`. The gate
    // should reject because the final path doesn't start with
    // `${SANDBOX_HOME}/`.
    expect(() =>
      resolveModDest(
        makeGameWithUserData(),
        "/var/lib/install-dir",
        "~/../etc/passwd",
      ),
    ).toThrow(/outside \$HOME/);
  });

  it("substitutes {userDataDir} from the parent game manifest, then expands ~", async () => {
    const { resolveModDest } = await import("./mods");
    const result = resolveModDest(
      makeGameWithUserData("~/.local/share/TwilitRealm/Dusklight"),
      "/var/lib/install-dir",
      "{userDataDir}/texture_replacements/",
    );
    expect(result).toBe(
      `${SANDBOX_HOME}/.local/share/TwilitRealm/Dusklight/texture_replacements`,
    );
  });

  it("throws when {userDataDir} is templated but the game manifest doesn't declare one", async () => {
    const { resolveModDest } = await import("./mods");
    expect(() =>
      resolveModDest(
        makeGameWithUserData(), // no userDataDir
        "/var/lib/install-dir",
        "{userDataDir}/texture_replacements/",
      ),
    ).toThrow(/doesn't declare one/);
  });

  it("refuses when {userDataDir} resolves to a path outside $HOME (manifest typo / injection)", async () => {
    // A malicious or buggy manifest could declare userDataDir: "/etc".
    // After substitution the gate's regular `$HOME` check should fire
    // and refuse the install — the substitution path mustn't be a
    // back door around the security gate.
    const { resolveModDest } = await import("./mods");
    expect(() =>
      resolveModDest(
        makeGameWithUserData("/etc"),
        "/var/lib/install-dir",
        "{userDataDir}/passwd",
      ),
    ).toThrow(/outside \$HOME/);
  });

  it("refuses when $HOME is unset (env misconfigured)", async () => {
    delete process.env.HOME;
    const { resolveModDest } = await import("./mods");
    expect(() =>
      resolveModDest(makeGameWithUserData(), "/var/lib/install-dir", "~/Foo"),
    ).toThrow(/outside \$HOME/);
  });
});

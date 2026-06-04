import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { GameEntry, GitHubRelease, PipelineEvent } from "./types";

// ── Test helpers ─────────────────────────────────────────────────────

function makeGameEntry(overrides?: Partial<GameEntry>): GameEntry {
  return {
    id: "test-game",
    name: "Test Game",
    project: "Test Project",
    platform: "n64",
    repo: "test/repo",
    description: "A test game",
    installType: "prebuilt",
    releaseAssets: { linux: "test-*-linux.zip" },
    launchCommand: { linux: "{installDir}/test" },
    tags: ["test"],
    ...overrides,
  };
}

// ── resolveTemplate tests ────────────────────────────────────────────

describe("resolveTemplate", () => {
  // Import the function fresh each test to avoid stale state
  it("replaces {installDir}", async () => {
    const { resolveTemplate } = await import("./pipeline");
    const result = resolveTemplate("{installDir}/game.exe", "/home/user/games/zelda");
    expect(result).toBe("/home/user/games/zelda/game.exe");
  });

  it("replaces {romPath}", async () => {
    const { resolveTemplate } = await import("./pipeline");
    const result = resolveTemplate(
      "{installDir}/extract {romPath}",
      "/games/soh",
      "/roms/oot.z64",
    );
    expect(result).toBe("/games/soh/extract /roms/oot.z64");
  });

  it("replaces {platform}", async () => {
    const { resolveTemplate } = await import("./pipeline");
    const result = resolveTemplate("{installDir}/bin/{platform}/game", "/games/test");
    // Platform will be one of linux/windows/macos
    expect(result).toContain("/games/test/bin/");
    expect(result).toContain("/game");
  });

  it("handles multiple occurrences of same placeholder", async () => {
    const { resolveTemplate } = await import("./pipeline");
    const result = resolveTemplate(
      "{installDir}/a {installDir}/b",
      "/games",
    );
    expect(result).toBe("/games/a /games/b");
  });

  it("leaves unknown placeholders as-is", async () => {
    const { resolveTemplate } = await import("./pipeline");
    const result = resolveTemplate("{installDir}/{unknown}", "/games");
    expect(result).toBe("/games/{unknown}");
  });

  it("handles template with no placeholders", async () => {
    const { resolveTemplate } = await import("./pipeline");
    const result = resolveTemplate("/usr/bin/game", "/games");
    expect(result).toBe("/usr/bin/game");
  });

  it("does not replace {romPath} when romPath not provided", async () => {
    const { resolveTemplate } = await import("./pipeline");
    const result = resolveTemplate("{installDir}/extract {romPath}", "/games");
    expect(result).toBe("/games/extract {romPath}");
  });
});

// ── resolveAssetUrl tests ────────────────────────────────────────────

describe("resolveAssetUrl", () => {
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    mockFetch = mock();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    // Clear GITHUB_TOKEN to avoid real API calls
    delete process.env.GITHUB_TOKEN;
  });

  it("uses pre-resolved URLs when available", async () => {
    const { resolveAssetUrl } = await import("./pipeline");

    const entry = makeGameEntry({
      latestVersion: "v1.2.2",
      latestAssetUrl: {
        linux: "https://github.com/test/releases/download/v1.2.2/test-linux.zip",
      },
    });

    const result = await resolveAssetUrl(entry);
    expect(result.url).toBe(
      "https://github.com/test/releases/download/v1.2.2/test-linux.zip",
    );
    expect(result.version).toBe("v1.2.2");
    // Should not call fetch when pre-resolved URLs exist
    // (it might still call for gh token check, so we don't assert 0 calls)
  });

  it("falls back to GitHub Releases API", async () => {
    const releases: GitHubRelease[] = [
      {
        tag_name: "v2.0.0",
        prerelease: false,
        assets: [
          {
            name: "test-v2.0.0-linux.zip",
            browser_download_url: "https://github.com/test/releases/download/v2.0.0/test-v2.0.0-linux.zip",
            size: 1000000,
          },
          {
            name: "test-v2.0.0-windows.zip",
            browser_download_url: "https://github.com/test/releases/download/v2.0.0/test-v2.0.0-windows.zip",
            size: 1200000,
          },
        ],
      },
    ];

    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("api.github.com")) {
        return Promise.resolve(
          new Response(JSON.stringify(releases), { status: 200 }),
        );
      }
      // gh auth token call — simulate not found
      return Promise.resolve(new Response("", { status: 404 }));
    });

    const { resolveAssetUrl } = await import("./pipeline");

    const entry = makeGameEntry({
      releaseAssets: { linux: "test-*-linux.zip" },
    });

    const result = await resolveAssetUrl(entry);
    expect(result.url).toContain("test-v2.0.0-linux.zip");
    expect(result.version).toBe("v2.0.0");
  });

  it("skips prereleases", async () => {
    const releases: GitHubRelease[] = [
      {
        tag_name: "v3.0.0-beta",
        prerelease: true,
        assets: [
          { name: "test-v3-linux.zip", browser_download_url: "https://beta", size: 100 },
        ],
      },
      {
        tag_name: "v2.0.0",
        prerelease: false,
        assets: [
          { name: "test-v2.0.0-linux.zip", browser_download_url: "https://stable", size: 100 },
        ],
      },
    ];

    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("api.github.com")) {
        return Promise.resolve(
          new Response(JSON.stringify(releases), { status: 200 }),
        );
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });

    const { resolveAssetUrl } = await import("./pipeline");
    const entry = makeGameEntry({
      releaseAssets: { linux: "test-*-linux.zip" },
    });

    const result = await resolveAssetUrl(entry);
    expect(result.version).toBe("v2.0.0");
    expect(result.url).toBe("https://stable");
  });

  it("throws when no platform asset pattern exists at all", async () => {
    const { resolveAssetUrl } = await import("./pipeline");
    // Neither linux nor windows — Linux hosts can't fall back to
    // Proton, macOS hosts have nothing to load. Should throw.
    const entry = makeGameEntry({
      releaseAssets: { macos: "test-mac.zip" },
    });

    if (process.platform !== "darwin") {
      await expect(resolveAssetUrl(entry)).rejects.toThrow("not available");
    }
  });

  it("throws when no matching asset found", async () => {
    const releases: GitHubRelease[] = [
      {
        tag_name: "v1.0.0",
        prerelease: false,
        assets: [
          { name: "totally-different.zip", browser_download_url: "https://wrong", size: 100 },
        ],
      },
    ];

    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("api.github.com")) {
        return Promise.resolve(
          new Response(JSON.stringify(releases), { status: 200 }),
        );
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });

    const { resolveAssetUrl } = await import("./pipeline");
    const entry = makeGameEntry({
      releaseAssets: { linux: "test-*-linux.zip" },
    });

    await expect(resolveAssetUrl(entry)).rejects.toThrow("No asset matching");
  });

  it("throws when no releases found", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("api.github.com")) {
        return Promise.resolve(new Response("[]", { status: 200 }));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });

    const { resolveAssetUrl } = await import("./pipeline");
    const entry = makeGameEntry();

    await expect(resolveAssetUrl(entry)).rejects.toThrow("No releases found");
  });
});

// ── fetchReleases tests ──────────────────────────────────────────────

describe("fetchReleases", () => {
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    mockFetch = mock();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    delete process.env.GITHUB_TOKEN;
  });

  it("fetches from GitHub API", async () => {
    const releases: GitHubRelease[] = [
      { tag_name: "v1.0", prerelease: false, assets: [] },
    ];

    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("api.github.com")) {
        return Promise.resolve(
          new Response(JSON.stringify(releases), { status: 200 }),
        );
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });

    const { fetchReleases } = await import("./pipeline");
    const result = await fetchReleases("test/repo");
    expect(result).toHaveLength(1);
    expect(result[0].tag_name).toBe("v1.0");
  });

  it("throws on API error", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("api.github.com")) {
        return Promise.resolve(
          new Response("rate limit exceeded", { status: 403 }),
        );
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });

    const { fetchReleases } = await import("./pipeline");
    await expect(fetchReleases("test/repo")).rejects.toThrow("GitHub API 403");
  });

  it("uses GITHUB_TOKEN when available", async () => {
    process.env.GITHUB_TOKEN = "test-token-123";

    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("api.github.com")) {
        return Promise.resolve(new Response("[]", { status: 200 }));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });

    const { fetchReleases } = await import("./pipeline");
    await fetchReleases("test/repo");

    // Find the github API call
    const apiCall = mockFetch.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("api.github.com"),
    );
    expect(apiCall).toBeDefined();
    const headers = (apiCall![1] as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-token-123");

    delete process.env.GITHUB_TOKEN;
  });
});

// ── FIX 4: checksum pinning ──────────────────────────────────────────

describe("resolveAssetUrl — sha256 threading", () => {
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    mockFetch = mock();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    delete process.env.GITHUB_TOKEN;
  });

  it("returns the pinned sha256 for the resolved platform (pre-resolved path)", async () => {
    const { resolveAssetUrl } = await import("./pipeline");
    const entry = makeGameEntry({
      latestVersion: "v1.0.0",
      latestAssetUrl: {
        linux: "https://example.com/test-linux.zip",
      },
      releaseSha256: {
        linux: "a".repeat(64),
      },
    });
    const result = await resolveAssetUrl(entry);
    expect(result.sha256).toBe("a".repeat(64));
  });

  it("returns undefined sha256 when none is pinned", async () => {
    const { resolveAssetUrl } = await import("./pipeline");
    const entry = makeGameEntry({
      latestVersion: "v1.0.0",
      latestAssetUrl: { linux: "https://example.com/test-linux.zip" },
    });
    const result = await resolveAssetUrl(entry);
    expect(result.sha256).toBeUndefined();
  });
});

describe("verifyDownloadChecksum — FIX 4", () => {
  it("passes when the file's sha256 matches the expected value", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "recomp-cksum-"));
    const file = join(dir, "asset.zip");
    const data = "the quick brown fox";
    await writeFile(file, data);
    // Known sha256 of the data computed via Bun's hasher.
    const expected = new Bun.CryptoHasher("sha256").update(data).digest("hex");

    const { verifyDownloadChecksum } = await import("./pipeline");
    const events: string[] = [];
    await verifyDownloadChecksum(file, expected, (m) => events.push(m));
    // No throw == pass.
    await rm(dir, { recursive: true, force: true });
  });

  it("throws AND removes the file when the sha256 mismatches", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "recomp-cksum-"));
    const file = join(dir, "asset.zip");
    await writeFile(file, "tampered bytes");

    const { verifyDownloadChecksum } = await import("./pipeline");
    await expect(
      verifyDownloadChecksum(file, "b".repeat(64), () => {}),
    ).rejects.toThrow(/checksum|sha256|mismatch/i);
    expect(existsSync(file)).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it("proceeds with an 'unverified download' notice when no checksum is pinned", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "recomp-cksum-"));
    const file = join(dir, "asset.zip");
    await writeFile(file, "some bytes");

    const { verifyDownloadChecksum } = await import("./pipeline");
    const notices: string[] = [];
    await verifyDownloadChecksum(file, undefined, (m) => notices.push(m));
    // File untouched, and a one-line unverified notice was emitted.
    expect(existsSync(file)).toBe(true);
    expect(notices.some((n) => /unverified/i.test(n))).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it("matches case-insensitively / ignores a leading sha256: prefix", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "recomp-cksum-"));
    const file = join(dir, "asset.zip");
    const data = "hello world";
    await writeFile(file, data);
    const hex = new Bun.CryptoHasher("sha256").update(data).digest("hex");

    const { verifyDownloadChecksum } = await import("./pipeline");
    // Uppercased + prefixed should still validate.
    await verifyDownloadChecksum(file, `sha256:${hex.toUpperCase()}`, () => {});
    await rm(dir, { recursive: true, force: true });
  });
});

// ── Pipeline event structure ─────────────────────────────────────────

describe("PipelineEvent structure", () => {
  it("progress event has all fields", () => {
    const event: PipelineEvent = {
      type: "progress",
      gameId: "test",
      stage: "downloading",
      percent: 50.5,
      message: "25.0 / 50.0 MB",
    };
    expect(event.type).toBe("progress");
    expect(event.percent).toBeCloseTo(50.5);
  });

  it("complete event has version", () => {
    const event: PipelineEvent = {
      type: "complete",
      gameId: "test",
      version: "v1.0.0",
    };
    expect(event.type).toBe("complete");
    expect(event.version).toBe("v1.0.0");
  });

  it("error event has message", () => {
    const event: PipelineEvent = {
      type: "error",
      gameId: "test",
      message: "Download failed",
    };
    expect(event.type).toBe("error");
    expect(event.message).toBe("Download failed");
  });

  it("rom_required event has message", () => {
    const event: PipelineEvent = {
      type: "rom_required",
      gameId: "test",
      message: "Provide your ROM file",
    };
    expect(event.type).toBe("rom_required");
  });
});

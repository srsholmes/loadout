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

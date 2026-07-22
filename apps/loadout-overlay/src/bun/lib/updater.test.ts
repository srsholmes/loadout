import { describe, expect, test } from "bun:test";
import {
  checkForUpdate,
  resolveLatestReleaseTag,
  startUpdate,
  getUpdateStatus,
  isTrustedGithubHost,
  parseSha256Sums,
  type UpdaterDeps,
} from "./updater";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

function fakeDeps(fetchFn: typeof fetch, overrides: Partial<UpdaterDeps> = {}): UpdaterDeps {
  return {
    fetchFn,
    run: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    home: "/nonexistent-home",
    backendBase: "http://127.0.0.1:33820",
    scheduleOverlayRestart: () => {},
    sha256File: async () => "0".repeat(64),
    ...overrides,
  };
}

describe("resolveLatestReleaseTag", () => {
  test("uses releases/latest when it returns a proper tag", async () => {
    const fetchFn = (async (url: string | URL | Request) => {
      expect(String(url)).toContain("/releases/latest");
      return jsonResponse({ tag_name: "v0.7.0" });
    }) as unknown as typeof fetch;
    expect(await resolveLatestReleaseTag(fetchFn)).toBe("v0.7.0");
  });

  test("falls back to the release list when latest is the rolling tag", async () => {
    const fetchFn = (async (url: string | URL | Request) => {
      if (String(url).includes("/releases/latest")) {
        return jsonResponse({ tag_name: "rolling" });
      }
      return jsonResponse([
        { tag_name: "rolling" },
        { tag_name: "v0.6.0" },
        { tag_name: "v0.10.0" }, // numerically higher than v0.9.x
        { tag_name: "v0.9.1" },
        { tag_name: "v1.0.0", prerelease: true }, // excluded
        { tag_name: "v2.0.0", draft: true }, // excluded
      ]);
    }) as unknown as typeof fetch;
    expect(await resolveLatestReleaseTag(fetchFn)).toBe("v0.10.0");
  });

  test("null when nothing parseable is published", async () => {
    const fetchFn = (async (url: string | URL | Request) => {
      if (String(url).includes("/releases/latest")) return jsonResponse({}, 404);
      return jsonResponse([{ tag_name: "rolling" }]);
    }) as unknown as typeof fetch;
    expect(await resolveLatestReleaseTag(fetchFn)).toBeNull();
  });
});

describe("checkForUpdate", () => {
  const latest = (tag: string) =>
    (async () => jsonResponse({ tag_name: tag })) as unknown as typeof fetch;

  test("reports an available newer release", async () => {
    const res = await checkForUpdate("0.6.0", fakeDeps(latest("v0.7.0")));
    expect(res).toEqual({ available: true, tag: "v0.7.0", latestVersion: "0.7.0" });
  });

  test("not available when up to date", async () => {
    const res = await checkForUpdate("0.7.0", fakeDeps(latest("v0.7.0")));
    expect(res.available).toBe(false);
    expect(res.tag).toBe("v0.7.0");
  });

  test("disabled on dev builds without touching the network", async () => {
    let fetched = false;
    const fetchFn = (async () => {
      fetched = true;
      return jsonResponse({});
    }) as unknown as typeof fetch;
    const res = await checkForUpdate("dev", fakeDeps(fetchFn));
    expect(res.available).toBe(false);
    expect(res.error).toContain("dev builds");
    expect(fetched).toBe(false);
  });

  test("network errors surface as a non-available result", async () => {
    const fetchFn = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const res = await checkForUpdate("0.6.0", fakeDeps(fetchFn));
    expect(res.available).toBe(false);
    expect(res.error).toContain("offline");
  });
});

describe("startUpdate guards", () => {
  test("rejects malformed tags without changing status", () => {
    for (const tag of ["rolling", "0.7.0", "v0.7.0-rc1", "../etc", ""]) {
      const res = startUpdate(tag, fakeDeps(fetch));
      expect(res.success).toBe(false);
      expect(getUpdateStatus().phase).toBe("idle");
    }
  });

  test("a valid tag with no installed overlay tree fails cleanly", async () => {
    const fetchFn = (async () =>
      jsonResponse({ token: "t" })) as unknown as typeof fetch;
    const res = startUpdate("v9.9.9", fakeDeps(fetchFn, { home: "/nonexistent-home" }));
    expect(res.success).toBe(true); // accepted — failure lands in status
    // Wait for the async flow to reject on the missing overlay dir.
    for (let i = 0; i < 50 && getUpdateStatus().phase !== "error"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(getUpdateStatus().phase).toBe("error");
    expect(getUpdateStatus().message).toContain("no installed overlay tree");
  });

  test("rejects a second update while one is in flight", () => {
    // status is still "error" from the previous test's flow — reset by
    // startUpdate only through a fresh run, so use a fresh accepted run.
    const fetchFn = (async () =>
      new Promise<Response>(() => {})) as unknown as typeof fetch; // hangs forever
    const first = startUpdate("v9.9.8", fakeDeps(fetchFn));
    expect(first.success).toBe(true);
    const second = startUpdate("v9.9.8", fakeDeps(fetchFn));
    expect(second.success).toBe(false);
    expect(second.error).toContain("in progress");
  });
});

describe("helpers", () => {
  test("isTrustedGithubHost pins exact hosts and subdomains only", () => {
    expect(isTrustedGithubHost("github.com")).toBe(true);
    expect(isTrustedGithubHost("release-assets.githubusercontent.com")).toBe(true);
    expect(isTrustedGithubHost("notgithub.com")).toBe(false);
    expect(isTrustedGithubHost("github.com.evil.example")).toBe(false);
  });

  test("parseSha256Sums extracts asset hashes", () => {
    const sums = parseSha256Sums(
      "e".repeat(64) + "  loadout-overlay-x86_64.tar.xz\n",
    );
    expect(sums.get("loadout-overlay-x86_64.tar.xz")).toBe("e".repeat(64));
  });
});

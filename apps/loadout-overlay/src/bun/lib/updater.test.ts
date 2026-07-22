import { beforeEach, describe, expect, test } from "bun:test";
import {
  checkForUpdate,
  resolveLatestReleaseTag,
  startUpdate,
  getUpdateStatus,
  resetUpdateStatusForTest,
  waitForBackendDone,
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
    sleep: async () => {}, // no real delay in tests
    now: () => 0,
    ...overrides,
  };
}

// The updater keeps a module-level status singleton; reset it between
// tests so an in-flight/terminal state from one can't leak into another.
beforeEach(() => resetUpdateStatusForTest());

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
    const fetchFn = (async () => jsonResponse({ token: "t" })) as unknown as typeof fetch;
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
    // startUpdate flips status to "downloading" synchronously before it
    // returns, so the second call sees the in-flight guard regardless of
    // where the async flow is. (beforeEach reset guarantees a clean
    // starting status — no dependence on test order.)
    const fetchFn = (async () => jsonResponse({ token: "t" })) as unknown as typeof fetch;
    const first = startUpdate("v9.9.8", fakeDeps(fetchFn));
    expect(first.success).toBe(true);
    const second = startUpdate("v9.9.8", fakeDeps(fetchFn));
    expect(second.success).toBe(false);
    expect(second.error).toContain("in progress");
  });
});

describe("waitForBackendDone", () => {
  // A scripted backend: each poll of /api/self-update returns the next
  // phase in `phases`; /api/token and /api/status (version) answer the
  // fallback path. sleep/now are faked so the 1s poll + 10min deadline
  // cost nothing.
  function scriptedDeps(opts: {
    phases: Array<{ status: number; body: unknown } | "throw">;
    statusVersion?: string;
    extra?: Partial<UpdaterDeps>;
  }): UpdaterDeps {
    let poll = 0;
    const fetchFn = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/api/token")) return jsonResponse({ token: "fresh" });
      if (u.endsWith("/api/status")) {
        return jsonResponse({ version: opts.statusVersion ?? "0.6.0" });
      }
      // /api/self-update
      const step = opts.phases[Math.min(poll, opts.phases.length - 1)];
      poll++;
      if (step === "throw") throw new Error("ECONNREFUSED");
      return jsonResponse(step!.body, step!.status);
    }) as unknown as typeof fetch;
    return fakeDeps(fetchFn, opts.extra);
  }

  test("returns as soon as the backend reports done", async () => {
    const deps = scriptedDeps({
      phases: [
        { status: 200, body: { phase: "applying" } },
        { status: 200, body: { phase: "done" } },
      ],
    });
    await waitForBackendDone({ tag: "v0.7.0", token: "t", preVersion: "0.6.0", deps });
    expect(true).toBe(true); // resolved without throwing
  });

  test("throws when the backend reports error", async () => {
    const deps = scriptedDeps({
      phases: [{ status: 200, body: { phase: "error", message: "checksum mismatch" } }],
    });
    await expect(
      waitForBackendDone({ tag: "v0.7.0", token: "t", preVersion: "0.6.0", deps }),
    ).rejects.toThrow(/checksum mismatch/);
  });

  test("falls back to version match when the restart wins the race (upgrade)", async () => {
    // active → connection dropped (mid-restart) → the version fallback
    // reads the NEW target version and accepts (version changed).
    const deps = scriptedDeps({
      phases: [{ status: 200, body: { phase: "applying" } }, "throw"],
      statusVersion: "0.7.0",
    });
    await waitForBackendDone({ tag: "v0.7.0", token: "t", preVersion: "0.6.0", deps });
    expect(true).toBe(true);
  });

  test("treats a 404 on the route as done (updated onto a pre-feature backend)", async () => {
    // The backend restarted into a build without /api/self-update (e.g.
    // an older release). It must NOT hang waiting for a "done" that
    // route can never report.
    const deps = scriptedDeps({
      phases: [
        { status: 200, body: { phase: "applying" } },
        { status: 404, body: { error: "not found" } },
      ],
    });
    await waitForBackendDone({ tag: "v0.6.0", token: "t", preVersion: "0.5.9", deps });
    expect(true).toBe(true); // resolved, did not hang to the deadline
  });

  test("same-version repair rejects an uncorroborated version match (finding 4)", async () => {
    // preVersion === tag. A flaky poll must NOT be read as done just
    // because /api/status already reports the target version — the
    // backend never reports done or active here, so it must time out
    // rather than declare premature success.
    let nowMs = 0;
    const deps = scriptedDeps({
      phases: ["throw"],
      statusVersion: "0.7.0",
      extra: {
        sleep: async () => {
          nowMs += 30_000; // burn the 10-min deadline fast
        },
        now: () => nowMs,
      },
    });
    await expect(
      waitForBackendDone({ tag: "v0.7.0", token: "t", preVersion: "0.7.0", deps }),
    ).rejects.toThrow(/timed out/);
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
    const sums = parseSha256Sums("e".repeat(64) + "  loadout-overlay-x86_64.tar.xz\n");
    expect(sums.get("loadout-overlay-x86_64.tar.xz")).toBe("e".repeat(64));
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  checkForUpdate,
  resolveLatestReleaseTag,
  startUpdate,
  getUpdateStatus,
  resetUpdateStatusForTest,
  waitForBackendDone,
  cleanupUpdateArtifacts,
  reapOldGeneration,
  makeIdleAbort,
  isTrustedGithubHost,
  parseSha256Sums,
  type UpdaterDeps,
} from "./updater";
import { rename as realRename } from "node:fs/promises";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "overlay-update-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

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
    rename: async () => {},
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

  test("rejects a second update while one is in flight", async () => {
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
    // Drain the first flow's pending rejection (missing overlay tree)
    // INSIDE this test — otherwise it lands mid-next-test and mutates
    // the module status singleton under someone else's assertions.
    for (let i = 0; i < 50 && getUpdateStatus().phase !== "error"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(getUpdateStatus().phase).toBe("error");
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
    /** Full /api/status body override — lets a test model a PRE-FEATURE
     *  backend whose status has NO `version` field at all. */
    statusBody?: unknown;
    extra?: Partial<UpdaterDeps>;
  }): UpdaterDeps {
    let poll = 0;
    const fetchFn = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/api/token")) return jsonResponse({ token: "fresh" });
      if (u.endsWith("/api/status")) {
        return jsonResponse(
          opts.statusBody !== undefined
            ? opts.statusBody
            : { version: opts.statusVersion ?? "0.6.0" },
        );
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
    await expect(
      waitForBackendDone({ tag: "v0.7.0", token: "t", preVersion: "0.6.0", deps }),
    ).resolves.toBeUndefined();
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
    await expect(
      waitForBackendDone({ tag: "v0.7.0", token: "t", preVersion: "0.6.0", deps }),
    ).resolves.toBeUndefined();
  });

  test("pre-feature backend: stale-token 401 → fresh token → 404 = done", async () => {
    // Faithfully models the auth gate: the restarted backend rejects the
    // STALE pre-update token with 401 (before route dispatch); only a
    // FRESH token reaches dispatch, where a build lacking the route 404s.
    // /api/status THROWS throughout so the version-less-status probe
    // cannot rescue the scenario — the first version of this test let
    // that sibling branch mask deletion of both the 401 retry AND the
    // 404 return (a second-generation tautology). Now ONLY the
    // fresh-token 404 can resolve it; the clock advances so a
    // regression fails fast as "timed out" instead of spinning.
    let freshRoutePolls = 0;
    let nowMs = 0;
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/api/token")) return jsonResponse({ token: "fresh" });
      if (u.endsWith("/api/status")) throw new Error("status probe disabled in this test");
      if (u.endsWith("/api/self-update")) {
        const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
        if (auth === "Bearer fresh") {
          freshRoutePolls++;
          return jsonResponse({ error: "not found" }, 404); // route absent on the new build
        }
        return jsonResponse({ error: "unauthorized" }, 401); // stale token
      }
      throw new Error(`unexpected ${u}`);
    }) as unknown as typeof fetch;
    await expect(
      waitForBackendDone({
        tag: "v0.6.0",
        token: "stale",
        preVersion: "0.5.9",
        deps: fakeDeps(fetchFn, {
          sleep: async () => {
            nowMs += 1000;
          },
          now: () => nowMs,
        }),
      }),
    ).resolves.toBeUndefined();
    // Proves the route was RE-polled with the fresh token — the branch
    // the whole scenario hinges on.
    expect(freshRoutePolls).toBeGreaterThan(0);
  });

  test("observed restart corroborates a bare version match (sawRestart)", async () => {
    // Restart wins every race: no active phase was ever seen and the
    // pre-update snapshot is unknown (preIsTag ⇒ strict). The fresh
    // process HAS the route (reports idle) and /api/status shows the
    // target version — only the observed 401 (sawRestart) can
    // corroborate the match. Without that term this times out.
    let nowMs = 0;
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/api/token")) return jsonResponse({ token: "fresh" });
      if (u.endsWith("/api/status")) return jsonResponse({ version: "0.7.0" });
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      return auth === "Bearer fresh"
        ? jsonResponse({ phase: "idle" })
        : jsonResponse({ error: "unauthorized" }, 401);
    }) as unknown as typeof fetch;
    await expect(
      waitForBackendDone({
        tag: "v0.7.0",
        token: "stale",
        preVersion: null,
        deps: fakeDeps(fetchFn, {
          sleep: async () => {
            nowMs += 1000;
          },
          now: () => nowMs,
        }),
      }),
    ).resolves.toBeUndefined();
  });

  test("restart back to the PRE-update version fails fast (service died mid-apply)", async () => {
    // 401 proves a restart, but the fresh process reports idle at the
    // OLD version — the apply died and nothing will ever report done.
    // Must throw promptly, not idle out the 10-minute deadline.
    let nowMs = 0;
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/api/token")) return jsonResponse({ token: "fresh" });
      if (u.endsWith("/api/status")) return jsonResponse({ version: "0.6.0" }); // still old
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      return auth === "Bearer fresh"
        ? jsonResponse({ phase: "idle" })
        : jsonResponse({ error: "unauthorized" }, 401);
    }) as unknown as typeof fetch;
    const startedAt = 0;
    await expect(
      waitForBackendDone({
        tag: "v0.7.0",
        token: "stale",
        preVersion: "0.6.0",
        deps: fakeDeps(fetchFn, {
          sleep: async () => {
            nowMs += 1000;
          },
          now: () => nowMs,
        }),
      }),
    ).rejects.toThrow(/restarted without applying/);
    // Fast: a couple of poll ticks, nowhere near the 10-minute idle deadline.
    expect(nowMs - startedAt).toBeLessThan(10_000);
  });

  test("a slow but ACTIVE backend extends the idle deadline past 10 minutes", async () => {
    // The backend downloads ~150 MB inside this wait — 30 "applying"
    // polls at one simulated minute apart put 31 minutes on the wall
    // clock, far beyond the old fixed 10-minute deadline. Activity must
    // keep extending the idle limit until `done` lands.
    let nowMs = 0;
    const phases: Array<{ status: number; body: unknown }> = Array.from({ length: 30 }, () => ({
      status: 200,
      body: { phase: "applying" },
    }));
    phases.push({ status: 200, body: { phase: "done" } });
    const deps = scriptedDeps({
      phases,
      extra: {
        sleep: async () => {
          nowMs += 60_000;
        },
        now: () => nowMs,
      },
    });
    await expect(
      waitForBackendDone({ tag: "v0.7.0", token: "t", preVersion: "0.6.0", deps }),
    ).resolves.toBeUndefined();
  });

  test("restart into a pre-feature backend resolves via the version-less /api/status probe", async () => {
    // The fresh-token 404 probe can miss when it races the restart; the
    // belt-and-braces signal is a REACHABLE /api/status with no
    // `version` field (that field ships with this feature) after the
    // route went unreachable.
    const deps = scriptedDeps({
      phases: [{ status: 200, body: { phase: "applying" } }, "throw"],
      statusBody: { ok: true }, // pre-feature: no version field
    });
    await expect(
      waitForBackendDone({ tag: "v0.6.0", token: "t", preVersion: "0.5.9", deps }),
    ).resolves.toBeUndefined();
  });

  test("an unknown pre-update snapshot demands corroboration (no instant version match)", async () => {
    // preVersion === null means "the backend might already have been at
    // the target" — a bare version match with no observed activity or
    // restart must NOT read as done, or a same-version repair whose
    // snapshot fetch flaked would return mid-apply.
    let nowMs = 0;
    const deps = scriptedDeps({
      phases: ["throw"],
      statusVersion: "0.7.0",
      extra: {
        sleep: async () => {
          nowMs += 30_000;
        },
        now: () => nowMs,
      },
    });
    await expect(
      waitForBackendDone({ tag: "v0.7.0", token: "t", preVersion: null, deps }),
    ).rejects.toThrow(/timed out/);
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

describe("cleanupUpdateArtifacts / reapOldGeneration", () => {
  test("restores .old when the live tree is missing (mid-swap crash)", async () => {
    const home = tmp();
    const overlayDir = join(home, ".local", "share", "loadout-overlay");
    mkdirSync(join(`${overlayDir}.old`, "bin"), { recursive: true });
    writeFileSync(join(`${overlayDir}.old`, "bin", "launcher"), "survivor");
    await cleanupUpdateArtifacts({ home });
    expect(readFileSync(join(overlayDir, "bin", "launcher"), "utf8")).toBe("survivor");
    expect(existsSync(`${overlayDir}.old`)).toBe(false);
  });

  test("keepOldGeneration preserves the rollback copy; reapOldGeneration ends the window", async () => {
    const home = tmp();
    const overlayDir = join(home, ".local", "share", "loadout-overlay");
    mkdirSync(overlayDir, { recursive: true });
    mkdirSync(`${overlayDir}.old`, { recursive: true });
    mkdirSync(`${overlayDir}.staging`, { recursive: true });
    writeFileSync(`${overlayDir}.update.tar.xz`, "x");

    // Boot path: staging + tarball reaped, `.old` kept — the new overlay
    // hasn't proven itself yet (CEF can still crash after bun starts).
    await cleanupUpdateArtifacts({ home, keepOldGeneration: true });
    expect(existsSync(`${overlayDir}.old`)).toBe(true);
    expect(existsSync(`${overlayDir}.staging`)).toBe(false);
    expect(existsSync(`${overlayDir}.update.tar.xz`)).toBe(false);

    // First webview heartbeat: NOW the rollback window closes.
    await reapOldGeneration({ home });
    expect(existsSync(`${overlayDir}.old`)).toBe(false);
  });

  test("default sweep also reaps .old when the live tree is present", async () => {
    const home = tmp();
    const overlayDir = join(home, ".local", "share", "loadout-overlay");
    mkdirSync(overlayDir, { recursive: true });
    mkdirSync(`${overlayDir}.old`, { recursive: true });
    await cleanupUpdateArtifacts({ home });
    expect(existsSync(overlayDir)).toBe(true);
    expect(existsSync(`${overlayDir}.old`)).toBe(false);
  });
});

describe("makeIdleAbort", () => {
  test("aborts after silence; reset() defers; clear() disarms", async () => {
    const idle = makeIdleAbort(40);
    // Keep resetting well inside the window — must stay alive.
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 15));
      idle.reset();
    }
    expect(idle.signal.aborted).toBe(false);
    // Now go silent past the window — must abort with a readable reason.
    await new Promise((r) => setTimeout(r, 90));
    expect(idle.signal.aborted).toBe(true);
    expect(String(idle.signal.reason)).toContain("stalled");

    const idle2 = makeIdleAbort(30);
    idle2.clear();
    await new Promise((r) => setTimeout(r, 60));
    expect(idle2.signal.aborted).toBe(false); // cleared before firing
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

// -- runUpdate apply path (overlay tree swap + .so carry-over) -----------------

async function sha(text: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  h.update(text);
  return h.digest("hex");
}

async function awaitOverlaySettled(): Promise<string> {
  for (let i = 0; i < 300; i++) {
    const p = getUpdateStatus().phase;
    if (p === "restarting" || p === "error" || p === "idle") return p;
    await new Promise((r) => setTimeout(r, 10));
  }
  return getUpdateStatus().phase;
}

/**
 * Temp-fs fixture that drives the full overlay `runUpdate`: a live
 * overlay tree with a webkit `.so` closure the release tar omits, a
 * fake release served over `fetchFn`, and `run` faking tar/cp. Records
 * every `run` argv so the `.so` carry-over can be asserted.
 */
async function setupOverlayApply(opts: { renameOverride?: UpdaterDeps["rename"] } = {}) {
  const home = tmp();
  const overlayDir = join(home, ".local", "share", "loadout-overlay");
  const liveBin = join(overlayDir, "bin");
  mkdirSync(liveBin, { recursive: true });
  writeFileSync(join(liveBin, "launcher"), "old-launcher");
  // Closure libs fetch-deck-overlay-libs.sh dropped in; the release tar omits them.
  writeFileSync(join(liveBin, "libwebkit2gtk-4.1.so.0"), "webkit");
  // Electrobun's OWN lib — also present in the staged tar, must NOT be over-copied.
  writeFileSync(join(liveBin, "libelectrobun.so"), "old-electrobun");

  const tarBytes = "OVERLAY-TARBALL";
  const sums = `${await sha(tarBytes)}  loadout-overlay-x86_64.tar.xz`;

  const runCalls: string[][] = [];
  const run = async (argv: string[]) => {
    runCalls.push(argv);
    if (argv[0] === "tar") {
      // Materialise the staged tree the archive would contain: launcher
      // + Electrobun's own libelectrobun.so (but NOT the webkit closure).
      const dest = argv[argv.indexOf("-C") + 1]!;
      mkdirSync(join(dest, "bin"), { recursive: true });
      writeFileSync(join(dest, "bin", "launcher"), "new-launcher", { mode: 0o755 });
      writeFileSync(join(dest, "bin", "libelectrobun.so"), "new-electrobun");
    }
    if (argv[0] === "cp") {
      // Perform the carry-over for real so the swapped tree is complete.
      const target = argv[argv.length - 1]!;
      for (const src of argv.slice(2, -1)) {
        writeFileSync(join(target, src.split("/").pop()!), readFileSync(src));
      }
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/api/token")) return jsonResponse({ token: "t" });
    if (u.endsWith("/api/status")) return jsonResponse({ ok: true, version: "0.6.0" });
    if (u.endsWith("/api/self-update")) {
      if (init?.method === "POST") return jsonResponse({ ok: true }, 202);
      return jsonResponse({ phase: "done" }); // GET poll → done immediately
    }
    if (u.endsWith("/SHA256SUMS")) return new Response(sums);
    if (u.endsWith("/loadout-overlay-x86_64.tar.xz")) return new Response(tarBytes);
    throw new Error(`unexpected fetch ${u}`);
  }) as unknown as typeof fetch;

  const deps = fakeDeps(fetchFn, {
    home,
    run,
    sha256File: async (p) => sha(readFileSync(p, "utf8")),
    rename: opts.renameOverride ?? realRename,
  });
  return { home, overlayDir, liveBin, runCalls, deps };
}

describe("runUpdate overlay apply", () => {
  test("happy path: swaps the tree, carries the webkit closure, ends 'restarting'", async () => {
    const { overlayDir, runCalls, deps } = await setupOverlayApply();
    const res = startUpdate("v0.7.0", deps);
    expect(res.success).toBe(true);
    expect(await awaitOverlaySettled()).toBe("restarting");

    // New launcher is live; webkit closure carried; Electrobun's own lib
    // came from the tar (not over-copied from the old tree).
    expect(readFileSync(join(overlayDir, "bin", "launcher"), "utf8")).toBe("new-launcher");
    expect(readFileSync(join(overlayDir, "bin", "libwebkit2gtk-4.1.so.0"), "utf8")).toBe("webkit");
    expect(readFileSync(join(overlayDir, "bin", "libelectrobun.so"), "utf8")).toBe(
      "new-electrobun",
    );
    expect(existsSync(`${overlayDir}.old`)).toBe(true); // kept one gen for rollback
    // The ExecStartPre sentinel is consumed by the swap, not littered
    // into the live tree.
    expect(existsSync(join(overlayDir, ".verified"))).toBe(false);

    // The cp carried ONLY the webkit lib — never Electrobun's own (already staged).
    const cp = runCalls.find((c) => c[0] === "cp");
    expect(cp).toBeDefined();
    expect(cp!.some((a) => a.includes("libwebkit2gtk-4.1.so.0"))).toBe(true);
    expect(cp!.some((a) => a.includes("libelectrobun.so"))).toBe(false);
  });

  test("swap failure rolls the old tree back into place", async () => {
    // rename #1 (live→.old) succeeds; rename #2 (staging→live) throws;
    // rollback rename must restore the old tree so the unit still starts.
    let call = 0;
    const rename: UpdaterDeps["rename"] = async (from, to) => {
      call++;
      if (call === 2) throw new Error("simulated ENOSPC on staging→live");
      return realRename(from, to);
    };
    const { overlayDir, deps } = await setupOverlayApply({ renameOverride: rename });
    startUpdate("v0.7.0", deps);
    expect(await awaitOverlaySettled()).toBe("error");
    // Old tree restored to the live path (launcher back), not left at .old.
    expect(readFileSync(join(overlayDir, "bin", "launcher"), "utf8")).toBe("old-launcher");
    expect(existsSync(`${overlayDir}.old`)).toBe(false);
  });
});

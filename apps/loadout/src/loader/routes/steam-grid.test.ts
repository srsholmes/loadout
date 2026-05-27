import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `os.homedir()` ignores $HOME on Linux (reads from passwd), so we
// can't redirect path helpers by setting an env var. Mock the
// module so each test points the route at its own tmpdir.
let currentUserdata = "";
let currentAppcache = "";
mock.module("@loadout/steam-paths", () => ({
  getUserdataDir: () => currentUserdata,
  getAppCacheLibraryDir: () => currentAppcache,
}));

import { steamGridCandidates, steamGridRoute } from "./steam-grid";

// Moved from index.spec.ts during the A-001 route extraction. The
// pure dual-stem logic lives next to its consumer now.

describe("steamGridCandidates", () => {
  // Steam app: 32-bit appId, no gameid64 sentinel in the bottom bits,
  // so only one stem.
  it("Steam app capsule probes only the portrait variants of one stem", () => {
    expect(steamGridCandidates("730", "capsule")).toEqual(["730p.jpg", "730p.png"]);
  });

  it("Steam app header probes only the unsuffixed variants", () => {
    expect(steamGridCandidates("730", "header")).toEqual(["730.png", "730.jpg"]);
  });

  it("Steam app hero probes the _hero suffix", () => {
    expect(steamGridCandidates("730", "hero")).toEqual(["730_hero.jpg", "730_hero.png"]);
  });

  // Non-Steam shortcut: the gameid64 form is `(appId << 32) | 0x02000000`.
  // Steam's "Set Custom Artwork" UI writes under the 32-bit appid; SGDB
  // double-writes both — the route must probe both stems so either
  // origin resolves. This is the audit-2026-05 fix for emulated games
  // showing the hero (landscape grid) instead of the capsule.
  it("Shortcut capsule probes BOTH gameid64 and shortcut appid stems", () => {
    // appid = 2934567890 → gameid64 = (2934567890n << 32n) | 0x02000000n
    //                                = 12604866617641959424
    const gameid64 = ((2934567890n << 32n) | 0x02000000n).toString();
    expect(steamGridCandidates(gameid64, "capsule")).toEqual([
      `${gameid64}p.jpg`,
      `${gameid64}p.png`,
      "2934567890p.jpg",
      "2934567890p.png",
    ]);
  });

  it("Shortcut header probes both stems with landscape suffix", () => {
    const gameid64 = ((2934567890n << 32n) | 0x02000000n).toString();
    expect(steamGridCandidates(gameid64, "header")).toEqual([
      `${gameid64}.png`,
      `${gameid64}.jpg`,
      "2934567890.png",
      "2934567890.jpg",
    ]);
  });

  it("Shortcut hero probes both stems with _hero suffix", () => {
    const gameid64 = ((2934567890n << 32n) | 0x02000000n).toString();
    expect(steamGridCandidates(gameid64, "hero")).toEqual([
      `${gameid64}_hero.jpg`,
      `${gameid64}_hero.png`,
      "2934567890_hero.jpg",
      "2934567890_hero.png",
    ]);
  });

  it("Capsule never falls back to landscape (strict aspect-ratio)", () => {
    // Regression guard: the previous fallback chain served the
    // landscape grid as the capsule whenever no portrait existed,
    // which is what the user saw as "hero showing instead of capsule".
    const candidates = steamGridCandidates("730", "capsule");
    expect(candidates.every((c) => c.includes("p."))).toBe(true);
  });

  it("Header never falls back to portrait (strict aspect-ratio)", () => {
    const candidates = steamGridCandidates("730", "header");
    expect(candidates.every((c) => !c.includes("p."))).toBe(true);
    expect(candidates.every((c) => !c.includes("_hero"))).toBe(true);
  });

  // Logo support landed alongside the auto-discover route variant
  // so the overlay's NowPlaying widget can resolve a shortcut's logo
  // (closes #113). Same dual-stem treatment as hero/header/capsule.
  it("Steam app logo probes the _logo suffix", () => {
    expect(steamGridCandidates("730", "logo")).toEqual([
      "730_logo.png",
      "730_logo.jpg",
    ]);
  });

  it("Shortcut logo probes both stems with _logo suffix", () => {
    const gameid64 = ((2934567890n << 32n) | 0x02000000n).toString();
    expect(steamGridCandidates(gameid64, "logo")).toEqual([
      `${gameid64}_logo.png`,
      `${gameid64}_logo.jpg`,
      "2934567890_logo.png",
      "2934567890_logo.jpg",
    ]);
  });
});

describe("steamGridRoute handler", () => {
  const USER_ID = "25139426";
  const GAMEID64 = "9947301272983961600"; // shortcut appid 2316036558
  let tmp: string;
  let gridDir: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "steam-grid-"));
    currentUserdata = join(tmp, "userdata");
    currentAppcache = join(tmp, "appcache", "librarycache");
    gridDir = join(currentUserdata, USER_ID, "config", "grid");
    await mkdir(gridDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function reqFor(stem: string, type = "capsule", headers: HeadersInit = {}) {
    const url = new URL(`http://localhost/api/steam-grid/${stem}/${USER_ID}/${type}`);
    return { req: new Request(url, { headers }), url };
  }

  async function writeAt(filename: string, body: string, mtimeMs: number) {
    const p = join(gridDir, filename);
    await writeFile(p, body);
    const t = mtimeMs / 1000;
    await utimes(p, t, t);
    return p;
  }

  async function call(req: Request, url: URL): Promise<Response> {
    const res = await steamGridRoute.handle(req, url, {} as never);
    if (!res) throw new Error("route returned undefined");
    return res;
  }

  it("404 when no candidate file exists", async () => {
    const { req, url } = reqFor(GAMEID64);
    const res = await call(req, url);
    expect(res.status).toBe(404);
  });

  it("picks the newest-mtime candidate (regression: stale .jpg shadowing fresh .png)", async () => {
    // Mirror the bug from #105: previous SGDB apply left a JPG; new
    // Steam SetCustomArtworkForApp wrote a PNG under the shortcut stem.
    // Old fixed-priority probe served the JPG (it ranks first); newest-
    // mtime must win.
    await writeAt(`${GAMEID64}p.jpg`, "old-jpg", 1_000_000);
    await writeAt("2316036558p.png", "new-png", 2_000_000);
    const { req, url } = reqFor(GAMEID64);
    const res = await call(req, url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(await res.text()).toBe("new-png");
  });

  it("returns 304 with matching If-None-Match and CORS still set", async () => {
    await writeAt(`${GAMEID64}p.png`, "body", 1_500_000);
    const first = await call(reqFor(GAMEID64).req, reqFor(GAMEID64).url);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^W\/"\d+-4"$/);

    const { req, url } = reqFor(GAMEID64, "capsule", { "If-None-Match": etag! });
    const res = await call(req, url);
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(etag);
    // 304 must carry CORS for any future cross-origin <img crossorigin>.
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("ETag changes when the underlying file is overwritten", async () => {
    await writeAt(`${GAMEID64}p.png`, "v1", 1_000_000);
    const r1 = await call(reqFor(GAMEID64).req, reqFor(GAMEID64).url);
    const e1 = r1.headers.get("etag");
    await writeAt(`${GAMEID64}p.png`, "v2-different-size", 2_000_000);
    const r2 = await call(reqFor(GAMEID64).req, reqFor(GAMEID64).url);
    expect(r2.headers.get("etag")).not.toBe(e1);
  });

  // Auto-discover form (no userId in the URL) — used by the overlay
  // homepage's NowPlaying widget which knows the running appId but
  // not the Steam account it was launched from. Closes #113.
  describe("auto-discover form (no userId in URL)", () => {
    function autoReqFor(stem: string, type = "hero") {
      const url = new URL(`http://localhost/api/steam-grid/${stem}/${type}`);
      return { req: new Request(url), url };
    }

    it("scans every user dir and serves the matching file", async () => {
      await writeAt(`${GAMEID64}_hero.png`, "shortcut-hero", 1_000_000);
      const { req, url } = autoReqFor(GAMEID64, "hero");
      const res = await call(req, url);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("shortcut-hero");
    });

    it("returns 404 when no userdata profile has the file", async () => {
      const { req, url } = autoReqFor(GAMEID64, "hero");
      const res = await call(req, url);
      expect(res.status).toBe(404);
    });

    it("picks the newest-mtime match across multiple users", async () => {
      // Second profile dir with a fresher copy. SGDB fans the file out
      // to every user, so the only divergence in practice is when one
      // profile is mid-apply; pick the freshest to mirror the per-user
      // route's newest-mtime tiebreak.
      await writeAt(`${GAMEID64}_hero.png`, "old", 1_000_000);
      const otherUserGrid = join(
        currentUserdata,
        "99999999",
        "config",
        "grid",
      );
      await mkdir(otherUserGrid, { recursive: true });
      const newer = join(otherUserGrid, `${GAMEID64}_hero.png`);
      await writeFile(newer, "new");
      await utimes(newer, 3000, 3000);
      const { req, url } = autoReqFor(GAMEID64, "hero");
      const res = await call(req, url);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("new");
    });

    it("serves logo via the auto-discover form", async () => {
      await writeAt(`${GAMEID64}_logo.png`, "logo-bytes", 1_000_000);
      const { req, url } = autoReqFor(GAMEID64, "logo");
      const res = await call(req, url);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("logo-bytes");
    });
  });

  // Steam's appcache fallback — for real Steam apps, when nothing's
  // in `userdata/.../grid/` (the user hasn't applied SGDB / custom
  // art), serve the file Steam itself downloaded for its own library
  // UI from `appcache/librarycache/<appId>/<filename>`. Means the
  // overlay renders art for every installed Steam app offline without
  // touching the CDN — issue #113 follow-up.
  describe("Steam appcache fallback", () => {
    const STEAM_APPID = "730"; // CS2

    async function writeAppcache(filename: string, body: string, mtimeMs: number) {
      const dir = join(currentAppcache, STEAM_APPID);
      await mkdir(dir, { recursive: true });
      const p = join(dir, filename);
      await writeFile(p, body);
      const t = mtimeMs / 1000;
      await utimes(p, t, t);
      return p;
    }

    it("auto-discover serves Steam's library_hero from appcache when grid/ has nothing", async () => {
      await writeAppcache("library_hero.jpg", "appcache-hero", 1_000_000);
      const url = new URL(
        `http://localhost/api/steam-grid/${STEAM_APPID}/hero`,
      );
      const res = await call(new Request(url), url);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/jpeg");
      expect(await res.text()).toBe("appcache-hero");
    });

    it("auto-discover serves logo / capsule / header from appcache too", async () => {
      await writeAppcache("logo.png", "appcache-logo", 1_000_000);
      await writeAppcache("library_600x900.jpg", "appcache-capsule", 1_000_000);
      await writeAppcache("header.jpg", "appcache-header", 1_000_000);
      for (const [type, body] of [
        ["logo", "appcache-logo"],
        ["capsule", "appcache-capsule"],
        ["header", "appcache-header"],
      ] as const) {
        const url = new URL(
          `http://localhost/api/steam-grid/${STEAM_APPID}/${type}`,
        );
        const res = await call(new Request(url), url);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe(body);
      }
    });

    it("user customisation in grid/ wins over Steam's appcache", async () => {
      await writeAppcache("library_hero.jpg", "steam-default", 1_000_000);
      // SGDB-style filename for a Steam app: `<appId>_hero.<ext>`.
      await writeAt(`${STEAM_APPID}_hero.png`, "user-applied", 1_000_000);
      const url = new URL(
        `http://localhost/api/steam-grid/${STEAM_APPID}/hero`,
      );
      const res = await call(new Request(url), url);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("user-applied");
    });

    it("redirects to the Steam CDN when neither grid/ nor appcache has it (Steam apps only)", async () => {
      // Real-world bug from #113 follow-up: Cyberpunk's appcache uses
      // the newer hash-named layout (no `library_hero.jpg` etc.), so
      // the local fallback misses and we'd otherwise 404. Public CDN
      // still has art for every real Steam app — redirect there as a
      // last resort and let the browser fetch directly.
      const url = new URL(
        `http://localhost/api/steam-grid/${STEAM_APPID}/hero`,
      );
      const res = await call(new Request(url), url);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(
        `https://cdn.cloudflare.steamstatic.com/steam/apps/${STEAM_APPID}/library_hero.jpg`,
      );
      // Browser caches the redirect for 5 min so NowPlaying re-renders
      // don't round-trip the loader to re-resolve the Location header.
      expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    });

    it("auto-discover redirects to the CDN even when userdata is missing entirely", async () => {
      // No userdata = Steam never installed (CI runners, fresh dev
      // box). Auto-discover form must still resolve Steam apps via
      // the CDN-redirect fallback rather than 404'ing.
      currentUserdata = join(tmp, "no-such-userdata");
      const url = new URL(
        `http://localhost/api/steam-grid/${STEAM_APPID}/hero`,
      );
      const res = await call(new Request(url), url);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain(
        `cloudflare.steamstatic.com/steam/apps/${STEAM_APPID}/library_hero.jpg`,
      );
    });

    it("appId 33554432 (= 0x02000000) is treated as a Steam app, not a gameid64", async () => {
      // Regression guard: the original looksLikeSteamAppId used the
      // gameid64 sentinel `(big & 0xffffffffn) === 0x02000000n` which
      // fired on this literal value too, misclassifying it and
      // returning 404 instead of falling through to CDN-redirect.
      const url = new URL(
        `http://localhost/api/steam-grid/33554432/hero`,
      );
      const res = await call(new Request(url), url);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("/steam/apps/33554432/");
    });

    it("CDN redirect uses the right filename per type", async () => {
      const expectations: Record<string, string> = {
        hero: "library_hero.jpg",
        logo: "logo.png",
        header: "header.jpg",
        capsule: "library_600x900.jpg",
      };
      for (const [type, filename] of Object.entries(expectations)) {
        const url = new URL(
          `http://localhost/api/steam-grid/${STEAM_APPID}/${type}`,
        );
        const res = await call(new Request(url), url);
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe(
          `https://cdn.cloudflare.steamstatic.com/steam/apps/${STEAM_APPID}/${filename}`,
        );
      }
    });

    it("appcache fallback does NOT trigger for non-Steam shortcut gameid64s", async () => {
      // Even if a directory with the same numeric name happened to
      // exist in appcache/librarycache (which it wouldn't on a real
      // system — Steam doesn't appcache shortcuts), the route must
      // not descend into it: a gameid64 isn't a valid Steam appId.
      await writeAppcache("library_hero.jpg", "should-not-serve", 1_000_000);
      const url = new URL(
        `http://localhost/api/steam-grid/${GAMEID64}/hero`,
      );
      const res = await call(new Request(url), url);
      expect(res.status).toBe(404);
    });

    it("per-user form also falls back to appcache for Steam apps", async () => {
      await writeAppcache("library_hero.jpg", "appcache-hero", 1_000_000);
      const url = new URL(
        `http://localhost/api/steam-grid/${STEAM_APPID}/${USER_ID}/hero`,
      );
      const res = await call(new Request(url), url);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("appcache-hero");
    });
  });
});

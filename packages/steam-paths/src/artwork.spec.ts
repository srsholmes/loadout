import { describe, it, expect } from "bun:test";
import { steamArtworkUrls } from "./artwork";

describe("steamArtworkUrls", () => {
  describe("real Steam apps (appId < 2^31)", () => {
    it("routes to the loader's local /api/steam-grid endpoint with the bare appId stem", () => {
      const urls = steamArtworkUrls(730);
      const base = "http://localhost:33820/api/steam-grid/730";
      expect(urls.hero).toBe(`${base}/hero`);
      expect(urls.logo).toBe(`${base}/logo`);
      expect(urls.header).toBe(`${base}/header`);
      expect(urls.capsule).toBe(`${base}/capsule`);
    });

    it("works for stringified Steam appIds", () => {
      const urls = steamArtworkUrls("440");
      expect(urls.hero).toBe("http://localhost:33820/api/steam-grid/440/hero");
    });

    // Boundary: 2^31 - 1 is the largest signed-int32 value; Valve has
    // never issued a Steam appId anywhere near it. Must still take the
    // bare-appId stem (route falls back to Steam's appcache for it).
    it("treats 2^31 - 1 as a Steam app (bare appId stem)", () => {
      const urls = steamArtworkUrls(0x7fffffff);
      expect(urls.hero).toBe(
        `http://localhost:33820/api/steam-grid/${0x7fffffff}/hero`,
      );
    });
  });

  describe("non-Steam shortcuts (appId >= 2^31)", () => {
    // Shortcuts must use the gameid64 stem so the route can probe both
    // the gameid64 form (SGDB writes both) and the recovered shortcut
    // appid form (Steam's SetCustomArtworkForApp writes that one).
    const SHORTCUT_APPID = 2934567890; // example uint32 with high bit set
    const expectedStem = (
      (BigInt(SHORTCUT_APPID) << 32n) |
      0x02000000n
    ).toString();

    it("routes shortcut appId to the loader's /api/steam-grid endpoint with gameid64 stem", () => {
      const urls = steamArtworkUrls(SHORTCUT_APPID);
      const base = `http://localhost:33820/api/steam-grid/${expectedStem}`;
      expect(urls.hero).toBe(`${base}/hero`);
      expect(urls.logo).toBe(`${base}/logo`);
      expect(urls.header).toBe(`${base}/header`);
      expect(urls.capsule).toBe(`${base}/capsule`);
    });

    it("works when the shortcut appId arrives as a string", () => {
      const urls = steamArtworkUrls(String(SHORTCUT_APPID));
      expect(urls.hero).toBe(
        `http://localhost:33820/api/steam-grid/${expectedStem}/hero`,
      );
    });

    // Boundary: 2^31 itself is the first shortcut value; must take
    // the gameid64 stem path.
    it("treats exactly 2^31 as a shortcut (gameid64 stem)", () => {
      const appId = 0x80000000;
      const stem = ((BigInt(appId) << 32n) | 0x02000000n).toString();
      const urls = steamArtworkUrls(appId);
      expect(urls.hero).toBe(
        `http://localhost:33820/api/steam-grid/${stem}/hero`,
      );
    });
  });

  describe("non-numeric inputs", () => {
    // Caller-supplied strings that don't parse to a finite number get
    // routed verbatim into the URL — the route's regex requires
    // all-digits and would 404, but at least the URL builder doesn't
    // crash.
    it("does not crash on garbage input", () => {
      const urls = steamArtworkUrls("not-a-number");
      expect(urls.hero).toBe(
        "http://localhost:33820/api/steam-grid/not-a-number/hero",
      );
    });
  });
});

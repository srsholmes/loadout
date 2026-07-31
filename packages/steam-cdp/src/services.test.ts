// Real disk I/O against a per-test temp dir via XDG_CACHE_HOME — the pattern
// packages/external-cache and packages/plugin-storage use, to avoid the
// `mock.module("fs/promises", …)` cross-file leakage documented in
// docs/test-mock-contamination.md. The page itself is stubbed through the
// `evaluate` seam, so nothing here needs Steam.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  buildCallExpression,
  callSteamService,
  chunkCacheKey,
  clearServiceModuleCache,
  findModuleIdInSource,
  resolveServiceModuleId,
  SteamServiceError,
  type SteamServiceSpec,
} from "./services";

const SPEC: SteamServiceSpec = {
  namespace: "Player",
  method: "GetAchievementsProgress",
};
const LITERAL = '"Player.GetAchievementsProgress#1"';

let tempDir: string;
let prevXdg: string | undefined;

beforeEach(async () => {
  prevXdg = process.env.XDG_CACHE_HOME;
  tempDir = mkdtempSync(join(tmpdir(), "steam-services-"));
  process.env.XDG_CACHE_HOME = tempDir;
  // The module-id memo is process-global; clear it so tests don't leak into
  // each other through it.
  await clearServiceModuleCache();
});

afterEach(() => {
  if (prevXdg === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = prevXdg;
  rmSync(tempDir, { recursive: true, force: true });
});

// ── findModuleIdInSource ─────────────────────────────────────────────────

describe("findModuleIdInSource", () => {
  it("finds a modern arrow-form module header", () => {
    const src = `64295:(e,t,r)=>{r.d(t,{xtC:()=>x});const m=${LITERAL};}`;
    expect(findModuleIdInSource(src, src.indexOf(LITERAL))).toBe(64295);
  });

  it("finds a legacy function-form module header", () => {
    const src = `12345:function(e,t,r){const m=${LITERAL};}`;
    expect(findModuleIdInSource(src, src.indexOf(LITERAL))).toBe(12345);
  });

  it("tolerates whitespace in the header", () => {
    const src = `999 : ( e , t , r ) => { const m=${LITERAL};}`;
    expect(findModuleIdInSource(src, src.indexOf(LITERAL))).toBe(999);
  });

  it("returns the NEAREST preceding header, not the first in the file", () => {
    // The whole point of walking backwards. Getting this wrong resolves to
    // some unrelated module hundreds of kilobytes earlier and the call fails
    // with a confusing no-namespace.
    const src = [
      `1111:(e,t,r)=>{ const other = "Wishlist.GetWishlistItemCount#1"; }`,
      `2222:(e,t,r)=>{ const other = "Store.GetItems#1"; }`,
      `3333:(e,t,r)=>{ const m = ${LITERAL}; }`,
    ].join(",");
    expect(findModuleIdInSource(src, src.indexOf(LITERAL))).toBe(3333);
  });

  it("ignores headers that appear AFTER the match", () => {
    const src = [
      `7777:(e,t,r)=>{ const m = ${LITERAL}; }`,
      `8888:(e,t,r)=>{ const later = "Nope#1"; }`,
    ].join(",");
    expect(findModuleIdInSource(src, src.indexOf(LITERAL))).toBe(7777);
  });

  it("returns null when no header precedes the match", () => {
    // e.g. the literal appeared in a sourcemap comment before any module.
    const src = `/* ${LITERAL} */`;
    expect(findModuleIdInSource(src, src.indexOf(LITERAL))).toBeNull();
  });

  it("does not mistake a bare digit run for a module header", () => {
    const src = `const version = 42; const m=${LITERAL};`;
    expect(findModuleIdInSource(src, src.indexOf(LITERAL))).toBeNull();
  });

  it("does not mistake a two-argument factory for a module header", () => {
    // Webpack module factories always take exactly three params.
    const src = `55:(a,b)=>{ const m=${LITERAL}; }`;
    expect(findModuleIdInSource(src, src.indexOf(LITERAL))).toBeNull();
  });

  it("handles a header at offset 0", () => {
    const src = `1:(e,t,r)=>{${LITERAL}}`;
    expect(findModuleIdInSource(src, src.indexOf(LITERAL))).toBe(1);
  });
});

// ── chunkCacheKey ────────────────────────────────────────────────────────

describe("chunkCacheKey", () => {
  it("is independent of readdir order", () => {
    const a = chunkCacheKey(["/s/chunk~a.js", "/s/chunk~b.js"]);
    const b = chunkCacheKey(["/s/chunk~b.js", "/s/chunk~a.js"]);
    expect(a).toBe(b);
  });

  it("is independent of the directory the chunks live in", () => {
    // Only the content-hashed basenames identify a build.
    expect(chunkCacheKey(["/one/chunk~a.js"])).toBe(
      chunkCacheKey(["/completely/other/chunk~a.js"]),
    );
  });

  it("changes when a chunk's content hash changes", () => {
    const before = chunkCacheKey(["/s/chunk~2c8f1a.js"]);
    const after = chunkCacheKey(["/s/chunk~9d3e77.js"]);
    expect(after).not.toBe(before);
  });

  it("changes when a chunk is added", () => {
    const one = chunkCacheKey(["/s/chunk~a.js"]);
    const two = chunkCacheKey(["/s/chunk~a.js", "/s/chunk~b.js"]);
    expect(two).not.toBe(one);
  });

  it("is a stable fixed-width hex string", () => {
    const key = chunkCacheKey(["/s/chunk~a.js"]);
    expect(key).toMatch(/^[0-9a-f]{8}$/);
    expect(chunkCacheKey(["/s/chunk~a.js"])).toBe(key);
  });
});

// ── buildCallExpression ──────────────────────────────────────────────────

describe("buildCallExpression", () => {
  const expr = buildCallExpression(64295, "GetAchievementsProgress", {
    steamid: "76561198000000001",
    appids: [620, 570],
  }, 8000);

  it("embeds the in-page timeout race", () => {
    // Non-negotiable: without it a never-settling CM call holds the
    // per-target evaluate chain and blocks every other consumer of Steam.
    expect(expr).toContain("Promise.race");
    expect(expr).toContain("setTimeout");
    expect(expr).toContain("8000");
    expect(expr).toContain("in-page timeout");
  });

  it("self-bootstraps webpack require rather than trusting the injector", () => {
    expect(expr).toContain("__STEAM_WP_REQUIRE");
    expect(expr).toContain("webpackChunksteamui");
  });

  it("duck-types the namespace instead of a minified export key", () => {
    expect(expr).toContain("Object.values(mod)");
    expect(expr).not.toContain("xtC");
  });

  it("serialises the request as JSON, preserving a 64-bit id as a string", () => {
    expect(expr).toContain('"steamid":"76561198000000001"');
    expect(expr).toContain('"appids":[620,570]');
  });

  it("reads the EResult both ways Steam exposes it", () => {
    expect(expr).toContain("GetEResult");
    expect(expr).toContain("response.eresult");
  });

  it("normalises Longs and round-trips through JSON before the clone", () => {
    expect(expr).toContain("normaliseLongs");
    expect(expr).toContain("JSON.parse(JSON.stringify(");
  });

  it("returns a tagged union covering every failure mode", () => {
    for (const tag of [
      "no-wp",
      "no-transport",
      "no-namespace",
      "timeout",
      "malformed",
      "ok",
    ]) {
      expect(expr).toContain(`tag: "${tag}"`);
    }
  });

  it("is a syntactically valid expression", () => {
    // Cheapest possible guard against a template-literal typo shipping.
    expect(() => new Function(`return ${expr};`)).not.toThrow();
  });
});

// ── resolveServiceModuleId ───────────────────────────────────────────────

describe("resolveServiceModuleId", () => {
  it("greps the chunks and returns the enclosing module id", async () => {
    const id = await resolveServiceModuleId(SPEC, {
      listChunks: async () => ["/s/chunk~a.js"],
      readChunk: async () => `64295:(e,t,r)=>{const m=${LITERAL};}`,
    });
    expect(id).toBe(64295);
  });

  it("searches later chunks when the first does not match", async () => {
    const read: string[] = [];
    const id = await resolveServiceModuleId(SPEC, {
      listChunks: async () => ["/s/chunk~a.js", "/s/chunk~b.js"],
      readChunk: async (p) => {
        read.push(p);
        return p.endsWith("b.js")
          ? `777:(e,t,r)=>{const m=${LITERAL};}`
          : `111:(e,t,r)=>{const nope="Other#1";}`;
      },
    });
    expect(id).toBe(777);
    expect(read).toEqual(["/s/chunk~a.js", "/s/chunk~b.js"]);
  });

  it("accepts single-quoted literals", async () => {
    const id = await resolveServiceModuleId(SPEC, {
      listChunks: async () => ["/s/chunk~a.js"],
      readChunk: async () =>
        `4242:(e,t,r)=>{const m='Player.GetAchievementsProgress#1';}`,
    });
    expect(id).toBe(4242);
  });

  it("skips a chunk that vanishes mid-read", async () => {
    // Steam updating underneath us must not fail the whole resolution.
    const id = await resolveServiceModuleId(SPEC, {
      listChunks: async () => ["/s/gone.js", "/s/chunk~b.js"],
      readChunk: async (p) => {
        if (p.endsWith("gone.js")) throw new Error("ENOENT");
        return `31337:(e,t,r)=>{const m=${LITERAL};}`;
      },
    });
    expect(id).toBe(31337);
  });

  it("throws unresolved, naming the literal, when nothing matches", async () => {
    const err = await resolveServiceModuleId(SPEC, {
      listChunks: async () => ["/s/chunk~a.js"],
      readChunk: async () => "nothing interesting here",
    }).catch((e) => e);

    expect(err).toBeInstanceOf(SteamServiceError);
    expect((err as SteamServiceError).code).toBe("unresolved");
    // Diagnosable from the log line alone after a Valve rename.
    expect((err as SteamServiceError).message).toContain(
      "Player.GetAchievementsProgress#1",
    );
  });

  it("throws unresolved when Steam is not installed", async () => {
    const err = await resolveServiceModuleId(SPEC, {
      listChunks: async () => [],
    }).catch((e) => e);
    expect((err as SteamServiceError).code).toBe("unresolved");
    expect((err as SteamServiceError).message).toMatch(/Is Steam installed/);
  });

  it("caches so a second call does not re-read the bundle", async () => {
    let reads = 0;
    const opts = {
      listChunks: async () => ["/s/chunk~a.js"],
      readChunk: async () => {
        reads++;
        return `500:(e,t,r)=>{const m=${LITERAL};}`;
      },
    };

    expect(await resolveServiceModuleId(SPEC, opts)).toBe(500);
    expect(await resolveServiceModuleId(SPEC, opts)).toBe(500);
    expect(reads).toBe(1);
  });

  it("re-greps when the chunk filenames change, i.e. Steam updated", async () => {
    let reads = 0;
    const first = await resolveServiceModuleId(SPEC, {
      listChunks: async () => ["/s/chunk~OLD.js"],
      readChunk: async () => {
        reads++;
        return `100:(e,t,r)=>{const m=${LITERAL};}`;
      },
    });
    expect(first).toBe(100);

    // Fresh memo, as after a restart; the disk cache is keyed on the names.
    await clearServiceModuleCache();

    const second = await resolveServiceModuleId(SPEC, {
      listChunks: async () => ["/s/chunk~NEW.js"],
      readChunk: async () => {
        reads++;
        return `200:(e,t,r)=>{const m=${LITERAL};}`;
      },
    });
    // The id moved between builds — exactly the reason nothing is hardcoded.
    expect(second).toBe(200);
    expect(reads).toBe(2);
  });
});

// ── callSteamService ─────────────────────────────────────────────────────

/** Resolve to module 64295 without touching disk twice. */
const resolveOpts = {
  listChunks: async () => ["/s/chunk~a.js"],
  readChunk: async () => `64295:(e,t,r)=>{const m=${LITERAL};}`,
};

function callWith(result: unknown, extra: { timeoutMs?: number } = {}) {
  return callSteamService(SPEC, { appids: [620] }, {
    ...resolveOpts,
    ...extra,
    evaluate: async () => result,
  });
}

describe("callSteamService", () => {
  it("returns the response data on ok", async () => {
    const data = {
      achievement_progress: [
        { appid: 620, unlocked: 26, total: 51, percentage: 50.98 },
      ],
    };
    expect(await callWith({ tag: "ok", eresult: 1, data })).toEqual(data);
  });

  it("accepts an ok response with no EResult at all", async () => {
    // Not every response object exposes one; treating that as failure would
    // reject perfectly good data.
    expect(await callWith({ tag: "ok", data: { ok: true } })).toEqual({ ok: true });
  });

  it("passes the resolved module id and request into the expression", async () => {
    let seen = "";
    await callSteamService(SPEC, { appids: [620, 570] }, {
      ...resolveOpts,
      evaluate: async (expr) => {
        seen = expr;
        return { tag: "ok", eresult: 1, data: null };
      },
    });
    expect(seen).toContain("64295");
    expect(seen).toContain('"appids":[620,570]');
  });

  const tagCases: Array<[string, string, RegExp]> = [
    ["no-wp", "no-wp", /webpack require/],
    ["no-transport", "no-transport", /GetServiceTransport/],
    ["no-namespace", "no-namespace", /does not export/],
    ["timeout", "timeout", /did not respond/],
    ["malformed", "malformed", /unusable response/],
  ];

  for (const [tag, code, messageMatch] of tagCases) {
    it(`maps the ${tag} tag to a typed ${code} error`, async () => {
      const err = await callWith({ tag }).catch((e) => e);
      expect(err).toBeInstanceOf(SteamServiceError);
      expect((err as SteamServiceError).code).toBe(code);
      expect((err as SteamServiceError).message).toMatch(messageMatch);
    });
  }

  it("includes the in-page detail in a malformed error", async () => {
    const err = await callWith({
      tag: "malformed",
      detail: "body.constructor is undefined",
    }).catch((e) => e);
    expect((err as SteamServiceError).message).toContain(
      "body.constructor is undefined",
    );
  });

  it("throws eresult, carrying the numeric code, on a non-OK EResult", async () => {
    const err = await callWith({ tag: "ok", eresult: 84, data: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(SteamServiceError);
    expect((err as SteamServiceError).code).toBe("eresult");
    expect((err as SteamServiceError).eresult).toBe(84);
  });

  it("rejects an unrecognised payload rather than returning undefined data", async () => {
    for (const junk of [null, undefined, "surprise", 42, {}]) {
      const err = await callWith(junk).catch((e) => e);
      expect((err as SteamServiceError).code).toBe("malformed");
    }
  });

  it("times out on the JS side when the page never settles", async () => {
    // The backstop: an in-page timer cannot fire if the page is wedged, and
    // a stuck evaluate blocks every other consumer of that target.
    const err = await callSteamService(SPEC, {}, {
      ...resolveOpts,
      timeoutMs: 5,
      evaluate: () => new Promise(() => {}),
    }).catch((e) => e);

    expect(err).toBeInstanceOf(SteamServiceError);
    expect((err as SteamServiceError).code).toBe("timeout");
  });

  it("propagates a resolution failure without evaluating anything", async () => {
    let evaluated = false;
    const err = await callSteamService(SPEC, {}, {
      listChunks: async () => ["/s/chunk~a.js"],
      readChunk: async () => "no match",
      evaluate: async () => {
        evaluated = true;
        return { tag: "ok", data: null };
      },
    }).catch((e) => e);

    expect((err as SteamServiceError).code).toBe("unresolved");
    expect(evaluated).toBe(false);
  });

  it("surfaces an evaluate rejection rather than swallowing it", async () => {
    const err = await callSteamService(SPEC, {}, {
      ...resolveOpts,
      evaluate: async () => {
        throw new Error("CDP connection closed");
      },
    }).catch((e) => e);
    expect((err as Error).message).toBe("CDP connection closed");
  });
});

// ── the in-page Long normaliser ──────────────────────────────────────────

describe("normaliseLongs (executed from the generated source)", () => {
  /** Pull the helper out of the generated expression and run it for real, so
   *  the 64-bit conversion is tested rather than assumed. */
  function loadNormaliser(): (v: unknown) => unknown {
    const expr = buildCallExpression(1, "M", {}, 1000);
    const start = expr.indexOf("function normaliseLongs");
    const end = expr.indexOf("\n    }", start) + "\n    }".length;
    const src = expr.slice(start, end);
    return new Function(`${src}; return normaliseLongs;`)() as (v: unknown) => unknown;
  }

  const normalise = loadNormaliser();

  it("passes primitives and null through untouched", () => {
    expect(normalise(42)).toBe(42);
    expect(normalise("x")).toBe("x");
    expect(normalise(null)).toBeNull();
    expect(normalise(true)).toBe(true);
  });

  it("converts a 17-digit Steam id without precision loss", () => {
    // 76561198000000001 = high 17825793, low 512 (unsigned).
    const steamId = 76561198000000001n;
    const long = {
      low: Number(steamId & 0xffffffffn) | 0,
      high: Number((steamId >> 32n) & 0xffffffffn) | 0,
      unsigned: true,
    };
    expect(normalise(long)).toBe("76561198000000001");
    // Why a decimal string and not a number: the value exceeds 2^53, so the
    // number path silently drops the last digit.
    expect(String(Number("76561198000000001"))).toBe("76561198000000000");
  });

  it("converts a small unsigned Long", () => {
    expect(normalise({ low: 1294, high: 0, unsigned: true })).toBe("1294");
  });

  it("converts a negative signed Long via two's complement", () => {
    expect(normalise({ low: -1, high: -1, unsigned: false })).toBe("-1");
  });

  it("recurses through arrays and nested objects", () => {
    const out = normalise({
      rows: [{ id: { low: 5, high: 0, unsigned: true }, name: "a" }],
    }) as { rows: Array<{ id: unknown; name: string }> };
    expect(out.rows[0]!.id).toBe("5");
    expect(out.rows[0]!.name).toBe("a");
  });
});

import { describe, expect, it } from "bun:test";

import { classify, countFresh, fixedTtl } from "./staleness";
import type { FactRow } from "./types";

const HOUR = 60 * 60 * 1000;

/** The achievement policy from the plan: no-achievements 30d, complete 7d,
 *  partial 24h. Exercised here because the value-dependent case is the whole
 *  reason this module isn't a bare number. */
const achievements = {
  ttlSecFor: (v: { unlocked: number; total: number }) => {
    if (v.total === 0) return 30 * 24 * 60 * 60;
    if (v.unlocked >= v.total) return 7 * 24 * 60 * 60;
    return 24 * 60 * 60;
  },
};

function row<V>(at: number, value: V): FactRow<V> {
  return { at, value };
}

describe("classify", () => {
  it("reports a missing row as missing, not stale", () => {
    expect(classify(undefined, 1_000, fixedTtl(60))).toBe("missing");
  });

  it("is fresh strictly inside the window and stale at the boundary", () => {
    const policy = fixedTtl(60);
    const at = 1_000_000;
    // 59.999s old — inside.
    expect(classify(row(at, 1), at + 59_999, policy)).toBe("fresh");
    // Exactly 60s old — the window is [0, ttl), so this is stale.
    expect(classify(row(at, 1), at + 60_000, policy)).toBe("stale");
    expect(classify(row(at, 1), at + 60_001, policy)).toBe("stale");
  });

  it("treats Infinity as never re-fetch", () => {
    const policy = fixedTtl(Infinity);
    const at = 0;
    expect(classify(row(at, 1), at + 1_000 * HOUR, policy)).toBe("fresh");
  });

  it("treats a zero or negative TTL as always stale", () => {
    const at = 5_000;
    expect(classify(row(at, 1), at, fixedTtl(0))).toBe("stale");
    expect(classify(row(at, 1), at, fixedTtl(-10))).toBe("stale");
  });

  it("reads a future-dated row as fresh so clock skew cannot spin the sweep", () => {
    const now = 1_000_000;
    expect(classify(row(now + 5 * HOUR, 1), now, fixedTtl(60))).toBe("fresh");
  });

  describe("value-dependent TTL", () => {
    const at = 1_000_000_000;

    it("keeps a no-achievements row fresh for 30 days", () => {
      const r = row(at, { unlocked: 0, total: 0 });
      expect(classify(r, at + 29 * 24 * HOUR, achievements)).toBe("fresh");
      expect(classify(r, at + 31 * 24 * HOUR, achievements)).toBe("stale");
    });

    it("keeps a completed row fresh for 7 days", () => {
      const r = row(at, { unlocked: 51, total: 51 });
      expect(classify(r, at + 6 * 24 * HOUR, achievements)).toBe("fresh");
      expect(classify(r, at + 8 * 24 * HOUR, achievements)).toBe("stale");
    });

    it("expires a partial row after 24 hours", () => {
      const r = row(at, { unlocked: 26, total: 51 });
      expect(classify(r, at + 23 * HOUR, achievements)).toBe("fresh");
      expect(classify(r, at + 25 * HOUR, achievements)).toBe("stale");
    });

    it("gives the three buckets genuinely different lifetimes", () => {
      // Guards against a refactor that collapses the policy to one TTL:
      // at 10 days only the no-achievements row should still be fresh.
      const now = at + 10 * 24 * HOUR;
      expect(classify(row(at, { unlocked: 0, total: 0 }), now, achievements)).toBe("fresh");
      expect(classify(row(at, { unlocked: 51, total: 51 }), now, achievements)).toBe("stale");
      expect(classify(row(at, { unlocked: 26, total: 51 }), now, achievements)).toBe("stale");
    });
  });
});

describe("countFresh", () => {
  const policy = fixedTtl(60);

  it("counts only fresh rows, ignoring stale and missing", () => {
    const now = 1_000_000;
    const rows = new Map<string, FactRow<number>>([
      ["a", row(now, 1)], // fresh
      ["b", row(now - 10 * 60_000, 1)], // stale
      // "c" missing entirely
    ]);
    expect(countFresh(["a", "b", "c"], rows, now, policy)).toBe(1);
  });

  it("ignores cached rows that are not in the requested universe", () => {
    const now = 1_000_000;
    const rows = new Map<string, FactRow<number>>([
      ["a", row(now, 1)],
      ["ghost", row(now, 1)],
    ]);
    // "ghost" is cached and fresh but no longer in the library.
    expect(countFresh(["a"], rows, now, policy)).toBe(1);
  });

  it("returns 0 for an empty universe", () => {
    expect(countFresh([], new Map(), 1_000, policy)).toBe(0);
  });
});

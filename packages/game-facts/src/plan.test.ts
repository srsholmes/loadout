import { describe, expect, it } from "bun:test";

import { planBatches, planCost } from "./plan";
import { fixedTtl } from "./staleness";
import type { FactRow } from "./types";

const HOUR = 60 * 60 * 1000;
const policy = fixedTtl(24 * 60 * 60);
const NOW = 1_700_000_000_000;

function freshRows(appIds: string[], at = NOW): Map<string, FactRow<number>> {
  return new Map(appIds.map((id) => [id, { at, value: 1 }]));
}

function ids(n: number, prefix = "app"): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

describe("planBatches", () => {
  it("returns an empty plan when everything is fresh", () => {
    const appIds = ids(10);
    const batches = planBatches({
      appIds,
      rows: freshRows(appIds),
      batchSize: 50,
      policy,
      now: NOW,
    });
    expect(batches).toEqual([]);
  });

  it("batches every appId when the cache is cold", () => {
    const batches = planBatches({
      appIds: ids(137),
      rows: new Map(),
      batchSize: 50,
      policy,
      now: NOW,
    });
    // The plan's headline arithmetic: 137 apps at 50/batch is exactly 3.
    expect(batches.length).toBe(3);
    expect(batches[0]!.length).toBe(50);
    expect(batches[1]!.length).toBe(50);
    expect(batches[2]!.length).toBe(37);
    expect(batches.flat().length).toBe(137);
  });

  it("preserves input order so recency-first batching reaches the hero row first", () => {
    // Callers sort by last-played before calling; the planner must not re-sort.
    const appIds = ["recent", "older", "oldest", "ancient"];
    const batches = planBatches({
      appIds,
      rows: new Map(),
      batchSize: 2,
      policy,
      now: NOW,
    });
    expect(batches).toEqual([
      ["recent", "older"],
      ["oldest", "ancient"],
    ]);
  });

  it("skips fresh rows and keeps the survivors in order", () => {
    const appIds = ["a", "b", "c", "d", "e"];
    const batches = planBatches({
      appIds,
      rows: freshRows(["b", "d"]),
      batchSize: 10,
      policy,
      now: NOW,
    });
    expect(batches).toEqual([["a", "c", "e"]]);
  });

  it("re-queues stale rows", () => {
    const appIds = ["fresh", "stale"];
    const rows = new Map<string, FactRow<number>>([
      ["fresh", { at: NOW, value: 1 }],
      ["stale", { at: NOW - 48 * HOUR, value: 1 }],
    ]);
    const batches = planBatches({ appIds, rows, batchSize: 10, policy, now: NOW });
    expect(batches).toEqual([["stale"]]);
  });

  it("resumes a partial sweep without a persisted cursor", () => {
    // Simulate a sweep that committed the first 16 of 40 batches, then died.
    const appIds = ids(2000);
    const done = appIds.slice(0, 16 * 50);
    const batches = planBatches({
      appIds,
      rows: freshRows(done),
      batchSize: 50,
      policy,
      now: NOW,
    });
    expect(batches.length).toBe(40 - 16);
    // It picks up exactly where it left off, in order.
    expect(batches[0]![0]).toBe(appIds[16 * 50]);
  });

  it("re-fetches everything when forced, ignoring freshness", () => {
    const appIds = ids(10);
    const batches = planBatches({
      appIds,
      rows: freshRows(appIds),
      batchSize: 4,
      policy,
      now: NOW,
      force: true,
    });
    expect(batches.flat()).toEqual(appIds);
  });

  it("still respects the current library when forced", () => {
    // A cached row for a game no longer owned must not resurrect into a batch.
    const batches = planBatches({
      appIds: ["a"],
      rows: freshRows(["a", "unowned"]),
      batchSize: 10,
      policy,
      now: NOW,
      force: true,
    });
    expect(batches).toEqual([["a"]]);
  });

  it("collapses duplicate appIds, keeping first position", () => {
    // appStore.allApps can list the same appid twice (owned + family-shared).
    const batches = planBatches({
      appIds: ["a", "b", "a", "c", "b"],
      rows: new Map(),
      batchSize: 10,
      policy,
      now: NOW,
    });
    expect(batches).toEqual([["a", "b", "c"]]);
  });

  it("handles an empty library", () => {
    expect(
      planBatches({ appIds: [], rows: new Map(), batchSize: 50, policy, now: NOW }),
    ).toEqual([]);
  });

  it("emits single-item batches when batchSize is 1", () => {
    const batches = planBatches({
      appIds: ["a", "b"],
      rows: new Map(),
      batchSize: 1,
      policy,
      now: NOW,
    });
    expect(batches).toEqual([["a"], ["b"]]);
  });

  it("rejects a nonsensical batch size rather than looping forever", () => {
    const base = { appIds: ["a"], rows: new Map(), policy, now: NOW };
    expect(() => planBatches({ ...base, batchSize: 0 })).toThrow(/batchSize/);
    expect(() => planBatches({ ...base, batchSize: -5 })).toThrow(/batchSize/);
    expect(() => planBatches({ ...base, batchSize: Infinity })).toThrow(/batchSize/);
  });
});

describe("planCost", () => {
  it("reports the request count the UI shows on the Rescan button", () => {
    expect(
      planCost({
        appIds: ids(2000),
        rows: new Map(),
        batchSize: 50,
        policy,
        now: NOW,
      }),
    ).toBe(40);
  });

  it("is 0 when nothing is due", () => {
    const appIds = ids(5);
    expect(
      planCost({ appIds, rows: freshRows(appIds), batchSize: 50, policy, now: NOW }),
    ).toBe(0);
  });
});

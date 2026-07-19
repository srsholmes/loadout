import { describe, it, expect } from "bun:test";
import type { BacklogEntry } from "./types";
import {
  addToBacklog,
  removeFromBacklog,
  setBacklogStatus,
  cycleBacklogStatus,
  nextStatus,
  reorderBacklog,
  swapBacklogOrder,
  sortBacklog,
  groupBacklog,
  inBacklog,
} from "./backlog";

function entry(over: Partial<BacklogEntry> & Pick<BacklogEntry, "appId">): BacklogEntry {
  return { status: "toPlay", order: 0, addedAt: 0, ...over };
}

describe("nextStatus", () => {
  it("cycles toPlay → playing → beaten → dropped → toPlay", () => {
    expect(nextStatus("toPlay")).toBe("playing");
    expect(nextStatus("playing")).toBe("beaten");
    expect(nextStatus("beaten")).toBe("dropped");
    expect(nextStatus("dropped")).toBe("toPlay");
  });
});

describe("addToBacklog", () => {
  it("appends a new toPlay entry at the end of the order", () => {
    const b0 = addToBacklog([], "1", 100);
    expect(b0).toEqual([{ appId: "1", status: "toPlay", order: 0, addedAt: 100 }]);
    const b1 = addToBacklog(b0, "2", 200);
    expect(b1[1]).toEqual({ appId: "2", status: "toPlay", order: 1, addedAt: 200 });
  });
  it("is a no-op when the game is already present", () => {
    const b0 = addToBacklog([], "1", 100);
    expect(addToBacklog(b0, "1", 999)).toBe(b0);
    expect(inBacklog(b0, "1")).toBe(true);
  });
  it("orders after the current max even with gaps", () => {
    const seeded = [entry({ appId: "a", order: 5 })];
    expect(addToBacklog(seeded, "b", 0)[1]!.order).toBe(6);
  });
});

describe("removeFromBacklog", () => {
  it("drops the matching entry", () => {
    const b = [entry({ appId: "a" }), entry({ appId: "b" })];
    expect(removeFromBacklog(b, "a").map((e) => e.appId)).toEqual(["b"]);
  });
});

describe("status transitions", () => {
  it("setBacklogStatus sets an explicit status", () => {
    const b = [entry({ appId: "a" })];
    expect(setBacklogStatus(b, "a", "beaten")[0]!.status).toBe("beaten");
  });
  it("cycleBacklogStatus advances one step", () => {
    const b = [entry({ appId: "a", status: "playing" })];
    expect(cycleBacklogStatus(b, "a")[0]!.status).toBe("beaten");
  });
  it("leaves other entries untouched", () => {
    const b = [entry({ appId: "a" }), entry({ appId: "b", status: "playing" })];
    expect(setBacklogStatus(b, "a", "dropped")[1]!.status).toBe("playing");
  });
});

describe("reorderBacklog", () => {
  const b = [
    entry({ appId: "a", order: 0 }),
    entry({ appId: "b", order: 1 }),
    entry({ appId: "c", order: 2 }),
  ];

  it("moves a game up by swapping order with its neighbour", () => {
    const out = sortBacklog(reorderBacklog(b, "b", "up"));
    expect(out.map((e) => e.appId)).toEqual(["b", "a", "c"]);
  });
  it("moves a game down", () => {
    const out = sortBacklog(reorderBacklog(b, "b", "down"));
    expect(out.map((e) => e.appId)).toEqual(["a", "c", "b"]);
  });
  it("no-ops at the boundaries", () => {
    expect(reorderBacklog(b, "a", "up")).toBe(b);
    expect(reorderBacklog(b, "c", "down")).toBe(b);
  });
  it("no-ops for an unknown appId", () => {
    expect(reorderBacklog(b, "zzz", "up")).toBe(b);
  });
});

describe("swapBacklogOrder", () => {
  const b = [
    entry({ appId: "a", order: 0 }),
    entry({ appId: "b", order: 5 }),
    entry({ appId: "c", order: 9 }),
  ];
  it("swaps two entries' order regardless of adjacency", () => {
    const out = sortBacklog(swapBacklogOrder(b, "a", "c"));
    expect(out.map((e) => e.appId)).toEqual(["c", "b", "a"]);
  });
  it("no-ops when an appId is missing", () => {
    expect(swapBacklogOrder(b, "a", "zzz")).toBe(b);
  });
});

describe("groupBacklog", () => {
  it("groups by status in display order, omitting empty groups", () => {
    const b = [
      entry({ appId: "a", status: "toPlay", order: 1 }),
      entry({ appId: "b", status: "playing", order: 0 }),
      entry({ appId: "c", status: "toPlay", order: 2 }),
    ];
    const groups = groupBacklog(b);
    expect(groups.map((g) => g.status)).toEqual(["playing", "toPlay"]);
    expect(groups[1]!.entries.map((e) => e.appId)).toEqual(["a", "c"]);
  });
});

import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { EmitPayload } from "@loadout/types";
import type { BacklogEntry, GameTabsData, Tab } from "./lib/types";

// ── In-memory plugin storage ─────────────────────────────────────────
// Backend persists through @loadout/plugin-storage; back it with a plain
// object so tests never touch ~/.config.
let store: Record<string, unknown> = {};
mock.module("@loadout/plugin-storage", () => ({
  readPluginStorage: async (id: string) => store[id] ?? {},
  writePluginStorage: async (id: string, data: unknown) => {
    store[id] = data;
  },
  mutatePluginStorage: async (
    id: string,
    mutate: (c: Record<string, unknown>) => unknown,
  ) => {
    store[id] = mutate((store[id] as Record<string, unknown>) ?? {});
  },
}));

// ── Fake Steam CDP ───────────────────────────────────────────────────
class FakeUnreachable extends Error {}
let executeUrls: string[] = [];
let unreachableTimes = 0; // how many of the next withSteamClient calls throw
mock.module("@loadout/steam-cdp", () => ({
  SteamClientUnreachableError: FakeUnreachable,
  withSteamClient: async (
    fn: (sc: { url: { executeSteamURL: (u: string) => Promise<void> } }) => Promise<unknown>,
  ) => {
    if (unreachableTimes > 0) {
      unreachableTimes--;
      throw new FakeUnreachable("Steam CEF unreachable");
    }
    return fn({
      url: {
        executeSteamURL: async (u: string) => {
          executeUrls.push(u);
        },
      },
    });
  },
}));

// ── Fake vdf gameid derivation ───────────────────────────────────────
mock.module("@loadout/vdf", () => ({
  shortcutGameId64: (n: number) => String((BigInt(n) << 32n) | (1n << 25n)),
}));

async function makeBackend() {
  const mod = await import("./backend");
  return new mod.default();
}

const sampleTab: Tab = {
  id: "roguelikes",
  name: "Roguelikes",
  filters: [{ id: "f", type: "collection", params: { collections: ["Roguelike"], mode: "or" } }],
  filtersMode: "and",
  sort: "alpha",
  autoHide: false,
  position: 1,
  hidden: false,
};

const sampleBacklog: BacklogEntry[] = [
  { appId: "1145360", status: "playing", order: 0, addedAt: 111 },
];

describe("GameTabsBackend", () => {
  beforeEach(() => {
    store = {};
    executeUrls = [];
    unreachableTimes = 0;
  });

  describe("getData", () => {
    it("seeds a default 'All Games' tab on first run", async () => {
      const backend = await makeBackend();
      const data = await backend.getData();
      expect(data.version).toBe(1);
      expect(data.tabs).toHaveLength(1);
      expect(data.tabs[0]!.name).toBe("All Games");
      expect(data.tabs[0]!.filters).toEqual([]);
      expect(data.backlog).toEqual([]);
    });

    it("returns stored data when present", async () => {
      store["game-tabs"] = { version: 1, tabs: [sampleTab], backlog: sampleBacklog };
      const backend = await makeBackend();
      const data = await backend.getData();
      expect(data.tabs).toHaveLength(1);
      expect(data.tabs[0]!.id).toBe("roguelikes");
      expect(data.backlog[0]!.appId).toBe("1145360");
    });
  });

  describe("saveTabs", () => {
    it("persists tabs and preserves the backlog", async () => {
      store["game-tabs"] = { version: 1, tabs: [], backlog: sampleBacklog };
      const backend = await makeBackend();
      const next = await backend.saveTabs([sampleTab]);
      expect(next.tabs[0]!.id).toBe("roguelikes");
      expect(next.backlog).toEqual(sampleBacklog);
      // Persisted, not just returned.
      expect((store["game-tabs"] as GameTabsData).tabs[0]!.id).toBe("roguelikes");
    });

    it("emits dataChanged with the merged data", async () => {
      const backend = await makeBackend();
      const events: EmitPayload[] = [];
      backend.emit = (p) => events.push(p);
      await backend.saveTabs([sampleTab]);
      expect(events).toHaveLength(1);
      expect(events[0]!.event).toBe("dataChanged");
      expect((events[0]!.data as GameTabsData).tabs[0]!.id).toBe("roguelikes");
    });
  });

  describe("saveBacklog", () => {
    it("persists the backlog and preserves tabs", async () => {
      store["game-tabs"] = { version: 1, tabs: [sampleTab], backlog: [] };
      const backend = await makeBackend();
      const next = await backend.saveBacklog(sampleBacklog);
      expect(next.backlog[0]!.appId).toBe("1145360");
      expect(next.tabs[0]!.id).toBe("roguelikes");
    });
  });

  describe("launchGame", () => {
    it("launches a Steam app via steam://rungameid/<appId>", async () => {
      const backend = await makeBackend();
      const res = await backend.launchGame("379720", "steam");
      expect(res.launched).toBe(true);
      expect(executeUrls).toEqual(["steam://rungameid/379720"]);
    });

    it("derives the 64-bit gameid for a non-Steam shortcut", async () => {
      const backend = await makeBackend();
      const res = await backend.launchGame("3735928559", "shortcut");
      const expected = String((BigInt(3735928559) << 32n) | (1n << 25n));
      expect(res.launched).toBe(true);
      expect(executeUrls).toEqual([`steam://rungameid/${expected}`]);
    });

    it("retries once and succeeds after a transient unreachable error", async () => {
      unreachableTimes = 1;
      const backend = await makeBackend();
      const res = await backend.launchGame("379720", "steam");
      expect(res.launched).toBe(true);
      expect(executeUrls).toEqual(["steam://rungameid/379720"]);
    });

    it("reports steam-unreachable when both attempts fail", async () => {
      unreachableTimes = 2;
      const backend = await makeBackend();
      const res = await backend.launchGame("379720", "steam");
      expect(res.launched).toBe(false);
      expect(res.reason).toBe("steam-unreachable");
      expect(executeUrls).toEqual([]);
    });
  });
});

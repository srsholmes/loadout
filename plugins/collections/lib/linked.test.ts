import { describe, expect, it } from "bun:test";
import { linkedCollections, sortLinked } from "./linked";
import type { MirrorLedger } from "./types";

function steam(over: Partial<Parameters<typeof linkedCollections>[0]["steamCollections"][number]> = {}) {
  return {
    id: "uc-1",
    name: "Mine",
    appIds: ["10"],
    isDynamic: false,
    isEditable: true,
    ...over,
  };
}

const noLedger: MirrorLedger = { version: 1, entries: [] };

function ledgerFor(steamCollectionId: string): MirrorLedger {
  return {
    version: 1,
    entries: [
      { managedId: "m", steamCollectionId, steamName: "n", appIds: [], lastSyncedAt: 0 },
    ],
  };
}

describe("linkedCollections", () => {
  it("keeps a collection the user made by hand", () => {
    const out = linkedCollections({ steamCollections: [steam()], ledger: noLedger });
    expect(out.map((c) => c.id)).toEqual(["uc-1"]);
  });

  it("keeps EmuDeck's ROM collections", () => {
    // The reason this module exists: `srm-*` sets are the bulk of a real
    // handheld library, and the plugin was blind to them.
    const out = linkedCollections({
      steamCollections: [steam({ id: "srm-U2VnYQ==", name: "Sega Genesis", appIds: ["1", "2"] })],
      ledger: noLedger,
    });
    expect(out[0]!.name).toBe("Sega Genesis");
  });

  it("excludes Steam's own library filters", () => {
    // `uncategorized`, `favorite`, `local-install` and the `type-*` sets are
    // filters Steam already surfaces and recomputes. Showing them would put a
    // second "Installed" beside Steam's and imply we could edit it.
    const out = linkedCollections({
      steamCollections: [
        steam({ id: "uncategorized", name: "Uncategorized", isEditable: false }),
        steam({ id: "local-install", name: "Locally Installed", isEditable: false }),
        steam({ id: "type-music", name: "Soundtracks", isEditable: false }),
        steam(),
      ],
      ledger: noLedger,
    });
    expect(out.map((c) => c.id)).toEqual(["uc-1"]);
  });

  it("excludes a collection this plugin created", () => {
    // It is already on the grid as a managed collection. Two cards for one
    // thing would disagree the moment its rules matched something new.
    const out = linkedCollections({
      steamCollections: [steam({ id: "uc-ours" }), steam({ id: "uc-theirs" })],
      ledger: ledgerFor("uc-ours"),
    });
    expect(out.map((c) => c.id)).toEqual(["uc-theirs"]);
  });

  it("keeps a dynamic collection, but flags it", () => {
    // It is the user's own and shows in Steam's sidebar, so hiding it would
    // misrepresent the library — but Steam recomputes its contents, so the UI
    // must not offer an edit that Steam will silently undo.
    const out = linkedCollections({
      steamCollections: [steam({ isDynamic: true })],
      ledger: noLedger,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.isDynamic).toBe(true);
  });

  it("copies the app list rather than aliasing Steam's", () => {
    const source = steam({ appIds: ["1"] });
    const out = linkedCollections({ steamCollections: [source], ledger: noLedger });
    out[0]!.appIds.push("2");
    expect(source.appIds).toEqual(["1"]);
  });
});

describe("sortLinked", () => {
  it("puts the fullest collections first", () => {
    // Alphabetical buries the collections you actually use behind a one-game
    // experiment.
    const out = sortLinked([
      { id: "a", name: "Small", appIds: ["1"], isDynamic: false, isEditable: true },
      { id: "b", name: "Big", appIds: ["1", "2", "3"], isDynamic: false, isEditable: true },
    ]);
    expect(out.map((c) => c.name)).toEqual(["Big", "Small"]);
  });

  it("breaks ties by name, so the order doesn't shuffle between reads", () => {
    const out = sortLinked([
      { id: "b", name: "Zed", appIds: ["1"], isDynamic: false, isEditable: true },
      { id: "a", name: "Alpha", appIds: ["1"], isDynamic: false, isEditable: true },
    ]);
    expect(out.map((c) => c.name)).toEqual(["Alpha", "Zed"]);
  });
});

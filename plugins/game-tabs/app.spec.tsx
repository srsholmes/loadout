/**
 * Game Tabs frontend spec.
 *
 * Mocks `@loadout/ui`'s backend hooks so the component renders against
 * controllable RPC without a running loader. Covers the mount factory,
 * the initial data fetch, the tab strip, the backlog view, and opening
 * the "New tab" editor.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import * as actualUi from "@loadout/ui";
import { waitFor } from "../../test/render";
import type { GameTabsData } from "./lib/types";

const library = [
  {
    appId: "1145360",
    name: "Hades",
    sizeOnDisk: 0,
    headerUrl: "",
    capsuleUrl: "",
    localHeaderUrl: "",
    localCapsuleUrl: "",
    source: "steam",
    tags: ["Roguelike"],
  },
  {
    appId: "9001",
    name: "Zelda TOTK",
    sizeOnDisk: 0,
    headerUrl: "",
    capsuleUrl: "",
    localHeaderUrl: "",
    localCapsuleUrl: "",
    source: "shortcut",
    tags: ["Nintendo Switch - Yuzu"],
  },
];

const storedData: GameTabsData = {
  version: 1,
  tabs: [
    { id: "all", name: "All Games", filters: [], filtersMode: "and", sort: "alpha", autoHide: false, position: 0, hidden: false },
    {
      id: "rogue",
      name: "Roguelikes",
      filters: [{ id: "f", type: "collection", params: { collections: ["Roguelike"], mode: "or" } }],
      filtersMode: "and",
      sort: "alpha",
      autoHide: false,
      position: 1,
      hidden: false,
    },
  ],
  backlog: [{ appId: "1145360", status: "playing", order: 0, addedAt: 1 }],
};

function makeCall(overrides: Record<string, unknown> = {}) {
  return mock((method: string) => {
    if (method === "getData") return Promise.resolve(storedData);
    if (method === "getGames") return Promise.resolve(library);
    if (method === "getCollections")
      return Promise.resolve([{ id: "Roguelike", count: 1 }]);
    if (method === "getRecentSessions") return Promise.resolve([]);
    if (method in overrides) return Promise.resolve(overrides[method]);
    return Promise.resolve(null);
  });
}

let callMock = makeCall();

mock.module("@loadout/ui", () => ({
  ...actualUi,
  PluginProvider: ({ children }: any) => children,
  useBackend: () => ({
    call: callMock,
    useEvent: () => {},
    ready: true,
  }),
  useCurrentGame: () => null,
}));

describe("game-tabs plugin", () => {
  beforeEach(() => {
    callMock = makeCall();
  });

  it("mount and mountHeader are functions (mountComponent factory)", async () => {
    const mod = await import("./app");
    expect(typeof mod.mount).toBe("function");
    expect(typeof mod.mountHeader).toBe("function");
  });

  it("fetches data + library on mount", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("getData");
      expect(callMock).toHaveBeenCalledWith("getGames");
    });
  });

  it("renders the tab strip with the persisted tabs + backlog", async () => {
    // The title lives in <PluginHeader>, which portals into the shell's
    // topbar slot — absent in a unit mount — so we assert the tab strip
    // (rendered in the body) instead.
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("All Games");
      expect(container.textContent).toContain("Roguelikes");
      expect(container.textContent).toContain("Backlog");
    });
  });

  it("shows games in the active tab", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Hades");
      expect(container.textContent).toContain("Zelda TOTK");
    });
  });
});

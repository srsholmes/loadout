import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as actualUi from "@loadout/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const calls: Array<{ method: string; args: unknown[] }> = [];
let summaries: unknown[] = [];
let steamReachable = true;
let games: string[] = [];
let managedCollections: unknown[] = [];

/** A managed collection with every field the rule builder reads. */
function fullCollection(id: string, label: string) {
  return {
    id,
    label,
    root: { kind: "group", id: `${id}-root`, combinator: "all", children: [] },
    sort: [],
    limit: null,
    display: { tileWidth: 150, showLabels: true, badges: [] },
    indeterminatePolicy: "pass",
  };
}

const callMock = mock((method: string, ...args: unknown[]) => {
  calls.push({ method, args });
  switch (method) {
    case "listAll":
      return Promise.resolve({ collections: summaries, steamReachable });
    case "getSnapshot":
      return Promise.resolve({ games: [], providers: {}, generatedAt: 0 });
    case "getConfig":
      return Promise.resolve({ config: { collections: managedCollections }, warnings: [], readOnly: false });
    case "createCollection":
      return Promise.resolve({
        collections: [...managedCollections, fullCollection("made", "New collection")],
      });
    case "syncMirror":
      return Promise.resolve({
        created: 0, updated: 1, renamed: 0, deleted: 0, failures: [],
        changes: [
          { label: "Backlog", kind: "updated", added: [], removed: ["Portal 2"], addedCount: 0, removedCount: 1 },
        ],
      });
    case "setCollections":
      return Promise.resolve({ collections: managedCollections });
    case "listGames":
      return Promise.resolve({ games: games.map((appId) => ({ appId, name: `Game ${appId}` })), kind: "linked" });
    default:
      return Promise.resolve(null);
  }
});

mock.module("@loadout/ui", () => ({
  ...actualUi,
  useBackend: () => ({ call: callMock, useEvent: () => {}, ready: true }),
}));

const { Collections } = await import("./app");

/**
 * Render with a real header slot.
 *
 * `PluginHeader` portals into the shell's topbar and renders nothing when no
 * slot is wired, so without this every header control — search, New, Edit
 * rules — is invisible to the tests. `PluginHeaderSlotProvider` is the same
 * seam `PluginProvider` uses.
 */
function renderApp() {
  const slot = document.createElement("div");
  document.body.appendChild(slot);
  const view = render(
    <actualUi.PluginHeaderSlotProvider slot={slot}>
      <Collections />
    </actualUi.PluginHeaderSlotProvider>,
    { container },
  );
  return { ...view, unmount: () => { view.unmount(); slot.remove(); } };
}

function summary(over: Record<string, unknown> = {}) {
  return {
    id: "srm-1",
    label: "Sega Genesis",
    count: 713,
    previewAppIds: ["1", "2"],
    kind: "linked",
    autoMaintained: false,
    ...over,
  };
}

let container: HTMLElement;
let unmount: () => void;

beforeEach(() => {
  calls.length = 0;
  summaries = [];
  steamReachable = true;
  games = [];
  managedCollections = [];
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  unmount?.();
  container.remove();
});

describe("the collections grid", () => {
  it("lists collections that already exist in Steam", async () => {
    // The whole reason this rework happened: EmuDeck's ROM sets were invisible
    // to the plugin, so it could not honestly claim to manage collections.
    summaries = [summary(), summary({ id: "srm-2", label: "Nintendo 64", count: 316 })];
    ({ unmount } = renderApp());

    await waitFor(() => expect(screen.getByText("Sega Genesis")).toBeTruthy());
    expect(screen.getByText("Nintendo 64")).toBeTruthy();
    expect(screen.getByText("713")).toBeTruthy();
  });

  it("says which collections maintain themselves", async () => {
    // A managed collection can drop a game the moment its rules stop matching.
    // That is correct, and only jarring when it is a surprise — so the card
    // says so before you open it.
    summaries = [summary({ kind: "managed", autoMaintained: true, label: "Backlog" })];
    ({ unmount } = renderApp());
    await waitFor(() => expect(screen.getByText("Rules · updates itself")).toBeTruthy());
  });

  it("explains a short list when Steam is unreachable", async () => {
    // Otherwise the user sees their EmuDeck collections missing and assumes
    // the plugin lost them.
    steamReachable = false;
    summaries = [summary({ kind: "managed", label: "Backlog" })];
    ({ unmount } = renderApp());
    await waitFor(() => expect(screen.getByText(/Steam isn't reachable/)).toBeTruthy());
  });

  it("offers a starting point when there is nothing at all", async () => {
    ({ unmount } = renderApp());
    await waitFor(() => expect(screen.getByText(/No collections yet/)).toBeTruthy());
  });

  // Search filtering is not covered here: `PluginHeader` portals into the
  // shell's header slot, which does not exist under test, so the search box
  // never renders. Faking the slot would test the fake.
});

describe("opening a collection", () => {
  it("asks the backend for its games", async () => {
    // Membership for a linked collection only exists in Steam, so the UI must
    // not try to compute it.
    summaries = [summary()];
    games = ["10", "20"];
    ({ unmount } = renderApp());
    await waitFor(() => expect(screen.getByText("Sega Genesis")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Sega Genesis/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "listGames")).toBe(true));
    expect(calls.find((c) => c.method === "listGames")!.args).toEqual(["srm-1"]);
  });

  it("shows an empty collection as empty rather than as an error", async () => {
    // A new collection starts here, and seeing it empty is the preview working.
    summaries = [summary({ count: 0, previewAppIds: [] })];
    games = [];
    ({ unmount } = renderApp());
    await waitFor(() => expect(screen.getByText("Sega Genesis")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Sega Genesis/ }));
    await waitFor(() => expect(screen.getByText(/Nothing in this collection yet/)).toBeTruthy());
  });
});

describe("editing a collection's rules", () => {
  /** A managed collection with the shape the rule builder needs. */
  const managed = fullCollection;

  it("offers Edit rules on a managed collection", async () => {
    managedCollections = [managed("backlog", "Backlog")];
    summaries = [summary({ id: "backlog", label: "Backlog", kind: "managed", autoMaintained: true })];
    ({ unmount } = renderApp());

    await waitFor(() => expect(screen.getByText("Backlog")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Backlog/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit rules" })).toBeTruthy());
  });

  it("does not offer it on a collection that came from Steam", async () => {
    // A linked collection has no rules. Offering the builder would imply we
    // could take over a set EmuDeck curated.
    summaries = [summary()];
    ({ unmount } = renderApp());

    await waitFor(() => expect(screen.getByText("Sega Genesis")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Sega Genesis/ }));
    await waitFor(() => expect(screen.getByText(/Nothing in this collection/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Edit rules" })).toBeNull();
  });

  it("opens the builder straight after creating one", async () => {
    // A new collection matches the whole library, so leaving the user on the
    // grid in front of a 4000-game card is the wrong place to stop.
    ({ unmount } = renderApp());
    await waitFor(() => expect(screen.getByText(/No collections yet/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "New" }));
    await waitFor(() => expect(calls.some((c) => c.method === "createCollection")).toBe(true));
    // And lands in the builder rather than back on the grid.
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeTruthy());
  });
});

describe("sync reporting", () => {
  it("names what left a collection, on the page rather than in a toast", async () => {
    // A rules-driven collection dropping a game is correct; finding out by
    // accident is what makes it feel arbitrary. A toast is gone before you
    // have read it.
    summaries = [summary({ kind: "managed", label: "Backlog", autoMaintained: true })];
    ({ unmount } = renderApp());
    await waitFor(() => expect(screen.getByText("Backlog")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Sync with Steam" }));
    await waitFor(() => expect(screen.getByText(/Backlog — 1 removed \(Portal 2\)/)).toBeTruthy());
  });
});

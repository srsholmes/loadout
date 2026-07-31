import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as actualUi from "@loadout/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LIBRARY } from "./test/fixtures/library";
import { defaultConfig, validateConfig } from "./lib/config";

const calls: Array<{ method: string; args: unknown[] }> = [];
let mirrorState = { autoSync: false, pendingSync: false };
/**
 * Hold `listGames` open, the way a 713-entry collection does.
 *
 * A latch rather than a timer: the assertion is about what is on screen *while*
 * the read is in flight, and a timing race would make that flaky under load.
 */
let releaseListGames: (() => void) | null = null;
let holdListGames = false;
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
      // A real library, not an empty one: the preset gallery greys out any
      // preset whose data source is missing, so with no games every preset
      // would be unpickable.
      return Promise.resolve({ games: LIBRARY, providers: {}, generatedAt: 0 });
    case "getConfig":
      // A *whole* config, built from the real default. It used to be
      // `{collections, mirror}` alone — a shape the real `setConfig` rejects
      // outright ("settings are missing", "collectionOrder must be a list of
      // ids"), so the autoSync toggle's round trip was being tested against
      // something that could never have worked on a device. `mirror` in
      // particular is read in the same load as the library snapshot, and
      // without it that load throws and the library never arrives.
      return Promise.resolve({
        config: {
          ...defaultConfig(),
          collections: managedCollections,
          mirror: { ...defaultConfig().mirror, ...mirrorState },
        },
        warnings: [],
        readOnly: false,
      });
    case "createCollection":
      return Promise.resolve({
        collections: [
          ...managedCollections,
          fullCollection("made", String((args as string[])[0] ?? "New collection")),
        ],
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
    case "listGames": {
      const answer = {
        games: games.map((appId) => ({ appId, name: `Game ${appId}` })),
        kind: "linked",
        staleAppIds: [],
      };
      // A real one is a Steam round trip; a 713-entry collection takes seconds.
      if (!holdListGames) return Promise.resolve(answer);
      return new Promise((resolve) => {
        releaseListGames = () => resolve(answer);
      });
    }
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
  mirrorState = { autoSync: false, pendingSync: false };
  releaseListGames = null;
  holdListGames = false;
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

  it("locks the gallery while a preset is being built", async () => {
    // Creating one takes a beat, and a press that shows no sign of having
    // registered gets pressed again — which is how five identical collections
    // got made.
    ({ unmount } = renderApp());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "New collection" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "New collection" }));
    await waitFor(() => expect(screen.getByText("Or start from a preset")).toBeTruthy());

    const row = screen.getByRole("button", { name: /Never played/ });
    fireEvent.click(row);
    expect(row.hasAttribute("disabled")).toBe(true);
    expect(row.textContent).toMatch(/Building it/);

    fireEvent.click(row);
    fireEvent.click(row);
    expect(calls.filter((c) => c.method === "createCollection")).toHaveLength(1);
  });

  it("builds a collection from a preset without a word being typed", async () => {
    // Typing on a handheld means the on-screen keyboard and a thumbstick. A
    // preset arrives named and ruled, so the whole flow is two presses.
    ({ unmount } = renderApp());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "New collection" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "New collection" }));

    await waitFor(() => expect(screen.getByText("Or start from a preset")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Never played/ }));

    await waitFor(() => expect(calls.some((c) => c.method === "createCollection")).toBe(true));
    expect(calls.find((c) => c.method === "createCollection")!.args).toEqual(["Never played"]);

    // And the rules land with it — a preset that created an empty collection
    // would just be a slower way of pressing New.
    await waitFor(() => expect(calls.some((c) => c.method === "setCollections")).toBe(true));
    const saved = calls.find((c) => c.method === "setCollections")!.args[0] as Array<{
      label: string;
      root: { children: unknown[] };
    }>;
    const made = saved.find((c) => c.label === "Never played")!;
    expect(made.root.children.length).toBeGreaterThan(0);
  });

  it("posts a config the backend would actually accept when toggling sync", async () => {
    // The UI round-trips the whole config through `setConfig` to flip one
    // flag. If it drops a field on the way, the real backend throws and the
    // setting silently never takes — invisible against a fake that accepts
    // any shape.
    ({ unmount } = renderApp());
    await waitFor(() => expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Sync now" })).toBeTruthy());

    fireEvent.click(document.querySelector('input[type="checkbox"]')!);
    await waitFor(() => expect(calls.some((c) => c.method === "setConfig")).toBe(true));

    const posted = calls.find((c) => c.method === "setConfig")!.args[0];
    expect(validateConfig(posted)).toEqual([]);
    expect((posted as { mirror: { autoSync: boolean } }).mirror.autoSync).toBe(true);
  });

  it("syncs on the way out, not while you work", async () => {
    // Nothing is waiting on the backend once the plugin is gone, which is the
    // entire reason the sync happens here.
    mirrorState = { autoSync: true, pendingSync: true };
    ({ unmount } = renderApp());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "New collection" })).toBeTruthy(),
    );
    expect(calls.some((c) => c.method === "syncMirror")).toBe(false);

    unmount();
    unmount = () => {};
    expect(calls.some((c) => c.method === "syncMirror")).toBe(true);
  });

  it("opens a managed collection's rules from the cog", async () => {
    // One screen, not two: Options and Edit rules were separate pages that
    // both edited the same collection.
    managedCollections = [managed("backlog", "Backlog")];
    summaries = [summary({ id: "backlog", label: "Backlog", kind: "managed", autoMaintained: true })];
    ({ unmount } = renderApp());

    await waitFor(() => expect(screen.getByText("Backlog")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Backlog/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Options" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Options" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeTruthy());
    // Name and delete live on it too, so there is one place to change anything
    // about this collection.
    expect(screen.getByRole("button", { name: "Delete this collection" })).toBeTruthy();
  });

  it("sends a Steam collection to the shorter page, which has no rules", async () => {
    // A linked collection has no rules. Offering the builder would imply we
    // could take over a set EmuDeck curated.
    summaries = [summary()];
    ({ unmount } = renderApp());

    await waitFor(() => expect(screen.getByText("Sega Genesis")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Sega Genesis/ }));
    await waitFor(() => expect(screen.getByText(/Nothing in this collection/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Options" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Rename" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("won't offer adding until it knows what is already in the collection", async () => {
    // Adding against a list that hadn't arrived wrote only what was picked, so
    // a 713-entry ROM collection came back holding one game.
    summaries = [summary()];
    holdListGames = true;
    ({ unmount } = renderApp());
    await waitFor(() => expect(screen.getByText("Sega Genesis")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Sega Genesis/ }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Options" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Add games" })).toBeNull();

    // Once the membership is known, the + is offered.
    releaseListGames?.();
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Add games" }).length).toBeGreaterThan(0),
    );
  });

  it("adds games to a Steam collection, writing the whole list once", async () => {
    // Removing has worked from the detail grid for a while; without this an
    // accidental Remove was permanent as far as this plugin was concerned.
    summaries = [summary()];
    ({ unmount } = renderApp());
    await waitFor(() => expect(screen.getByText("Sega Genesis")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Sega Genesis/ }));
    // Two of them on an empty collection: the header's + and the one in the
    // body, where the page is otherwise blank.
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Add games" }).length).toBe(2),
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Add games" })[0]!);
    // The picker lists the whole library up front rather than asking for a
    // search first.
    await waitFor(() => expect(screen.getByText(LIBRARY[0]!.name)).toBeTruthy());
    fireEvent.click(screen.getByText(LIBRARY[0]!.name));
    fireEvent.click(screen.getByRole("button", { name: "Add 1 game" }));

    await waitFor(() => expect(calls.some((c) => c.method === "editLinked")).toBe(true));
    const [id, delta] = calls.find((c) => c.method === "editLinked")!.args as [
      string,
      { add?: string[] },
    ];
    expect(id).toBe("srm-1");
    // A delta. Writing the whole membership from the UI's list truncated the
    // collection to whatever it happened to be showing.
    expect(delta.add).toEqual([LIBRARY[0]!.appId]);
  });

  it("does not offer hand-editing on a collection Steam maintains", async () => {
    // Steam recomputes a dynamic collection, so anything written to it is
    // undone without a word.
    summaries = [summary({ autoMaintained: true })];
    ({ unmount } = renderApp());
    await waitFor(() => expect(screen.getByText("Sega Genesis")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Sega Genesis/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Options" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Add games" })).toBeNull();
  });

  it("drops the card and lands on the grid before Steam has answered", async () => {
    // Re-reading the grid is a full library evaluation plus a Steam round
    // trip. A collection that lingers for that long after you confirmed its
    // deletion reads as a delete that did not take.
    summaries = [summary(), summary({ id: "srm-2", label: "Nintendo 64" })];
    ({ unmount } = renderApp());
    await waitFor(() => expect(screen.getByText("Sega Genesis")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Sega Genesis/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove collection" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Remove collection" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove collection" }));

    await waitFor(() => expect(screen.queryByText("Sega Genesis")).toBeNull());
    // Back on the grid, with everything else still there.
    expect(screen.getByText("Nintendo 64")).toBeTruthy();
  });

  it("deletes even when the grid rows haven't arrived", async () => {
    // It used to look the collection up in the loaded summaries and do nothing
    // at all when it couldn't find one — a confirmed delete as a silent no-op,
    // which is the worst possible answer to "did that work?".
    managedCollections = [managed("backlog", "Backlog")];
    summaries = [summary({ id: "backlog", label: "Backlog", kind: "managed" })];
    ({ unmount } = renderApp());
    await waitFor(() => expect(screen.getByText("Backlog")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Backlog/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Options" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Options" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Delete this collection" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete this collection" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(calls.some((c) => c.method === "deleteCollection")).toBe(true));
    expect(calls.find((c) => c.method === "deleteCollection")!.args).toEqual(["backlog"]);
  });

  it("removes a collection from the detail header, but only on the second press", async () => {
    summaries = [summary()];
    ({ unmount } = renderApp());

    await waitFor(() => expect(screen.getByText("Sega Genesis")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Sega Genesis/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove collection" })).toBeTruthy());

    // The bin spells out what it would do rather than doing it: an icon cannot
    // name the collection it is about to destroy.
    fireEvent.click(screen.getByRole("button", { name: "Remove collection" }));
    expect(calls.some((c) => c.method === "deleteLinked")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Remove collection" }));
    await waitFor(() => expect(calls.some((c) => c.method === "deleteLinked")).toBe(true));
  });

  it("opens the builder straight after creating one", async () => {
    // A new collection matches the whole library, so leaving the user on the
    // grid in front of a 4000-game card is the wrong place to stop.
    ({ unmount } = renderApp());
    await waitFor(() => expect(screen.getByText(/No collections yet/)).toBeTruthy());

    // New names the collection first — the name is what Steam shows, so it is
    // the one decision worth taking before the rules.
    fireEvent.click(screen.getByRole("button", { name: "New collection" }));
    await waitFor(() => expect(screen.getByText("Name your own")).toBeTruthy());

    fireEvent.change(document.querySelector('input[placeholder^="e.g."]')!, {
      target: { value: "Backlog" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(calls.some((c) => c.method === "createCollection")).toBe(true));
    expect(calls.find((c) => c.method === "createCollection")!.args).toEqual(["Backlog"]);
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

    // The gear opens Settings now. It used to run a sync directly, so pressing
    // a settings icon usually just produced "Already up to date".
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Sync now" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(screen.getByText(/Backlog — 1 removed \(Portal 2\)/)).toBeTruthy());
  });
});

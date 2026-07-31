import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as actualUi from "@loadout/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const calls: Array<{ method: string; args: unknown[] }> = [];
let summaries: unknown[] = [];
let steamReachable = true;
let games: string[] = [];

const callMock = mock((method: string, ...args: unknown[]) => {
  calls.push({ method, args });
  switch (method) {
    case "listAll":
      return Promise.resolve({ collections: summaries, steamReachable });
    case "listGames":
      return Promise.resolve({ appIds: games, kind: "linked" });
    default:
      return Promise.resolve(null);
  }
});

mock.module("@loadout/ui", () => ({
  ...actualUi,
  useBackend: () => ({ call: callMock, useEvent: () => {}, ready: true }),
}));

const { Collections } = await import("./app");

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
    ({ unmount } = render(<Collections />, { container }));

    await waitFor(() => expect(screen.getByText("Sega Genesis")).toBeTruthy());
    expect(screen.getByText("Nintendo 64")).toBeTruthy();
    expect(screen.getByText("713")).toBeTruthy();
  });

  it("says which collections maintain themselves", async () => {
    // A managed collection can drop a game the moment its rules stop matching.
    // That is correct, and only jarring when it is a surprise — so the card
    // says so before you open it.
    summaries = [summary({ kind: "managed", autoMaintained: true, label: "Backlog" })];
    ({ unmount } = render(<Collections />, { container }));
    await waitFor(() => expect(screen.getByText("Rules · updates itself")).toBeTruthy());
  });

  it("explains a short list when Steam is unreachable", async () => {
    // Otherwise the user sees their EmuDeck collections missing and assumes
    // the plugin lost them.
    steamReachable = false;
    summaries = [summary({ kind: "managed", label: "Backlog" })];
    ({ unmount } = render(<Collections />, { container }));
    await waitFor(() => expect(screen.getByText(/Steam isn't reachable/)).toBeTruthy());
  });

  it("offers a starting point when there is nothing at all", async () => {
    ({ unmount } = render(<Collections />, { container }));
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
    ({ unmount } = render(<Collections />, { container }));
    await waitFor(() => expect(screen.getByText("Sega Genesis")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Sega Genesis/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "listGames")).toBe(true));
    expect(calls.find((c) => c.method === "listGames")!.args).toEqual(["srm-1"]);
  });

  it("shows an empty collection as empty rather than as an error", async () => {
    // A new collection starts here, and seeing it empty is the preview working.
    summaries = [summary({ count: 0, previewAppIds: [] })];
    games = [];
    ({ unmount } = render(<Collections />, { container }));
    await waitFor(() => expect(screen.getByText("Sega Genesis")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Sega Genesis/ }));
    await waitFor(() => expect(screen.getByText(/Nothing in this collection yet/)).toBeTruthy());
  });
});

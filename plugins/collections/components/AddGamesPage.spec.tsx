import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { PluginHeaderSlotProvider } from "@loadout/ui";
import { AddGamesPage } from "./AddGamesPage";

const LIBRARY = [
  { appId: "1", name: "Portal 2", installed: true },
  { appId: "2", name: "Celeste", installed: false },
  { appId: "3", name: "Hades", installed: false },
  { appId: "4", name: "Portal", installed: true },
];

function renderPage(props: Partial<Parameters<typeof AddGamesPage>[0]> = {}) {
  const handlers = { onBack: mock(() => {}), onAdd: mock((_: string[]) => {}) };
  const slot = document.createElement("div");
  document.body.appendChild(slot);
  render(
    <PluginHeaderSlotProvider slot={slot}>
      <AddGamesPage label="Emulation" candidates={LIBRARY} {...handlers} {...props} />
    </PluginHeaderSlotProvider>,
  );
  // Every tile carries an "Add" button of its own, so the confirm one has to
  // be looked for in the header rather than by name alone.
  return { ...handlers, header: within(slot) };
}

const filter = (text: string) =>
  fireEvent.change(document.querySelector<HTMLInputElement>('input[placeholder^="Filter"]')!, {
    target: { value: text },
  });

/** Tile titles in render order. */
const titles = () =>
  [...document.querySelectorAll("[data-testid='game-card-title'], .truncate")]
    .map((el) => el.textContent?.trim())
    .filter((t): t is string => Boolean(t));

describe("browsing the library", () => {
  it("shows everything up front, without being searched first", () => {
    // A search box you have to type into only works if you already know what
    // you are looking for, and browsing is most of what adding to a collection
    // is.
    renderPage();
    for (const game of LIBRARY) expect(screen.getByText(game.name)).toBeTruthy();
  });

  it("orders them alphabetically", () => {
    renderPage();
    const shown = titles().filter((t) => LIBRARY.some((g) => g.name === t));
    expect(shown).toEqual(["Celeste", "Hades", "Portal", "Portal 2"]);
  });

  it("says how many there are to add", () => {
    renderPage();
    expect(screen.getByText("4 of 4 games not in it yet")).toBeTruthy();
  });

  it("marks what is installed, rather than hiding where a game lives", () => {
    renderPage();
    expect(screen.getAllByText("Installed").length).toBe(2);
  });

  it("won't claim the library is exhausted before it has been read", () => {
    // The empty list and the unread library look identical from here, and
    // "every game in your library is already in this collection" is a
    // confident statement of fact about somebody's library. `getSnapshot`
    // never rejects — both its sources degrade to empty — so the unread case
    // arrives as an ordinary empty candidate list and needs saying apart.
    renderPage({ candidates: [], libraryLoaded: false });
    expect(screen.queryByText(/already in this collection/)).toBeNull();
    expect(screen.getByText(/Reading your library/)).toBeTruthy();
  });

  it("says when there is nothing left to add", () => {
    renderPage({ candidates: [] });
    expect(screen.getByText(/already in this collection/)).toBeTruthy();
  });
});

describe("the filter", () => {
  it("narrows what is shown, case-insensitively", () => {
    renderPage();
    filter("port");
    expect(screen.getByText("Portal 2")).toBeTruthy();
    expect(screen.queryByText("Hades")).toBeNull();
  });

  it("counts what it narrowed to", () => {
    renderPage();
    filter("port");
    expect(screen.getByText("2 of 4 games not in it yet")).toBeTruthy();
  });

  it("says so when nothing matches, and why that might be", () => {
    renderPage();
    filter("zzz");
    expect(screen.getByText(/already be in this collection/)).toBeTruthy();
  });
});

describe("picking games", () => {
  const pick = (name: string) => fireEvent.click(screen.getByText(name));

  it("won't write an empty selection", () => {
    const { header } = renderPage();
    expect(header.getByRole("button", { name: "Add" }).hasAttribute("disabled")).toBe(true);
  });

  it("adds several on one write", () => {
    // Each confirm is a Steam Cloud round trip; one per game turns adding five
    // into five chances to fail halfway.
    const h = renderPage();
    pick("Hades");
    pick("Celeste");
    fireEvent.click(h.header.getByRole("button", { name: "Add 2 games" }));
    expect(h.onAdd).toHaveBeenCalledWith(["3", "2"]);
  });

  it("keeps a pick through a filter change", () => {
    // Otherwise narrowing the list to find the second game quietly drops the
    // first, and you only find out after the write.
    const h = renderPage();
    pick("Hades");
    filter("celeste");
    pick("Celeste");
    fireEvent.click(h.header.getByRole("button", { name: "Add 2 games" }));
    expect(h.onAdd).toHaveBeenCalledWith(["3", "2"]);
  });

  it("toggles rather than adding the same game twice", () => {
    const { header } = renderPage();
    pick("Hades");
    expect(header.getByRole("button", { name: "Add 1 game" })).toBeTruthy();
    pick("Hades");
    expect(header.getByRole("button", { name: "Add" }).hasAttribute("disabled")).toBe(true);
  });

  it("counts what is picked against what is shown", () => {
    renderPage();
    pick("Hades");
    expect(screen.getByText("1 picked · 4 shown")).toBeTruthy();
  });

  it("leaves without writing", () => {
    const h = renderPage();
    pick("Hades");
    fireEvent.click(h.header.getByRole("button", { name: "Cancel" }));
    expect(h.onBack).toHaveBeenCalledTimes(1);
    expect(h.onAdd).not.toHaveBeenCalled();
  });
});

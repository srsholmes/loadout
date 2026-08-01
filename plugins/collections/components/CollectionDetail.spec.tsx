import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { PluginHeaderSlotProvider } from "@loadout/ui";
import { CollectionDetail } from "./CollectionDetail";

const GAMES = [
  { appId: "1", name: "Portal 2" },
  { appId: "2", name: "Celeste" },
  { appId: "3", name: "Hades" },
];

function renderDetail(props: Partial<Parameters<typeof CollectionDetail>[0]> = {}) {
  const handlers = {
    onBack: mock(() => {}),
    onPickGame: mock((_: string) => {}),
    onOptions: mock(() => {}),
    onDelete: mock(() => {}),
    onRemoveGames: mock((_: string[]) => {}),
  };
  const slot = document.createElement("div");
  document.body.appendChild(slot);
  render(
    <PluginHeaderSlotProvider slot={slot}>
      <CollectionDetail label="Emulation" games={GAMES} {...handlers} {...props} />
    </PluginHeaderSlotProvider>,
  );
  return { ...handlers, header: within(slot) };
}

const filter = (text: string) =>
  fireEvent.change(document.querySelector<HTMLInputElement>('input[placeholder^="Filter"]')!, {
    target: { value: text },
  });

describe("browsing a collection", () => {
  it("opens a game rather than launching it", () => {
    const h = renderDetail();
    fireEvent.click(screen.getByText("Hades"));
    expect(h.onPickGame).toHaveBeenCalledWith("3");
  });

  it("puts no destructive control on the tiles", () => {
    // A Remove button on every tile is a destructive control under the thumb
    // on a grid you scroll with a thumbstick.
    renderDetail();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });

  it("filters, because a ROM collection here runs to 700+ entries", () => {
    renderDetail();
    filter("ce");
    expect(screen.getByText("Celeste")).toBeTruthy();
    expect(screen.queryByText("Hades")).toBeNull();
  });

  it("says how much the filter narrowed it to", () => {
    renderDetail();
    filter("ce");
    expect(screen.getByText("1 of 3 games")).toBeTruthy();
  });

  it("says so when the filter matches nothing", () => {
    renderDetail();
    filter("zzz");
    expect(screen.getByText(/No game in this collection matches/)).toBeTruthy();
  });

  it("offers no editing on a collection Steam maintains", () => {
    renderDetail({ onRemoveGames: undefined });
    expect(screen.queryByRole("button", { name: "Edit collection" })).toBeNull();
  });
});

describe("removing games", () => {
  const enterEditMode = () => fireEvent.click(screen.getByRole("button", { name: "Edit collection" }));

  it("picks with the tile, the same gesture as adding", () => {
    const h = renderDetail();
    enterEditMode();
    fireEvent.click(screen.getByText("Hades"));
    expect(h.onPickGame).not.toHaveBeenCalled();
    expect(h.header.getByRole("button", { name: "Remove 1 from collection" })).toBeTruthy();
  });

  it("removes several on one write", () => {
    // One write, not one per game: each is a Steam Cloud round trip.
    const h = renderDetail();
    enterEditMode();
    fireEvent.click(screen.getByText("Hades"));
    fireEvent.click(screen.getByText("Celeste"));
    fireEvent.click(h.header.getByRole("button", { name: "Remove 2 from collection" }));
    expect(h.onRemoveGames).toHaveBeenCalledWith(["3", "2"]);
  });

  it("won't remove nothing", () => {
    const { header } = renderDetail();
    enterEditMode();
    expect(
      header.getByRole("button", { name: "Remove from collection" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("toggles a pick off again", () => {
    const { header } = renderDetail();
    enterEditMode();
    fireEvent.click(screen.getByText("Hades"));
    fireEvent.click(screen.getByText("Hades"));
    expect(
      header.getByRole("button", { name: "Remove from collection" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("leaves the mode without removing anything", () => {
    const h = renderDetail();
    enterEditMode();
    fireEvent.click(screen.getByText("Hades"));
    fireEvent.click(h.header.getByRole("button", { name: "Done" }));
    expect(h.onRemoveGames).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Edit collection" })).toBeTruthy();
  });

  it("hides the collection-wide controls while picking", () => {
    // The bin deletes the whole collection. Leaving it beside a "remove these
    // three" button is an invitation to hit the wrong one.
    renderDetail();
    enterEditMode();
    expect(screen.queryByRole("button", { name: "Remove collection" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Options" })).toBeNull();
  });

  it("says how many picks the filter is hiding, before you confirm", () => {
    // Picks survive a filter change on purpose. Without this count, narrowing
    // the view after picking removes games that aren't on screen and nothing
    // says so — the grid doesn't even change afterwards, because the filter is
    // still applied.
    renderDetail();
    enterEditMode();
    fireEvent.click(screen.getByText("Hades"));
    filter("celeste");
    expect(screen.getByText("1 picked · 1 not shown")).toBeTruthy();
  });

  it("names the collection and what survives before deleting it", () => {
    // Trigger and confirm used to share an accessible name and a screen slot,
    // so two quick presses on what reads as one control destroyed it.
    const { header } = renderDetail();
    fireEvent.click(header.getByRole("button", { name: "Remove collection" }));
    expect(header.queryByRole("button", { name: "Remove collection" })).toBeNull();
    expect(header.getByText(/Delete .*Emulation.*3 games stay in your library/)).toBeTruthy();
    // The safe option comes first now.
    expect(header.getByRole("button", { name: "Keep it" })).toBeTruthy();
  });

  it("disarms the bin when you go into select mode", () => {
    // Otherwise you come back from picking games to a live delete button armed
    // by an intent expressed several interactions ago.
    const { header } = renderDetail();
    fireEvent.click(header.getByRole("button", { name: "Remove collection" }));
    enterEditMode();
    fireEvent.click(header.getByRole("button", { name: "Done" }));
    expect(header.getByRole("button", { name: "Remove collection" })).toBeTruthy();
    expect(header.queryByText(/Delete .*Emulation/)).toBeNull();
  });

  it("still filters while picking, so a long collection stays usable", () => {
    const h = renderDetail();
    enterEditMode();
    filter("hades");
    fireEvent.click(screen.getByText("Hades"));
    fireEvent.click(h.header.getByRole("button", { name: "Remove 1 from collection" }));
    expect(h.onRemoveGames).toHaveBeenCalledWith(["3"]);
  });
});

describe("entries Steam can no longer resolve", () => {
  it("names them and offers a clean-up, behind a confirm", () => {
    const onCleanUp = mock(() => {});
    renderDetail({ staleCount: 206, onCleanUp });
    expect(screen.getByText(/206 more entries/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clean up" }));
    expect(onCleanUp).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove 206" }));
    expect(onCleanUp).toHaveBeenCalledTimes(1);
  });

  it("says nothing when there are none", () => {
    renderDetail();
    expect(screen.queryByText(/point at shortcuts/)).toBeNull();
  });
});

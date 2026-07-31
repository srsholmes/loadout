import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { PluginHeaderSlotProvider } from "@loadout/ui";
import { AddGamesPage } from "./AddGamesPage";

const LIBRARY = [
  { appId: "1", name: "Portal 2" },
  { appId: "2", name: "Portal" },
  { appId: "3", name: "Hades" },
  { appId: "4", name: "Celeste" },
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
  return handlers;
}

const search = (text: string) =>
  fireEvent.change(document.querySelector<HTMLInputElement>('input[placeholder^="Search"]')!, {
    target: { value: text },
  });

describe("finding a game", () => {
  it("starts empty and says what searching will cover", () => {
    // 2501 games is not a list you scroll through with a thumbstick.
    renderPage();
    expect(screen.getByText(/Type to search 4 games/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Hades/ })).toBeNull();
  });

  it("matches on any part of the name, case-insensitively", () => {
    renderPage();
    search("port");
    expect(screen.getByRole("button", { name: /Portal 2/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Portal Add$/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Hades/ })).toBeNull();
  });

  it("says so when nothing matches, and why that might be", () => {
    renderPage();
    search("zzz");
    expect(screen.getByText(/already be in this collection/)).toBeTruthy();
  });

  it("caps how many rows it renders, and says it capped them", () => {
    // A search matching hundreds needs refining, not hundreds of mounted rows
    // — but a list that quietly stops short is how you conclude a game isn't
    // in your library.
    const many = Array.from({ length: 60 }, (_, i) => ({ appId: String(i), name: `Game ${i}` }));
    renderPage({ candidates: many });
    search("Game");
    expect(screen.getByText(/Showing 40 of 60 matches/)).toBeTruthy();
  });

  it("says when there is nothing left to add", () => {
    renderPage({ candidates: [] });
    expect(screen.getByText(/already in this collection/)).toBeTruthy();
  });
});

describe("picking games", () => {
  it("won't write an empty selection", () => {
    renderPage();
    expect(screen.getByRole("button", { name: "Add" }).hasAttribute("disabled")).toBe(true);
  });

  it("adds several on one write", () => {
    // Each confirm is a Steam Cloud round trip; one per game turns adding five
    // into five chances to fail halfway.
    const h = renderPage();
    search("port");
    fireEvent.click(screen.getByRole("button", { name: /Portal 2/ }));
    search("hades");
    fireEvent.click(screen.getByRole("button", { name: /Hades/ }));

    fireEvent.click(screen.getByRole("button", { name: "Add 2 games" }));
    expect(h.onAdd).toHaveBeenCalledWith(["1", "3"]);
  });

  it("keeps what you picked visible while you keep searching", () => {
    // Otherwise the only record of a mis-tap is a number in the header, and it
    // stays invisible until after the write.
    renderPage();
    search("hades");
    fireEvent.click(screen.getByRole("button", { name: /Hades/ }));
    search("celeste");
    expect(screen.getByRole("button", { name: "Don't add Hades" })).toBeTruthy();
  });

  it("lets you take one back off the list", () => {
    const h = renderPage();
    search("hades");
    fireEvent.click(screen.getByRole("button", { name: /Hades/ }));
    fireEvent.click(screen.getByRole("button", { name: "Don't add Hades" }));
    expect(screen.getByRole("button", { name: "Add" }).hasAttribute("disabled")).toBe(true);
    expect(h.onAdd).not.toHaveBeenCalled();
  });

  it("toggles rather than adding the same game twice", () => {
    renderPage();
    search("hades");
    // The picked chip also carries the name, so match the row exactly.
    const row = () => screen.getByRole("button", { name: /^Hades (Add|Picked)$/ });
    fireEvent.click(row());
    expect(row().textContent).toMatch(/Picked/);
    fireEvent.click(row());
    expect(row().textContent).toMatch(/Add/);
  });

  it("counts one game in the singular", () => {
    renderPage();
    search("hades");
    fireEvent.click(screen.getByRole("button", { name: /Hades/ }));
    expect(screen.getByRole("button", { name: "Add 1 game" })).toBeTruthy();
  });
});

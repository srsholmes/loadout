import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { PluginHeaderSlotProvider } from "@loadout/ui";
import { NewCollectionPage } from "./NewCollectionPage";
import { buildEvalGames } from "../lib/facts";
import { LIBRARY } from "../test/fixtures/library";

const NOW = 1_760_000_000;
const games = buildEvalGames(LIBRARY);

function renderPage(props: Partial<Parameters<typeof NewCollectionPage>[0]> = {}) {
  const handlers = {
    onBack: mock(() => {}),
    onCreate: mock((_: string) => {}),
    onPickPreset: mock((_: unknown) => {}),
  };
  const slot = document.createElement("div");
  document.body.appendChild(slot);
  render(
    <PluginHeaderSlotProvider slot={slot}>
      <NewCollectionPage existingNames={[]} games={games} now={NOW} {...handlers} {...props} />
    </PluginHeaderSlotProvider>,
  );
  return handlers;
}

/** The name field, not the shell's search box, which is also an `input`. */
const nameField = () => document.querySelector<HTMLInputElement>('input[placeholder^="e.g."]')!;

describe("presets", () => {
  it("offers ready-made collections so nothing has to be typed", () => {
    // Typing on a handheld means the on-screen keyboard and a thumbstick, so a
    // named, ruled starting point is the difference between two presses and a
    // chore.
    const h = renderPage();
    fireEvent.click(screen.getByRole("button", { name: /Dive back in/ }));
    expect(h.onPickPreset).toHaveBeenCalledTimes(1);
    expect((h.onPickPreset.mock.calls[0]![0] as { label: string }).label).toBe("Dive back in");
  });

  it("prices each one against the library before it is picked", () => {
    // The count is the whole point: it is what stops the gallery offering a
    // dozen collections that turn out to be empty on this library.
    renderPage();
    expect(screen.getByRole("button", { name: /Emulated & non-Steam/ }).textContent).toMatch(
      /→ \d+ games?/,
    );
  });

  it("says so rather than showing a number when nothing matches", () => {
    // Play history is present — every game here has been played — so the
    // preset is offerable and simply comes back empty. That is a different
    // thing from the source being missing, and reads differently.
    renderPage({ games: buildEvalGames(LIBRARY.map((g) => ({ ...g, lastPlayed: NOW - 60 }))) });
    expect(screen.getByRole("button", { name: /Never played/ }).textContent).toMatch(
      /Nothing matches/,
    );
  });

  it("greys out a preset whose data source is missing, and names it", () => {
    // HowLongToBeat is a separate plugin. Offering "Short games" without it
    // hands over a collection that can only ever be empty.
    const short = () => screen.getByRole("button", { name: /Short games/ });
    renderPage();
    expect(short().textContent).toMatch(/HowLongToBeat/);
    expect(short().hasAttribute("disabled")).toBe(true);
  });

  it("offers it once its fact is available", () => {
    renderPage({ availableFacts: new Set(["hltbMain" as const]) });
    expect(screen.getByRole("button", { name: /Short games/ }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("blocks a preset you have already made, rather than making a twin", () => {
    const h = renderPage({ existingNames: ["Dive back in"] });
    const row = screen.getByRole("button", { name: /Dive back in/ });
    expect(row.hasAttribute("disabled")).toBe(true);
    fireEvent.click(row);
    expect(h.onPickPreset).not.toHaveBeenCalled();
  });
});

describe("while a collection is being built", () => {
  const spinner = () => document.body.querySelector(".loading");

  it("puts a spinner in the header and names what it is building", () => {
    // Creating one takes a beat — reading the library, writing the rules,
    // opening the result — and the page is inert for all of it.
    renderPage();
    expect(spinner()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Never played/ }));
    expect(spinner()).toBeTruthy();
    expect(screen.getByText(/Building “Never played”/)).toBeTruthy();
  });

  it("doesn't blame the library for a read that hasn't finished", () => {
    // Until the snapshot lands nothing can be priced, and `metadataNeedsMet`
    // sees an empty library — so every preset that reads anything came back
    // "Needs play history", which blames the user's library for an outage of
    // ours. It also left the D-pad with nothing to reach on the page.
    renderPage({ libraryLoaded: false });
    expect(screen.queryByText(/Needs play history/)).toBeNull();
    expect(screen.getByText(/Reading your library/)).toBeTruthy();
    // Blocked while it arrives, rather than pickable against nothing.
    expect(screen.getByRole("button", { name: /Most played/ }).hasAttribute("disabled")).toBe(true);
  });

  it("prices and offers them once it has", () => {
    renderPage();
    expect(screen.queryByText(/Reading your library/)).toBeNull();
    expect(screen.getByRole("button", { name: /Most played/ }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("locks every other preset too, not just the one pressed", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /Never played/ }));
    expect(screen.getByRole("button", { name: /Most played/ }).hasAttribute("disabled")).toBe(true);
  });

  it("does the same for one created from scratch", () => {
    const h = renderPage();
    fireEvent.change(nameField(), { target: { value: "Backlog" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(h.onCreate).toHaveBeenCalledWith("Backlog");
    expect(spinner()).toBeTruthy();
    expect(screen.getByRole("button", { name: "Creating…" }).hasAttribute("disabled")).toBe(true);
  });

  it("won't create the same one twice from a second press", () => {
    const h = renderPage();
    fireEvent.change(nameField(), { target: { value: "Backlog" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    fireEvent.click(screen.getByRole("button", { name: "Creating…" }));
    fireEvent.keyDown(nameField(), { key: "Enter" });
    expect(h.onCreate).toHaveBeenCalledTimes(1);
  });
});

describe("naming one yourself", () => {
  it("won't create one without a name, and says how to get a keyboard", () => {
    // A disabled button that gives no reason is indistinguishable from a
    // broken one — which is exactly what "I press Create and nothing happens"
    // turned out to be.
    renderPage();
    expect(screen.getByRole("button", { name: "Create" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/keyboard button is in the footer/)).toBeTruthy();
  });

  it("creates with the typed name", () => {
    const h = renderPage();
    fireEvent.change(nameField(), { target: { value: "Backlog" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(h.onCreate).toHaveBeenCalledWith("Backlog");
  });

  it("creates on Enter too", () => {
    const h = renderPage();
    fireEvent.change(nameField(), { target: { value: "Backlog" } });
    fireEvent.keyDown(nameField(), { key: "Enter" });
    expect(h.onCreate).toHaveBeenCalledWith("Backlog");
  });

  it("trims before creating, so a stray space isn't part of the Steam name", () => {
    const h = renderPage();
    fireEvent.change(nameField(), { target: { value: "  Backlog  " } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(h.onCreate).toHaveBeenCalledWith("Backlog");
  });

  it("catches a name clash before Steam sees it", () => {
    const h = renderPage({ existingNames: ["Backlog"] });
    fireEvent.change(nameField(), { target: { value: "Backlog" } });
    expect(screen.getByText(/already have a collection called/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(h.onCreate).not.toHaveBeenCalled();
  });

  it("treats a clash case-insensitively", () => {
    // Steam's sidebar shows "Backlog" and "backlog" as two entries that look
    // identical, which is nobody's intent.
    renderPage({ existingNames: ["Backlog"] });
    fireEvent.change(nameField(), { target: { value: "backlog" } });
    expect(screen.getByText(/already have a collection called/)).toBeTruthy();
  });

  it("echoes the name in the header, where Steam will show it", () => {
    renderPage();
    fireEvent.change(nameField(), { target: { value: "Backlog" } });
    expect(screen.getByRole("region", { name: "Backlog" })).toBeTruthy();
  });
});

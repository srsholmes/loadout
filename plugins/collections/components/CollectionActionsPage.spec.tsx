import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { PluginHeaderSlotProvider } from "@loadout/ui";
import { CollectionActionsPage } from "./CollectionActionsPage";

/**
 * Render inside a header slot.
 *
 * `BuilderPage` portals its title and Back into the shell's topbar, and
 * `PluginHeader` renders nothing when no slot is wired — so without this the
 * Back control simply does not exist under test.
 */
function renderWithHeader(ui: React.ReactElement) {
  const slot = document.createElement("div");
  document.body.appendChild(slot);
  return render(<PluginHeaderSlotProvider slot={slot}>{ui}</PluginHeaderSlotProvider>);
}

function renderPage(props: Partial<Parameters<typeof CollectionActionsPage>[0]> = {}) {
  const handlers = {
    onBack: mock(() => {}),
    onRename: mock((_: string) => {}),
    onDelete: mock(() => {}),
    onEditRules: mock(() => {}),
  };
  renderWithHeader(
    <CollectionActionsPage
      label="Backlog"
      kind="managed"
      count={45}
      autoMaintained
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe("renaming", () => {
  it("renames only once the name has actually changed", () => {
    const h = renderPage();
    expect(screen.getByRole("button", { name: "Rename" }).hasAttribute("disabled")).toBe(true);

    fireEvent.change(document.querySelector("input")!, { target: { value: "Shelf" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(h.onRename).toHaveBeenCalledWith("Shelf");
  });

  it("renames on Enter, not only from the button", () => {
    // On a handheld the on-screen keyboard's confirm is right there and the
    // separate button is easy to miss, so Enter doing nothing reads as broken.
    const h = renderPage();
    const input = document.querySelector("input")!;
    fireEvent.change(input, { target: { value: "Shelf" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(h.onRename).toHaveBeenCalledWith("Shelf");
  });

  it("says a managed rename reaches Steam", () => {
    renderPage();
    expect(screen.getByText(/the name Steam uses too/)).toBeTruthy();
  });
});

describe("a managed collection", () => {
  it("offers editing the rules, and says they re-run", () => {
    // The card and this page both have to say it: rules re-running is what
    // makes a game leave, and silence is what makes that feel arbitrary.
    const h = renderPage();
    expect(screen.getByText(/re-run on every sync/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit rules" }));
    expect(h.onEditRules).toHaveBeenCalledTimes(1);
  });
});

describe("a linked collection", () => {
  it("has no rules to edit, and says where its games come from", () => {
    renderPage({ kind: "linked", autoMaintained: false, onEditRules: undefined });
    expect(screen.queryByRole("button", { name: "Edit rules" })).toBeNull();
    expect(screen.getByText(/add or remove games/)).toBeTruthy();
  });

  it("explains why a dynamic one can't be edited", () => {
    // Steam recomputes it, so any edit we offered would be silently undone.
    renderPage({ kind: "linked", autoMaintained: true, onEditRules: undefined });
    expect(screen.getByText(/works this one out from a filter/)).toBeTruthy();
  });
});

describe("deleting", () => {
  it("requires a second press", () => {
    const h = renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Delete this collection" }));
    expect(h.onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(h.onDelete).toHaveBeenCalledTimes(1);
  });

  it("can be backed out of", () => {
    const h = renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Delete this collection" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(h.onDelete).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Delete this collection" })).toBeTruthy();
  });

  it("warns that a linked delete removes a real Steam collection", () => {
    // It may be one EmuDeck spent a long time generating, and this plugin
    // cannot rebuild it.
    renderPage({ kind: "linked", autoMaintained: false, count: 713 });
    fireEvent.click(screen.getByRole("button", { name: "Delete this collection" }));
    expect(screen.getByText(/from Steam\? 713 games stay in your library/)).toBeTruthy();
  });
});

describe("getting out", () => {
  it("shows a Back control", () => {
    // Back is rendered by `BuilderPage` into the shell's topbar. It once sat
    // in the page body, where it scrolled away with the content.
    const h = renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(h.onBack).toHaveBeenCalledTimes(1);
  });
});

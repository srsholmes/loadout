import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { PluginHeaderSlotProvider } from "@loadout/ui";
import { NewCollectionPage } from "./NewCollectionPage";

function renderPage(existingNames: string[] = []) {
  const handlers = { onBack: mock(() => {}), onCreate: mock((_: string) => {}) };
  const slot = document.createElement("div");
  document.body.appendChild(slot);
  render(
    <PluginHeaderSlotProvider slot={slot}>
      <NewCollectionPage existingNames={existingNames} {...handlers} />
    </PluginHeaderSlotProvider>,
  );
  return handlers;
}

describe("naming a collection first", () => {
  it("won't create one without a name", () => {
    renderPage();
    expect(screen.getByRole("button", { name: "Create" }).hasAttribute("disabled")).toBe(true);
  });

  it("creates with the typed name", () => {
    const h = renderPage();
    fireEvent.change(document.querySelector("input")!, { target: { value: "Backlog" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(h.onCreate).toHaveBeenCalledWith("Backlog");
  });

  it("creates on Enter too", () => {
    const h = renderPage();
    const input = document.querySelector("input")!;
    fireEvent.change(input, { target: { value: "Backlog" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(h.onCreate).toHaveBeenCalledWith("Backlog");
  });

  it("trims before creating, so a stray space isn't part of the Steam name", () => {
    const h = renderPage();
    fireEvent.change(document.querySelector("input")!, { target: { value: "  Backlog  " } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(h.onCreate).toHaveBeenCalledWith("Backlog");
  });

  it("catches a name clash before Steam sees it", () => {
    const h = renderPage(["Backlog"]);
    fireEvent.change(document.querySelector("input")!, { target: { value: "Backlog" } });
    expect(screen.getByText(/already have a collection called/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(h.onCreate).not.toHaveBeenCalled();
  });

  it("treats a clash case-insensitively", () => {
    // Steam's sidebar shows "Backlog" and "backlog" as two entries that look
    // identical, which is nobody's intent.
    renderPage(["Backlog"]);
    fireEvent.change(document.querySelector("input")!, { target: { value: "backlog" } });
    expect(screen.getByText(/already have a collection called/)).toBeTruthy();
  });

  it("says the name reaches Steam", () => {
    renderPage();
    expect(screen.getByText(/this is the name Steam will show too/i)).toBeTruthy();
  });
});

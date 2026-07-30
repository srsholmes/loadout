import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { TabActionsPage } from "./TabActionsPage";
import { builtinTabs, templates } from "../lib/templates";
import type { Tab } from "../lib/types";

const NOW = 1_800_000_000;

function custom(): Tab {
  return templates(NOW).find((t) => t.id === "space-hogs")!.build("mine");
}

function builtin(): Tab {
  return builtinTabs().find((t) => t.id === "all")!;
}

function renderPage(tab: Tab, overrides: Partial<Parameters<typeof TabActionsPage>[0]> = {}) {
  const handlers = {
    onBack: mock(() => {}),
    onRename: mock((_: string) => {}),
    onToggleVisible: mock(() => {}),
    onMove: mock((_: number) => {}),
    onEditRules: mock(() => {}),
    onDelete: mock(() => {}),
  };
  render(
    <TabActionsPage tab={tab} index={1} tabCount={4} {...handlers} {...overrides} />,
  );
  return handlers;
}

describe("TabActionsPage — a custom tab", () => {
  it("offers editing the rules", () => {
    const h = renderPage(custom());
    fireEvent.click(screen.getByRole("button", { name: "Edit rules" }));
    expect(h.onEditRules).toHaveBeenCalledTimes(1);
  });

  it("renames only once the name has actually changed", () => {
    const h = renderPage(custom());
    const rename = screen.getByRole("button", { name: "Rename" });
    // Unchanged name: nothing to do, so the control is inert rather than
    // firing a pointless write.
    expect(rename.hasAttribute("disabled")).toBe(true);

    const input = document.querySelector("input");
    fireEvent.change(input!, { target: { value: "Chonky" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(h.onRename).toHaveBeenCalledWith("Chonky");
  });

  it("requires a second press before deleting", () => {
    // One tap destroying a tab the user spent time on is the wrong trade; two
    // taps with the name in the prompt is enough for a single tab.
    const h = renderPage(custom());
    fireEvent.click(screen.getByRole("button", { name: "Delete this tab" }));
    expect(h.onDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(h.onDelete).toHaveBeenCalledTimes(1);
  });

  it("can back out of a delete", () => {
    const h = renderPage(custom());
    fireEvent.click(screen.getByRole("button", { name: "Delete this tab" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(h.onDelete).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Delete this tab" })).toBeTruthy();
  });

  it("moves the tab in the strip", () => {
    const h = renderPage(custom());
    fireEvent.click(screen.getByRole("button", { name: "Move left" }));
    expect(h.onMove).toHaveBeenCalledWith(-1);
    fireEvent.click(screen.getByRole("button", { name: "Move right" }));
    expect(h.onMove).toHaveBeenCalledWith(1);
  });

  it("disables the move that would leave the strip", () => {
    renderPage(custom(), { index: 0 });
    expect(
      screen.getByRole("button", { name: "Move left" }).hasAttribute("disabled"),
    ).toBe(true);
  });
});

describe("TabActionsPage — a built-in tab", () => {
  it("cannot be deleted, and says why rather than hiding the section", () => {
    renderPage(builtin());
    expect(screen.queryByRole("button", { name: "Delete this tab" })).toBeNull();
    expect(screen.getByText(/hidden but not deleted/)).toBeTruthy();
  });

  it("cannot have its rules edited, and says why", () => {
    renderPage(builtin());
    expect(screen.queryByRole("button", { name: "Edit rules" })).toBeNull();
    expect(screen.getByText(/rules we maintain/)).toBeTruthy();
  });

  it("can still be hidden and moved", () => {
    // The restriction is on the rules, not on the tab — a built-in the user
    // never uses should still be removable from the strip.
    const h = renderPage(builtin());
    fireEvent.click(screen.getByRole("button", { name: /Hide from the strip/ }));
    expect(h.onToggleVisible).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Move right" }));
    expect(h.onMove).toHaveBeenCalledWith(1);
  });

  it("offers to bring a hidden tab back", () => {
    renderPage({ ...builtin(), visible: false });
    expect(screen.getByRole("button", { name: /Show in the strip/ })).toBeTruthy();
  });
});

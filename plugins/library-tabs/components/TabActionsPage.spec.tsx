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
    onToggleMirror: mock(() => {}),
    onOpenMirror: mock(() => {}),
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

  it("renames on Enter, not only from the button", () => {
    // On a handheld the on-screen keyboard's confirm is right there and the
    // separate Rename button is easy to miss, so Enter doing nothing reads as
    // "renaming is broken".
    const h = renderPage(custom());
    const input = document.querySelector("input")!;
    fireEvent.change(input, { target: { value: "Chonky" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(h.onRename).toHaveBeenCalledWith("Chonky");
  });

  it("ignores Enter when the name has not changed", () => {
    const h = renderPage(custom());
    fireEvent.keyDown(document.querySelector("input")!, { key: "Enter" });
    expect(h.onRename).not.toHaveBeenCalled();
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

describe("TabActionsPage — the Steam mirror", () => {
  it("offers to mirror a tab that isn't mirrored", () => {
    const h = renderPage(custom());
    // No sync button yet: there is nothing in Steam to sync to, and offering
    // one would imply the tab is already over there.
    expect(screen.queryByRole("button", { name: /Review/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show in Steam" }));
    expect(h.onToggleMirror).toHaveBeenCalledTimes(1);
  });

  it("names the collection a mirrored tab writes to", () => {
    // Which collection this lands in is the user's whole mental model of the
    // feature; leaving it implicit is how a tab quietly overwrites the wrong one.
    const tab = { ...custom(), mirror: { enabled: true, collectionName: "My Shelf" } };
    renderPage(tab);
    expect(screen.getByText(/“My Shelf”/)).toBeTruthy();
  });

  it("falls back to the tab's own name when no collection name is set", () => {
    const tab = { ...custom(), mirror: { enabled: true, collectionName: "" } };
    renderPage(tab);
    expect(screen.getByText(new RegExp(`“${tab.label}”`))).toBeTruthy();
  });

  it("routes to the dry run rather than syncing from here", () => {
    // Nothing writes to the user's Steam library without them seeing the plan.
    const tab = { ...custom(), mirror: { enabled: true, collectionName: "X" } };
    const h = renderPage(tab);
    fireEvent.click(screen.getByRole("button", { name: /Review/ }));
    expect(h.onOpenMirror).toHaveBeenCalledTimes(1);
  });

  it("lets a built-in tab be mirrored too", () => {
    // The rules are ours; where the tab shows up is the user's call.
    const h = renderPage(builtin());
    fireEvent.click(screen.getByRole("button", { name: "Show in Steam" }));
    expect(h.onToggleMirror).toHaveBeenCalledTimes(1);
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

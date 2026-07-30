import { describe, expect, it, mock } from "bun:test";
import * as actualUi from "@loadout/ui";
import { fireEvent, render, screen } from "@testing-library/react";

// `PluginHeader` portals into a slot the overlay shell reserves; there is no
// shell here, so render it inline or nothing below is in the document.
mock.module("@loadout/ui", () => ({
  ...actualUi,
  PluginHeader: ({ children }: { children: unknown }) => children,
}));

const { CollectionsHeader } = await import("./CollectionsHeader");

function renderHeader(props: Partial<Parameters<typeof CollectionsHeader>[0]> = {}) {
  const onSearchChange = mock((_: string) => {});
  const view = render(
    <CollectionsHeader
      subtitle="Show every game, sorted by name ascending"
      search=""
      onSearchChange={onSearchChange}
      showBrowseActions
      addTabLabel="Add tab"
      searchPlaceholder="Search All…"
      {...props}
    />,
  );
  return { onSearchChange, view };
}

describe("CollectionsHeader", () => {
  it("names the plugin and carries the active tab's sentence as the subtitle", () => {
    renderHeader();
    expect(screen.getByRole("heading", { name: "Collections" })).toBeTruthy();
    expect(
      screen.getByText("Show every game, sorted by name ascending"),
    ).toBeTruthy();
  });

  it("shows what is being edited instead, while editing", () => {
    renderHeader({ subtitle: "Editing “Backlog”", showBrowseActions: false });
    expect(screen.getByText("Editing “Backlog”")).toBeTruthy();
  });

  it("hides search and the actions while editing, since the builder owns the screen", () => {
    renderHeader({
      showBrowseActions: false,
      onAddTab: () => {},
      onTabOptions: () => {},
    });
    expect(screen.queryByRole("button", { name: "Add tab" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit rules" })).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("reports typing in the search box", () => {
    const { onSearchChange } = renderHeader();
    const input = document.querySelector("input");
    if (!input) throw new Error("expected a search input");
    fireEvent.change(input, { target: { value: "halo" } });
    expect(onSearchChange).toHaveBeenCalledWith("halo");
  });

  it("offers Tab options for a builtin too — it can still be hidden or moved", () => {
    // Hiding the control entirely for built-ins is what made tab management
    // look absent: there was no visible way to rename, reorder or delete
    // anything, because the one button only appeared on custom tabs.
    renderHeader({ onTabOptions: () => {}, onAddTab: () => {} });
    expect(screen.getByRole("button", { name: "Tab options" })).toBeTruthy();
  });

  it("omits Add tab when the config is read-only", () => {
    renderHeader({ onTabOptions: () => {} });
    expect(screen.queryByRole("button", { name: "Add tab" })).toBeNull();
    expect(screen.getByRole("button", { name: "Tab options" })).toBeTruthy();
  });

  it("relabels the add button when the template gallery is open", () => {
    renderHeader({ addTabLabel: "Close", onAddTab: () => {} });
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("fires its callbacks", () => {
    const onAddTab = mock(() => {});
    const onTabOptions = mock(() => {});
    renderHeader({ onAddTab, onTabOptions });
    fireEvent.click(screen.getByRole("button", { name: "Add tab" }));
    fireEvent.click(screen.getByRole("button", { name: "Tab options" }));
    expect(onAddTab).toHaveBeenCalledTimes(1);
    expect(onTabOptions).toHaveBeenCalledTimes(1);
  });
});

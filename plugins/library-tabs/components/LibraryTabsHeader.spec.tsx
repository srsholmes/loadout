import { describe, expect, it, mock } from "bun:test";
import * as actualUi from "@loadout/ui";
import { fireEvent, render, screen } from "@testing-library/react";

// `PluginHeader` portals into a slot the overlay shell reserves; there is no
// shell here, so render it inline or nothing below is in the document.
mock.module("@loadout/ui", () => ({
  ...actualUi,
  PluginHeader: ({ children }: { children: unknown }) => children,
}));

const { LibraryTabsHeader } = await import("./LibraryTabsHeader");

function renderHeader(props: Partial<Parameters<typeof LibraryTabsHeader>[0]> = {}) {
  const onSearchChange = mock((_: string) => {});
  const view = render(
    <LibraryTabsHeader
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

describe("LibraryTabsHeader", () => {
  it("names the plugin and carries the active tab's sentence as the subtitle", () => {
    renderHeader();
    expect(screen.getByRole("heading", { name: "Library Tabs" })).toBeTruthy();
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
      onEditRules: () => {},
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

  it("omits Edit rules for a builtin tab, which has no editable root", () => {
    renderHeader({ onAddTab: () => {} });
    expect(screen.queryByRole("button", { name: "Edit rules" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add tab" })).toBeTruthy();
  });

  it("omits Add tab when the config is read-only", () => {
    renderHeader({ onEditRules: () => {} });
    expect(screen.queryByRole("button", { name: "Add tab" })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit rules" })).toBeTruthy();
  });

  it("relabels the add button when the template gallery is open", () => {
    renderHeader({ addTabLabel: "Close", onAddTab: () => {} });
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("fires its callbacks", () => {
    const onAddTab = mock(() => {});
    const onEditRules = mock(() => {});
    renderHeader({ onAddTab, onEditRules });
    fireEvent.click(screen.getByRole("button", { name: "Add tab" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit rules" }));
    expect(onAddTab).toHaveBeenCalledTimes(1);
    expect(onEditRules).toHaveBeenCalledTimes(1);
  });
});

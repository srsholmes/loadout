import { describe, expect, it } from "bun:test";
import { render, screen } from "@testing-library/react";
import { TabStrip, type TabStripEntry } from "./TabStrip";

const TABS: TabStripEntry[] = [
  { id: "all", label: "All", count: 120 },
  { id: "installed", label: "Installed", count: 12 },
  { id: "deck", label: "Deck Verified", count: 0, unavailable: true },
];

describe("TabStrip", () => {
  it("renders one tab per entry", () => {
    render(<TabStrip tabs={TABS} activeId="all" onSelect={() => {}} />);
    expect(screen.getByRole("tab", { name: /All/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Installed/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Deck Verified/ })).toBeTruthy();
  });

  it("renders match counts, including zero", () => {
    // The count is the difference between "is my tab broken?" and seeing 0
    // before you click, so a zero must render rather than being falsy-skipped.
    render(<TabStrip tabs={TABS} activeId="all" onSelect={() => {}} />);
    expect(screen.getByText("120")).toBeTruthy();
    expect(screen.getByText("0")).toBeTruthy();
  });

  it("omits counts when the setting is off", () => {
    render(
      <TabStrip tabs={TABS} activeId="all" onSelect={() => {}} showCounts={false} />,
    );
    expect(screen.queryByText("120")).toBeNull();
  });

  it("omits a count that hasn't been computed yet", () => {
    // `undefined` means the library is still loading; showing 0 there would
    // claim the tab is empty when we simply don't know.
    render(
      <TabStrip
        tabs={[{ id: "all", label: "All" }]}
        activeId="all"
        onSelect={() => {}}
      />,
    );
    const tab = screen.getByRole("tab", { name: /All/ });
    expect(tab.textContent).toBe("All");
  });

  it("marks the active tab with aria-selected", () => {
    render(<TabStrip tabs={TABS} activeId="installed" onSelect={() => {}} />);
    expect(
      screen.getByRole("tab", { name: /Installed/ }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByRole("tab", { name: /All/ }).getAttribute("aria-selected"),
    ).toBe("false");
  });

  it("calls onSelect with the tab id when clicked", () => {
    const picked: string[] = [];
    render(
      <TabStrip tabs={TABS} activeId="all" onSelect={(id) => picked.push(id)} />,
    );
    screen.getByRole("tab", { name: /Installed/ }).click();
    expect(picked).toEqual(["installed"]);
  });

  it("explains a dimmed tab with a title, rather than just greying it", () => {
    render(<TabStrip tabs={TABS} activeId="all" onSelect={() => {}} />);
    const deck = screen.getByRole("tab", { name: /Deck Verified/ });
    expect(deck.getAttribute("title")).toContain("isn't available yet");
  });

  it("leaves available tabs untitled", () => {
    render(<TabStrip tabs={TABS} activeId="all" onSelect={() => {}} />);
    expect(screen.getByRole("tab", { name: /^All/ }).getAttribute("title")).toBeNull();
  });

  it("renders a tablist with an accessible name", () => {
    render(<TabStrip tabs={TABS} activeId="all" onSelect={() => {}} />);
    expect(screen.getByRole("tablist", { name: "Library tabs" })).toBeTruthy();
  });

  it("renders nothing at all when there are no tabs", () => {
    const { container } = render(
      <TabStrip tabs={[]} activeId={null} onSelect={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("gives every tab a 44px minimum target, per DESIGN.md", () => {
    render(<TabStrip tabs={TABS} activeId="all" onSelect={() => {}} />);
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.className).toContain("min-h-[44px]");
    }
  });

  it("uses real <button> elements so native Tab order works when docked", () => {
    // Mouse/keyboard is TabMaster's broken input path; it is a first-class
    // constraint here, not an afterthought.
    render(<TabStrip tabs={TABS} activeId="all" onSelect={() => {}} />);
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.tagName).toBe("BUTTON");
      expect(tab.getAttribute("type")).toBe("button");
    }
  });
});

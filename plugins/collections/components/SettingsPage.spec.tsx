import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { SettingsPage } from "./SettingsPage";

function renderPage(props: Partial<Parameters<typeof SettingsPage>[0]> = {}) {
  const handlers = {
    onBack: mock(() => {}),
    onToggleAutoSync: mock((_: boolean) => {}),
    onOpenMirror: mock(() => {}),
  };
  render(
    <SettingsPage
      autoSync={false}
      mirroredCount={1}
      pendingSync={false}
      readOnly={false}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

function toggle(): HTMLInputElement {
  return document.querySelector('input[type="checkbox"]') as HTMLInputElement;
}

describe("SettingsPage — sync with Steam", () => {
  it("turns syncing on", () => {
    const h = renderPage({ autoSync: false });
    expect(toggle().checked).toBe(false);
    fireEvent.click(toggle());
    expect(h.onToggleAutoSync).toHaveBeenCalledWith(true);
  });

  it("turns syncing off", () => {
    const h = renderPage({ autoSync: true });
    expect(toggle().checked).toBe(true);
    fireEvent.click(toggle());
    expect(h.onToggleAutoSync).toHaveBeenCalledWith(false);
  });

  it("says syncing happens on its own, so nobody goes hunting for a button", () => {
    renderPage({ autoSync: true });
    expect(screen.getByText(/whenever a tab or its rules change/)).toBeTruthy();
  });

  it("explains why nothing will sync when no tab is set to show in Steam", () => {
    // Enabling a setting and seeing nothing happen is the failure mode this
    // whole screen exists to avoid.
    renderPage({ autoSync: true, mirroredCount: 0 });
    expect(screen.getByText(/No tabs are set to show in Steam yet/)).toBeTruthy();
    expect(screen.getByText(/turn on “Show in Steam”/)).toBeTruthy();
  });

  it("counts the mirrored tabs, singular and plural", () => {
    renderPage({ mirroredCount: 1 });
    expect(screen.getByText("1 tab is set to show in Steam.")).toBeTruthy();
  });

  it("counts several mirrored tabs", () => {
    renderPage({ mirroredCount: 3 });
    expect(screen.getByText("3 tabs are set to show in Steam.")).toBeTruthy();
  });

  it("says when a sync is still owed", () => {
    // Editing tabs with Steam closed is normal on a handheld. Silence here
    // reads as "syncing is broken".
    renderPage({ autoSync: true, pendingSync: true });
    expect(screen.getByText(/A sync is still owed/)).toBeTruthy();
  });

  it("stays quiet when nothing is owed", () => {
    renderPage({ autoSync: true, pendingSync: false });
    expect(screen.queryByText(/still owed/)).toBeNull();
  });
});

describe("SettingsPage — the dry run is still reachable", () => {
  it("opens the review screen", () => {
    // Automatic syncing must not remove the only way to see a delete coming.
    const h = renderPage({ autoSync: true });
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    expect(h.onOpenMirror).toHaveBeenCalledTimes(1);
  });
});

describe("SettingsPage — read-only config", () => {
  it("cannot be changed, and says why", () => {
    renderPage({ readOnly: true });
    expect(toggle().disabled).toBe(true);
    expect(screen.getByText(/newer version of Loadout/)).toBeTruthy();
  });
});

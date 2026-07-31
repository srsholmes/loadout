import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { PluginHeaderSlotProvider } from "@loadout/ui";
import { SettingsPage, describeChange } from "./SettingsPage";

function renderPage(props: Partial<Parameters<typeof SettingsPage>[0]> = {}) {
  const handlers = {
    onBack: mock(() => {}),
    onToggleAutoSync: mock((_: boolean) => {}),
    onSyncNow: mock(() => {}),
  };
  const slot = document.createElement("div");
  document.body.appendChild(slot);
  render(
    <PluginHeaderSlotProvider slot={slot}>
      <SettingsPage
        autoSync={false}
        managedCount={2}
        pendingSync={false}
        busy={false}
        lastSync={null}
        {...handlers}
        {...props}
      />
    </PluginHeaderSlotProvider>,
  );
  return handlers;
}

const toggle = () => document.querySelector('input[type="checkbox"]') as HTMLInputElement;

describe("syncing as a setting, not an action", () => {
  it("turns it on", () => {
    // The gear used to run a sync directly, so pressing a settings icon
    // usually just produced "Already up to date".
    const h = renderPage();
    fireEvent.click(toggle());
    expect(h.onToggleAutoSync).toHaveBeenCalledWith(true);
  });

  it("still offers a manual sync", () => {
    const h = renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(h.onSyncNow).toHaveBeenCalledTimes(1);
  });

  it("locks the button while a sync is running", () => {
    renderPage({ busy: true });
    expect(screen.getByRole("button", { name: "Syncing…" }).hasAttribute("disabled")).toBe(true);
  });

  it("explains why nothing will sync when every collection came from Steam", () => {
    // Enabling a setting and seeing nothing happen is the failure this avoids.
    renderPage({ managedCount: 0 });
    expect(screen.getByText(/Nothing to sync yet/)).toBeTruthy();
  });

  it("says when a sync is still owed", () => {
    renderPage({ pendingSync: true });
    expect(screen.getByText(/still owed/)).toBeTruthy();
  });
});

describe("the last sync report", () => {
  it("names what left a collection", () => {
    renderPage({
      lastSync: [
        { label: "Backlog", kind: "updated", added: [], removed: ["Portal 2"], addedCount: 0, removedCount: 1 },
      ],
    });
    expect(screen.getByText("Backlog — 1 removed (Portal 2)")).toBeTruthy();
  });

  it("says so when a sync changed nothing", () => {
    renderPage({ lastSync: [] });
    expect(screen.getByText("Nothing changed.")).toBeTruthy();
  });
});

describe("describeChange", () => {
  it("lists a couple of names and then trails off", () => {
    // A bare "12 removed" provokes exactly the question the names answer.
    expect(
      describeChange({
        label: "Backlog",
        kind: "updated",
        added: [],
        removed: ["Portal 2", "Hades", "Celeste"],
        addedCount: 0,
        removedCount: 12,
      }),
    ).toBe("Backlog — 12 removed (Portal 2, Hades, …)");
  });

  it("describes a create and a delete", () => {
    const base = { added: [], removed: [], addedCount: 5, removedCount: 0 };
    expect(describeChange({ ...base, label: "New", kind: "created" })).toBe(
      "New — created with 5 games",
    );
    expect(describeChange({ ...base, label: "Old", kind: "deleted" })).toBe(
      "Old — removed from Steam",
    );
  });
});

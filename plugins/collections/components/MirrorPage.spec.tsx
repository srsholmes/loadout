import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { MirrorPage } from "./MirrorPage";
import type { MirrorPlan } from "../lib/mirror";

function plan(overrides: Partial<MirrorPlan> = {}): MirrorPlan {
  return {
    creates: [],
    updates: [],
    renames: [],
    deletes: [],
    conflicts: [],
    drifted: [],
    orphaned: [],
    noops: [],
    skipped: [],
    ...overrides,
  };
}

function renderPage(props: Partial<Parameters<typeof MirrorPage>[0]> = {}) {
  const handlers = {
    onBack: mock(() => {}),
    onRefresh: mock(() => {}),
    onSync: mock(() => {}),
  };
  render(
    <MirrorPage
      plan={plan()}
      summary="Everything is already in sync"
      tabLabels={{}}
      busy={false}
      error={null}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe("MirrorPage — nothing writes without a look first", () => {
  it("cannot sync a plan that would do nothing", () => {
    renderPage();
    expect(screen.getByRole("button", { name: "Sync" }).hasAttribute("disabled")).toBe(true);
  });

  it("cannot sync before the plan has loaded", () => {
    // A Sync button that is live while we still don't know what Steam holds
    // would write against an empty plan.
    renderPage({ plan: null, summary: "" });
    expect(screen.getByRole("button", { name: "Sync" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Checking Steam…")).toBeTruthy();
  });

  it("syncs once the plan has something in it", () => {
    const h = renderPage({
      plan: plan({ creates: [{ tabId: "t", name: "Backlog", appIds: ["1", "2"] }] }),
      summary: "Sync will create 1",
    });
    fireEvent.click(screen.getByRole("button", { name: "Sync" }));
    expect(h.onSync).toHaveBeenCalledTimes(1);
  });

  it("locks the controls while a sync is in flight", () => {
    // Double-tapping Sync on a handheld is easy, and a second run against a
    // stale plan would fight the first.
    renderPage({
      plan: plan({ creates: [{ tabId: "t", name: "B", appIds: [] }] }),
      busy: true,
    });
    expect(screen.getByRole("button", { name: "Syncing…" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Refresh" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("MirrorPage — the plan is shown in full", () => {
  it("lists what will be created, with counts", () => {
    renderPage({ plan: plan({ creates: [{ tabId: "t", name: "Backlog", appIds: ["1", "2"] }] }) });
    expect(screen.getByText(/“Backlog” — 2 games/)).toBeTruthy();
  });

  it("shows deletions and says they are only ever ours", () => {
    // The user needs to know a collection is about to disappear, and that the
    // plugin will not touch one it didn't make.
    renderPage({
      plan: plan({
        deletes: [{ tabId: "t", collectionId: "uc-1", name: "Old", reason: "tab-deleted" }],
      }),
    });
    expect(screen.getByText(/“Old” — its tab is gone/)).toBeTruthy();
    expect(screen.getByText(/Only collections this plugin created/)).toBeTruthy();
  });

  it("distinguishes the two reasons a collection gets removed", () => {
    renderPage({
      plan: plan({
        deletes: [{ tabId: "t", collectionId: "uc-1", name: "Old", reason: "mirror-disabled" }],
      }),
    });
    expect(screen.getByText(/you turned mirroring off/)).toBeTruthy();
  });

  it("explains a name conflict and what to do about it", () => {
    // Silently skipping the tab is what makes this feature feel broken — the
    // user turns mirroring on and nothing ever appears in Steam.
    renderPage({
      plan: plan({
        conflicts: [
          { tabId: "t", name: "Backlog", existingCollectionId: "uc-9", existingCount: 12 },
        ],
      }),
      tabLabels: { t: "My Backlog" },
    });
    expect(screen.getByText(/“My Backlog” wants “Backlog”, which already has 12 games/)).toBeTruthy();
    expect(screen.getByText(/Rename the tab to sync it/)).toBeTruthy();
  });

  it("warns that syncing will undo hand edits", () => {
    renderPage({
      plan: plan({
        drifted: [
          { tabId: "t", collectionId: "uc-1", unexpectedAdds: ["1"], unexpectedRemoves: ["2", "3"] },
        ],
      }),
      tabLabels: { t: "Backlog" },
    });
    expect(screen.getByText(/1 added and 2 removed by hand/)).toBeTruthy();
    expect(screen.getByText(/put these back to what the tab's rules say/)).toBeTruthy();
  });

  it("says why a tab was skipped", () => {
    renderPage({
      plan: plan({ skipped: [{ tabId: "t", reason: "it is a dynamic Steam collection" }] }),
      tabLabels: { t: "Backlog" },
    });
    expect(screen.getByText(/“Backlog” — it is a dynamic Steam collection/)).toBeTruthy();
  });

  it("names a deleted tab from the ledger, not from the tab list", () => {
    // The tab is gone by definition, so the label has to come from what we
    // recorded when we last synced it.
    renderPage({
      plan: plan({
        skipped: [{ tabId: "ghost", reason: "gone" }],
      }),
      tabLabels: { ghost: "Old Shelf" },
    });
    expect(screen.getByText(/“Old Shelf”/)).toBeTruthy();
  });
});

describe("MirrorPage — Steam not running", () => {
  it("says what the user has to do", () => {
    renderPage({ plan: null, error: "Couldn't reach Steam." });
    expect(screen.getByText(/Steam has to be running/)).toBeTruthy();
  });

  it("still offers a retry", () => {
    const h = renderPage({ plan: null, error: "Couldn't reach Steam." });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(h.onRefresh).toHaveBeenCalledTimes(1);
  });
});

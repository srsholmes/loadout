import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { RuleBuilder } from "./RuleBuilder";
import { buildEvalGames } from "../lib/facts";
import { LIBRARY } from "../test/fixtures/library";
import type { GroupRule, Rule, Tab } from "../lib/types";

const games = buildEvalGames(LIBRARY);
const NOW = 1_800_000_000_000;

function tab(children: Rule[], combinator: "all" | "any" = "all"): Tab {
  const root: GroupRule = { id: "root", kind: "group", combinator, children };
  return {
    id: "t1",
    label: "Test tab",
    visible: true,
    autoHide: false,
    root,
    sort: [{ field: "sortAs", dir: "asc" }],
    limit: null,
    group: { kind: "none" },
    display: { tileWidth: 150, showLabels: true, badges: [] },
    mirror: { enabled: false, collectionName: "" },
    indeterminatePolicy: "pass",
  };
}

function renderBuilder(t: Tab) {
  const onSave = mock((_: Tab) => {});
  const onCancel = mock(() => {});
  const view = render(
    <RuleBuilder tab={t} games={games} onSave={onSave} onCancel={onCancel} now={NOW} />,
  );
  return { onSave, onCancel, view };
}

/** Open the overflow menu for the row whose visible label matches. */
function openRowMenu(name: RegExp) {
  fireEvent.click(screen.getByRole("button", { name }));
}

describe("RuleBuilder — the combinator consequence line", () => {
  it("shows BOTH outcomes at once, so the AND/OR mistake cannot be made unknowingly", () => {
    // `installed` AND `not installed` is empty under ALL and non-empty under
    // ANY — exactly TabMaster's most-reported failure.
    renderBuilder(
      tab([
        { id: "a", kind: "installed" },
        { id: "b", kind: "installed", invert: true },
      ]),
    );

    const all = screen.getByText(/ALL → \d+ games?/);
    const any = screen.getByText(/ANY → \d+ games?/);
    expect(all.textContent).toContain("ALL → 0 games");
    expect(any.textContent).not.toContain("ANY → 0 games");
  });

  it("prices both combinators for every group, not just the root", () => {
    renderBuilder(
      tab([
        { id: "a", kind: "installed" },
        {
          id: "g2",
          kind: "group",
          combinator: "any",
          children: [{ id: "b", kind: "owned" }],
        },
      ]),
    );
    expect(screen.getAllByText(/ALL → \d+ games?/)).toHaveLength(2);
  });

  it("switching the combinator updates the tab total", () => {
    renderBuilder(
      tab([
        { id: "a", kind: "installed" },
        { id: "b", kind: "installed", invert: true },
      ]),
    );
    const before = screen.getByText(/^\d+ games?$/).textContent;
    // Two radios per group; the root's ANY is the second.
    fireEvent.click(screen.getAllByRole("radio", { name: "any" })[0] as HTMLElement);
    expect(screen.getByText(/^\d+ games?$/).textContent).not.toBe(before);
  });
});

describe("RuleBuilder — per-rule counts", () => {
  it("shows a count on every rule row without needing a save", () => {
    renderBuilder(tab([{ id: "a", kind: "installed" }]));
    const row = screen.getByText("Installed").closest("li");
    if (!row) throw new Error("expected a rule row");
    // The count badge is a plain number beside the summary.
    expect(within(row).getByText(/^\d+$/)).toBeTruthy();
  });

  it("marks a rule that has no value yet rather than showing a bogus count", () => {
    renderBuilder(tab([{ id: "a", kind: "collection", collectionIds: [], mode: "anyOf" }]));
    expect(screen.getByText(/needs a value/i)).toBeTruthy();
  });
});

describe("RuleBuilder — editing is a draft", () => {
  it("does not save until Save is pressed", () => {
    const { onSave } = renderBuilder(tab([{ id: "a", kind: "installed" }]));
    openRowMenu(/Actions for Installed/);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("hands the edited tab to onSave", () => {
    const { onSave } = renderBuilder(tab([{ id: "a", kind: "installed" }]));
    openRowMenu(/Actions for Installed/);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Save tab" }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0]?.[0] as Tab;
    expect(saved.root.children).toHaveLength(0);
  });

  it("Cancel reports without saving", () => {
    const { onCancel, onSave } = renderBuilder(tab([{ id: "a", kind: "installed" }]));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("RuleBuilder — row actions", () => {
  it("moves a rule down, and the order is reflected in the saved tab", () => {
    const { onSave } = renderBuilder(
      tab([
        { id: "a", kind: "installed" },
        { id: "b", kind: "owned" },
      ]),
    );
    openRowMenu(/Actions for Installed/);
    fireEvent.click(screen.getByRole("button", { name: "Move down" }));
    fireEvent.click(screen.getByRole("button", { name: "Save tab" }));

    const saved = onSave.mock.calls[0]?.[0] as Tab;
    expect(saved.root.children.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("hides Move up on the first row rather than offering an inert button", () => {
    renderBuilder(
      tab([
        { id: "a", kind: "installed" },
        { id: "b", kind: "owned" },
      ]),
    );
    openRowMenu(/Actions for Installed/);
    expect(screen.queryByRole("button", { name: "Move up" })).toBeNull();
    expect(screen.getByRole("button", { name: "Move down" })).toBeTruthy();
  });

  it("wraps a rule in a group that inherits the opposite combinator", () => {
    const { onSave } = renderBuilder(tab([{ id: "a", kind: "installed" }], "all"));
    openRowMenu(/Actions for Installed/);
    fireEvent.click(screen.getByRole("button", { name: "Wrap in group" }));
    fireEvent.click(screen.getByRole("button", { name: "Save tab" }));

    const saved = onSave.mock.calls[0]?.[0] as Tab;
    const wrapper = saved.root.children[0] as GroupRule;
    expect(wrapper.kind).toBe("group");
    expect(wrapper.combinator).toBe("any");
  });

  it("duplicates a rule with a fresh id, so the copies are independent", () => {
    const { onSave } = renderBuilder(tab([{ id: "a", kind: "installed" }]));
    openRowMenu(/Actions for Installed/);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    fireEvent.click(screen.getByRole("button", { name: "Save tab" }));

    const saved = onSave.mock.calls[0]?.[0] as Tab;
    const ids = saved.root.children.map((c) => c.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("offers no invert on a whitelist, where inverting is the other rule", () => {
    renderBuilder(tab([{ id: "w", kind: "whitelist", appIds: ["1"] }]));
    openRowMenu(/Actions for Only these games/);
    expect(screen.queryByRole("button", { name: "Invert" })).toBeNull();
  });
});

describe("RuleBuilder — the palette", () => {
  it("prices each candidate before it is added", () => {
    renderBuilder(tab([]));
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));

    // The palette opens as its own page and every priceable candidate carries
    // a consequence — this is the whole point of the preview.
    const dialog = screen.getByRole("region", { name: "Add a rule" });
    expect(within(dialog).getAllByText(/→ \d+ games?/).length).toBeGreaterThan(0);
  });

  it("says so rather than showing a number when a rule needs a value", () => {
    renderBuilder(tab([]));
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    const dialog = screen.getByRole("region", { name: "Add a rule" });
    expect(within(dialog).getAllByText("Needs a value").length).toBeGreaterThan(0);
  });

  it("labels a fact-backed rule instead of pricing it at the whole library", () => {
    // Regression, found on hardware: an unresolvable fact is `indeterminate`,
    // and the default "pass" policy turns that into every game — so the
    // palette read "Friends playing now → 2002 games (no change)" for a rule
    // that cannot be checked at all. The opposite of the truth.
    renderBuilder(tab([]));
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    const dialog = screen.getByRole("region", { name: "Add a rule" });

    const card = within(dialog).getByText("Friends playing now").closest("button");
    if (!card) throw new Error("expected a Friends playing now candidate");
    expect(card.textContent).toContain("Needs Steam friends data");
    expect(card.textContent).not.toContain("no change");
    expect(card.textContent).not.toMatch(/→ \d+ games/);
  });

  it("prices a fact-backed rule once its fact is available", () => {
    render(
      <RuleBuilder
        tab={tab([])}
        games={games}
        onSave={() => {}}
        onCancel={() => {}}
        availableFacts={new Set(["friendsPlaying"] as const)}
        now={NOW}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    const dialog = screen.getByRole("region", { name: "Add a rule" });
    const card = within(dialog).getByText("Friends playing now").closest("button");
    expect(card?.textContent).not.toContain("Needs Steam friends data");
  });

  it("adds the picked rule to the tree", () => {
    const { onSave } = renderBuilder(tab([]));
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    const dialog = screen.getByRole("region", { name: "Add a rule" });
    fireEvent.click(within(dialog).getByText("Installed").closest("button") as HTMLElement);

    fireEvent.click(screen.getByRole("button", { name: "Save tab" }));
    const saved = onSave.mock.calls[0]?.[0] as Tab;
    expect(saved.root.children).toHaveLength(1);
    expect(saved.root.children[0]?.kind).toBe("installed");
  });
});

describe("RuleBuilder — diagnostics", () => {
  it("explains an empty tab instead of rendering a blank tree", () => {
    renderBuilder(
      tab([
        { id: "a", kind: "installed" },
        { id: "b", kind: "installed", invert: true },
      ]),
    );
    // `diagnoseTab` finds the contradiction empirically from the leaf masks.
    // Asserted on the alert's whole text, since the message is composed of
    // several spans and no single node carries the sentence.
    const alert = screen.getByRole("alert");
    expect(alert.textContent ?? "").toMatch(/never both|ANY|remove|empty/i);
  });

  it("offers a one-tap fix that actually repairs the tab", () => {
    const { onSave } = renderBuilder(
      tab([
        { id: "a", kind: "installed" },
        { id: "b", kind: "installed", invert: true },
      ]),
    );
    // Fixes render beside the alert, not inside it.
    fireEvent.click(screen.getByRole("button", { name: /^Switch to ANY/ }));

    fireEvent.click(screen.getByRole("button", { name: "Save tab" }));
    const saved = onSave.mock.calls[0]?.[0] as Tab;
    // Whatever the fix did, the tab must no longer be self-contradictory.
    const stillBoth =
      saved.root.combinator === "all" && saved.root.children.length === 2;
    expect(stillBoth).toBe(false);
  });
});

describe("RuleBuilder — generated rule ids", () => {
  /** Every rule id in the saved tab, flattened. */
  function idsOf(rule: Rule): string[] {
    return rule.kind === "group"
      ? [rule.id, ...rule.children.flatMap(idsOf)]
      : [rule.id];
  }

  it("gives every rule in a duplicated group its own id", () => {
    // `newId` read a state counter through a closure, so the several calls
    // `cloneWithNewIds` makes inside one handler all saw the same pre-render
    // value and merely queued an increment. A duplicated group came back with
    // every rule sharing one id: React warned about duplicate keys, editing
    // one copy hit an arbitrary sibling, and the trace map collided so the
    // copies showed each other's counts.
    const { onSave } = renderBuilder(tab([{ id: "a", kind: "installed" }]));

    // Wrap into a group so there is a group to duplicate, then duplicate it.
    openRowMenu(/Actions for Installed/);
    fireEvent.click(screen.getByRole("button", { name: "Wrap in group" }));
    openRowMenu(/Actions for group/);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    fireEvent.click(screen.getByRole("button", { name: "Save tab" }));

    const saved = onSave.mock.calls[0]?.[0] as Tab;
    const ids = idsOf(saved.root);
    expect(ids.length).toBeGreaterThan(3);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives consecutive rules distinct ids within one tick", () => {
    // The ids embed `Date.now()`, which is constant across a burst — so the
    // counter is the only thing keeping them apart.
    const { onSave } = renderBuilder(tab([{ id: "a", kind: "installed" }]));
    for (let i = 0; i < 3; i++) {
      // After the first duplicate several rows share a label, so address the
      // first menu explicitly rather than by an ambiguous name lookup.
      fireEvent.click(screen.getAllByRole("button", { name: /Actions for Installed/ })[0]!);
      fireEvent.click(screen.getAllByRole("button", { name: "Duplicate" })[0]!);
    }
    fireEvent.click(screen.getByRole("button", { name: "Save tab" }));

    const saved = onSave.mock.calls[0]?.[0] as Tab;
    const ids = idsOf(saved.root);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

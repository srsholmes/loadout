import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { PluginHeaderSlotProvider } from "@loadout/ui";
import { tryRunBackInterceptor } from "@loadout/ui";
import { BuilderPage } from "./BuilderPage";

/**
 * Render inside a header slot.
 *
 * `BuilderPage` portals its title and Back into the shell's topbar, and
 * `PluginHeader` renders nothing when no slot is wired — so without this the
 * Back control simply does not exist under test.
 */
function renderWithHeader(ui: React.ReactElement) {
  const slot = document.createElement("div");
  document.body.appendChild(slot);
  return render(<PluginHeaderSlotProvider slot={slot}>{ui}</PluginHeaderSlotProvider>);
}

function open(props: Partial<Parameters<typeof BuilderPage>[0]> = {}) {
  const onBack = mock(() => {});
  const view = renderWithHeader(
    <BuilderPage title="Add a rule" onBack={onBack} {...props}>
      <button type="button">Inside</button>
    </BuilderPage>,
  );
  return { onBack, view };
}

describe("BuilderPage", () => {
  it("shows a spinner in the topbar while work is in flight", () => {
    // The alternative is a page that stops responding with nothing to say why
    // — and a press that shows no sign of having registered gets pressed
    // again.
    const { view } = open({ busy: true });
    expect(view.baseElement.querySelector(".loading")).toBeTruthy();
  });

  it("has no spinner when it is idle", () => {
    const { view } = open();
    expect(view.baseElement.querySelector(".loading")).toBeNull();
  });

  it("is a labelled region, not a dialog — the app is already an overlay", () => {
    open();
    expect(screen.getByRole("region", { name: "Add a rule" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("has no fixed-position scrim to escape the plugin's bounds", () => {
    const { view } = open();
    const fixed = view.container.querySelectorAll('[class*="fixed"]');
    expect(fixed).toHaveLength(0);
  });

  it("goes back on Escape, which the docked keyboard path depends on", () => {
    const { onBack } = open();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("ignores other keys", () => {
    const { onBack } = open();
    fireEvent.keyDown(document, { key: "a" });
    expect(onBack).not.toHaveBeenCalled();
  });

  it("goes back from the explicit control", () => {
    const { onBack } = open();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("takes a custom back label, so a rule editor can say Cancel", () => {
    open({ backLabel: "Cancel" });
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("consumes B so it pops this page rather than the whole plugin", () => {
    const { onBack } = open();
    expect(tryRunBackInterceptor()).toBe(true);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("releases the interceptor on unmount, leaving Back alone", () => {
    const { view } = open();
    view.unmount();
    expect(tryRunBackInterceptor()).toBe(false);
  });

  it("focuses the first control in the content, not the Back button", () => {
    open();
    // Landing on Back would offer "leave" as the opening move of an edit.
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Inside" }),
    );
  });

  it("renders a description and a footer when given them", () => {
    open({
      description: "Each option shows what your tab would contain",
      footer: <button type="button">Save rule</button>,
    });
    expect(
      screen.getByText("Each option shows what your tab would contain"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save rule" })).toBeTruthy();
  });
});

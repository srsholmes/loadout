import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { tryRunBackInterceptor } from "@loadout/ui";
import { Sheet } from "./Sheet";

function open(props: Partial<Parameters<typeof Sheet>[0]> = {}) {
  const onClose = mock(() => {});
  const view = render(
    <Sheet open title="Edit rule" onClose={onClose} {...props}>
      <button type="button">Inside</button>
    </Sheet>,
  );
  return { onClose, view };
}

describe("Sheet", () => {
  it("renders nothing when closed", () => {
    render(
      <Sheet open={false} title="Edit rule" onClose={() => {}}>
        <span>Body</span>
      </Sheet>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is a modal dialog labelled by its title", () => {
    open();
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe("Edit rule");
  });

  it("closes on Escape, which the docked keyboard path depends on", () => {
    const { onClose } = open();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores other keys", () => {
    const { onClose } = open();
    fireEvent.keyDown(document, { key: "a" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes when the backdrop is pressed", () => {
    const { onClose } = open();
    const dialog = screen.getByRole("dialog");
    const backdrop = dialog.parentElement;
    if (!backdrop) throw new Error("expected a backdrop wrapper");
    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close on a press that lands inside the panel", () => {
    const { onClose } = open();
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes from the explicit Close button", () => {
    const { onClose } = open();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("registers a back interceptor while open, so B does not pop the page", () => {
    const { onClose } = open();
    // Consuming the press is the contract — returning false would let the
    // shell navigate away from the plugin underneath the sheet.
    expect(tryRunBackInterceptor()).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("disposes the interceptor on unmount, leaving Back alone", () => {
    const { view } = open();
    view.unmount();
    expect(tryRunBackInterceptor()).toBe(false);
  });

  it("disposes the interceptor when it closes without unmounting", () => {
    const onClose = mock(() => {});
    const view = render(
      <Sheet open title="Edit rule" onClose={onClose}>
        <button type="button">Inside</button>
      </Sheet>,
    );
    view.rerender(
      <Sheet open={false} title="Edit rule" onClose={onClose}>
        <button type="button">Inside</button>
      </Sheet>,
    );
    expect(tryRunBackInterceptor()).toBe(false);
  });

  it("moves focus into the sheet on open", () => {
    open();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Inside" }));
  });

  it("restores focus to whatever had it when the sheet closes", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open";
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const view = render(
      <Sheet open title="Edit rule" onClose={() => {}}>
        <button type="button">Inside</button>
      </Sheet>,
    );
    view.unmount();

    // Without this, closing a rule editor drops a gamepad user at the top of
    // the page instead of back on the row they were editing.
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("renders a footer when given one", () => {
    open({ footer: <button type="button">Save rule</button> });
    expect(screen.getByRole("button", { name: "Save rule" })).toBeTruthy();
  });

  it("associates a description with the dialog", () => {
    open({ description: "Pick what this rule matches" });
    const dialog = screen.getByRole("dialog");
    const id = dialog.getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    expect(document.getElementById(id ?? "")?.textContent).toBe(
      "Pick what this rule matches",
    );
  });
});

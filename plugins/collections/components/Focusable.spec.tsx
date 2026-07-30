/**
 * Every interactive control in the rule builder must join the shell's focus
 * tree, because that tree *is* the D-pad on a handheld.
 *
 * This shipped broken: "Add rule", both ⋮ menus and every value editor were
 * plain `<button>`/`<input>` elements. They are clickable with a mouse, so
 * every existing spec passed, while on the device you could read the builder
 * and never build anything.
 *
 * These tests install a recorder in place of the shell's `SpatialNavigation`
 * singleton and assert on what actually registered. Asserting that a click
 * handler fires would reproduce the original blind spot exactly.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { FocusButton, FocusInput } from "./Focusable";

interface Registration {
  focusKey: string;
  node: unknown;
  focusable?: boolean;
}

let registered: Registration[] = [];
let prevNav: unknown;

beforeEach(() => {
  registered = [];
  prevNav = (window as unknown as Record<string, unknown>).__SPATIAL_NAV__;
  (window as unknown as Record<string, unknown>).__SPATIAL_NAV__ = {
    addFocusable: (args: Registration) => registered.push(args),
    removeFocusable: ({ focusKey }: { focusKey: string }) => {
      registered = registered.filter((r) => r.focusKey !== focusKey);
    },
    updateAllLayouts: () => {},
    setFocus: () => {},
    getCurrentFocusKey: () => "",
    updateFocusable: () => {},
    pause: () => {},
    resume: () => {},
  };
});

afterEach(() => {
  (window as unknown as Record<string, unknown>).__SPATIAL_NAV__ = prevNav;
});

describe("FocusButton", () => {
  it("registers with the shell's focus tree", () => {
    render(<FocusButton onClick={() => {}}>Add rule</FocusButton>);
    expect(registered).toHaveLength(1);
  });

  it("still works as an ordinary button", () => {
    const onClick = mock(() => {});
    render(<FocusButton onClick={onClick}>Add rule</FocusButton>);
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("is registered as unfocusable when disabled, so the D-pad skips it", () => {
    // The singleton always registers and reads the `focusable` flag to decide
    // whether to stop on a node — so the assertion is on the flag, not on
    // absence from the tree.
    render(
      <FocusButton onClick={() => {}} disabled>
        Add
      </FocusButton>,
    );
    expect(registered).toHaveLength(1);
    expect(registered[0]!.focusable).toBe(false);
  });

  it("is focusable when enabled", () => {
    render(<FocusButton onClick={() => {}}>Add</FocusButton>);
    expect(registered[0]!.focusable).toBe(true);
  });

  it("does not fire when disabled", () => {
    const onClick = mock(() => {});
    render(
      <FocusButton onClick={onClick} disabled>
        Add
      </FocusButton>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("carries the accessible name and state through", () => {
    render(
      <FocusButton onClick={() => {}} ariaLabel="Actions for group" ariaExpanded={true}>
        ⋮
      </FocusButton>,
    );
    const btn = screen.getByRole("button", { name: "Actions for group" });
    expect(btn.getAttribute("aria-expanded")).toBe("true");
  });

  it("supports the chip's radio/checkbox role", () => {
    render(
      <FocusButton onClick={() => {}} role="checkbox" ariaChecked={true}>
        Installed
      </FocusButton>,
    );
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
  });

  it("unregisters when it goes away", () => {
    const { unmount } = render(<FocusButton onClick={() => {}}>X</FocusButton>);
    expect(registered).toHaveLength(1);
    unmount();
    expect(registered).toHaveLength(0);
  });
});

describe("FocusInput", () => {
  it("registers with the shell's focus tree", () => {
    render(<FocusInput value="" onChange={() => {}} ariaLabel="Minimum" />);
    expect(registered).toHaveLength(1);
  });

  it("reports what was typed", () => {
    const onChange = mock((_: string) => {});
    render(<FocusInput value="" onChange={onChange} ariaLabel="Minimum" />);
    fireEvent.change(screen.getByLabelText("Minimum"), { target: { value: "30" } });
    expect(onChange).toHaveBeenCalledWith("30");
  });

  it("submits on Enter when the caller wants it", () => {
    const onEnter = mock(() => {});
    render(<FocusInput value="a" onChange={() => {}} ariaLabel="Tag" onEnter={onEnter} />);
    fireEvent.keyDown(screen.getByLabelText("Tag"), { key: "Enter" });
    expect(onEnter).toHaveBeenCalledTimes(1);
  });
});

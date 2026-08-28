import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen } from "../../../../test/render";

/**
 * The focus ring is the whole point of these tests.
 *
 * SegmentedItem took `ref` from useFocusable and dropped `focused`, and there
 * is no `:focus` rule for `.segmented > button` in the shell CSS — so a
 * controller could move through a segmented control with nothing on screen
 * changing. Reachable, but indistinguishable from not being navigable at all.
 *
 * `focused` is driven by norigin-spatial-navigation at runtime, so it's
 * mocked here rather than simulated.
 */
let focusedNow = false;
mock.module("../spatial-nav", () => ({
  useFocusable: () => ({
    ref: { current: null },
    focused: focusedNow,
    focusSelf: () => {},
    hasFocusedChild: false,
    focusKey: "k",
  }),
}));

const { SegmentedItem } = await import("./Segmented");

beforeEach(() => {
  focusedNow = false;
  document.body.innerHTML = "";
});

describe("SegmentedItem", () => {
  it("shows nothing extra when it isn't focused", () => {
    render(
      <SegmentedItem active={false} onSelect={() => {}}>
        Off
      </SegmentedItem>,
    );
    const btn = screen.getByRole("button");
    expect(btn.style.animation).toBe("");
    expect(btn.className).not.toContain("scale-[1.02]");
  });

  it("renders a visible focus ring when focused", () => {
    focusedNow = true;
    render(
      <SegmentedItem active={false} onSelect={() => {}}>
        Off
      </SegmentedItem>,
    );
    const btn = screen.getByRole("button");
    expect(btn.style.animation).toContain("focusPulse");
    expect(btn.className).toContain("scale-[1.02]");
  });

  it("shows the focus ring on a cell that isn't the selected one", () => {
    // The failure mode being guarded: `active` styling made it *look* like
    // focus was visible, while moving onto any other cell showed nothing.
    focusedNow = true;
    render(
      <SegmentedItem active={false} onSelect={() => {}}>
        3
      </SegmentedItem>,
    );
    const btn = screen.getByRole("button");
    expect(btn.className).not.toContain("active");
    expect(btn.style.animation).toContain("focusPulse");
  });

  it("keeps caller-supplied style and className alongside the ring", () => {
    focusedNow = true;
    render(
      <SegmentedItem active onSelect={() => {}} className="flex-1" style={{ color: "red" }}>
        5
      </SegmentedItem>,
    );
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("flex-1");
    expect(btn.className).toContain("active");
    expect(btn.style.color).toBe("red");
    expect(btn.style.animation).toContain("focusPulse");
  });
});

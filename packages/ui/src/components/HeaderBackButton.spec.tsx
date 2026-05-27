import { describe, it, expect, mock, afterEach } from "bun:test";
import { render, screen, fireEvent } from "../../../../test/render";
import { HeaderBackButton, useHeaderBack } from "./HeaderBackButton";
import { tryRunBackInterceptor } from "../spatial-nav";

// HeaderBackButton pushes onto the global back interceptor stack
// (window.__SL_BACK_INTERCEPTORS__). Make sure the stack is empty
// between tests so they don't influence one another.
afterEach(() => {
  (window as unknown as {
    __SL_BACK_INTERCEPTORS__?: Array<() => boolean>;
  }).__SL_BACK_INTERCEPTORS__ = [];
});

describe("HeaderBackButton", () => {
  it("renders a button with the default 'Back' title and aria-label", () => {
    render(<HeaderBackButton onBack={() => {}} />);
    const btn = screen.getByRole("button");
    expect(btn).toBeTruthy();
    expect(btn.getAttribute("title")).toBe("Back");
    expect(btn.getAttribute("aria-label")).toBe("Back");
  });

  it("respects a custom title and falls back to title for aria-label", () => {
    render(<HeaderBackButton onBack={() => {}} title="Back to library" />);
    const btn = screen.getByRole("button");
    expect(btn.getAttribute("title")).toBe("Back to library");
    expect(btn.getAttribute("aria-label")).toBe("Back to library");
  });

  it("uses an explicit ariaLabel override when provided", () => {
    render(
      <HeaderBackButton
        onBack={() => {}}
        title="Back"
        ariaLabel="Return to game list"
      />,
    );
    expect(
      screen.getByRole("button").getAttribute("aria-label"),
    ).toBe("Return to game list");
  });

  it("calls onBack when clicked", () => {
    const onBack = mock();
    render(<HeaderBackButton onBack={onBack} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("pushes a back interceptor that runs onBack on B/Escape", () => {
    const onBack = mock();
    render(<HeaderBackButton onBack={onBack} />);
    // Simulate the shell's back chain firing.
    const handled = tryRunBackInterceptor();
    expect(handled).toBe(true);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("pops the interceptor on unmount so further back presses fall through", () => {
    const onBack = mock();
    const { unmount } = render(<HeaderBackButton onBack={onBack} />);
    unmount();
    const handled = tryRunBackInterceptor();
    expect(handled).toBe(false);
    expect(onBack).not.toHaveBeenCalled();
  });

  it("useHeaderBack always invokes the latest onBack closure", () => {
    let latest = 0;
    const first = mock(() => {
      latest = 1;
    });
    const second = mock(() => {
      latest = 2;
    });
    function Harness({ cb }: { cb: () => void }) {
      useHeaderBack(cb);
      return null;
    }
    const { rerender } = render(<Harness cb={first} />);
    rerender(<Harness cb={second} />);
    tryRunBackInterceptor();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(latest).toBe(2);
  });
});

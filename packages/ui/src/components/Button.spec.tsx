import { describe, it, expect, mock } from "bun:test";
import { render, screen } from "../../../../test/render";
import { Button } from "./Button";

describe("Button", () => {
  it("renders children text", () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole("button", { name: "Click me" })).toBeTruthy();
  });

  it("calls onClick when clicked", () => {
    const fn = mock();
    render(<Button onClick={fn}>Go</Button>);
    screen.getByRole("button").click();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not call onClick when disabled", () => {
    const fn = mock();
    render(
      <Button onClick={fn} disabled>
        Nope
      </Button>,
    );
    screen.getByRole("button").click();
    expect(fn).not.toHaveBeenCalled();
  });

  it("applies primary variant class", () => {
    render(<Button variant="primary">Primary</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("btn-primary");
    expect(btn.className).not.toContain("btn-outline");
  });

  it("applies danger variant class", () => {
    render(<Button variant="danger">Danger</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("btn-error");
  });

  it("applies soft variant class when no variant specified", () => {
    render(<Button>Default</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("btn-soft");
  });

  it("sets the disabled attribute on the button element", () => {
    render(<Button disabled>Disabled</Button>);
    const btn = screen.getByRole("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("applies custom style", () => {
    render(<Button style={{ color: "red" }}>Styled</Button>);
    const btn = screen.getByRole("button") as HTMLButtonElement;
    expect(btn.style.color).toBe("red");
  });
});

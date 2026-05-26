import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Button } from "./Button";

describe("Button", () => {
  afterEach(() => cleanup());

  it("renders children", () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole("button").textContent).toBe("Click me");
  });

  it("invokes onClick on click", () => {
    let count = 0;
    render(<Button onClick={() => count++}>Tap</Button>);
    fireEvent.click(screen.getByRole("button"));
    expect(count).toBe(1);
  });

  it("does not invoke onClick when disabled", () => {
    let count = 0;
    render(
      <Button onClick={() => count++} disabled>
        Tap
      </Button>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(count).toBe(0);
  });

  it("applies primary variant class", () => {
    render(<Button variant="primary">Go</Button>);
    expect(screen.getByRole("button").className).toContain("btn-primary");
  });

  it("applies sm size class", () => {
    render(<Button size="sm">Go</Button>);
    expect(screen.getByRole("button").className).toContain("btn-sm");
  });
});

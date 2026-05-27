import { describe, it, expect } from "vitest";
import { render } from "../../../../test/render";
import { Spinner } from "./Spinner";

describe("Spinner", () => {
  it("renders a span element", () => {
    const { container } = render(<Spinner />);
    const span = container.querySelector("span");
    expect(span).toBeTruthy();
  });

  it("applies loading spinner classes", () => {
    const { container } = render(<Spinner />);
    const span = container.querySelector("span")!;
    expect(span.className).toContain("loading");
    expect(span.className).toContain("loading-spinner");
  });

  it("uses default size of 20px", () => {
    const { container } = render(<Spinner />);
    const span = container.querySelector("span") as HTMLElement;
    expect(span.style.width).toBe("20px");
    expect(span.style.height).toBe("20px");
  });

  it("accepts a custom size prop", () => {
    const { container } = render(<Spinner size={40} />);
    const span = container.querySelector("span") as HTMLElement;
    expect(span.style.width).toBe("40px");
    expect(span.style.height).toBe("40px");
  });

  it("applies primary text color class", () => {
    const { container } = render(<Spinner />);
    const span = container.querySelector("span")!;
    expect(span.className).toContain("text-primary");
  });

  it("supports the dots variant via the `variant` prop", () => {
    const { container } = render(<Spinner variant="dots" />);
    const span = container.querySelector("span")!;
    expect(span.className).toContain("loading-dots");
    expect(span.className).not.toContain("loading-spinner");
  });

  it("accepts a named DaisyUI size for the dots variant", () => {
    const { container } = render(<Spinner variant="dots" size="md" />);
    const span = container.querySelector("span") as HTMLElement;
    expect(span.className).toContain("loading-md");
    // Named sizes don't set inline width/height — that's only the
    // spinner-variant's path.
    expect(span.style.width).toBe("");
  });

  it("defaults `size` to `md` when variant is `dots`", () => {
    const { container } = render(<Spinner variant="dots" />);
    const span = container.querySelector("span")!;
    expect(span.className).toContain("loading-md");
  });
});

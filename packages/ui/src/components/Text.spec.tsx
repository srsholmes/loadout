import { describe, it, expect } from "bun:test";
import { render, screen } from "../../../../test/render";
import { Text } from "./Text";

describe("Text", () => {
  it("renders children text", () => {
    render(<Text>Hello world</Text>);
    expect(screen.getByText("Hello world")).toBeTruthy();
  });

  it("renders as a p element", () => {
    const { container } = render(<Text>Paragraph</Text>);
    expect(container.querySelector("p")).toBeTruthy();
  });

  it("applies body variant class by default", () => {
    const { container } = render(<Text>Default</Text>);
    const p = container.querySelector("p")!;
    expect(p.className).toContain("text-sm");
    expect(p.className).toContain("text-base-content");
    expect(p.className).not.toContain("text-base-content/50");
  });

  it("applies secondary variant class", () => {
    const { container } = render(<Text variant="secondary">Muted</Text>);
    const p = container.querySelector("p")!;
    expect(p.className).toContain("text-base-content/50");
  });

  it("applies heading variant class", () => {
    const { container } = render(<Text variant="heading">Title</Text>);
    const p = container.querySelector("p")!;
    expect(p.className).toContain("text-lg");
    expect(p.className).toContain("font-semibold");
  });

  it("applies custom inline style", () => {
    const { container } = render(
      <Text style={{ marginTop: 20 }}>Styled</Text>,
    );
    const p = container.querySelector("p") as HTMLElement;
    expect(p.style.marginTop).toBe("20px");
  });

  it("renders complex children", () => {
    render(
      <Text>
        <strong>Bold</strong> text
      </Text>,
    );
    expect(screen.getByText("Bold")).toBeTruthy();
  });
});

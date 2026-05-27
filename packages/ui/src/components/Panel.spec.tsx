import { describe, it, expect } from "bun:test";
import { render, screen } from "../../../../test/render";
import { Panel } from "./Panel";

describe("Panel", () => {
  it("renders children", () => {
    render(<Panel>Hello content</Panel>);
    expect(screen.getByText("Hello content")).toBeTruthy();
  });

  it("renders title when provided", () => {
    render(<Panel title="Settings">Content</Panel>);
    expect(screen.getByText("Settings")).toBeTruthy();
  });

  it("does not render a heading element when title is omitted", () => {
    const { container } = render(<Panel>No title</Panel>);
    expect(container.querySelector("h3")).toBeNull();
  });

  it("renders title in an h3 element", () => {
    const { container } = render(<Panel title="My Panel">Body</Panel>);
    const heading = container.querySelector("h3");
    expect(heading).toBeTruthy();
    expect(heading!.textContent).toBe("My Panel");
  });

  it("applies panel styling classes", () => {
    const { container } = render(<Panel>Styled</Panel>);
    const div = container.firstElementChild as HTMLElement;
    expect(div.className).toContain("bg-base-200");
    expect(div.className).toContain("rounded-2xl");
  });

  it("renders multiple children", () => {
    render(
      <Panel>
        <span>First</span>
        <span>Second</span>
      </Panel>,
    );
    expect(screen.getByText("First")).toBeTruthy();
    expect(screen.getByText("Second")).toBeTruthy();
  });
});

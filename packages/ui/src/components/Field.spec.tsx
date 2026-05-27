import { describe, it, expect } from "vitest";
import { render, screen } from "../../../../test/render";
import { Field } from "./Field";

describe("Field", () => {
  it("renders the label text", () => {
    render(<Field label="CPU">AMD Ryzen</Field>);
    expect(screen.getByText("CPU")).toBeTruthy();
  });

  it("renders children as the value", () => {
    render(<Field label="Status">Online</Field>);
    expect(screen.getByText("Online")).toBeTruthy();
  });

  it("renders label and children in separate spans", () => {
    const { container } = render(<Field label="Name">Simon</Field>);
    const spans = container.querySelectorAll("span");
    expect(spans.length).toBe(2);
    expect(spans[0].textContent).toBe("Name");
    expect(spans[1].textContent).toBe("Simon");
  });

  it("applies flex layout for horizontal alignment", () => {
    const { container } = render(<Field label="Key">Value</Field>);
    const row = container.firstElementChild as HTMLElement;
    expect(row.className).toContain("flex");
    expect(row.className).toContain("justify-between");
  });

  it("renders complex children (JSX elements)", () => {
    render(
      <Field label="Health">
        <span className="badge">95%</span>
      </Field>,
    );
    expect(screen.getByText("95%")).toBeTruthy();
  });
});

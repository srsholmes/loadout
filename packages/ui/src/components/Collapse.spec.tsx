import { describe, it, expect } from "bun:test";
import { render, screen, fireEvent } from "../../../../test/render";
import { Collapse } from "./Collapse";

describe("Collapse", () => {
  it("renders the title", () => {
    render(
      <Collapse title="Sensors">
        <div>Body content</div>
      </Collapse>,
    );
    expect(screen.getByText("Sensors")).toBeTruthy();
  });

  it("is closed by default — body not rendered", () => {
    render(
      <Collapse title="T">
        <div>Body content</div>
      </Collapse>,
    );
    expect(screen.queryByText("Body content")).toBeNull();
  });

  it("renders the body when defaultOpen", () => {
    render(
      <Collapse title="T" defaultOpen>
        <div>Body content</div>
      </Collapse>,
    );
    expect(screen.getByText("Body content")).toBeTruthy();
  });

  it("toggles the body when the title row is activated", () => {
    render(
      <Collapse title="T" ariaLabel="Toggle T">
        <div>Body content</div>
      </Collapse>,
    );
    const toggle = screen.getByRole("button", { name: "Toggle T" });
    expect(screen.queryByText("Body content")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText("Body content")).toBeTruthy();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(screen.queryByText("Body content")).toBeNull();
  });

  it("exposes a focusable, controller-reachable header (role=button, tabindex, aria-expanded)", () => {
    render(
      <Collapse title="T" ariaLabel="Toggle T">
        <span>c</span>
      </Collapse>,
    );
    const toggle = screen.getByRole("button", { name: "Toggle T" });
    expect(toggle.getAttribute("tabindex")).toBe("0");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // Header is a centred flex row so the title aligns with the chevron.
    expect(toggle.className).toContain("items-center");
  });
});

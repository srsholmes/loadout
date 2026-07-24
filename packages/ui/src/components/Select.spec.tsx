import { describe, it, expect, mock } from "bun:test";
import { render, screen, fireEvent } from "../../../../test/render";
import { Select } from "./Select";

describe("Select", () => {
  it("renders the current value's label by default (closed)", () => {
    render(
      <Select
        value="b"
        options={["a", "b", "c"] as const}
        labels={{ a: "Alpha", b: "Bravo", c: "Charlie" }}
        onChange={() => {}}
      />,
    );
    // The trigger button shows the selected label, listbox is not open.
    expect(screen.getByRole("button", { name: /Bravo/ })).toBeTruthy();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("opens the listbox when the trigger is clicked", () => {
    render(
      <Select
        value="a"
        options={["a", "b"] as const}
        labels={{ a: "Alpha", b: "Bravo" }}
        onChange={() => {}}
      />,
    );
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Alpha/ }));
    expect(screen.getByRole("listbox")).toBeTruthy();
    // Both options are visible and have role="option".
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("closes the listbox when the trigger is clicked again", () => {
    render(
      <Select
        value="a"
        options={["a", "b"] as const}
        labels={{ a: "Alpha", b: "Bravo" }}
        onChange={() => {}}
      />,
    );
    const trigger = screen.getByRole("button", { name: /Alpha/ });
    fireEvent.click(trigger);
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.click(trigger);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("fires onChange with the option value when an option is clicked", () => {
    const onChange = mock();
    render(
      <Select
        value="a"
        options={["a", "b", "c"] as const}
        labels={{ a: "Alpha", b: "Bravo", c: "Charlie" }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Alpha/ }));
    fireEvent.click(screen.getByRole("option", { name: "Charlie" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("c");
  });

  it("closes the listbox after a selection", () => {
    render(
      <Select
        value="a"
        options={["a", "b"] as const}
        labels={{ a: "Alpha", b: "Bravo" }}
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Alpha/ }));
    fireEvent.click(screen.getByRole("option", { name: "Bravo" }));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes the listbox on outside mousedown", () => {
    render(
      <div>
        <span data-testid="outside">outside</span>
        <Select
          value="a"
          options={["a", "b"] as const}
          labels={{ a: "Alpha", b: "Bravo" }}
          onChange={() => {}}
        />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Alpha/ }));
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("marks the active option with aria-selected=true", () => {
    render(
      <Select
        value="b"
        options={["a", "b", "c"] as const}
        labels={{ a: "Alpha", b: "Bravo", c: "Charlie" }}
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Bravo/ }));
    const opts = screen.getAllByRole("option");
    const selected = opts.find(
      (o) => o.getAttribute("aria-selected") === "true",
    );
    expect(selected?.textContent).toBe("Bravo");
  });

  it("renders placeholder when the value matches no option", () => {
    render(
      <Select
        value={"missing" as unknown as "a"}
        options={["a", "b"] as const}
        labels={{ a: "Alpha", b: "Bravo" }}
        onChange={() => {}}
        placeholder="Pick one…"
      />,
    );
    expect(screen.getByRole("button", { name: /Pick one/ })).toBeTruthy();
  });

  it("renders the open menu in a portal, outside the trigger's wrapper", () => {
    // Regression: the menu must escape the Select's own DOM subtree so a
    // clipping ancestor (cards use overflow:hidden, pages scroll) can't crop
    // it. It's portaled to <body> with position:fixed.
    const { container } = render(
      <div style={{ overflow: "hidden" }}>
        <Select
          value="a"
          options={["a", "b"] as const}
          labels={{ a: "Alpha", b: "Bravo" }}
          onChange={() => {}}
        />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Alpha/ }));
    const listbox = screen.getByRole("listbox");
    // Not inside the rendered container (the clipping wrapper)…
    expect(container.contains(listbox)).toBe(false);
    // …and positioned fixed so it's viewport-relative, not clipped.
    expect(listbox.className).toContain("fixed");
  });

  it("supports {value, label} option objects", () => {
    const onChange = mock();
    render(
      <Select
        value="x"
        options={[
          { value: "x", label: "Ex" },
          { value: "y", label: "Why" },
        ] as const}
        onChange={onChange}
      />,
    );
    expect(screen.getByRole("button", { name: /Ex/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByRole("option", { name: "Why" }));
    expect(onChange).toHaveBeenCalledWith("y");
  });
});

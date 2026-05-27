import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "../../../../test/render";
import { Slider } from "./Slider";

describe("Slider", () => {
  it("renders a range input", () => {
    render(<Slider value={50} onChange={() => {}} />);
    const input = screen.getByRole("slider") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.type).toBe("range");
  });

  it("reflects the current value", () => {
    render(<Slider value={42} onChange={() => {}} />);
    const input = screen.getByRole("slider") as HTMLInputElement;
    expect(input.value).toBe("42");
  });

  it("uses provided min and max", () => {
    render(<Slider value={10} onChange={() => {}} min={5} max={20} />);
    const input = screen.getByRole("slider") as HTMLInputElement;
    expect(input.min).toBe("5");
    expect(input.max).toBe("20");
  });

  it("uses provided step", () => {
    render(<Slider value={10} onChange={() => {}} step={5} />);
    const input = screen.getByRole("slider") as HTMLInputElement;
    expect(input.step).toBe("5");
  });

  it("calls onChange with numeric value on change", () => {
    const fn = vi.fn();
    render(<Slider value={50} onChange={fn} />);
    const input = screen.getByRole("slider");
    fireEvent.change(input, { target: { value: "75" } });
    expect(fn).toHaveBeenCalledWith(75);
  });

  it("sets disabled attribute", () => {
    render(<Slider value={50} onChange={() => {}} disabled />);
    const input = screen.getByRole("slider") as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it("defaults min=0, max=100, step=1", () => {
    render(<Slider value={50} onChange={() => {}} />);
    const input = screen.getByRole("slider") as HTMLInputElement;
    expect(input.min).toBe("0");
    expect(input.max).toBe("100");
    expect(input.step).toBe("1");
  });

  it("applies accent color via style", () => {
    render(<Slider value={50} onChange={() => {}} accentColor="red" />);
    const input = screen.getByRole("slider") as HTMLInputElement;
    expect(input.style.accentColor).toBe("red");
  });
});

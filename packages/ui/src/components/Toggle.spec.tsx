import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "../../../../test/render";
import { Toggle } from "./Toggle";

describe("Toggle", () => {
  it("renders a checkbox input", () => {
    render(<Toggle checked={false} onChange={() => {}} />);
    expect(screen.getByRole("checkbox")).toBeTruthy();
  });

  it("reflects checked state", () => {
    render(<Toggle checked={true} onChange={() => {}} />);
    const input = screen.getByRole("checkbox") as HTMLInputElement;
    expect(input.checked).toBe(true);
  });

  it("reflects unchecked state", () => {
    render(<Toggle checked={false} onChange={() => {}} />);
    const input = screen.getByRole("checkbox") as HTMLInputElement;
    expect(input.checked).toBe(false);
  });

  it("calls onChange with toggled value on click", () => {
    const fn = vi.fn();
    render(<Toggle checked={false} onChange={fn} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(fn).toHaveBeenCalledWith(true);
  });

  it("calls onChange with false when unchecking", () => {
    const fn = vi.fn();
    render(<Toggle checked={true} onChange={fn} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(fn).toHaveBeenCalledWith(false);
  });

  it("does not call onChange when disabled", () => {
    const fn = vi.fn();
    render(<Toggle checked={false} onChange={fn} disabled />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(fn).not.toHaveBeenCalled();
  });

  it("applies small size class", () => {
    render(<Toggle checked={false} onChange={() => {}} size="small" />);
    const input = screen.getByRole("checkbox");
    expect(input.className).toContain("toggle-xs");
  });

  it("applies default size class", () => {
    render(<Toggle checked={false} onChange={() => {}} size="default" />);
    const input = screen.getByRole("checkbox");
    expect(input.className).toContain("toggle-sm");
  });
});

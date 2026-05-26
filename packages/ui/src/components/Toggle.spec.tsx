import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Toggle } from "./Toggle";

describe("Toggle", () => {
  afterEach(() => cleanup());

  it("reflects checked state", () => {
    render(<Toggle checked={true} onChange={() => {}} />);
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  });

  it("calls onChange with the inverse value", () => {
    const observed: boolean[] = [];
    render(<Toggle checked={false} onChange={(v) => observed.push(v)} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(observed).toEqual([true]);
  });

  it("doesn't fire onChange when disabled", () => {
    let value: boolean | null = null;
    render(<Toggle checked={false} disabled onChange={(v) => (value = v)} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(value).toBeNull();
  });
});

import { describe, it, expect, mock } from "bun:test";
import { render, screen, fireEvent } from "../../../../test/render";
import { TextInput } from "./TextInput";

describe("TextInput", () => {
  it("renders a text input", () => {
    render(<TextInput value="" onChange={() => {}} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.type).toBe("text");
  });

  it("reflects the current value", () => {
    render(<TextInput value="hello" onChange={() => {}} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("hello");
  });

  it("calls onChange with new value on input", () => {
    const fn = mock();
    render(<TextInput value="" onChange={fn} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "world" } });
    expect(fn).toHaveBeenCalledWith("world");
  });

  it("shows placeholder text", () => {
    render(
      <TextInput value="" onChange={() => {}} placeholder="Enter name..." />,
    );
    const input = screen.getByPlaceholderText("Enter name...");
    expect(input).toBeTruthy();
  });

  it("supports custom type", () => {
    const { container } = render(
      <TextInput value="" onChange={() => {}} type="password" />,
    );
    const input = container.querySelector("input") as HTMLInputElement;
    expect(input.type).toBe("password");
  });

  it("applies custom style", () => {
    const { container } = render(
      <TextInput value="" onChange={() => {}} style={{ width: 200 }} />,
    );
    const input = container.querySelector("input") as HTMLElement;
    expect(input.style.width).toBe("200px");
  });

  it("applies input styling classes", () => {
    const { container } = render(<TextInput value="" onChange={() => {}} />);
    const input = container.querySelector("input")!;
    expect(input.className).toContain("input");
    expect(input.className).toContain("input-bordered");
  });
});

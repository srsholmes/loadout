import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "../../../../test/render";
import { GameCard, collectionBadgeVariant } from "./GameCard";

describe("GameCard", () => {
  it("renders the primary image first", () => {
    const { container } = render(
      <GameCard
        imageUrl="https://example.invalid/header.jpg"
        fallbackImageUrl="https://example.invalid/capsule.jpg"
        title="Half-Life 2"
      />,
    );
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.src).toBe("https://example.invalid/header.jpg");
  });

  it("falls back to the fallbackImageUrl when the primary errors", () => {
    const { container } = render(
      <GameCard
        imageUrl="https://example.invalid/header.jpg"
        fallbackImageUrl="https://example.invalid/capsule.jpg"
        title="Half-Life 2"
      />,
    );
    const img = container.querySelector("img") as HTMLImageElement;
    fireEvent.error(img);
    const after = container.querySelector("img") as HTMLImageElement;
    expect(after).toBeTruthy();
    expect(after.src).toBe("https://example.invalid/capsule.jpg");
  });

  it("falls through to the placeholder gradient when both URLs error", () => {
    const { container } = render(
      <GameCard
        imageUrl="https://example.invalid/header.jpg"
        fallbackImageUrl="https://example.invalid/capsule.jpg"
        title="Half-Life 2"
      />,
    );
    // First error: primary -> fallback
    fireEvent.error(container.querySelector("img")!);
    // Second error: fallback -> placeholder
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    // The placeholder gradient div should be present in the image slot.
    const gradient = container.querySelector(
      '[class*="bg-gradient-to-br"]',
    );
    expect(gradient).toBeTruthy();
  });

  it("renders without an <img> when the primary URL is missing and goes straight to placeholder after first error", () => {
    // When there's no fallbackImageUrl and the primary errors, the next
    // phase is "placeholder" — no img element.
    const { container } = render(
      <GameCard imageUrl="https://example.invalid/header.jpg" title="HL2" />,
    );
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders as a <button> when onPick is provided and fires onPick on click", () => {
    const onPick = vi.fn();
    render(
      <GameCard
        imageUrl="https://example.invalid/header.jpg"
        title="Portal"
        onPick={onPick}
      />,
    );
    const btn = screen.getByRole("button");
    expect(btn.tagName).toBe("BUTTON");
    btn.click();
    expect(onPick).toHaveBeenCalledOnce();
  });

  it("renders as a passive <div> when onPick is omitted", () => {
    const { container } = render(
      <GameCard imageUrl="https://example.invalid/header.jpg" title="Portal" />,
    );
    expect(container.querySelector("button")).toBeNull();
    expect(container.firstElementChild?.tagName).toBe("DIV");
  });

  it("renders the title", () => {
    render(
      <GameCard imageUrl="https://example.invalid/x.jpg" title="Portal 2" />,
    );
    expect(screen.getByText("Portal 2")).toBeTruthy();
  });

  it("collectionBadgeVariant returns a stable variant for the same name", () => {
    expect(collectionBadgeVariant("Nintendo 64")).toBe(
      collectionBadgeVariant("Nintendo 64"),
    );
  });
});

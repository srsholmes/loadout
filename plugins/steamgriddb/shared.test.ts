import { describe, it, expect } from "bun:test";
import { cleanTitleForSearch, extFromUrl } from "./shared";

describe("cleanTitleForSearch", () => {
  it("strips parenthesised regions", () => {
    expect(cleanTitleForSearch("Super Mario 64 (USA)")).toBe("Super Mario 64");
  });
  it("strips bracketed version tags", () => {
    expect(cleanTitleForSearch("Foo [v1.0.2-beta]")).toBe("Foo");
  });
  it("strips disc markers (case-insensitive)", () => {
    expect(cleanTitleForSearch("Bar - Disc 2")).toBe("Bar");
    expect(cleanTitleForSearch("Baz - disc 1")).toBe("Baz");
  });
  it("strips trailing version suffixes", () => {
    expect(cleanTitleForSearch("Quux v1.2.3")).toBe("Quux");
  });
  it("collapses whitespace runs", () => {
    expect(cleanTitleForSearch("Hello   World   ")).toBe("Hello World");
  });
  it("is a no-op for already-clean names", () => {
    expect(cleanTitleForSearch("Half-Life 2")).toBe("Half-Life 2");
  });
});

describe("extFromUrl", () => {
  it("returns the extension for a normal CDN URL", () => {
    expect(extFromUrl("https://cdn2.steamgriddb.com/grid/12345.png")).toBe(
      ".png",
    );
  });
  it("ignores query strings", () => {
    expect(
      extFromUrl("https://cdn.example.com/grid/12345.jpg?token=abcd1234"),
    ).toBe(".jpg");
  });
  it("ignores hash fragments", () => {
    expect(extFromUrl("https://cdn.example.com/grid/12345.webp#big")).toBe(
      ".webp",
    );
  });
  it("ignores dots elsewhere in the path", () => {
    expect(extFromUrl("https://cdn.example.com/foo.bar/12345.png")).toBe(
      ".png",
    );
  });
  it("returns .png default when there is no extension at all", () => {
    expect(extFromUrl("https://cdn.example.com/grid/12345")).toBe(".png");
  });
  it("returns .png default for path-only-dot oddities", () => {
    expect(extFromUrl("https://cdn.example.com/grid/12345.")).toBe(".png");
  });
  it("returns .png default for a malformed URL string", () => {
    expect(extFromUrl("not a url")).toBe(".png");
  });
  it("rejects executable / unknown extensions", () => {
    expect(extFromUrl("https://malicious.example.com/grid/12345.exe")).toBe(
      ".png",
    );
    expect(extFromUrl("https://cdn.example.com/grid/12345.svg")).toBe(".png");
  });
  it("lower-cases the extension before allow-listing", () => {
    expect(extFromUrl("https://cdn.example.com/grid/12345.PNG")).toBe(".png");
    expect(extFromUrl("https://cdn.example.com/grid/12345.JPEG")).toBe(".jpeg");
  });
});

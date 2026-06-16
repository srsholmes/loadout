import { describe, it, expect } from "bun:test";
import { isValidFlatpakAppId } from "./flatpak";

describe("isValidFlatpakAppId", () => {
  it("accepts canonical reverse-DNS app ids", () => {
    expect(isValidFlatpakAppId("org.mozilla.firefox")).toBe(true);
    expect(isValidFlatpakAppId("com.google.Chrome")).toBe(true);
    expect(isValidFlatpakAppId("com.brave.Browser")).toBe(true);
    expect(isValidFlatpakAppId("io.gitlab.librewolf-community")).toBe(true);
    expect(isValidFlatpakAppId("org.chromium.Chromium")).toBe(true);
  });

  it("accepts plain identifiers", () => {
    expect(isValidFlatpakAppId("firefox")).toBe(true);
    expect(isValidFlatpakAppId("a")).toBe(true);
  });

  it("rejects ids that start with a non-letter", () => {
    expect(isValidFlatpakAppId("1com.foo")).toBe(false);
    expect(isValidFlatpakAppId(".org.foo")).toBe(false);
    expect(isValidFlatpakAppId("-com.foo")).toBe(false);
  });

  it("rejects shell-metacharacter injection attempts", () => {
    expect(isValidFlatpakAppId("foo;rm -rf /")).toBe(false);
    expect(isValidFlatpakAppId("foo && bar")).toBe(false);
    expect(isValidFlatpakAppId("foo|bar")).toBe(false);
    expect(isValidFlatpakAppId("foo`bar`")).toBe(false);
    expect(isValidFlatpakAppId("foo$(bar)")).toBe(false);
    expect(isValidFlatpakAppId("foo bar")).toBe(false);
    expect(isValidFlatpakAppId("foo/bar")).toBe(false);
    expect(isValidFlatpakAppId("")).toBe(false);
  });
});

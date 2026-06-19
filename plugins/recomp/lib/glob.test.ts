import { describe, it, expect } from "bun:test";
import { globMatches } from "./glob";

describe("globMatches", () => {
  // ── Exact match (no wildcards) ───────────────────────────────────
  it("matches exact strings", () => {
    expect(globMatches("hello.zip", "hello.zip")).toBe(true);
  });

  it("rejects mismatched exact strings", () => {
    expect(globMatches("hello.zip", "world.zip")).toBe(false);
  });

  // ── Single wildcard ──────────────────────────────────────────────
  it("matches wildcard at start", () => {
    expect(globMatches("*-Linux.zip", "Game-v1.2-Linux.zip")).toBe(true);
  });

  it("matches wildcard in middle", () => {
    expect(globMatches("Game-*-Linux.zip", "Game-v1.2-Linux.zip")).toBe(true);
  });

  it("matches wildcard at end", () => {
    expect(globMatches("Game-v1*", "Game-v1.2-Linux.zip")).toBe(true);
  });

  it("matches wildcard matching empty string", () => {
    expect(globMatches("Game*Linux.zip", "GameLinux.zip")).toBe(true);
  });

  // ── Multiple wildcards ───────────────────────────────────────────
  it("matches multiple wildcards", () => {
    expect(
      globMatches("Zelda64Recompiled-*-Linux-*.zip", "Zelda64Recompiled-v1.2.2-Linux-X64.zip"),
    ).toBe(true);
  });

  it("matches pattern with only wildcard", () => {
    expect(globMatches("*", "anything.zip")).toBe(true);
  });

  it("matches double wildcard", () => {
    expect(globMatches("**", "anything")).toBe(true);
  });

  // ── Anchoring ────────────────────────────────────────────────────
  it("first segment must anchor to start", () => {
    expect(globMatches("Game-*", "NotGame-v1")).toBe(false);
  });

  it("last segment must anchor to end when no trailing *", () => {
    expect(globMatches("Game-*.zip", "Game-v1.zip.bak")).toBe(false);
  });

  it("trailing wildcard allows anything after", () => {
    expect(globMatches("Game-*.zip*", "Game-v1.zip.bak")).toBe(true);
  });

  // ── Real-world registry patterns ────────────────────────────────
  it("matches Zelda64 Linux pattern", () => {
    expect(
      globMatches(
        "Zelda64Recompiled-*-Linux-X64.zip",
        "Zelda64Recompiled-v1.2.2-Linux-X64.zip",
      ),
    ).toBe(true);
  });

  it("rejects Zelda64 Windows asset for Linux pattern", () => {
    expect(
      globMatches(
        "Zelda64Recompiled-*-Linux-X64.zip",
        "Zelda64Recompiled-v1.2.2-Windows.zip",
      ),
    ).toBe(false);
  });

  it("matches BanjoRecomp pattern", () => {
    expect(
      globMatches("BanjoRecompiled-*-Linux-X64.zip", "BanjoRecompiled-v1.0.1-Linux-X64.zip"),
    ).toBe(true);
  });

  it("matches SoH pattern", () => {
    expect(globMatches("SoH-*-Linux.zip", "SoH-Ackbar-Alpha-Linux.zip")).toBe(true);
  });

  it("matches opengoal tar.gz pattern", () => {
    expect(
      globMatches("opengoal-linux-*.tar.gz", "opengoal-linux-v0.2.14.tar.gz"),
    ).toBe(true);
  });

  // ── Edge cases ───────────────────────────────────────────────────
  it("empty pattern matches empty text", () => {
    expect(globMatches("", "")).toBe(true);
  });

  it("empty pattern does not match non-empty text", () => {
    expect(globMatches("", "something")).toBe(false);
  });

  it("non-empty pattern does not match empty text", () => {
    expect(globMatches("something", "")).toBe(false);
  });

  it("lone wildcard matches empty text", () => {
    expect(globMatches("*", "")).toBe(true);
  });
});

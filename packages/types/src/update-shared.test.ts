import { describe, expect, test } from "bun:test";
import { isTrustedGithubHost, parseSha256Sums, makeIdleAbort } from "./update-shared";

describe("isTrustedGithubHost", () => {
  test("accepts github release hosts and their subdomains", () => {
    expect(isTrustedGithubHost("github.com")).toBe(true);
    expect(isTrustedGithubHost("objects.githubusercontent.com")).toBe(true);
    expect(isTrustedGithubHost("release-assets.githubusercontent.com")).toBe(true);
  });

  test("rejects lookalikes and everything else", () => {
    expect(isTrustedGithubHost("evilgithub.com")).toBe(false);
    expect(isTrustedGithubHost("notgithub.com")).toBe(false);
    expect(isTrustedGithubHost("github.com.evil.example")).toBe(false);
    expect(isTrustedGithubHost("example.com")).toBe(false);
    expect(isTrustedGithubHost("")).toBe(false);
  });
});

describe("parseSha256Sums", () => {
  test("parses sha256sum output including binary-mode markers", () => {
    const text = [
      "a".repeat(64) + "  loadout-x86_64",
      "b".repeat(64) + " *loadout-plugins-x86_64.tar.xz",
      "",
      "not a sums line",
    ].join("\n");
    const sums = parseSha256Sums(text);
    expect(sums.get("loadout-x86_64")).toBe("a".repeat(64));
    expect(sums.get("loadout-plugins-x86_64.tar.xz")).toBe("b".repeat(64));
    expect(sums.size).toBe(2);
  });

  test("lowercases hashes", () => {
    const sums = parseSha256Sums("ABCDEF" + "0".repeat(58) + "  file");
    expect(sums.get("file")).toBe("abcdef" + "0".repeat(58));
  });
});

describe("makeIdleAbort", () => {
  test("aborts after silence; reset() defers; clear() disarms", async () => {
    const idle = makeIdleAbort(40);
    // Keep resetting well inside the window — must stay alive.
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 15));
      idle.reset();
    }
    expect(idle.signal.aborted).toBe(false);
    // Now go silent past the window — must abort with a readable reason.
    await new Promise((r) => setTimeout(r, 90));
    expect(idle.signal.aborted).toBe(true);
    expect(String(idle.signal.reason)).toContain("stalled");

    const idle2 = makeIdleAbort(30);
    idle2.clear();
    await new Promise((r) => setTimeout(r, 60));
    expect(idle2.signal.aborted).toBe(false); // cleared before firing
  });
});

import { describe, it, expect } from "bun:test";
import { formatBytes, formatReleaseDate, friendlyErrorMessage } from "./format";

describe("formatBytes", () => {
  it("returns null for undefined / zero / negative", () => {
    expect(formatBytes(undefined)).toBeNull();
    expect(formatBytes(0)).toBeNull();
    expect(formatBytes(-1)).toBeNull();
  });
  it("renders sub-GiB as MiB with one decimal", () => {
    expect(formatBytes(500 * 1024 * 1024)).toBe("500.0 MiB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MiB");
  });
  it("renders GiB-and-above as GiB with two decimals", () => {
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.50 GiB");
    expect(formatBytes(24.123 * 1024 * 1024 * 1024)).toBe("24.12 GiB");
  });
  it("crosses the 1-GiB boundary exactly at 1024 MiB", () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.00 GiB");
    // 1 MiB short of the boundary still reports as MiB.
    expect(formatBytes(1024 * 1024 * 1024 - 1)).toMatch(/MiB$/);
  });
});

describe("formatReleaseDate", () => {
  it("returns null for undefined / empty / non-parseable", () => {
    expect(formatReleaseDate(undefined)).toBeNull();
    expect(formatReleaseDate("")).toBeNull();
    expect(formatReleaseDate("not a date")).toBeNull();
  });
  it("renders a valid ISO date as Mmm YYYY in the test env's locale", () => {
    const out = formatReleaseDate("2024-03-15T00:00:00Z");
    // Locale-sensitive: en-US → "Mar 2024", de-DE → "März 2024".
    // Just confirm we got a month-and-year-shaped string.
    expect(out).not.toBeNull();
    expect(out).toMatch(/2024/);
  });
});

describe("friendlyErrorMessage", () => {
  it("rewrites legendary auth failures", () => {
    expect(friendlyErrorMessage("Login session expired")).toMatch(/sign-in expired/i);
    expect(friendlyErrorMessage("Refresh failed")).toMatch(/sign-in expired/i);
    expect(friendlyErrorMessage("No account")).toMatch(/sign-in expired/i);
    expect(friendlyErrorMessage("Error: not logged in")).toMatch(/sign-in expired/i);
  });
  it("rewrites disk-full errors", () => {
    expect(friendlyErrorMessage("No space left on device")).toMatch(/disk space/i);
    expect(friendlyErrorMessage("ENOSPC")).toMatch(/disk space/i);
    expect(friendlyErrorMessage("Disk full")).toMatch(/disk space/i);
  });
  it("rewrites network errors", () => {
    expect(friendlyErrorMessage("getaddrinfo ENOTFOUND nameresolution")).toMatch(/internet/i);
    expect(friendlyErrorMessage("Connection refused")).toMatch(/internet/i);
    expect(friendlyErrorMessage("Network is unreachable")).toMatch(/internet/i);
    expect(friendlyErrorMessage("Connection reset")).toMatch(/internet/i);
    expect(friendlyErrorMessage("Operation timed out")).toMatch(/internet/i);
  });
  it("rewrites legendary concurrent-run lock contention", () => {
    expect(friendlyErrorMessage("Blocked by a concurrent run")).toMatch(/another install/i);
  });
  it("passes through already-friendly executable messages", () => {
    const friendly = "Can't determine the launch executable for Foo. Try Uninstall + Reinstall.";
    expect(friendlyErrorMessage(friendly)).toBe(friendly);
  });
  it("trims long stderr blobs to fit a toast", () => {
    const long = "x".repeat(500);
    const out = friendlyErrorMessage(long);
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.endsWith("…")).toBe(true);
  });
  it("falls through unmatched messages unchanged", () => {
    expect(friendlyErrorMessage("something the heuristics don't catch")).toBe(
      "something the heuristics don't catch",
    );
  });
});

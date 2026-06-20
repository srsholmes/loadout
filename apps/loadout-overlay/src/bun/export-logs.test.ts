import { describe, test, expect } from "bun:test";
import {
  buildReport,
  extractUiLogs,
  timestampForFilename,
} from "./export-logs";

describe("timestampForFilename", () => {
  test("renders a filesystem-safe local timestamp", () => {
    // 2026-06-20 14:32:07 local time
    const d = new Date(2026, 5, 20, 14, 32, 7);
    expect(timestampForFilename(d)).toBe("2026-06-20_14-32-07");
  });

  test("zero-pads single-digit components", () => {
    const d = new Date(2026, 0, 3, 4, 5, 6);
    expect(timestampForFilename(d)).toBe("2026-01-03_04-05-06");
  });
});

describe("extractUiLogs", () => {
  test("returns the uiLogs string when present", () => {
    expect(extractUiLogs({ uiLogs: "hello" })).toBe("hello");
  });

  test("returns empty string for malformed payloads", () => {
    expect(extractUiLogs(undefined)).toBe("");
    expect(extractUiLogs(null)).toBe("");
    expect(extractUiLogs("nope")).toBe("");
    expect(extractUiLogs({ uiLogs: 123 })).toBe("");
    expect(extractUiLogs({})).toBe("");
  });
});

describe("buildReport", () => {
  const generatedAt = new Date(2026, 5, 20, 14, 32, 7);

  test("includes both sections with their content", () => {
    const report = buildReport({
      uiLogs: "[main] booting",
      serverLogs: "2026-06-20 [INFO] [server] started",
      generatedAt,
    });
    expect(report).toContain("Loadout diagnostic log export");
    expect(report).toContain("UI LOGS");
    expect(report).toContain("[main] booting");
    expect(report).toContain("SERVER LOGS");
    expect(report).toContain("2026-06-20 [INFO] [server] started");
    expect(report).toContain(generatedAt.toISOString());
  });

  test("falls back to placeholders for empty logs", () => {
    const report = buildReport({ uiLogs: "  ", serverLogs: "", generatedAt });
    expect(report).toContain("(no UI logs captured this session)");
    expect(report).toContain("(server log was empty)");
  });
});

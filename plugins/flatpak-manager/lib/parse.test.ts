import { describe, it, expect } from "bun:test";
import { parseInstalled, parseUpdates, isValidAppId } from "./parse";

describe("parseInstalled()", () => {
  it("parses tab-separated rows into installed app objects", () => {
    const output = [
      "Steam\tcom.valvesoftware.Steam\t1.0.0\t500.0 MB\tflathub",
      "Firefox\torg.mozilla.firefox\t120.0\t200.0 MB\tflathub",
    ].join("\n");

    const apps = parseInstalled(output);

    expect(apps).toHaveLength(2);
    expect(apps[0]).toEqual({
      name: "Steam",
      appId: "com.valvesoftware.Steam",
      version: "1.0.0",
      size: "500.0 MB",
      origin: "flathub",
    });
    expect(apps[1]).toEqual({
      name: "Firefox",
      appId: "org.mozilla.firefox",
      version: "120.0",
      size: "200.0 MB",
      origin: "flathub",
    });
  });

  it("returns an empty array when output is empty", () => {
    expect(parseInstalled("")).toEqual([]);
  });

  it("skips lines with fewer than 5 columns", () => {
    const output = [
      "Steam\tcom.valvesoftware.Steam\t1.0.0\t500.0 MB\tflathub",
      "Broken\tonly-two-cols",
      "",
    ].join("\n");

    const apps = parseInstalled(output);
    expect(apps).toHaveLength(1);
    expect(apps[0].name).toBe("Steam");
  });

  it("trims whitespace around each field", () => {
    const apps = parseInstalled(
      "  Steam \t com.valvesoftware.Steam \t 1.0 \t 500 MB \t flathub \n",
    );
    expect(apps[0]).toEqual({
      name: "Steam",
      appId: "com.valvesoftware.Steam",
      version: "1.0",
      size: "500 MB",
      origin: "flathub",
    });
  });
});

describe("parseUpdates()", () => {
  it("parses tab-separated rows into update info objects", () => {
    const output = [
      "Firefox\torg.mozilla.firefox\t122.0",
      "Steam\tcom.valvesoftware.Steam\t1.0.1",
    ].join("\n");

    const updates = parseUpdates(output);

    expect(updates).toHaveLength(2);
    expect(updates[0]).toEqual({
      name: "Firefox",
      appId: "org.mozilla.firefox",
      newVersion: "122.0",
    });
  });

  it("returns an empty array when output is empty", () => {
    expect(parseUpdates("")).toEqual([]);
  });

  it("skips lines with fewer than 3 columns", () => {
    const output = ["Firefox\torg.mozilla.firefox\t122.0", "Broken", ""].join(
      "\n",
    );
    const updates = parseUpdates(output);
    expect(updates).toHaveLength(1);
  });
});

describe("isValidAppId()", () => {
  it("accepts standard reverse-DNS app IDs", () => {
    expect(isValidAppId("com.valvesoftware.Steam")).toBe(true);
    expect(isValidAppId("org.mozilla.firefox")).toBe(true);
    expect(isValidAppId("io.github.some-app")).toBe(true);
    expect(isValidAppId("App_With_Underscores")).toBe(true);
  });

  it("rejects flag-injection attempts", () => {
    expect(isValidAppId("--help")).toBe(false);
    expect(isValidAppId("-y")).toBe(false);
    expect(isValidAppId("-y; rm -rf /")).toBe(false);
  });

  it("rejects IDs starting with a number", () => {
    expect(isValidAppId("123.bad.id")).toBe(false);
  });

  it("rejects IDs with shell metacharacters", () => {
    expect(isValidAppId("foo;bar")).toBe(false);
    expect(isValidAppId("foo bar")).toBe(false);
    expect(isValidAppId("foo$bar")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidAppId("")).toBe(false);
  });
});

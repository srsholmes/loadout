import { describe, it, expect } from "bun:test";
import { parseDfOutput } from "./parse-df";

describe("parseDfOutput", () => {
  it("parses a single-partition df output", () => {
    const out = [
      "Filesystem      Size  Used Avail Use% Mounted on",
      "/dev/sda1       500G  200G  300G  40% /",
    ].join("\n");

    const result = parseDfOutput(out);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      filesystem: "/dev/sda1",
      size: "500G",
      used: "200G",
      available: "300G",
      usePercent: "40%",
      mountpoint: "/",
    });
  });

  it("dedupes same filesystem (e.g. / and /home on one partition)", () => {
    const out = [
      "Filesystem      Size  Used Avail Use% Mounted on",
      "/dev/sda1       500G  200G  300G  40% /",
      "/dev/sda1       500G  200G  300G  40% /home",
    ].join("\n");

    const result = parseDfOutput(out);
    expect(result).toHaveLength(1);
    expect(result[0].mountpoint).toBe("/");
  });

  it("keeps distinct filesystems", () => {
    const out = [
      "Filesystem      Size  Used Avail Use% Mounted on",
      "/dev/sda1       500G  200G  300G  40% /",
      "/dev/sdb1       1.0T  500G  500G  50% /home",
    ].join("\n");

    const result = parseDfOutput(out);
    expect(result).toHaveLength(2);
    expect(result[0].filesystem).toBe("/dev/sda1");
    expect(result[1].filesystem).toBe("/dev/sdb1");
  });

  it("ignores malformed lines with too few columns", () => {
    const out = [
      "Filesystem      Size  Used Avail Use% Mounted on",
      "/dev/sda1       500G  200G",
      "/dev/sda1       500G  200G  300G  40% /",
    ].join("\n");

    const result = parseDfOutput(out);
    expect(result).toHaveLength(1);
  });

  it("returns empty for empty input", () => {
    expect(parseDfOutput("")).toEqual([]);
    expect(parseDfOutput("Filesystem header only")).toEqual([]);
  });

  it("preserves multi-word mountpoints (spaces in mount label)", () => {
    const out = [
      "Filesystem      Size  Used Avail Use% Mounted on",
      "/dev/sdc1       1.0T  100G  900G  10% /run/media/My SD Card",
    ].join("\n");

    const result = parseDfOutput(out);
    expect(result).toHaveLength(1);
    expect(result[0].mountpoint).toBe("/run/media/My SD Card");
    expect(result[0].size).toBe("1.0T");
    expect(result[0].usePercent).toBe("10%");
  });
});

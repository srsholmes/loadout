import { describe, it, expect } from "bun:test";
import { formatSize, parseSizeToGB, bytesToGB, formatGB } from "./size";

describe("formatSize", () => {
  it("formats bytes < 1GB as MB with 1 decimal", () => {
    expect(formatSize(512 * 1024 * 1024)).toBe("512.0 MB");
    expect(formatSize(1024 * 1024)).toBe("1.0 MB");
  });

  it("formats bytes ≥ 1GB as GB with 2 decimals", () => {
    expect(formatSize(1024 * 1024 * 1024)).toBe("1.00 GB");
    expect(formatSize(2.5 * 1024 * 1024 * 1024)).toBe("2.50 GB");
  });

  it("handles 0 bytes", () => {
    expect(formatSize(0)).toBe("0.0 MB");
  });
});

describe("parseSizeToGB", () => {
  it("parses GB suffix", () => {
    expect(parseSizeToGB("500G")).toBe(500);
    expect(parseSizeToGB("1.5G")).toBe(1.5);
  });

  it("parses TB suffix to GB", () => {
    expect(parseSizeToGB("1T")).toBe(1024);
    expect(parseSizeToGB("2.5T")).toBe(2560);
  });

  it("parses MB suffix to GB", () => {
    expect(parseSizeToGB("1024M")).toBe(1);
    expect(parseSizeToGB("512M")).toBe(0.5);
  });

  it("parses KB suffix to GB", () => {
    expect(parseSizeToGB("1048576K")).toBe(1);
  });

  it("parses bare numbers as GB", () => {
    expect(parseSizeToGB("42")).toBe(42);
  });

  it("returns 0 for empty/garbage input", () => {
    expect(parseSizeToGB("")).toBe(0);
    expect(parseSizeToGB("garbage")).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(parseSizeToGB("1g")).toBe(1);
    expect(parseSizeToGB("1t")).toBe(1024);
  });
});

describe("bytesToGB", () => {
  it("converts bytes to GB", () => {
    expect(bytesToGB(1024 * 1024 * 1024)).toBe(1);
    expect(bytesToGB(2.5 * 1024 * 1024 * 1024)).toBeCloseTo(2.5);
  });
});

describe("formatGB", () => {
  it("uses 0 decimals for values ≥ 100", () => {
    expect(formatGB(123.45)).toBe("123");
    expect(formatGB(500)).toBe("500");
  });

  it("uses 1 decimal for values ≥ 10 and < 100", () => {
    expect(formatGB(42.5)).toBe("42.5");
    expect(formatGB(10)).toBe("10.0");
  });

  it("uses 2 decimals for values < 10", () => {
    expect(formatGB(1.234)).toBe("1.23");
    expect(formatGB(0)).toBe("0.00");
  });
});

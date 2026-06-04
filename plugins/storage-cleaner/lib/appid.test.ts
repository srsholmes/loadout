import { describe, it, expect } from "bun:test";
import { isValidAppId } from "./appid";

describe("isValidAppId", () => {
  it("accepts numeric app IDs", () => {
    expect(isValidAppId("730")).toBe(true);
    expect(isValidAppId("440")).toBe(true);
    expect(isValidAppId("0")).toBe(true);
    expect(isValidAppId("9999999999")).toBe(true);
  });

  it("rejects path-traversal patterns", () => {
    expect(isValidAppId("../../../etc/passwd")).toBe(false);
    expect(isValidAppId("..")).toBe(false);
    expect(isValidAppId("../root")).toBe(false);
  });

  it("rejects command-injection patterns", () => {
    expect(isValidAppId("730; rm -rf /")).toBe(false);
    expect(isValidAppId("730 && echo hax")).toBe(false);
    expect(isValidAppId("$(echo 730)")).toBe(false);
  });

  it("rejects mixed alphanumeric / trailing chars", () => {
    expect(isValidAppId("730a")).toBe(false);
    expect(isValidAppId("a730")).toBe(false);
    expect(isValidAppId("valid123notreally/")).toBe(false);
    expect(isValidAppId("730/")).toBe(false);
  });

  it("rejects empty / whitespace", () => {
    expect(isValidAppId("")).toBe(false);
    expect(isValidAppId(" ")).toBe(false);
    expect(isValidAppId(" 730")).toBe(false);
    expect(isValidAppId("730 ")).toBe(false);
  });

  it("rejects negative or signed numbers", () => {
    expect(isValidAppId("-1")).toBe(false);
    expect(isValidAppId("+730")).toBe(false);
  });
});

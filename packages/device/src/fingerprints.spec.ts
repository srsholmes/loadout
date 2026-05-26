import { describe, it, expect } from "bun:test";
import { matchFingerprint } from "./fingerprints";

const baseDmi = { sysVendor: "", productName: "", productFamily: "", boardName: "" };

describe("matchFingerprint", () => {
  it("matches Apex", () => {
    const fp = matchFingerprint({
      ...baseDmi,
      sysVendor: "ONE-NETBOOK",
      productName: "ONEXPLAYER APEX 1",
    });
    expect(fp?.id).toBe("apex");
    expect(fp?.capabilities.hasRGB).toBe(true);
  });

  it("matches OneXFly F1 Pro", () => {
    const fp = matchFingerprint({
      ...baseDmi,
      sysVendor: "ONE-NETBOOK",
      productName: "ONEXPLAYER F1 Pro",
    });
    expect(fp?.id).toBe("onexfly-f1-pro");
  });

  it("matches Steam Deck OLED (Galileo)", () => {
    const fp = matchFingerprint({
      ...baseDmi,
      sysVendor: "Valve",
      productName: "Galileo",
    });
    expect(fp?.id).toBe("steamdeck-oled");
    expect(fp?.capabilities.hasRGB).toBe(false);
  });

  it("matches Steam Deck LCD (Jupiter)", () => {
    const fp = matchFingerprint({
      ...baseDmi,
      sysVendor: "Valve",
      productName: "Jupiter",
    });
    expect(fp?.id).toBe("steamdeck-lcd");
  });

  it("returns undefined for unknown hardware", () => {
    const fp = matchFingerprint({
      ...baseDmi,
      sysVendor: "Acme",
      productName: "GenericLaptop 9000",
    });
    expect(fp).toBeUndefined();
  });
});

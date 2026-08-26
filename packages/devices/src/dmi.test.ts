import { describe, it, expect } from "bun:test";
import { isApexDmi, isOneXPlayerDmi, isSteamDeckDmi } from "./dmi";

describe("isSteamDeckDmi", () => {
  it("matches the Deck LCD (Jupiter)", () => {
    expect(isSteamDeckDmi({ sysVendor: "Valve", productName: "Jupiter" })).toBe(true);
  });

  it("matches the Deck OLED (Galileo)", () => {
    expect(isSteamDeckDmi({ sysVendor: "Valve", productName: "Galileo" })).toBe(true);
  });

  it("falls back to a Valve sys_vendor for unknown future products", () => {
    expect(isSteamDeckDmi({ sysVendor: "Valve", productName: "Somethingnew" })).toBe(true);
  });

  it("rejects non-Deck handhelds", () => {
    expect(
      isSteamDeckDmi({ sysVendor: "ONE-NETBOOK", productName: "ONEXPLAYER APEX 1 ABXX" }),
    ).toBe(false);
    expect(isSteamDeckDmi({ sysVendor: "ASUSTeK COMPUTER INC.", productName: "RC73X" })).toBe(
      false,
    );
  });

  it("rejects empty DMI (unreadable /sys)", () => {
    expect(isSteamDeckDmi({ sysVendor: "", productName: "" })).toBe(false);
  });
});

describe("isApexDmi", () => {
  it("still matches the APEX and rejects the Deck", () => {
    expect(isApexDmi({ sysVendor: "ONE-NETBOOK", productName: "ONEXPLAYER APEX 1" })).toBe(true);
    expect(isApexDmi({ sysVendor: "Valve", productName: "Jupiter" })).toBe(false);
  });
});

describe("isOneXPlayerDmi", () => {
  it("matches the whole OneXPlayer family, not one model", () => {
    // The X2 Mini Pro's DMI string, per HHD's device table. It shares the
    // Apex's silicon but was locked out by a model-specific gate.
    // Neutral vendor on purpose: with "ONE-NETBOOK" here the function
    // short-circuits on the vendor branch and this list pins nothing —
    // "Jupiter" would pass just as well. The product branch is what's under
    // test.
    for (const productName of [
      "ONEXPLAYER APEX",
      "ONEXPLAYER X2Mini PRO",
      "ONEXPLAYER X1Mini Pro",
      "ONEXPLAYER G1 A",
      "ONEXPLAYER F1 Pro",
    ]) {
      expect(isOneXPlayerDmi({ sysVendor: "Default string", productName })).toBe(true);
    }
  });

  it("normalises case on both fields, not just one", () => {
    expect(isOneXPlayerDmi({ sysVendor: "One-Netbook", productName: "Default string" })).toBe(true);
    expect(isOneXPlayerDmi({ sysVendor: "Default string", productName: "OneXPlayer X1" })).toBe(
      true,
    );
  });

  it("matches on either field, since firmware is inconsistent", () => {
    // Vendor-only: some boards report a product name we've never seen.
    expect(isOneXPlayerDmi({ sysVendor: "ONE-NETBOOK", productName: "Something New" })).toBe(true);
    // Product-only: and some report a vendor we don't expect.
    expect(isOneXPlayerDmi({ sysVendor: "Default string", productName: "ONEXPLAYER X9" })).toBe(
      true,
    );
  });

  it("rejects other vendors' handhelds", () => {
    expect(isOneXPlayerDmi({ sysVendor: "Valve", productName: "Galileo" })).toBe(false);
    expect(isOneXPlayerDmi({ sysVendor: "AYANEO", productName: "AYANEO 2" })).toBe(false);
    expect(isOneXPlayerDmi({ sysVendor: "", productName: "" })).toBe(false);
  });
});

describe("isApexDmi — vendor matching", () => {
  it("accepts the longer vendor string some firmware reports", () => {
    // battery-tracker already matches "ONE-NETBOOK Technology Co., Ltd.",
    // so a strict equality here was wrong even for a genuine Apex.
    expect(
      isApexDmi({
        sysVendor: "ONE-NETBOOK Technology Co., Ltd.",
        productName: "ONEXPLAYER APEX",
      }),
    ).toBe(true);
  });

  it("still distinguishes the Apex from its siblings", () => {
    // isApexDmi gates board-specific constants (the fingerprint GPIO pin),
    // so it must stay narrow even as the family gate widens.
    expect(isApexDmi({ sysVendor: "ONE-NETBOOK", productName: "ONEXPLAYER X2Mini PRO" })).toBe(
      false,
    );
  });
});

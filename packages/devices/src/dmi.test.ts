import { describe, it, expect } from "bun:test";
import { isApexDmi, isSteamDeckDmi } from "./dmi";

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

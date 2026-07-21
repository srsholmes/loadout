import { describe, it, expect } from "bun:test";
import { matchDevice, matchProfileName } from "./devices";

describe("matchDevice", () => {
  it("matches a known device by DMI product-name substring", () => {
    const d = matchDevice("ONEXPLAYER APEX 1 ABXX", "AMD");
    expect(d.name).toBe("OneXPlayer APEX");
    expect(d.minTdp).toBe(5);
    expect(d.maxTdp).toBe(80);
    expect(d.batteryMaxTdp).toBe(55);
    expect(d.profiles).toEqual({ Silent: 15, Balanced: 30, Performance: 50 });
  });

  it("carries a battery cap on every match (<= the plugged max)", () => {
    const cases = [
      "ONEXPLAYER APEX",
      "Galileo",
      "ASUS ROG Ally X RC72LA",
      "Claw 8 AI",
      "Some Unknown Laptop", // vendor fallback
    ];
    for (const dmi of cases) {
      const d = matchDevice(dmi, "AMD");
      expect(typeof d.batteryMaxTdp).toBe("number");
      expect(d.batteryMaxTdp).toBeLessThanOrEqual(d.maxTdp);
      expect(d.batteryMaxTdp).toBeGreaterThanOrEqual(d.minTdp);
    }
  });

  it("is order-sensitive: more specific entries win over generic ones", () => {
    // "ONEXPLAYER APEX" must win over the generic "ONEXPLAYER" entry, and
    // "ROG Ally X RC72" over "ROG Ally RC71".
    expect(matchDevice("ONEXPLAYER APEX", "AMD").name).toBe("OneXPlayer APEX");
    expect(matchDevice("ONEXPLAYER Mini Pro 2", "AMD").name).toBe(
      "OneXPlayer Mini Pro",
    );
    expect(matchDevice("ASUS ROG Ally X RC72LA", "AMD").name).toBe("ROG Ally X");
    expect(matchDevice("ASUS ROG Ally RC71L", "AMD").name).toBe("ROG Ally");
  });

  it("matches Steam Deck variants", () => {
    expect(matchDevice("Galileo", "AMD").name).toBe("Steam Deck OLED");
    expect(matchDevice("Jupiter", "AMD").name).toBe("Steam Deck LCD");
  });

  it("matches the GPD Win 5 ahead of the GPD fallback with its Strix Halo range", () => {
    const d = matchDevice("G1618-05", "AMD");
    expect(d.name).toBe("GPD Win 5");
    expect(d.minTdp).toBe(4);
    expect(d.maxTdp).toBe(85);
    expect(d.batteryMaxTdp).toBe(55);
    expect(d.profiles).toEqual({ Silent: 15, Balanced: 25, Performance: 60 });
    // The Win 4 and the vendor fallback keep their 28 W envelope.
    expect(matchDevice("G1618-04", "AMD").maxTdp).toBe(28);
    expect(matchDevice("GPD SomethingNew", "AMD").name).toBe("GPD Device");
  });

  it("matches both GPD Win Mini and Win Max 2 revisions", () => {
    expect(matchDevice("G1617-01", "AMD").name).toBe("GPD Win Mini");
    expect(matchDevice("G1617-01", "AMD").maxTdp).toBe(28);
    // The 2025 Mini runs 30 W-class silicon — its entry must win over
    // the broader G1617 match.
    expect(matchDevice("G1617-02", "AMD").name).toBe("GPD Win Mini (2025)");
    expect(matchDevice("G1617-02", "AMD").maxTdp).toBe(30);
    expect(matchDevice("G1619-04", "AMD").name).toBe("GPD Win Max 2");
    expect(matchDevice("G1619-05", "AMD").name).toBe("GPD Win Max 2");
  });

  it("matches the ROG Xbox Ally pair and Flow Z13 by board code", () => {
    const xbox = matchDevice("ROG Xbox Ally RC73YA", "AMD");
    expect(xbox.name).toBe("ROG Xbox Ally");
    expect(xbox.maxTdp).toBe(20); // Z2 A — generic 35 W would overshoot
    const xboxX = matchDevice("ROG Xbox Ally X RC73XA", "AMD");
    expect(xboxX.name).toBe("ROG Xbox Ally X");
    expect(xboxX.maxTdp).toBe(35);
    expect(matchDevice("ROG Flow Z13 GZ302EA", "AMD").maxTdp).toBe(65);
  });

  it("matches the OneXFly F1 ahead of the OneXPlayer generic", () => {
    expect(matchDevice("ONEXPLAYER F1Pro", "AMD").maxTdp).toBe(30);
    expect(matchDevice("ONEXPLAYER F1 EVA-02", "AMD").name).toBe(
      "OneXPlayer OneXFly F1",
    );
    expect(matchDevice("ONEXPLAYER 2 PRO", "AMD").name).toBe("OneXPlayer");
  });

  it("matches the OrangePi Neo", () => {
    expect(matchDevice("NEO-01", "AMD").name).toBe("OrangePi Neo");
    expect(matchDevice("NEO-01", "AMD").maxTdp).toBe(28);
  });

  it("returns a fresh profiles copy (callers mutate it)", () => {
    const a = matchDevice("Galileo", "AMD");
    const b = matchDevice("Galileo", "AMD");
    expect(a.profiles).not.toBe(b.profiles);
    a.profiles.Silent = 999;
    expect(b.profiles.Silent).toBe(5);
  });

  it("falls back by CPU vendor when no device matches", () => {
    expect(matchDevice("Some Unknown Laptop", "AMD")).toMatchObject({
      name: "Generic AMD",
      minTdp: 5,
      maxTdp: 35,
    });
    expect(matchDevice("Some Unknown Laptop", "Intel")).toMatchObject({
      name: "Generic Intel",
      minTdp: 3,
      maxTdp: 40,
    });
    expect(matchDevice("Some Unknown Laptop", "Unknown").name).toBe("Unknown");
  });
});

describe("matchProfileName", () => {
  const profiles = { Silent: 10, Balanced: 18, Performance: 35 };

  it("returns null for a null reading", () => {
    expect(matchProfileName(null, profiles)).toBeNull();
  });

  it("names an exact preset match", () => {
    expect(matchProfileName(10, profiles)).toBe("Silent");
    expect(matchProfileName(18, profiles)).toBe("Balanced");
    expect(matchProfileName(35, profiles)).toBe("Performance");
  });

  it("matches within ±1 W", () => {
    expect(matchProfileName(11, profiles)).toBe("Silent"); // 10 ±1
    expect(matchProfileName(17, profiles)).toBe("Balanced"); // 18 ±1
    expect(matchProfileName(34, profiles)).toBe("Performance"); // 35 ±1
  });

  it('returns "Custom" when no preset is within ±1 W', () => {
    expect(matchProfileName(25, profiles)).toBe("Custom");
    expect(matchProfileName(13, profiles)).toBe("Custom");
  });
});

import { describe, it, expect } from "bun:test";
import { matchDevice, matchProfileName } from "./devices";

describe("matchDevice", () => {
  it("matches a known device by DMI product-name substring", () => {
    const d = matchDevice("ONEXPLAYER APEX 1 ABXX", "AMD");
    expect(d.name).toBe("OneXPlayer APEX");
    expect(d.minTdp).toBe(5);
    expect(d.maxTdp).toBe(80);
    expect(d.profiles).toEqual({ Silent: 15, Balanced: 30, Performance: 50 });
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

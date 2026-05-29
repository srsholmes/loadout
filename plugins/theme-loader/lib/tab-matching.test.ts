import { describe, it, expect } from "bun:test";
import { isTargetTab } from "./tab-matching";

describe("isTargetTab", () => {
  it("matches the SharedJSContext literals", () => {
    expect(isTargetTab({ title: "SharedJSContext" })).toBe(true);
    expect(isTargetTab({ title: "Steam Shared Context presented by Valve™" })).toBe(true);
    expect(isTargetTab({ title: "Steam" })).toBe(true);
    expect(isTargetTab({ title: "SP" })).toBe(true);
  });

  it("matches the Big Picture Mode parent shell literal", () => {
    expect(isTargetTab({ title: "Steam Big Picture Mode" })).toBe(true);
  });

  it("matches the BPM MainMenu_uid<N> popup tab for common session ids", () => {
    expect(isTargetTab({ title: "MainMenu_uid2" })).toBe(true);
    expect(isTargetTab({ title: "MainMenu_uid0" })).toBe(true);
    expect(isTargetTab({ title: "MainMenu_uid123" })).toBe(true);
  });

  it("rejects other MainMenu* tabs — guards against future Valve renames", () => {
    // The whole point of the regex tightening: a future Valve-side
    // tab named MainMenuSettings (or similar) MUST NOT silently
    // catch our CSS injection.
    expect(isTargetTab({ title: "MainMenu" })).toBe(false);
    expect(isTargetTab({ title: "MainMenuSettings" })).toBe(false);
    expect(isTargetTab({ title: "MainMenuOptions" })).toBe(false);
    expect(isTargetTab({ title: "MainMenu_settings" })).toBe(false);
    expect(isTargetTab({ title: "MainMenu_uid" })).toBe(false); // no digits
    expect(isTargetTab({ title: "MainMenu_uidA" })).toBe(false); // non-digit suffix
    expect(isTargetTab({ title: "MainMenu_uid2_extra" })).toBe(false); // extra suffix
    expect(isTargetTab({ title: "XMainMenu_uid2" })).toBe(false); // leading prefix
  });

  it("matches QuickAccess and the QuickAccess_uid<N> popup variant", () => {
    expect(isTargetTab({ title: "QuickAccess" })).toBe(true);
    expect(isTargetTab({ title: "QuickAccess_uid2" })).toBe(true);
    expect(isTargetTab({ title: "QuickAccess_uid9" })).toBe(true);
  });

  it("rejects QuickAccess look-alikes", () => {
    expect(isTargetTab({ title: "QuickAccessSettings" })).toBe(false);
    expect(isTargetTab({ title: "QuickAccess_uid" })).toBe(false);
    expect(isTargetTab({ title: "QuickAccess_uidX" })).toBe(false);
  });

  it("rejects unrelated tabs", () => {
    expect(isTargetTab({ title: "DevTools" })).toBe(false);
    expect(isTargetTab({ title: "" })).toBe(false);
    expect(isTargetTab({ title: "https://store.steampowered.com" })).toBe(false);
    expect(isTargetTab({ title: "Friends List" })).toBe(false);
  });
});

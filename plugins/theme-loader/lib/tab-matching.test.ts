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

  // Issue #259. Captured verbatim from a Russian Deck in Gaming Mode: the
  // window title is Steam's translated `SP_WindowTitle_BigPicture`, so
  // title-only matching dropped the tab the visible UI is painted in and no
  // theme CSS applied at all.
  it("matches the Big Picture window when its title is localized", () => {
    const GAMING_BPM =
      "about:blank?createflags=6292738&minwidth=853&minheight=534&pid=0&browser=-1&browserType=4&useragent=Valve%20Steam%20Gamepad";
    expect(isTargetTab({ title: "Режим Big Picture", url: GAMING_BPM })).toBe(true);
    expect(isTargetTab({ title: "Big-Picture-Modus", url: GAMING_BPM })).toBe(true);
    expect(isTargetTab({ title: "Steam 大屏幕模式", url: GAMING_BPM })).toBe(true);
  });

  it("still matches the popups the BPM UI needs, which carry no browserType", () => {
    // These are the other live targets from the same capture — theme CSS
    // wants them too, so the new URL path must not displace them.
    expect(
      isTargetTab({
        title: "MainMenu_uid2",
        url: "about:blank?browserviewpopup=1&requestid=1&parentpopup=2",
      }),
    ).toBe(true);
    expect(
      isTargetTab({
        title: "QuickAccess_uid2",
        url: "about:blank?browserviewpopup=1&requestid=2&parentpopup=2",
      }),
    ).toBe(true);
  });

  it("does not let the URL path widen the title allowlist", () => {
    // A tab we already rejected stays rejected when it carries no marker.
    expect(
      isTargetTab({ title: "MainMenuSettings", url: "about:blank?createflags=512" }),
    ).toBe(false);
    expect(
      isTargetTab({ title: "DevTools", url: "devtools://devtools/bundled/x.html" }),
    ).toBe(false);
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

import { describe, expect, test } from "bun:test";
import { isBigPictureMode, isSharedJSContext, type CEFTab } from "./tabs";

function makeTab(title: string, url: string): CEFTab {
  return { id: "1", title, url, webSocketDebuggerUrl: "ws://localhost:8080/devtools/page/1", type: "page" };
}

describe("isSharedJSContext", () => {
  test("matches SharedJSContext title with steamloopback routes URL", () => {
    expect(isSharedJSContext(makeTab("SharedJSContext", "https://steamloopback.host/routes/library"))).toBe(true);
  });

  test("matches SP title with steamloopback index URL", () => {
    expect(isSharedJSContext(makeTab("SP", "https://steamloopback.host/index.html"))).toBe(true);
  });

  test("matches Steam title with steamloopback URL", () => {
    expect(isSharedJSContext(makeTab("Steam", "https://steamloopback.host/routes/home"))).toBe(true);
  });

  test("rejects wrong title", () => {
    expect(isSharedJSContext(makeTab("Settings", "https://steamloopback.host/routes/settings"))).toBe(false);
  });

  test("rejects wrong URL", () => {
    expect(isSharedJSContext(makeTab("SharedJSContext", "https://store.steampowered.com/"))).toBe(false);
  });

  test("rejects both wrong", () => {
    expect(isSharedJSContext(makeTab("Friends", "https://store.steampowered.com/"))).toBe(false);
  });
});

describe("isBigPictureMode", () => {
  const BPM_WINDOW = "about:blank?createflags=6292738&browserType=4";

  test("matches the English Gaming Mode window", () => {
    expect(isBigPictureMode(makeTab("Steam Big Picture Mode", BPM_WINDOW))).toBe(true);
  });

  test("matches the desktop BPM window", () => {
    expect(isBigPictureMode(makeTab("Steam", "about:blank?browserType=4"))).toBe(true);
  });

  // Issue #259: the title is Steam's `SP_WindowTitle_BigPicture` string, so
  // it is translated in every non-English client. browserType=4 is not.
  test.each([
    ["Режим Big Picture", "russian"],
    ["Big-Picture-Modus", "german"],
    ["Steam 大屏幕模式", "schinese"],
    ["Steamin televisiotila", "finnish"],
    ["وضع الصورة الكبيرة لـSteam", "arabic"],
  ])("matches a localized window title (%s, %s)", (title) => {
    expect(isBigPictureMode(makeTab(title, BPM_WINDOW))).toBe(true);
  });

  test("rejects a browser-view popup even when it carries browserType", () => {
    expect(
      isBigPictureMode(
        makeTab("MainMenu_uid2", "about:blank?browserviewpopup=1&browserType=4"),
      ),
    ).toBe(false);
  });

  test("rejects the desktop chrome popups, which carry no browserType", () => {
    const supernav = "about:blank?createflags=4538378&pid=0&browser=-1&openerid=3";
    expect(isBigPictureMode(makeTab("Store Root Menu", supernav))).toBe(false);
    expect(isBigPictureMode(makeTab("Profile Supernav", supernav))).toBe(false);
  });

  test("rejects the shared context and ordinary web tabs", () => {
    expect(
      isBigPictureMode(makeTab("SharedJSContext", "https://steamloopback.host/index.html?LANGUAGE=russian")),
    ).toBe(false);
    expect(isBigPictureMode(makeTab("Steam", "https://steamcommunity.com/app/440"))).toBe(false);
  });
});

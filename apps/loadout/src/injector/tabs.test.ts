import { describe, expect, test } from "bun:test";
import { isSharedJSContext, type CEFTab } from "./tabs";

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

import { describe, expect, test } from "bun:test";
import {
  buildOverlayMenuInjectScript,
  buildOverlayMenuRemoveScript,
  OVERLAY_MENU_BINDING,
  OVERLAY_MENU_LABEL,
  OVERLAY_MENU_ROUTE,
  OVERLAY_MENU_STATE_GLOBAL,
} from "./overlay-menu";

describe("buildOverlayMenuInjectScript", () => {
  test("embeds the hardcoded label, sentinel route, and binding", () => {
    const script = buildOverlayMenuInjectScript();
    expect(script).toContain(`"label":"${OVERLAY_MENU_LABEL}"`);
    expect(script).toContain(OVERLAY_MENU_ROUTE);
    expect(script).toContain(OVERLAY_MENU_BINDING);
  });

  test("navigate-nowhere: wraps history push/replace and swallows the sentinel", () => {
    const script = buildOverlayMenuInjectScript();
    expect(script).toContain("history.push");
    expect(script).toContain("history.replace");
    expect(script).toContain("isSentinel");
    // Safety net still steps back rather than stranding on a blank page.
    expect(script).toContain("goBack");
    // No dependency on the (absent) navigation singleton anymore.
    expect(script).not.toContain("__LOADOUT_NAVIGATION");
  });

  test("wraps in an IIFE and installs a cleanup on the state global", () => {
    const script = buildOverlayMenuInjectScript();
    expect(script.startsWith("(function()")).toBe(true);
    expect(script).toContain(OVERLAY_MENU_STATE_GLOBAL);
    expect(script).toContain("cleanup");
  });

  test("pins the icon to 1.25rem so it matches Steam's sibling nav icons (20px)", () => {
    const script = buildOverlayMenuInjectScript();
    expect(script).toContain('width: "1.25rem"');
  });

  test("passes an explicit position through", () => {
    const script = buildOverlayMenuInjectScript({ position: 4 });
    expect(script).toContain('"position":4');
  });

  test("defaults position to just-after-Home (2)", () => {
    const script = buildOverlayMenuInjectScript();
    expect(script).toContain('"position":2');
  });
});

describe("buildOverlayMenuRemoveScript", () => {
  test("references the state global and calls its cleanup", () => {
    const script = buildOverlayMenuRemoveScript();
    expect(script).toContain(OVERLAY_MENU_STATE_GLOBAL);
    expect(script).toContain("cleanup");
    expect(script).toContain("nothing_to_remove");
  });
});

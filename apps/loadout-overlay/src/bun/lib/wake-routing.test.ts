import { describe, it, expect } from "bun:test";
import { routeWake } from "./wake-routing";
import type { ControllerShortcuts } from "../../webview/lib/electrobun";

// These specs cover audit finding B-006 — the onWake() branch table in
// index.ts had no unit tests. The bug class this prevents is real:
// a previous version of onWake() hardcoded Guide+X to ToggleOverlay
// regardless of the user's shortcut config (Guide+X bound to a plugin
// did nothing despite the UI claiming it was bound).

const DEFAULT_SHORTCUTS: ControllerShortcuts = {
  guide_a: { type: "None" },
  guide_b: { type: "None" },
  guide_x: { type: "ToggleOverlay" },
  guide_y: { type: "None" },
};

describe("routeWake — hardcoded keyboard wakes", () => {
  it("QamToggle always toggles", () => {
    expect(routeWake("QamToggle", DEFAULT_SHORTCUTS)).toEqual({
      kind: "toggle",
      reason: "QamToggle",
    });
  });

  it("CtrlThree always toggles", () => {
    expect(routeWake("CtrlThree", DEFAULT_SHORTCUTS)).toEqual({
      kind: "toggle",
      reason: "CtrlThree",
    });
  });

  it("CtrlFour always toggles", () => {
    expect(routeWake("CtrlFour", DEFAULT_SHORTCUTS)).toEqual({
      kind: "toggle",
      reason: "CtrlFour",
    });
  });

  it("ignores the configurable shortcut map for hardcoded events", () => {
    // QamToggle / Ctrl3 / Ctrl4 are keyboard wakes; the controller
    // shortcut config must not affect them. (If the user binds
    // Ctrl+3 somewhere else later, the wake-routing test will catch
    // a regression that breaks this assumption.)
    const weirdShortcuts: ControllerShortcuts = {
      guide_a: { type: "OpenPlugin", value: "fan-control" },
      guide_b: { type: "OpenPlugin", value: "fan-control" },
      guide_x: { type: "None" },
      guide_y: { type: "OpenPlugin", value: "fan-control" },
    };
    expect(routeWake("QamToggle", weirdShortcuts).kind).toBe("toggle");
  });
});

describe("routeWake — Steam-reserved Guide combos", () => {
  it("GuideA is ignored regardless of shortcut binding", () => {
    // Even with guide_a bound, the reserved-key filter must win.
    const shortcuts: ControllerShortcuts = {
      ...DEFAULT_SHORTCUTS,
      guide_a: { type: "ToggleOverlay" },
    };
    expect(routeWake("GuideA", shortcuts)).toEqual({
      kind: "ignore",
      reason: "reserved",
    });
  });

  it("GuideY is ignored regardless of shortcut binding", () => {
    const shortcuts: ControllerShortcuts = {
      ...DEFAULT_SHORTCUTS,
      guide_y: { type: "OpenPlugin", value: "audio-loader" },
    };
    expect(routeWake("GuideY", shortcuts)).toEqual({
      kind: "ignore",
      reason: "reserved",
    });
  });
});

describe("routeWake — configurable Guide combos", () => {
  it("GuideB → None: ignore", () => {
    expect(routeWake("GuideB", DEFAULT_SHORTCUTS)).toEqual({
      kind: "ignore",
      reason: "unknown-action",
    });
  });

  it("GuideB → ToggleOverlay: toggle", () => {
    const shortcuts: ControllerShortcuts = {
      ...DEFAULT_SHORTCUTS,
      guide_b: { type: "ToggleOverlay" },
    };
    expect(routeWake("GuideB", shortcuts)).toEqual({
      kind: "toggle",
      reason: "GuideB",
    });
  });

  it("GuideB → OpenPlugin: open the named plugin", () => {
    const shortcuts: ControllerShortcuts = {
      ...DEFAULT_SHORTCUTS,
      guide_b: { type: "OpenPlugin", value: "fan-control" },
    };
    expect(routeWake("GuideB", shortcuts)).toEqual({
      kind: "open-plugin",
      reason: "GuideB",
      pluginId: "fan-control",
    });
  });

  it("GuideX → ToggleOverlay (default): toggle", () => {
    // Locks in the default behavior — Guide+X is the only Guide combo
    // that defaults to ToggleOverlay out of the box (see initial
    // shortcuts in index.ts).
    expect(routeWake("GuideX", DEFAULT_SHORTCUTS)).toEqual({
      kind: "toggle",
      reason: "GuideX",
    });
  });

  it("GuideX → OpenPlugin: respects the user's binding", () => {
    // The regression this catches: a previous version of onWake()
    // hardcoded GuideX to ToggleOverlay regardless of config.
    const shortcuts: ControllerShortcuts = {
      ...DEFAULT_SHORTCUTS,
      guide_x: { type: "OpenPlugin", value: "audio-loader" },
    };
    expect(routeWake("GuideX", shortcuts)).toEqual({
      kind: "open-plugin",
      reason: "GuideX",
      pluginId: "audio-loader",
    });
  });

  it("GuideX → OpenPlugin with no value: ignore", () => {
    // The handler defends against half-built bindings (type set,
    // value not yet filled in by the UI). Without this branch the
    // overlay would open with a missing pluginId argument and the
    // webview would route to a nonexistent plugin route.
    const shortcuts: ControllerShortcuts = {
      ...DEFAULT_SHORTCUTS,
      guide_x: { type: "OpenPlugin" },
    };
    expect(routeWake("GuideX", shortcuts)).toEqual({
      kind: "ignore",
      reason: "unknown-action",
    });
  });

  it("GuideX → OpenPlugin with empty string value: ignore", () => {
    // Same as above — the `&& action.value` check rejects "" too.
    const shortcuts: ControllerShortcuts = {
      ...DEFAULT_SHORTCUTS,
      guide_x: { type: "OpenPlugin", value: "" },
    };
    expect(routeWake("GuideX", shortcuts)).toEqual({
      kind: "ignore",
      reason: "unknown-action",
    });
  });
});

describe("routeWake — issue #141 action types (OpenSettings / OpenHome / ToggleKeyboard)", () => {
  it("routes GuideB → OpenSettings as kind: open-settings", () => {
    const shortcuts: ControllerShortcuts = {
      guide_a: { type: "None" },
      guide_b: { type: "OpenSettings" },
      guide_x: { type: "None" },
      guide_y: { type: "None" },
    };
    expect(routeWake("GuideB", shortcuts)).toEqual({
      kind: "open-settings",
      reason: "GuideB",
    });
  });

  it("routes GuideX → OpenHome as kind: open-home", () => {
    const shortcuts: ControllerShortcuts = {
      guide_a: { type: "None" },
      guide_b: { type: "None" },
      guide_x: { type: "OpenHome" },
      guide_y: { type: "None" },
    };
    expect(routeWake("GuideX", shortcuts)).toEqual({
      kind: "open-home",
      reason: "GuideX",
    });
  });

  it("routes GuideB → ToggleKeyboard as kind: toggle-keyboard", () => {
    const shortcuts: ControllerShortcuts = {
      guide_a: { type: "None" },
      guide_b: { type: "ToggleKeyboard" },
      guide_x: { type: "None" },
      guide_y: { type: "None" },
    };
    expect(routeWake("GuideB", shortcuts)).toEqual({
      kind: "toggle-keyboard",
      reason: "GuideB",
    });
  });

  it("routes the reserved GuideA / GuideY to ignore even when bound to new actions", () => {
    // Even if some misconfigured save persisted GuideA: OpenSettings,
    // the reserved-events filter must short-circuit before the action
    // type is consulted. Otherwise binding to a reserved key would
    // re-introduce the Steam/InputPlumber focus-flicker bug.
    const shortcuts: ControllerShortcuts = {
      guide_a: { type: "OpenSettings" },
      guide_b: { type: "None" },
      guide_x: { type: "None" },
      guide_y: { type: "ToggleKeyboard" },
    };
    expect(routeWake("GuideA", shortcuts)).toEqual({
      kind: "ignore",
      reason: "reserved",
    });
    expect(routeWake("GuideY", shortcuts)).toEqual({
      kind: "ignore",
      reason: "reserved",
    });
  });
});

describe("routeWake — purity", () => {
  it("does not mutate the shortcuts argument", () => {
    // Belt-and-braces: routeWake is supposed to be pure. If it ever
    // grows a hidden mutation (e.g. setting a "last fired" timestamp
    // on the shortcut), this test fails loud.
    const shortcuts: ControllerShortcuts = {
      guide_a: { type: "None" },
      guide_b: { type: "OpenPlugin", value: "x" },
      guide_x: { type: "ToggleOverlay" },
      guide_y: { type: "None" },
    };
    const snapshot = JSON.stringify(shortcuts);
    routeWake("GuideB", shortcuts);
    routeWake("GuideX", shortcuts);
    routeWake("GuideA", shortcuts);
    routeWake("QamToggle", shortcuts);
    expect(JSON.stringify(shortcuts)).toBe(snapshot);
  });
});

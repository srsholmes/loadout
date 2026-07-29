import { afterEach, describe, expect, it } from "bun:test";
import { configPath, parsePersistedShortcuts } from "./persisted-shortcuts";
import type { ControllerShortcuts } from "../../webview/lib/electrobun";

// A full, valid controllerShortcuts block as the backend writes it into
// config.json.
const VALID_SHORTCUTS: ControllerShortcuts = {
  guide_a: { type: "None" },
  guide_b: { type: "ToggleOverlay" },
  guide_x: { type: "OpenPlugin", value: "fan-control" },
  guide_y: { type: "None" },
};

function configWith(shortcuts: unknown): string {
  return JSON.stringify({ theme: "tokyo", controllerShortcuts: shortcuts });
}

describe("parsePersistedShortcuts", () => {
  it("returns the validated shortcuts from a well-formed config", () => {
    const out = parsePersistedShortcuts(configWith(VALID_SHORTCUTS));
    expect(out).toEqual(VALID_SHORTCUTS);
  });

  it("returns null when the config has no controllerShortcuts key", () => {
    expect(parsePersistedShortcuts(JSON.stringify({ theme: "tokyo" }))).toBeNull();
  });

  it("returns null for unparseable JSON", () => {
    expect(parsePersistedShortcuts("{ not json")).toBeNull();
  });

  it("returns null when the JSON is not an object", () => {
    expect(parsePersistedShortcuts("42")).toBeNull();
    expect(parsePersistedShortcuts('"hello"')).toBeNull();
    expect(parsePersistedShortcuts("null")).toBeNull();
  });

  it("returns null when a required slot is missing", () => {
    const { guide_y, ...missingSlot } = VALID_SHORTCUTS;
    expect(parsePersistedShortcuts(configWith(missingSlot))).toBeNull();
  });

  it("returns null when a slot has an unknown action type", () => {
    const bad = { ...VALID_SHORTCUTS, guide_b: { type: "LaunchNukes" } };
    expect(parsePersistedShortcuts(configWith(bad))).toBeNull();
  });

  it("returns null when a slot is not an object", () => {
    const bad = { ...VALID_SHORTCUTS, guide_x: "ToggleOverlay" };
    expect(parsePersistedShortcuts(configWith(bad))).toBeNull();
  });

  it("returns null when controllerShortcuts is an array", () => {
    expect(parsePersistedShortcuts(configWith([]))).toBeNull();
  });
});

describe("configPath", () => {
  const original = process.env.XDG_CONFIG_HOME;
  afterEach(() => {
    if (original === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = original;
  });

  it("honors $XDG_CONFIG_HOME when set", () => {
    process.env.XDG_CONFIG_HOME = "/custom/xdg";
    expect(configPath()).toBe("/custom/xdg/loadout/config.json");
  });

  it("falls back to ~/.config when $XDG_CONFIG_HOME is empty", () => {
    process.env.XDG_CONFIG_HOME = "";
    expect(configPath()).toMatch(/\/\.config\/loadout\/config\.json$/);
  });
});

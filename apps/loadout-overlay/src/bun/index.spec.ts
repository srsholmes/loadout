import { describe, it, expect } from "bun:test";
import {
  validateSetControllerShortcutsParams,
  validateReadSoundFileFilename,
} from "./rpc-validation";

// These specs cover the audit findings B-001 / B-002 — both involve the
// RPC handlers in index.ts blindly casting unknown CEF payloads to their
// expected shape. The validators are pure functions extracted from the
// handlers; testing them here avoids booting the full Electrobun main
// process (window, atoms, evdev loop) which would otherwise pull in
// libNativeWrapper.so and X11.

describe("validateSetControllerShortcutsParams (B-001)", () => {
  // Happy path — the only payload shape the webview actually sends.
  it("accepts a well-formed payload", () => {
    const result = validateSetControllerShortcutsParams({
      shortcuts: {
        guide_a: { type: "None" },
        guide_b: { type: "ToggleOverlay" },
        guide_x: { type: "OpenPlugin", value: "fan-control" },
        guide_y: { type: "None" },
      },
    });
    expect(result).not.toBeNull();
    expect(result?.guide_x.type).toBe("OpenPlugin");
    expect(result?.guide_x.value).toBe("fan-control");
  });

  // Each of these previously triggered either a TypeError across IPC or
  // silent corruption of the module-global shortcuts state.
  it("rejects null / undefined / primitives", () => {
    expect(validateSetControllerShortcutsParams(null)).toBeNull();
    expect(validateSetControllerShortcutsParams(undefined)).toBeNull();
    expect(validateSetControllerShortcutsParams(42)).toBeNull();
    expect(validateSetControllerShortcutsParams("oops")).toBeNull();
    expect(validateSetControllerShortcutsParams(true)).toBeNull();
  });

  it("rejects arrays (would pass typeof === 'object')", () => {
    expect(validateSetControllerShortcutsParams([])).toBeNull();
    expect(validateSetControllerShortcutsParams([{ shortcuts: {} }])).toBeNull();
  });

  it("rejects payloads missing the `shortcuts` key", () => {
    expect(validateSetControllerShortcutsParams({})).toBeNull();
    expect(validateSetControllerShortcutsParams({ other: 1 })).toBeNull();
  });

  it("rejects payloads where `shortcuts` is the wrong type", () => {
    expect(validateSetControllerShortcutsParams({ shortcuts: null })).toBeNull();
    expect(validateSetControllerShortcutsParams({ shortcuts: "x" })).toBeNull();
    expect(validateSetControllerShortcutsParams({ shortcuts: [] })).toBeNull();
  });

  it("rejects payloads missing any of the four guide keys", () => {
    // missing guide_y
    expect(
      validateSetControllerShortcutsParams({
        shortcuts: {
          guide_a: { type: "None" },
          guide_b: { type: "None" },
          guide_x: { type: "None" },
        },
      }),
    ).toBeNull();
  });

  it("rejects an unknown action type", () => {
    expect(
      validateSetControllerShortcutsParams({
        shortcuts: {
          guide_a: { type: "Nuke" },
          guide_b: { type: "None" },
          guide_x: { type: "None" },
          guide_y: { type: "None" },
        },
      }),
    ).toBeNull();
  });

  it("rejects an action with a non-string `value`", () => {
    expect(
      validateSetControllerShortcutsParams({
        shortcuts: {
          guide_a: { type: "OpenPlugin", value: 123 },
          guide_b: { type: "None" },
          guide_x: { type: "None" },
          guide_y: { type: "None" },
        },
      }),
    ).toBeNull();
  });

  it("accepts an action with `value` omitted", () => {
    // `value` is optional on the type — must remain accepted.
    const result = validateSetControllerShortcutsParams({
      shortcuts: {
        guide_a: { type: "None" },
        guide_b: { type: "None" },
        guide_x: { type: "ToggleOverlay" },
        guide_y: { type: "None" },
      },
    });
    expect(result).not.toBeNull();
  });
});

describe("validateReadSoundFileFilename (B-002)", () => {
  it("accepts a string filename", () => {
    expect(validateReadSoundFileFilename({ filename: "click.wav" })).toBe(
      "click.wav",
    );
  });

  // The original bug: `params.filename.includes("/")` threw when
  // `filename` was not a string. Now we reject up-front.
  it("rejects a numeric filename", () => {
    expect(validateReadSoundFileFilename({ filename: 123 })).toBeNull();
  });

  it("rejects a missing filename", () => {
    expect(validateReadSoundFileFilename({})).toBeNull();
  });

  it("rejects null / undefined params", () => {
    expect(validateReadSoundFileFilename(null)).toBeNull();
    expect(validateReadSoundFileFilename(undefined)).toBeNull();
  });

  it("rejects an array filename", () => {
    expect(validateReadSoundFileFilename({ filename: ["a"] })).toBeNull();
  });

  it("rejects an object filename", () => {
    expect(validateReadSoundFileFilename({ filename: {} })).toBeNull();
  });

  // We intentionally accept the empty string here — the downstream
  // path-traversal / extension checks in the handler will reject it.
  // The validator's job is just typechecking.
  it("accepts an empty string (downstream checks will reject)", () => {
    expect(validateReadSoundFileFilename({ filename: "" })).toBe("");
  });
});

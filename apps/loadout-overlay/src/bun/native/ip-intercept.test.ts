import { describe, it, expect } from "bun:test";
import {
  parseInputEventLine,
  uiToInputEvent,
  pickCompositePaths,
} from "./ip-intercept";

describe("parseInputEventLine", () => {
  // gdbus monitor line shape for the DBusDevice.InputEvent signal.
  const line =
    "/org/shadowblip/InputPlumber/devices/target/dbus0: " +
    "org.shadowblip.Input.DBusDevice.InputEvent ('ui_up', 1.0)";

  it("parses capability + value from a gdbus InputEvent line", () => {
    expect(parseInputEventLine(line)).toEqual({ cap: "ui_up", value: 1 });
  });

  it("parses a release (value 0.0)", () => {
    expect(
      parseInputEventLine(
        "/x: org.shadowblip.Input.DBusDevice.InputEvent ('ui_accept', 0.0)",
      ),
    ).toEqual({ cap: "ui_accept", value: 0 });
  });

  it("parses fractional + integer-looking values", () => {
    expect(parseInputEventLine(".InputEvent ('ui_left', 0.5)")?.value).toBe(0.5);
    expect(parseInputEventLine(".InputEvent ('ui_left', 1)")?.value).toBe(1);
  });

  it("ignores non-InputEvent lines (e.g. PropertiesChanged)", () => {
    expect(
      parseInputEventLine(
        "/x: org.freedesktop.DBus.Properties.PropertiesChanged ('org.shadowblip.Input.CompositeDevice', {'InterceptMode': <uint32 3>}, @as [])",
      ),
    ).toBeNull();
  });

  it("returns null on the monitor header lines", () => {
    expect(
      parseInputEventLine("Monitoring signals from all objects owned by …"),
    ).toBeNull();
  });
});

describe("uiToInputEvent", () => {
  it("maps direction caps to hat axes with the correct sign on press", () => {
    expect(uiToInputEvent("ui_up", 1)).toEqual({
      kind: "axis",
      axis: "HatY",
      value: -1,
    });
    expect(uiToInputEvent("ui_down", 1)).toEqual({
      kind: "axis",
      axis: "HatY",
      value: 1,
    });
    expect(uiToInputEvent("ui_left", 1)).toEqual({
      kind: "axis",
      axis: "HatX",
      value: -1,
    });
    expect(uiToInputEvent("ui_right", 1)).toEqual({
      kind: "axis",
      axis: "HatX",
      value: 1,
    });
  });

  it("zeroes the axis on release so NavController clears the held direction", () => {
    expect(uiToInputEvent("ui_up", 0)).toEqual({
      kind: "axis",
      axis: "HatY",
      value: 0,
    });
  });

  it("maps accept/back/bumpers to buttons with pressed state", () => {
    expect(uiToInputEvent("ui_accept", 1)).toEqual({
      kind: "button",
      button: "A",
      pressed: true,
    });
    expect(uiToInputEvent("ui_back", 0)).toEqual({
      kind: "button",
      button: "B",
      pressed: false,
    });
    expect(uiToInputEvent("ui_l1", 1)).toEqual({
      kind: "button",
      button: "LB",
      pressed: true,
    });
    expect(uiToInputEvent("ui_r1", 1)).toEqual({
      kind: "button",
      button: "RB",
      pressed: true,
    });
  });

  it("treats the half-threshold as the press boundary", () => {
    // < 0.5 is a release, >= 0.5 is a press.
    expect(uiToInputEvent("ui_accept", 0.49)).toMatchObject({ pressed: false });
    expect(uiToInputEvent("ui_accept", 0.5)).toMatchObject({ pressed: true });
  });

  it("returns null for non-nav capabilities (handled elsewhere / logged)", () => {
    // ui_guide / ui_quick are wake-class, not nav — not in the nav table.
    expect(uiToInputEvent("ui_guide", 1)).toBeNull();
    expect(uiToInputEvent("ui_quick", 1)).toBeNull();
    expect(uiToInputEvent("ui_osk", 1)).toBeNull();
    expect(uiToInputEvent("KeyF16", 1)).toBeNull();
  });
});

describe("pickCompositePaths", () => {
  it("plucks top-level CompositeDeviceN paths from busctl tree output", () => {
    const tree = [
      "/org/shadowblip/InputPlumber",
      "/org/shadowblip/InputPlumber/CompositeDevice0",
      "/org/shadowblip/InputPlumber/devices/target/dbus0",
      "/org/shadowblip/InputPlumber/devices/target/gamepad1",
      "/org/shadowblip/InputPlumber/CompositeDevice1",
    ].join("\n");
    expect(pickCompositePaths(tree)).toEqual([
      "/org/shadowblip/InputPlumber/CompositeDevice0",
      "/org/shadowblip/InputPlumber/CompositeDevice1",
    ]);
  });

  it("does not match nested composite-device children", () => {
    const tree =
      "/org/shadowblip/InputPlumber/CompositeDevice0/source/event5\n" +
      "  /org/shadowblip/InputPlumber/CompositeDevice0";
    // Leading whitespace is trimmed; the bare composite path matches, the
    // /source/... child does not.
    expect(pickCompositePaths(tree)).toEqual([
      "/org/shadowblip/InputPlumber/CompositeDevice0",
    ]);
  });

  it("returns [] when there are no composite devices", () => {
    expect(pickCompositePaths("/org/shadowblip/InputPlumber\n")).toEqual([]);
  });
});

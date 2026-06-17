import { describe, it, expect } from "bun:test";
import { parseScreenGeometry } from "./screen-size";

describe("parseScreenGeometry", () => {
  it("prefers the output marked primary over earlier connected ones", () => {
    const xrandr = [
      "Screen 0: minimum 320 x 200, current 1920 x 1080, maximum 16384 x 16384",
      "HDMI-1 connected 1920x1080+0+0 (normal left inverted right) 600mm x 340mm",
      "DP-2 connected primary 2560x1440+1920+0 (normal left inverted) 597mm x 336mm",
    ].join("\n");
    expect(parseScreenGeometry(xrandr)).toEqual({
      w: 2560,
      h: 1440,
      x: 1920,
      y: 0,
    });
  });

  it("falls back to the first connected output when none is primary", () => {
    const xrandr = [
      "HDMI-1 connected 1366x768+0+0 (normal left inverted) 510mm x 290mm",
      "VGA-1 connected 1024x768+1366+0 (normal left inverted) 410mm x 230mm",
    ].join("\n");
    expect(parseScreenGeometry(xrandr)).toEqual({
      w: 1366,
      h: 768,
      x: 0,
      y: 0,
    });
  });

  it("parses the gamescope single-output shape (the #106 case)", () => {
    // gamescope's inner Xwayland typically exposes one output at the
    // panel resolution; this is what the overlay should be born at.
    const xrandr =
      "DP-1 connected 1280x800+0+0 (normal left inverted right x axis y axis) 0mm x 0mm";
    expect(parseScreenGeometry(xrandr)).toEqual({
      w: 1280,
      h: 800,
      x: 0,
      y: 0,
    });
  });

  it("ignores disconnected outputs without geometry", () => {
    const xrandr = [
      "HDMI-2 disconnected (normal left inverted right x axis y axis)",
      "eDP-1 connected primary 1280x800+0+0 (normal left inverted) 290mm x 180mm",
    ].join("\n");
    expect(parseScreenGeometry(xrandr)).toEqual({
      w: 1280,
      h: 800,
      x: 0,
      y: 0,
    });
  });

  it("returns null when no connected output exposes a geometry", () => {
    const xrandr = [
      "Screen 0: minimum 320 x 200, current 0 x 0, maximum 16384 x 16384",
      "HDMI-1 disconnected (normal left inverted right x axis y axis)",
    ].join("\n");
    expect(parseScreenGeometry(xrandr)).toBeNull();
  });
});

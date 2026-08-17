import { describe, it, expect } from "bun:test";
import {
  missingRequiredTools,
  shouldBlockOverlayOpen,
  formatMissingToolsBanner,
} from "./x11-preflight";

// Regression cover for the CachyOS report that motivated this module: a
// machine with no `xdotool` ran the overlay happily — service active, CEF
// renderer alive, no missing shared libraries — and every overlay open
// grabbed the controller and SIGSTOPped Steam while nothing was ever
// composited, because GamescopeAtoms.show() returns on its
// `if (!this.windowId) return` guard. The only trace was one console.warn
// at boot.

describe("missingRequiredTools", () => {
  it("is empty on a fully-equipped host", () => {
    expect(
      missingRequiredTools({ xdotool: true, xprop: true, xcbConnected: true }),
    ).toEqual([]);
  });

  it("flags xdotool — there is no fallback for the window-id lookup", () => {
    expect(
      missingRequiredTools({ xdotool: false, xprop: true, xcbConnected: true }),
    ).toEqual(["xdotool"]);
  });

  it("does NOT flag a missing xprop while libxcb is connected", () => {
    // The xprop path is only taken when libxcb is unusable, so demanding
    // it on a working xcb host would be a false alarm on most installs.
    expect(
      missingRequiredTools({ xdotool: true, xprop: false, xcbConnected: true }),
    ).toEqual([]);
  });

  it("flags xprop once libxcb is unavailable — nothing can write atoms then", () => {
    expect(
      missingRequiredTools({ xdotool: true, xprop: false, xcbConnected: false }),
    ).toEqual(["xprop"]);
  });

  it("flags both, xdotool first", () => {
    expect(
      missingRequiredTools({
        xdotool: false,
        xprop: false,
        xcbConnected: false,
      }),
    ).toEqual(["xdotool", "xprop"]);
  });
});

describe("shouldBlockOverlayOpen", () => {
  it("blocks under gamescope when a tool is missing", () => {
    expect(
      shouldBlockOverlayOpen({
        missingTools: ["xdotool"],
        gameModeActive: true,
      }),
    ).toBe(true);
  });

  it("allows desktop mode even with tools missing", () => {
    // Desktop has no gamescope: the WM maps the window, atoms are a no-op,
    // and Steam is never frozen — only raiseAboveDesktop() degrades.
    expect(
      shouldBlockOverlayOpen({
        missingTools: ["xdotool"],
        gameModeActive: false,
      }),
    ).toBe(false);
  });

  it("allows a healthy host under gamescope", () => {
    expect(
      shouldBlockOverlayOpen({ missingTools: [], gameModeActive: true }),
    ).toBe(false);
  });
});

describe("formatMissingToolsBanner", () => {
  /** Gaming Mode + one missing tool, the common case. */
  const banner = (missingTools: string[], osRelease: string) =>
    formatMissingToolsBanner({
      missingTools,
      osRelease,
      gameModeActive: true,
    });

  it("names the missing tools and the consequence", () => {
    const text = banner(["xdotool"], "ID=cachyos");
    expect(text).toContain("MISSING REQUIRED TOOL: xdotool");
    expect(text).toContain("CANNOT be shown in Gaming Mode");
    expect(text).toContain("systemctl --user restart loadout-overlay");
  });

  it("pluralises for more than one tool", () => {
    expect(banner(["xdotool", "xprop"], "ID=arch")).toContain(
      "MISSING REQUIRED TOOLS: xdotool, xprop",
    );
  });

  it("gives pacman on Arch-family hosts", () => {
    expect(banner(["xdotool"], "ID=cachyos")).toContain(
      "sudo pacman -S --needed",
    );
  });

  it("gives the read-only-root dance on SteamOS", () => {
    expect(banner(["xdotool"], 'ID=steamos\nNAME="SteamOS"')).toContain(
      "steamos-readonly disable",
    );
  });

  it("gives rpm-ostree on Bazzite", () => {
    expect(banner(["xdotool"], "ID=bazzite")).toContain("rpm-ostree install");
  });

  it("falls back to a generic hint on an unknown distro", () => {
    expect(banner(["xdotool"], "ID=plan9")).toContain("your package manager");
  });

  it("tells the xdotool story only when xdotool is the missing one", () => {
    expect(banner(["xdotool"], "ID=arch")).toContain("X window id with xdotool");
  });

  it("tells the xprop story when only xprop is missing", () => {
    const text = banner(["xprop"], "ID=arch");
    expect(text).toContain("xprop is the");
    expect(text).toContain("OVERLAY_FORCE_XPROP=1");
    // The xdotool explanation must not leak into an xprop-only banner —
    // this is the case the module bothered to model separately.
    expect(text).not.toContain("X window id with xdotool");
  });

  it("covers both tools when both are missing", () => {
    const text = banner(["xdotool", "xprop"], "ID=arch");
    expect(text).toContain("xdotool");
    expect(text).toContain("xprop is the fallback");
  });

  it("says opens are refused in Gaming Mode", () => {
    expect(banner(["xdotool"], "ID=arch")).toContain("Opens are refused");
  });

  it("does NOT claim opens are refused in desktop mode", () => {
    // shouldBlockOverlayOpen returns false when gameModeActive is false, so
    // a banner claiming refusal there would tell a working setup it's broken.
    const text = formatMissingToolsBanner({
      missingTools: ["xdotool"],
      osRelease: "ID=arch",
      gameModeActive: false,
    });
    expect(text).not.toContain("Opens are refused");
    expect(text).toContain("opens are NOT refused here");
    expect(text).toContain("Gaming Mode");
  });
});

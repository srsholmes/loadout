import { describe, it, expect } from "bun:test";
import {
  browserSizeFlags,
  buildLaunchOptionsBase,
} from "./browser-launch-options";

const RES_1080 = { width: 1920, height: 1080 };
const RES_1200 = { width: 1920, height: 1200 };

describe("browserSizeFlags", () => {
  it("emits --new-tab for firefox / librewolf, no CLI sizing", () => {
    expect(browserSizeFlags("firefox-native", RES_1080)).toBe("--new-tab");
    expect(browserSizeFlags("firefox-flatpak", RES_1080)).toBe("--new-tab");
    expect(browserSizeFlags("librewolf-flatpak", RES_1200)).toBe("--new-tab");
  });

  it("emits chromium-family flags for everything else", () => {
    expect(browserSizeFlags("chrome-native", RES_1080)).toBe(
      "--window-size=1920,1080 --window-position=0,0 --force-device-scale-factor=1.5",
    );
    expect(browserSizeFlags("brave-native", RES_1200)).toBe(
      "--window-size=1920,1200 --window-position=0,0 --force-device-scale-factor=1.5",
    );
    expect(browserSizeFlags("chromium-native", RES_1080)).toBe(
      "--window-size=1920,1080 --window-position=0,0 --force-device-scale-factor=1.5",
    );
    expect(browserSizeFlags("edge-native", RES_1080)).toBe(
      "--window-size=1920,1080 --window-position=0,0 --force-device-scale-factor=1.5",
    );
    expect(browserSizeFlags("vivaldi-native", RES_1080)).toBe(
      "--window-size=1920,1080 --window-position=0,0 --force-device-scale-factor=1.5",
    );
  });
});

describe("buildLaunchOptionsBase", () => {
  it("native firefox: just the flags + placeholder, no prefix", () => {
    expect(buildLaunchOptionsBase("firefox-native", RES_1080, "")).toBe(
      "--new-tab {url}",
    );
  });

  it("flatpak firefox: prepends `run <appid>` prefix", () => {
    expect(
      buildLaunchOptionsBase(
        "firefox-flatpak",
        RES_1080,
        "run org.mozilla.firefox",
      ),
    ).toBe("run org.mozilla.firefox --new-tab {url}");
  });

  it("native chromium-family: window-size flags with the actual resolution", () => {
    expect(buildLaunchOptionsBase("chrome-native", RES_1200, "")).toBe(
      "--window-size=1920,1200 --window-position=0,0 --force-device-scale-factor=1.5 {url}",
    );
  });

  it("flatpak chromium-family: prefix + flags + placeholder", () => {
    expect(
      buildLaunchOptionsBase(
        "brave-flatpak",
        RES_1200,
        "run com.brave.Browser",
      ),
    ).toBe(
      "run com.brave.Browser --window-size=1920,1200 --window-position=0,0 --force-device-scale-factor=1.5 {url}",
    );
  });
});

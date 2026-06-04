import { describe, it, expect } from "bun:test";
import { isChromeOrFirefoxBrowserId } from "./browser-id";

describe("isChromeOrFirefoxBrowserId", () => {
  it("matches firefox in any flavour", () => {
    expect(isChromeOrFirefoxBrowserId("firefox-native")).toBe(true);
    expect(isChromeOrFirefoxBrowserId("firefox-flatpak")).toBe(true);
  });

  it("matches chrome family ids", () => {
    expect(isChromeOrFirefoxBrowserId("chrome-native")).toBe(true);
    expect(isChromeOrFirefoxBrowserId("chrome-flatpak")).toBe(true);
  });

  it("matches librewolf (firefox fork)", () => {
    expect(isChromeOrFirefoxBrowserId("librewolf-flatpak")).toBe(true);
  });

  it("does not match brave / edge / chromium / vivaldi", () => {
    expect(isChromeOrFirefoxBrowserId("brave-native")).toBe(false);
    expect(isChromeOrFirefoxBrowserId("edge-native")).toBe(false);
    expect(isChromeOrFirefoxBrowserId("chromium-native")).toBe(false);
    expect(isChromeOrFirefoxBrowserId("vivaldi-native")).toBe(false);
  });

  it("returns false for empty / unknown ids", () => {
    expect(isChromeOrFirefoxBrowserId("")).toBe(false);
    expect(isChromeOrFirefoxBrowserId("opera-native")).toBe(false);
  });
});

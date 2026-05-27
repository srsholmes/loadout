import { describe, it, expect } from "vitest";
import { parseHash, routeToHash, type Route } from "./App";

describe("parseHash", () => {
  it("parses the empty hash as home", () => {
    expect(parseHash("")).toEqual({ view: "home" });
  });

  it("parses '#/' as home", () => {
    expect(parseHash("#/")).toEqual({ view: "home" });
  });

  it("parses '#/settings' as the settings view", () => {
    expect(parseHash("#/settings")).toEqual({ view: "settings" });
  });

  it("parses '#/plugin/<id>' into a plugin route with the id", () => {
    expect(parseHash("#/plugin/foo-bar")).toEqual({
      view: "plugin",
      pluginId: "foo-bar",
    });
  });

  it("preserves underscores, dots, and other id chars", () => {
    expect(parseHash("#/plugin/protondb_badges")).toEqual({
      view: "plugin",
      pluginId: "protondb_badges",
    });
  });

  it("falls back to home for an empty plugin id ('#/plugin/')", () => {
    // No id after the slash — defensive fallback to home.
    expect(parseHash("#/plugin/")).toEqual({ view: "home" });
  });

  it("falls back to home for a malformed hash", () => {
    expect(parseHash("#nonsense")).toEqual({ view: "home" });
    expect(parseHash("garbage")).toEqual({ view: "home" });
  });
});

describe("routeToHash", () => {
  it("serializes home", () => {
    expect(routeToHash({ view: "home" })).toBe("#/");
  });

  it("serializes settings", () => {
    expect(routeToHash({ view: "settings" })).toBe("#/settings");
  });

  it("serializes a plugin route with its id", () => {
    expect(routeToHash({ view: "plugin", pluginId: "lsfg-vk" })).toBe(
      "#/plugin/lsfg-vk",
    );
  });
});

describe("parseHash <-> routeToHash round-trip", () => {
  const routes: Route[] = [
    { view: "home" },
    { view: "settings" },
    { view: "plugin", pluginId: "sgdb" },
    { view: "plugin", pluginId: "css-loader" },
  ];

  for (const route of routes) {
    it(`round-trips ${JSON.stringify(route)}`, () => {
      expect(parseHash(routeToHash(route))).toEqual(route);
    });
  }
});

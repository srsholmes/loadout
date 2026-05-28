import { describe, it, expect } from "bun:test";
import {
  generateBadgeCSS,
  generateBPMScript,
  generateStoreScript,
  generateBPMPushExpression,
  generateStorePushExpression,
  generateStyleInjectionExpression,
  generateCleanupExpression,
  parseStoreAppId,
} from "./badge-scripts";
import { DEFAULT_SETTINGS, type ProtonDBSettings } from "./settings";

const SETTINGS_MINIMALIST: ProtonDBSettings = {
  ...DEFAULT_SETTINGS,
  size: "minimalist",
  position: "br",
  labelOnHover: "regular",
  showSubmitButton: true,
};

describe("generateBadgeCSS", () => {
  it("contains the per-tier background colours", () => {
    const css = generateBadgeCSS();
    // Tier rules need to land — without them the badge renders with no
    // background and is effectively invisible.
    expect(css).toContain(".protondb-tier-platinum");
    expect(css).toContain(".protondb-tier-gold");
    expect(css).toContain(".protondb-tier-silver");
    expect(css).toContain(".protondb-tier-bronze");
    expect(css).toContain(".protondb-tier-borked");
    expect(css).toContain(".protondb-tier-pending");
  });

  it("declares size variants for all three presets", () => {
    const css = generateBadgeCSS();
    expect(css).toContain("protondb-size-regular");
    expect(css).toContain("protondb-size-small");
    expect(css).toContain("protondb-size-minimalist");
  });

  it("defines the Tux indicator class so linux-supported games render the indicator", () => {
    const css = generateBadgeCSS();
    expect(css).toContain(".protondb-tux");
  });
});

describe("generateBPMScript", () => {
  it("embeds the settings as a JSON literal so the runtime gets a snapshot", () => {
    const script = generateBPMScript(SETTINGS_MINIMALIST);
    // Settings are JSON.stringify'd inline — every key from the source
    // settings object should appear verbatim in the produced source.
    expect(script).toContain('"size":"minimalist"');
    expect(script).toContain('"position":"br"');
    expect(script).toContain('"showSubmitButton":true');
  });

  it("exposes the four-method __protondb_badges interface", () => {
    const script = generateBPMScript(DEFAULT_SETTINGS);
    // Backend pushes data via these names — drift here silently breaks
    // every CDP call from `pushBadgeToBPM` and friends.
    expect(script).toContain("window.__protondb_badges");
    expect(script).toContain("cleanup");
    expect(script).toContain("updateBadge");
    expect(script).toContain("removeBadge");
    expect(script).toContain("updateSettings");
  });

  it("guards against re-injection by cleaning up the previous runtime first", () => {
    const script = generateBPMScript(DEFAULT_SETTINGS);
    // Without this the badge double-binds and click handlers stack —
    // re-injection happens on every settings update.
    expect(script).toContain(
      "if (window.__protondb_badges) window.__protondb_badges.cleanup()",
    );
  });

  it("includes both the ATOM (badge icon) and TUX SVGs", () => {
    const script = generateBPMScript(DEFAULT_SETTINGS);
    expect(script).toContain("ATOM_SVG");
    expect(script).toContain("TUX_SVG");
  });
});

describe("generateStoreScript", () => {
  it("exposes the three-method __protondb_store_badges interface", () => {
    const script = generateStoreScript();
    expect(script).toContain("window.__protondb_store_badges");
    expect(script).toContain("cleanup");
    expect(script).toContain("updateBadge");
    expect(script).toContain("removeBadge");
  });

  it("guards against re-injection", () => {
    const script = generateStoreScript();
    expect(script).toContain(
      "if (window.__protondb_store_badges) window.__protondb_store_badges.cleanup()",
    );
  });

  it("maps every tier to a colour + label", () => {
    const script = generateStoreScript();
    for (const tier of ["platinum", "gold", "silver", "bronze", "borked", "pending"]) {
      expect(script).toContain(tier);
    }
  });
});

describe("generateBPMPushExpression", () => {
  it("returns a removeBadge call when payload is null", () => {
    const expr = generateBPMPushExpression(null);
    expect(expr).toContain("removeBadge()");
    expect(expr).not.toContain("updateBadge(");
  });

  it("JSON-stringifies the payload inside updateBadge", () => {
    const expr = generateBPMPushExpression({
      report: { tier: "gold", confidence: "good", score: 0.75, trendingTier: "platinum" },
      linuxSupport: true,
      settings: DEFAULT_SETTINGS,
      appId: "12345",
    });
    expect(expr).toContain("updateBadge(");
    expect(expr).toContain('"tier":"gold"');
    expect(expr).toContain('"linuxSupport":true');
    expect(expr).toContain('"appId":"12345"');
  });

  it("guards against the runtime being absent", () => {
    // If the runtime hasn't been injected yet (e.g. push fires before
    // injectBadgeSystem completes), `window.__protondb_badges` is
    // undefined and we must not throw.
    const expr = generateBPMPushExpression(null);
    expect(expr).toContain("if (window.__protondb_badges)");
  });
});

describe("generateStorePushExpression", () => {
  it("returns a removeBadge call when payload is null", () => {
    const expr = generateStorePushExpression(null);
    expect(expr).toContain("removeBadge()");
    expect(expr).not.toContain("updateBadge(");
  });

  it("JSON-stringifies the payload inside updateBadge", () => {
    const expr = generateStorePushExpression({
      report: { tier: "silver" },
      appId: "99999",
    });
    expect(expr).toContain("updateBadge(");
    expect(expr).toContain('"tier":"silver"');
    expect(expr).toContain('"appId":"99999"');
  });
});

describe("generateStyleInjectionExpression", () => {
  it("removes any prior <style> with the same id before inserting", () => {
    const expr = generateStyleInjectionExpression("my-styles", ".x{}");
    expect(expr).toContain('document.getElementById("my-styles")');
    expect(expr).toContain("if (e) e.remove()");
  });

  it("tags the injected node with the loadout-plugin breadcrumb", () => {
    const expr = generateStyleInjectionExpression("my-styles", ".x{}");
    expect(expr).toContain('s.dataset.loadoutPlugin = "protondb-badges"');
  });

  it("escapes backticks in the CSS so template-literal interpolation does not break", () => {
    const css = ".x { content: '`'; }";
    const expr = generateStyleInjectionExpression("my-styles", css);
    // Backticks in CSS must be escaped — otherwise they'd terminate the
    // outer template literal we're emitting inside.
    expect(expr).toContain("\\`");
  });

  it("escapes ${} interpolations in CSS", () => {
    const css = ".x { content: '${oops}'; }";
    const expr = generateStyleInjectionExpression("my-styles", css);
    expect(expr).toContain("\\$");
  });
});

describe("generateCleanupExpression", () => {
  it("tears down both BPM and store runtimes", () => {
    const expr = generateCleanupExpression("my-styles");
    expect(expr).toContain("__protondb_badges");
    expect(expr).toContain("__protondb_store_badges");
    expect(expr).toContain("cleanup()");
  });

  it("removes the injected style node", () => {
    const expr = generateCleanupExpression("my-styles");
    expect(expr).toContain('document.getElementById("my-styles")');
  });
});

describe("parseStoreAppId", () => {
  it("returns the appid for a store game-detail URL", () => {
    expect(
      parseStoreAppId("https://store.steampowered.com/app/12345/Portal_2/"),
    ).toBe("12345");
  });

  it("returns the appid for the URL with no trailing slug", () => {
    expect(
      parseStoreAppId("https://store.steampowered.com/app/67890"),
    ).toBe("67890");
  });

  it("returns null for the storefront", () => {
    expect(
      parseStoreAppId("https://store.steampowered.com/"),
    ).toBeNull();
  });

  it("returns null for search / library / category pages", () => {
    expect(
      parseStoreAppId("https://store.steampowered.com/search/?term=portal"),
    ).toBeNull();
    expect(
      parseStoreAppId("https://store.steampowered.com/category/action/"),
    ).toBeNull();
  });

  it("returns null for null / undefined / empty input", () => {
    expect(parseStoreAppId(null)).toBeNull();
    expect(parseStoreAppId(undefined)).toBeNull();
    expect(parseStoreAppId("")).toBeNull();
  });
});

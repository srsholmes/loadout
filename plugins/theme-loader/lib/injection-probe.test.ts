import { describe, it, expect } from "bun:test";
import {
  EMPTY_CSS_MARKER,
  buildInjectStyleExpression,
  buildMissingStylesExpression,
  buildRemoveStyleExpression,
  parseMissingStyles,
} from "./injection-probe";

/**
 * The probe runs inside Steam's CEF, so the value that comes back is
 * whatever that page decided to hand us. These tests pin the two halves
 * we control: the expression we send, and how defensively we read the
 * reply.
 */
describe("buildMissingStylesExpression", () => {
  /** Evaluate the built expression against a stub `document`. */
  function run(styleIds: string[], present: Record<string, string | null>): string[] {
    const document = {
      getElementById(id: string) {
        if (!(id in present)) return null;
        return { isConnected: true, textContent: present[id] };
      },
    };
    const expr = buildMissingStylesExpression(styleIds);
    return new Function("document", `return (${expr});`)(document) as string[];
  }

  it("reports nothing missing when every style is present and populated", () => {
    expect(
      run(["a", "b"], { a: "body{}", b: ".x{}" }),
    ).toEqual([]);
  });

  it("reports styles whose element is absent", () => {
    expect(run(["a", "b"], { a: "body{}" })).toEqual(["b"]);
  });

  it("reports styles that exist but are empty — an interrupted injection", () => {
    expect(run(["a"], { a: "" })).toEqual(["a"]);
  });

  it("reports a detached element as missing", () => {
    const document = {
      getElementById: () => ({ isConnected: false, textContent: "body{}" }),
    };
    const result = new Function(
      "document",
      `return (${buildMissingStylesExpression(["a"])});`,
    )(document) as string[];
    expect(result).toEqual(["a"]);
  });

  it("escapes ids into the expression rather than interpolating them raw", () => {
    const expr = buildMissingStylesExpression(['a"; alert(1); //']);
    expect(expr).toContain(JSON.stringify(['a"; alert(1); //']));
  });
});

describe("parseMissingStyles", () => {
  it("keeps ids we asked about", () => {
    expect(parseMissingStyles(["a", "b"], ["a", "b", "c"])).toEqual(["a", "b"]);
  });

  it("drops ids we did not ask about", () => {
    expect(parseMissingStyles(["a", "zzz"], ["a"])).toEqual(["a"]);
  });

  it("treats a non-array reply as nothing missing, never as everything missing", () => {
    for (const raw of [undefined, null, "a", 3, {}]) {
      expect(parseMissingStyles(raw, ["a", "b"])).toEqual([]);
    }
  });

  it("drops non-string entries", () => {
    expect(parseMissingStyles(["a", 1, null], ["a"])).toEqual(["a"]);
  });
});

describe("buildInjectStyleExpression", () => {
  /** Evaluate the built expression against a stub document. */
  function run(
    { styleId, css, head }: { styleId: string; css: string; head?: unknown },
  ) {
    const created: Record<string, unknown>[] = [];
    const appended: Record<string, unknown>[] = [];
    const container = { appendChild: (el: Record<string, unknown>) => appended.push(el) };
    const document = {
      head: head === undefined ? container : head,
      documentElement: container,
      getElementById: () => null,
      createElement: () => {
        const el = { id: "", textContent: "", dataset: {}, classList: { add: () => {} } };
        created.push(el);
        return el;
      },
    };
    new Function("document", `return (${buildInjectStyleExpression({ styleId, css })});`)(document);
    return { created, appended };
  }

  it("sets the style id and the CSS", () => {
    const { created, appended } = run({ styleId: "theme-loader-a", css: "body { color: red; }" });
    expect(created[0]!.id).toBe("theme-loader-a");
    expect(created[0]!.textContent).toBe("body { color: red; }");
    expect(appended).toHaveLength(1);
  });

  /**
   * <head> can still be null on a tab caught mid-load during boot — the
   * exact window this plugin's boot fix targets.
   */
  it("falls back to documentElement when head is null", () => {
    const { appended } = run({ styleId: "theme-loader-a", css: "body{}", head: null });
    expect(appended).toHaveLength(1);
  });

  /**
   * assemblePackCss legitimately returns "" (empty inject map, or a pack
   * whose files all failed to read). An empty <style> reads as missing to
   * the probe, so without a marker the verify pass would re-inject that
   * theme on every tick for the life of the session.
   */
  it("writes a marker for empty CSS so the probe cannot loop on it", () => {
    const { created } = run({ styleId: "theme-loader-a", css: "" });
    expect(created[0]!.textContent).toBe(EMPTY_CSS_MARKER);

    const missing = new Function(
      "document",
      `return (${buildMissingStylesExpression(["theme-loader-a"])});`,
    )({
      getElementById: () => ({ isConnected: true, textContent: EMPTY_CSS_MARKER }),
    }) as string[];
    expect(missing).toEqual([]);
  });

  it("escapes backticks, backslashes and interpolation in the CSS", () => {
    const css = "a::after { content: '`${alert(1)}\\'; }";
    const { created } = run({ styleId: "theme-loader-a", css });
    expect(created[0]!.textContent).toBe(css);
  });

  it("escapes the style id rather than interpolating it raw", () => {
    const expr = buildInjectStyleExpression({ styleId: 'a"); alert(1); //', css: "body{}" });
    expect(expr).toContain(JSON.stringify('a"); alert(1); //'));
  });
});

describe("buildRemoveStyleExpression", () => {
  it("removes the element from its parent", () => {
    let removed: unknown = null;
    const el = { parentNode: { removeChild: (e: unknown) => { removed = e; } } };
    new Function("document", `return (${buildRemoveStyleExpression("theme-loader-a")});`)({
      getElementById: () => el,
    });
    expect(removed).toBe(el);
  });

  it("is a no-op when the element is absent", () => {
    expect(() =>
      new Function("document", `return (${buildRemoveStyleExpression("theme-loader-a")});`)({
        getElementById: () => null,
      }),
    ).not.toThrow();
  });
});

import { describe, it, expect } from "bun:test";
import {
  buildMissingStylesExpression,
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

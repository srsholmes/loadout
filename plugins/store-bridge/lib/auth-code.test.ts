import { describe, it, expect } from "bun:test";
import { extractAuthCode } from "./auth-code";

// Real Epic auth codes are 32 hex chars. Fixtures match that shape so
// the validator we added (≥16 alnum chars, no dashes/whitespace) treats
// them as plausible.
const REAL_CODE = "abcd1234efgh5678ijkl9012mnop3456";
const URL_CODE = "0123456789abcdef0123456789abcdef";

describe("extractAuthCode", () => {
  it("returns the raw code when the user only pasted the value", () => {
    expect(extractAuthCode(REAL_CODE)).toBe(REAL_CODE);
  });

  it("trims surrounding whitespace", () => {
    expect(extractAuthCode(`   ${REAL_CODE}   `)).toBe(REAL_CODE);
  });

  it("strips surrounding quotes when the user grabbed them too", () => {
    expect(extractAuthCode(`"${REAL_CODE}"`)).toBe(REAL_CODE);
    expect(extractAuthCode(`'${REAL_CODE}'`)).toBe(REAL_CODE);
  });

  it("pulls authorizationCode out of Epic's JSON response", () => {
    const payload = JSON.stringify({
      redirectUrl: `https://localhost/launcher/authorized?code=${URL_CODE}`,
      authorizationCode: REAL_CODE,
      exchangeCode: null,
      sid: null,
    });
    expect(extractAuthCode(payload)).toBe(REAL_CODE);
  });

  it("falls back to auth_code / code in non-Epic JSON shapes", () => {
    expect(extractAuthCode(`{"code":"${REAL_CODE}"}`)).toBe(REAL_CODE);
    expect(extractAuthCode(`{"auth_code":"${REAL_CODE}"}`)).toBe(REAL_CODE);
  });

  it("pulls the code out of a redirect URL paste", () => {
    expect(
      extractAuthCode(
        `https://localhost/launcher/authorized?code=${URL_CODE}`,
      ),
    ).toBe(URL_CODE);
  });

  it("rejects URL-decoded codes with non-alnum characters", () => {
    // URL decoding can produce `+`/`=`/`/` etc.; the validator treats
    // those as implausible and short-circuits to null so the UI's
    // Complete button stays disabled.
    expect(extractAuthCode("https://x?code=a%2Bb%3Dc")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(extractAuthCode("")).toBeNull();
    expect(extractAuthCode("   ")).toBeNull();
  });

  it("returns null when the JSON is malformed or contains an implausible code", () => {
    // Realistic case: user copies a half-line by mistake.
    expect(extractAuthCode("{bad json}")).toBeNull();
    // JSON with a short code is rejected at the validator level too.
    expect(extractAuthCode('{"code":"abc"}')).toBeNull();
  });
});

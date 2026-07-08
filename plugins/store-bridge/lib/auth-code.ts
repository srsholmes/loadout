/**
 * Best-effort extraction of an Epic auth code from whatever the user
 * pasted. After logging in, Epic shows a JSON page like:
 *
 *   {
 *     "redirectUrl": "https://localhost/launcher/authorized?code=AUTH_CODE",
 *     "authorizationCode": "abcd1234...",
 *     "exchangeCode": null,
 *     "sid": null,
 *     "ssoV2Enabled": true
 *   }
 *
 * People reflexively copy: the whole JSON, just the redirectUrl, or
 * just the `authorizationCode` string. We accept all three plus the
 * raw value, so the UI never has to make the user do string surgery.
 *
 * Returns the trimmed code, or null when nothing usable is found.
 * Real Epic auth codes are 32 hex characters; we enforce alnum-only
 * (no dashes, no whitespace) and a minimum length of 16 so a stray
 * "hello" paste doesn't sail through and the Complete button stays
 * disabled until something plausibly code-shaped is in the field.
 * legendary still rejects malformed codes with a readable error,
 * so this is just to keep the UI honest.
 */
const PLAUSIBLE_CODE_RE = /^[A-Za-z0-9]{16,}$/;

function plausible(s: string): boolean {
  return PLAUSIBLE_CODE_RE.test(s);
}

export function extractAuthCode(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // JSON paste — `authorizationCode` is the canonical Epic field; a
  // few mirror sites/tools call it `auth_code` or just `code`. Try the
  // common keys before bailing.
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      for (const key of ["authorizationCode", "auth_code", "code"]) {
        const v = parsed[key];
        if (typeof v === "string" && plausible(v.trim())) return v.trim();
      }
    } catch {
      // fall through — maybe it's a URL with a `{` somewhere weird
    }
  }

  // URL paste — `?code=…` or `&code=…`. We avoid `new URL()` because
  // the user may paste a path fragment (`/launcher/authorized?code=…`)
  // that URL constructors choke on without a base.
  const queryMatch = trimmed.match(/[?&]code=([^&#\s"']+)/);
  if (queryMatch) {
    // Group 1 always captures when the match succeeds.
    const decoded = decodeURIComponent(queryMatch[1]!);
    return plausible(decoded) ? decoded : null;
  }

  // Raw paste — strip surrounding quotes the user may have grabbed
  // along with the value, then validate.
  const bare = trimmed.replace(/^['"]|['"]$/g, "");
  return plausible(bare) ? bare : null;
}

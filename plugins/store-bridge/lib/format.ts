/**
 * Display-formatting helpers — pure, deterministic, no I/O.
 *
 * Extracted from `app.tsx` so they can be unit-tested directly
 * (formerly only exercised through the React tree, where their
 * regex-keyed branches were trivial to regress without anyone
 * noticing). Lives in `lib/` per the project convention for
 * deterministic helpers that don't pull React.
 */

/**
 * Format a byte count as GiB (when >= 1 GiB) or MiB. Returns null for
 * zero / negative / undefined so callers can skip rendering rather
 * than print "0.0 MiB" on a library entry that hasn't reported size.
 */
export function formatBytes(bytes?: number): string | null {
  if (!bytes || bytes <= 0) return null;
  const gib = bytes / (1024 * 1024 * 1024);
  if (gib >= 1) return `${gib.toFixed(2)} GiB`;
  const mib = bytes / (1024 * 1024);
  return `${mib.toFixed(1)} MiB`;
}

/**
 * Format an ISO release date as "Mmm YYYY" in the user's locale. Epic's
 * release dates aren't always accurate to the day, so a short
 * month-year format reads cleaner than the full date. Returns null
 * for unparseable / missing input.
 */
export function formatReleaseDate(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

/**
 * Rewrite raw legendary stderr / Error messages into something a
 * non-technical user can act on. The original message is the
 * fall-through so anything we don't have a heuristic for still
 * surfaces — opaque is better than swallowed.
 *
 * Heuristics intentionally match upstream phrasing: legendary's
 * "login session expired", "no space left", "blocked by a concurrent
 * run", etc. Keep this in sync with the strings in
 * `lib/stores/epic/legendary.ts`.
 */
const TRIM_LIMIT = 160;

export function friendlyErrorMessage(raw: string): string {
  const m = raw.toLowerCase();
  if (/login session expired|refresh failed|no account|not logged in/.test(m)) {
    return "Epic sign-in expired. Sign out and sign in again in Settings.";
  }
  if (/no space left|enospc|disk full/.test(m)) {
    return "Out of disk space. Free up space or change the install location.";
  }
  if (/nameresolution|connection refused|network is unreachable|connection reset|timed out/.test(m)) {
    return "Couldn't reach Epic. Check your internet and retry.";
  }
  if (/blocked by a concurrent run/.test(m)) {
    return "Another install was running and blocked this one. Try again.";
  }
  if (/can't determine the launch executable/i.test(raw)) {
    return raw;
  }
  const trimmed = raw.trim();
  return trimmed.length > TRIM_LIMIT ? trimmed.slice(0, TRIM_LIMIT - 3) + "…" : trimmed;
}

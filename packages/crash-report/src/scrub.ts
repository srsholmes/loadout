/**
 * Scrubbing — the last thing that runs before anything leaves the device.
 *
 * Everything here is pure and synchronous so it can be tested exhaustively
 * against real payload shapes. If you add a field to the event, add it to
 * `scrubEvent` and to the test table; a field that isn't scrubbed is a
 * field that ships someone's username to a third party.
 *
 * Two jobs, and the second one is why this isn't merely a privacy tax:
 *
 *  1. Remove identifying data — home directories, usernames, credentials.
 *  2. Normalise paths so the same crash from two different users produces
 *     the same fingerprint. Plugins are compiled on the end user's machine
 *     (see plugin-manager.ts), so their frames carry absolute local paths;
 *     without normalisation every user's copy of one bug is a separate
 *     Sentry issue.
 */

import type { Frame, SentryEvent } from "./types";

/**
 * Any user's home directory, not just this process's. The backend runs as
 * root, so `homedir()` is `/root` while the frames it collects reference
 * `/home/deck/...`. Scrubbing only the current home would miss exactly the
 * paths that carry the username.
 */
const ANY_HOME = /\/home\/[^/\s:)'"]+/g;

/** `/run/user/1000` → `/run/user/<uid>`; the uid is weakly identifying. */
const RUN_USER = /\/run\/user\/\d+/g;

/**
 * On-device plugin install paths. Runs *after* home normalisation, so the
 * leading segment is usually `~`. The alternation must *consume* that `~`,
 * not just look at it — an earlier version left it behind and produced
 * `~<plugins>/hltb`, which the never-leaks test caught.
 *
 * Captures the plugin id so it survives into the fingerprint: we still want
 * to know which plugin broke.
 */
const PLUGIN_PATH = /(?:~|\/)[^\s:)'"]*?\/loadout\/plugins\/([^/\s:)'"]+)/g;

/**
 * SteamID64. A persistent account identifier, and it turns up in ordinary
 * paths (`~/.steam/steam/userdata/<id>/`) as well as error text. All real
 * ones start 7656119 and run 17 digits.
 */
const STEAM_ID64 = /\b7656119\d{10}\b/g;

/**
 * Credentials that turn up inside error messages. The SGDB integration puts
 * an API key in a query string and loadout's own RPC uses a session token,
 * so a failed-request message can carry either. Matches `key=`, `token=`,
 * `api_key=`, `access_token=`, `password=`, `secret=` and Bearer headers.
 */
const QUERY_SECRET = /\b((?:api[_-]?|access[_-]?)?(?:key|token|password|secret))=[^&\s"')]+/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;

export interface ScrubOptions {
  /**
   * This machine's hostname. Passed in rather than read here so the function
   * stays pure and testable. Linux hostnames are frequently personal
   * ("simons-deck"), and while we never *set* `server_name`, a hostname can
   * still appear inside an error message — which is exactly how the
   * never-leaks test first caught it.
   */
  hostname?: string;
}

/** Escape a value for safe use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Scrub a single string. Order matters: credentials first (they can contain
 * slashes), then homes, then the plugin rewrite that depends on `~`.
 */
export function scrubString(input: string, opts: ScrubOptions = {}): string {
  let out = input
    .replace(QUERY_SECRET, "$1=<redacted>")
    .replace(BEARER, "Bearer <redacted>")
    .replace(ANY_HOME, "~")
    .replace(RUN_USER, "/run/user/<uid>")
    .replace(PLUGIN_PATH, "<plugins>/$1")
    .replace(STEAM_ID64, "<steamid>");
  // Very short hostnames ("deck") would match far too much ordinary text,
  // so only substitute one distinctive enough to be worth removing.
  if (opts.hostname && opts.hostname.length >= 5) {
    out = out.replace(new RegExp(escapeRe(opts.hostname), "g"), "<host>");
  }
  return out;
}

function scrubFrame(frame: Frame, opts: ScrubOptions): Frame {
  const out: Frame = { ...frame };
  if (out.filename) out.filename = scrubString(out.filename, opts);
  if (out.function) out.function = scrubString(out.function, opts);
  return out;
}

/**
 * Scrub a whole event in place-safe fashion (returns a new object).
 *
 * Also enforces the absences the type doc promises, defensively: `user`,
 * `server_name`, `breadcrumbs` and `request` are deleted even though we
 * never set them, so a future callsite can't reintroduce them by accident.
 */
export function scrubEvent(event: SentryEvent, opts: ScrubOptions = {}): SentryEvent {
  const out: SentryEvent = { ...event };

  if (out.exception?.values) {
    out.exception = {
      values: out.exception.values.map((v) => ({
        ...v,
        type: scrubString(v.type, opts),
        value: scrubString(v.value, opts),
        stacktrace: v.stacktrace
          ? { frames: v.stacktrace.frames.map((f) => scrubFrame(f, opts)) }
          : undefined,
      })),
    };
  }

  if (out.message) out.message = { formatted: scrubString(out.message.formatted, opts) };

  if (out.tags) {
    out.tags = Object.fromEntries(
      Object.entries(out.tags).map(([k, v]) => [k, scrubString(v, opts)]),
    );
  }

  // Belt and braces: these must never be present. We don't set them, but
  // deleting here means a future edit upstream can't leak them silently.
  const loose = out as unknown as Record<string, unknown>;
  delete loose.user;
  delete loose.server_name;
  delete loose.breadcrumbs;
  delete loose.request;

  return out;
}

/**
 * Stable fingerprint for dedup and rate limiting, computed *after*
 * scrubbing so it's identical across users hitting the same bug.
 *
 * Deliberately coarse: exception type + the top few in-app frames by
 * file/function, ignoring line numbers so a one-line edit between releases
 * doesn't reset the dedup window mid-crash-loop.
 */
export function fingerprint(event: SentryEvent): string {
  const ex = event.exception?.values?.[0];
  const parts: string[] = [event.tags?.process ?? "", ex?.type ?? "", ex?.value ?? ""];
  const frames = (ex?.stacktrace?.frames ?? []).filter((f) => f.in_app !== false).slice(-3);
  for (const f of frames) parts.push(`${f.filename ?? ""}:${f.function ?? ""}`);
  return djb2(parts.join("|"));
}

/** Small non-cryptographic hash — this is a dedup key, not a security boundary. */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

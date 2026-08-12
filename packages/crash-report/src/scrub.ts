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
 *     issue in Grafana.
 */

import type { FaroFrame, FaroPayload } from "./types";

/**
 * Any user's home directory, not just this process's. The backend runs as
 * root, so `homedir()` is `/root` while the frames it collects reference
 * `/home/deck/...`. Scrubbing only the current home would miss exactly the
 * paths that carry the username.
 *
 * The optional `/var` prefix covers ostree-based distros (Bazzite, Silverblue)
 * where real homes live at `/var/home/<user>`. Without it the `/home` branch
 * still matched the tail and produced a mangled `/var~/…`.
 */
const ANY_HOME = /(?:\/var)?\/home\/[^/\s:)'"]+/g;

/**
 * Removable-media mount points, which embed the username on every desktop
 * Linux system: `/run/media/<user>/<label>` (udisks2) and `/media/<user>/…`.
 *
 * This codebase constructs these paths deliberately — the storage plugin
 * builds `/run/media/${user}/${name}` from the real desktop username — so an
 * error thrown anywhere near SD-card handling carries it. The volume label
 * after the username is kept: it's useful for triage and is not a username.
 */
const MEDIA_MOUNT = /\/(?:run\/)?media\/[^/\s:)'"]+/g;

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
 * Steam account identifiers. All of these are permanent and resolve to a
 * public profile, so any one of them makes reports linkable to a named person
 * and to each other.
 *
 * The important case is the **32-bit account ID**, not the SteamID64. Steam
 * names `userdata/` directories by the 32-bit form (`userdata/25139426`), and
 * that is the value this codebase actually handles — steam-paths,
 * game-library, sgdb-art, steam-grid, hltb and playtime all build
 * `<userdata>/<accountId>/…` paths. `7656119…` appears nowhere in loadout
 * outside this file. An earlier version scrubbed only the SteamID64 and so
 * matched a format we never see, while the one we do see went out intact;
 * adding 76561197960265728 to it yields the SteamID64 and the profile URL.
 *
 * The account ID is scrubbed only in `userdata/` context — a bare 8-digit
 * number is indistinguishable from a timestamp or a byte count, and blanket
 * substitution would corrupt ordinary error text.
 */
const STEAM_USERDATA = /(userdata\/)\d{4,}/gi;
const STEAM_ID64 = /\b7656119\d{10}\b/g;
/** `[U:1:25139426]` — the SteamID3 rendering of the same account ID. */
const STEAM_ID3 = /\[U:1:\d+\]/g;
/** `STEAM_0:1:12569713` — the legacy SteamID2 rendering. */
const STEAM_ID2 = /\bSTEAM_[0-5]:[01]:\d+\b/gi;

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
  /**
   * The account name (the basename of the user's home). Path rules above
   * strip it from paths we recognise; this catches it in free-form error
   * text and in any path shape we did not anticipate — which matters because
   * the capture points exist precisely for *unanticipated* failures.
   */
  username?: string;
}

/**
 * Substituting a very short token would corrupt ordinary prose — "deck"
 * appears in "steamdeck", "decked", and half the identifiers in this project.
 * Below this length we leave it, accepting that the canonical SteamOS
 * username ("deck") is shared by every device and identifies nobody.
 */
const MIN_TOKEN_LEN = 5;

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
    // Media mounts before homes: both end up rewritten, but doing media
    // first keeps the `<media>` marker rather than a half-applied `~`.
    .replace(MEDIA_MOUNT, "<media>")
    .replace(ANY_HOME, "~")
    .replace(RUN_USER, "/run/user/<uid>")
    .replace(PLUGIN_PATH, "<plugins>/$1")
    .replace(STEAM_USERDATA, "$1<steamid>")
    .replace(STEAM_ID64, "<steamid>")
    .replace(STEAM_ID3, "<steamid>")
    .replace(STEAM_ID2, "<steamid>");
  // Case-insensitive: a hostname can appear capitalised in error text even
  // though the system stores it lowercase.
  if (opts.hostname && opts.hostname.length >= MIN_TOKEN_LEN) {
    out = out.replace(new RegExp(escapeRe(opts.hostname), "gi"), "<host>");
  }
  if (opts.username && opts.username.length >= MIN_TOKEN_LEN) {
    out = out.replace(new RegExp(escapeRe(opts.username), "gi"), "<user>");
  }
  return out;
}

function scrubFrame(frame: FaroFrame, opts: ScrubOptions): FaroFrame {
  return {
    ...frame,
    filename: scrubString(frame.filename, opts),
    function: scrubString(frame.function, opts),
  };
}

/**
 * Scrub a whole event in place-safe fashion (returns a new object).
 *
 * Also enforces the absences the type doc promises, defensively: `user`,
 * `server_name`, `breadcrumbs` and `request` are deleted even though we
 * never set them, so a future callsite can't reintroduce them by accident.
 */
export function scrubEvent(payload: FaroPayload, opts: ScrubOptions = {}): FaroPayload {
  const out: FaroPayload = {
    meta: { ...payload.meta },
    exceptions: payload.exceptions.map((ex) => ({
      ...ex,
      type: scrubString(ex.type, opts),
      value: scrubString(ex.value, opts),
      stacktrace: ex.stacktrace
        ? { frames: ex.stacktrace.frames.map((f) => scrubFrame(f, opts)) }
        : undefined,
      context: ex.context
        ? Object.fromEntries(
            Object.entries(ex.context).map(([k, v]) => [k, scrubString(v, opts)]),
          )
        : undefined,
    })),
  };

  // Belt and braces: Faro supports all of these and we never populate them.
  // Deleting here means a future edit upstream cannot leak them silently.
  const meta = out.meta as unknown as Record<string, unknown>;
  delete meta.user;
  delete meta.page;
  delete meta.browser;
  delete meta.view;
  delete meta.device;
  const app = out.meta.app as unknown as Record<string, unknown>;
  delete app.installationId;

  return out;
}

/** Runtime/vendor frames, excluded from the fingerprint. */
const VENDOR_FRAME = /(?:^|\/)(?:node_modules|bun:|node:)/;

/**
 * Stable fingerprint, computed *after* scrubbing so it's identical across
 * users hitting the same bug.
 *
 * Serves two purposes. Locally it is the dedup key for rate limiting — the
 * thing that stops a crash loop reporting forever. On the wire it becomes
 * `FaroException.fingerprint`, which is the **top layer** of Grafana's error
 * grouping and takes priority over its own stack normalisation. Getting it
 * stable across machines is what makes one bug read as one issue with N
 * affected devices, rather than N separate issues.
 *
 * Deliberately coarse: exception type and the innermost few app frames by
 * file/function, ignoring line numbers so a one-line edit between releases
 * doesn't split a group or reset a dedup window mid-crash-loop.
 */
export function fingerprint(payload: FaroPayload): string {
  const ex = payload.exceptions[0];
  const parts: string[] = [
    payload.meta.app.namespace ?? "",
    ex?.type ?? "",
    ex?.value ?? "",
  ];
  const frames = (ex?.stacktrace?.frames ?? [])
    .filter((f) => !VENDOR_FRAME.test(f.filename))
    .slice(-3);
  for (const f of frames) parts.push(`${f.filename}:${f.function}`);
  return djb2(parts.join("|"));
}

/** Small non-cryptographic hash — this is a dedup key, not a security boundary. */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

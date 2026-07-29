/**
 * Helpers shared by the two halves of the self-update pipeline (issue
 * #173): the root loader (apps/loadout/src/loader/self-update.ts) and
 * the overlay Bun host (apps/loadout-overlay/src/bun/lib/updater.ts).
 * These started as documented per-module copies (per the
 * plugins/store-bridge/lib/github-release.ts convention of copying
 * until a third consumer appears); the loader + overlay copies made
 * three, so they live here now. The store-bridge plugin keeps its own
 * variant — it has plugin-specific token handling and isn't part of
 * the self-update surface.
 */

/** Hosts a GitHub release-asset redirect chain may pass through.
 *  Checked on EVERY hop — an attacker-controlled hop must fail before
 *  its body is fetched. */
const TRUSTED_GITHUB_HOSTS = [
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
];

export function isTrustedGithubHost(host: string): boolean {
  const lower = host.toLowerCase();
  return TRUSTED_GITHUB_HOSTS.some((t) => lower === t || lower.endsWith(`.${t}`));
}

/** Parse a `sha256sum`-format manifest ("<hex>  <filename>" lines)
 *  into filename → lowercase hex. Tolerates the `*` binary-mode
 *  marker and blank lines. */
export function parseSha256Sums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
    const hash = m?.[1];
    const name = m?.[2];
    if (hash && name) out.set(name.trim(), hash.toLowerCase());
  }
  return out;
}

/** AbortController that fires after `ms` of silence; call reset() on
 *  every received chunk. Used to kill a stalled download — a half-open
 *  TCP connection would otherwise hang `fetch` forever, pinning the
 *  updater in a non-terminal phase where every retry is refused as
 *  "update already in progress". Timers are unref'd so a pending
 *  watchdog never keeps the process (or a test) alive on its own. */
export function makeIdleAbort(ms: number): {
  signal: AbortSignal;
  reset: () => void;
  clear: () => void;
} {
  const controller = new AbortController();
  const arm = () => {
    const t = setTimeout(
      () => controller.abort(new Error(`download stalled (no data for ${ms / 1000}s)`)),
      ms,
    );
    (t as unknown as { unref?: () => void }).unref?.();
    return t;
  };
  let timer = arm();
  return {
    signal: controller.signal,
    reset() {
      clearTimeout(timer);
      timer = arm();
    },
    clear() {
      clearTimeout(timer);
    },
  };
}

// -- Overlay updater status surface --------------------------------------------
// Defined here (not in the overlay's bun module) because BOTH sides of
// the Electrobun RPC boundary need the shape: the Bun host produces it
// (lib/updater.ts) and the webview consumes it (overlay/lib/host.ts).

export type UpdatePhase =
  | "idle"
  | "downloading"
  | "verifying"
  | "backend"
  | "swapping"
  | "restarting"
  | "error";

export interface UpdateStatus {
  phase: UpdatePhase;
  /** 0-100 coarse overall progress across all phases. */
  pct?: number;
  message?: string;
  tag?: string;
}

export interface UpdateCheckResult {
  available: boolean;
  /** Release tag, e.g. "v0.7.0". Present whenever a release resolved. */
  tag?: string;
  /** Bare version of `tag`, e.g. "0.7.0". */
  latestVersion?: string;
  error?: string;
}

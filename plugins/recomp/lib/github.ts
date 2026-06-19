import { rm, rename } from "node:fs/promises";
import { spawn } from "@loadout/exec";

// ── GitHub API error classification + retry ──────────────────────────
//
// Release/asset lookups against the GitHub API fail for distinct
// reasons that demand distinct handling:
//
//   • 404 → the repo/release genuinely doesn't exist. Retrying is
//     pointless and just delays the (correct) failure.
//   • 403 with `x-ratelimit-remaining: 0` → we've hit the hourly
//     rate limit. Hammer-retrying makes it strictly worse; surface
//     a clear message (including the reset time when present) so the
//     user knows to wait or set GITHUB_TOKEN.
//   • 5xx / network error → a transient upstream hiccup. A bounded
//     retry with backoff turns what would otherwise be a permanent
//     install failure into a brief stall.
//
// `githubFetch` centralises this so every API caller (fetchReleases,
// mods' fetchRelease, …) gets the same behaviour.

/** Repo / release / asset not found (HTTP 404). Never retried. */
export class GitHubNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubNotFoundError";
  }
}

/** GitHub API hourly rate limit hit (HTTP 403, remaining=0). Not
 *  retried — surfaces the reset time when GitHub provides it. */
export class GitHubRateLimitError extends Error {
  constructor(
    message: string,
    /** Unix epoch seconds when the limit resets, if known. */
    public readonly resetAt?: number,
  ) {
    super(message);
    this.name = "GitHubRateLimitError";
  }
}

/** Transient upstream failure (5xx / network). Thrown only after the
 *  bounded retry budget is exhausted. */
export class GitHubTransientError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubTransientError";
  }
}

export interface GitHubFetchOptions {
  /** Max retries for transient (5xx / network) failures. 404/403 are
   *  never retried. Defaults to 2 (→ up to 3 attempts total). */
  retries?: number;
  /** Backoff in ms before retry attempt `n` (1-based). Injectable so
   *  tests don't actually sleep. Defaults to exponential 250·2ⁿ⁻¹. */
  backoffMs?: (attempt: number) => number;
}

function isRateLimited(res: Response): boolean {
  // GitHub signals a rate-limit 403 with `x-ratelimit-remaining: 0`.
  // A plain 403 (e.g. SAML/SSO) is treated as not-found-ish and not
  // retried either, but we only emit the rate-limit message when the
  // header actually says we're out of budget.
  return res.headers.get("x-ratelimit-remaining") === "0";
}

/**
 * Fetch a GitHub API URL with status classification + bounded retry.
 *
 *   - Returns the `Response` on a 2xx.
 *   - Throws `GitHubNotFoundError` on 404 (no retry).
 *   - Throws `GitHubRateLimitError` on a rate-limited 403 (no retry).
 *   - Retries 5xx / network errors up to `retries` times with backoff,
 *     then throws `GitHubTransientError`.
 *
 * Callers layer their own context (repo name, asset pattern) on top of
 * the thrown error's message.
 */
export async function githubFetch(
  url: string,
  init: RequestInit,
  opts: GitHubFetchOptions = {},
): Promise<Response> {
  const retries = opts.retries ?? 2;
  const backoffMs = opts.backoffMs ?? ((attempt) => 250 * 2 ** (attempt - 1));

  let lastTransient: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      // Network-level failure (DNS, connection reset, fetch TypeError).
      // Transient — retry within budget.
      lastTransient = new GitHubTransientError(
        `GitHub request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (attempt < retries) {
        await sleep(backoffMs(attempt + 1));
        continue;
      }
      throw lastTransient;
    }

    if (res.ok) return res;

    if (res.status === 404) {
      throw new GitHubNotFoundError(`GitHub 404 (not found) for ${url}`);
    }

    if (res.status === 403 && isRateLimited(res)) {
      const resetHeader = res.headers.get("x-ratelimit-reset");
      const resetAt = resetHeader ? Number(resetHeader) : undefined;
      const when =
        resetAt && Number.isFinite(resetAt)
          ? ` Resets at ${new Date(resetAt * 1000).toISOString()}.`
          : "";
      throw new GitHubRateLimitError(
        `GitHub API rate limit exceeded for ${url}.${when} ` +
          `Set GITHUB_TOKEN (or run \`gh auth login\`) to raise the limit, or wait and retry.`,
        Number.isFinite(resetAt) ? resetAt : undefined,
      );
    }

    if (res.status >= 500) {
      lastTransient = new GitHubTransientError(
        `GitHub ${res.status} (transient) for ${url}`,
        res.status,
      );
      if (attempt < retries) {
        await sleep(backoffMs(attempt + 1));
        continue;
      }
      throw lastTransient;
    }

    // Other 4xx (401, plain 403, 422, …): not retryable, not a known
    // category — surface verbatim so the caller/user sees the status.
    throw new Error(`GitHub request to ${url} failed: HTTP ${res.status}`);
  }

  // Unreachable in practice (loop either returns or throws), but keeps
  // the type checker happy and gives a sane fallback.
  throw lastTransient ?? new GitHubTransientError(`GitHub request to ${url} failed`);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve a GitHub auth token. Prefers `GITHUB_TOKEN` from the
 * environment, then falls back to `gh auth token`. Returns
 * `undefined` if neither is available.
 *
 * Used by HTTP callers to raise GitHub's 60/hr unauthenticated rate
 * limit; no private repos are accessed by this plugin.
 */
export async function githubToken(): Promise<string | undefined> {
  const envToken = process.env.GITHUB_TOKEN;
  if (envToken) return envToken;

  try {
    const proc = spawn(["gh", "auth", "token"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0 && text.trim()) return text.trim();
  } catch {
    // gh CLI not available
  }
  return undefined;
}

/**
 * GitHub-aware HTTP downloader. Streams the response body through
 * a chunk buffer and writes once at the end (Bun's writable stream
 * write-during-fetch path was flaky as of 2026-Q2). Reports download
 * progress via the callback so the UI can render a percentage.
 *
 * Sends a `gh auth token` Bearer header when available so we get the
 * 5000/hr authenticated GitHub rate limit instead of the 60/hr
 * anonymous one.
 *
 * **Post-redirect host validation**: `allowedHosts` is an optional
 * whitelist of hostnames the final (post-redirect) URL must match.
 * When set, the fetch follows redirects normally, then refuses to
 * write the response if `res.url`'s host isn't in the list. Use
 * this for `direct-url` mod downloads from arbitrary CDNs to refuse
 * a cross-host redirect to an attacker-controlled file. Omit for
 * GitHub-release downloads where the redirect chain is implicit
 * (`api.github.com → objects.githubusercontent.com`).
 */
export async function downloadFile(
  url: string,
  dest: string,
  onProgress?: (downloaded: number, total: number) => void,
  allowedHosts?: string[],
): Promise<void> {
  const headers: Record<string, string> = {
    "User-Agent": "SteamLoader-RecompPlugin/0.1.0",
  };

  const token = await githubToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  // Abort the transfer if no bytes arrive for IDLE_MS — the content-
  // length truncation check below only fires when the connection
  // *closes* short, not when it hangs mid-stream, so without this a
  // stalled CDN connection would block `reader.read()` forever.
  const IDLE_MS = 120_000;
  // Hard ceiling so a hostile/mis-declared asset can't fill the disk.
  // Recomp release assets are at most ~1 GB; source tarballs far less.
  const MAX_BYTES = 16 * 1024 ** 3;
  const controller = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const bumpIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), IDLE_MS);
  };

  bumpIdle();
  let res: Response;
  try {
    res = await fetch(url, { headers, redirect: "follow", signal: controller.signal });
  } catch (err) {
    if (idleTimer) clearTimeout(idleTimer);
    throw new Error(
      `Download failed: ${controller.signal.aborted ? `no response within ${IDLE_MS / 1000}s` : err}`,
    );
  }
  if (!res.ok) {
    if (idleTimer) clearTimeout(idleTimer);
    throw new Error(`Download failed: HTTP ${res.status}`);
  }
  if (allowedHosts && allowedHosts.length > 0) {
    let finalHost: string;
    try {
      finalHost = new URL(res.url).host;
    } catch {
      if (idleTimer) clearTimeout(idleTimer);
      throw new Error(`Download refused: couldn't parse final URL "${res.url}".`);
    }
    if (!allowedHosts.includes(finalHost)) {
      if (idleTimer) clearTimeout(idleTimer);
      throw new Error(
        `Download refused: response redirected to host "${finalHost}", not in allowed list [${allowedHosts.join(", ")}]. Pin the mod's declared host (or the GitHub object CDN) on the manifest.`,
      );
    }
  }

  const totalSize = Number(res.headers.get("content-length") ?? 0);
  if (totalSize > MAX_BYTES) {
    if (idleTimer) clearTimeout(idleTimer);
    throw new Error(
      `Download refused: declared size ${totalSize} exceeds the ${MAX_BYTES}-byte cap.`,
    );
  }

  const body = res.body;
  if (!body) {
    if (idleTimer) clearTimeout(idleTimer);
    throw new Error("No response body");
  }

  // Stream to a `.part` file (not a 2×-resident in-memory buffer — the
  // old approach OOMed on multi-GB assets) and rename on success, so a
  // truncated/aborted transfer never leaves a usable file at `dest`.
  const tmp = `${dest}.part`;
  const sink = Bun.file(tmp).writer();
  let downloaded = 0;
  let sinceFlush = 0;
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bumpIdle();
      downloaded += value.byteLength;
      if (downloaded > MAX_BYTES) {
        throw new Error(`Download refused: exceeded the ${MAX_BYTES}-byte cap mid-stream.`);
      }
      sink.write(value);
      sinceFlush += value.byteLength;
      if (sinceFlush >= 8 * 1024 * 1024) {
        await sink.flush(); // bound in-flight memory (~8 MB)
        sinceFlush = 0;
      }
      onProgress?.(downloaded, totalSize);
    }
    await sink.end();
  } catch (err) {
    try { await sink.end(); } catch { /* ignore */ }
    try { await rm(tmp, { force: true }); } catch { /* ignore */ }
    throw new Error(
      controller.signal.aborted
        ? `Download stalled: no data for ${IDLE_MS / 1000}s.`
        : `Download failed: ${err instanceof Error ? err.message : err}`,
    );
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }

  // Truncation guard: a body that ended short of the declared
  // Content-Length means the connection dropped mid-transfer.
  if (totalSize > 0 && downloaded !== totalSize) {
    try { await rm(tmp, { force: true }); } catch { /* ignore */ }
    throw new Error(
      `Download incomplete: expected ${totalSize} bytes but received ${downloaded} (size mismatch — the transfer was likely truncated).`,
    );
  }

  await rename(tmp, dest);
}

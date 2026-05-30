import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "@loadout/exec";

/**
 * Resolve a GitHub auth token. Prefers `GITHUB_TOKEN` from the
 * environment, falls back to `gh auth token` if the CLI is installed.
 * Used purely to raise GitHub's 60/hr anonymous API limit to the
 * 5000/hr authenticated one — no private repos are touched.
 *
 * Cloned from `plugins/recomp/lib/github.ts:githubToken`; the
 * function is small enough that a copy is cheaper than a shared
 * package right now. If/when a third plugin needs this, pull it
 * into `@loadout/github-release`.
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
 * Allow-list of hostnames the GitHub-release download walker will
 * follow. Real release-asset URLs redirect from `github.com` →
 * `objects.githubusercontent.com` (and sometimes `*.githubusercontent.com`
 * /`codeload.github.com` for source archives). We re-check the host
 * on EVERY hop of the redirect chain, not just the final URL, so a
 * malicious release that 302s through an attacker host can't have
 * its body fetched before the final-host check fires.
 */
const TRUSTED_GITHUB_HOSTS = [
  "github.com",
  "objects.githubusercontent.com",
  "codeload.github.com",
];

function isTrustedGithubHost(host: string): boolean {
  const lower = host.toLowerCase();
  return TRUSTED_GITHUB_HOSTS.some(
    (t) => lower === t || lower.endsWith(`.${t}`),
  );
}

/**
 * Download `url` to `dest`. Auto-creates the parent directory.
 * Streams the body through a chunk buffer for progress reporting,
 * then writes once at the end — Bun's write-during-fetch path has
 * historically been flaky on large files.
 *
 * The redirect chain is walked MANUALLY (`redirect: "manual"`) so
 * we can re-pin the host on every hop. Letting WHATWG follow
 * automatically would still TLS-handshake an attacker host before
 * we got to check the final URL, and a malicious release whose
 * intermediate hops leak the GitHub `Authorization` header on the
 * leg before WHATWG strips it cross-origin would be a hole. The
 * review flagged this as a LOW security hardening item.
 */
export async function downloadFile(
  url: string,
  dest: string,
  onProgress?: (downloaded: number, total: number) => void,
): Promise<void> {
  const headers: Record<string, string> = {
    "User-Agent": "Loadout-StoreBridge/0.1.0",
  };
  const token = await githubToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  // Manual redirect walk. Cap at 10 hops — well above what a healthy
  // GitHub release uses (typically 1-2) and well below a redirect
  // loop's tail. After each hop, validate the next host against the
  // allow-list before initiating the next request — failing closed
  // on any non-trusted hostname.
  const MAX_HOPS = 10;
  let currentUrl = url;
  let res: Response | null = null;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const host = (() => {
      try {
        return new URL(currentUrl).hostname;
      } catch {
        return "";
      }
    })();
    if (!host || !isTrustedGithubHost(host)) {
      throw new Error(
        `Download refused: hop ${hop} pointed at untrusted host ${host || currentUrl} (started at ${url}).`,
      );
    }
    res = await fetch(currentUrl, { headers, redirect: "manual" });
    // 3xx with a Location header → follow manually. Anything else
    // is the terminal response; break and process below.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        throw new Error(
          `Download failed: HTTP ${res.status} from ${currentUrl} without a Location header.`,
        );
      }
      // Resolve relative redirects against the current URL.
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    break;
  }
  if (!res) {
    throw new Error(`Download failed: no response after ${MAX_HOPS} redirect hops from ${url}.`);
  }
  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  }
  const total = Number(res.headers.get("content-length") ?? 0);
  let downloaded = 0;
  const body = res.body;
  if (!body) throw new Error("No response body");

  const chunks: Uint8Array[] = [];
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    downloaded += value.byteLength;
    onProgress?.(downloaded, total);
  }
  const merged = new Uint8Array(downloaded);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, merged);
}

/** GitHub release `assets` shape — only the fields we need. */
export interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface GitHubRelease {
  tag_name: string;
  name?: string;
  assets: GitHubReleaseAsset[];
}

/**
 * Fetch `/repos/<owner>/<repo>/releases/latest`. Throws on non-200.
 * Bearer-authed when a token is available.
 */
export async function fetchLatestRelease(repo: string): Promise<GitHubRelease> {
  const headers: Record<string, string> = {
    "User-Agent": "Loadout-StoreBridge/0.1.0",
    Accept: "application/vnd.github+json",
  };
  const token = await githubToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers,
  });
  if (!res.ok) {
    throw new Error(`GitHub release lookup failed: HTTP ${res.status} for ${repo}`);
  }
  return (await res.json()) as GitHubRelease;
}

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
 * Download `url` to `dest`. Auto-creates the parent directory.
 * Streams the body through a chunk buffer for progress reporting,
 * then writes once at the end — Bun's write-during-fetch path has
 * historically been flaky on large files.
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

  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  }
  // We trust GitHub for the binary download (that's the whole basis
  // of the trust model documented in epic/install-legendary.ts) —
  // refuse to follow a redirect off-domain so a compromised release
  // can't point us at an attacker host. WHATWG fetch already strips
  // the Authorization header on cross-origin redirect, but the body
  // would still be fetched and written to disk without this guard.
  if (res.url) {
    try {
      const finalHost = new URL(res.url).hostname.toLowerCase();
      const ok =
        finalHost === "github.com" ||
        finalHost.endsWith(".github.com") ||
        finalHost === "githubusercontent.com" ||
        finalHost.endsWith(".githubusercontent.com");
      if (!ok) {
        throw new Error(
          `Download refused: redirect landed on untrusted host ${finalHost} (started at ${url}).`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Download refused")) {
        throw err;
      }
      // URL parse failure — treat as untrusted to fail closed.
      throw new Error(`Download refused: could not parse final URL ${res.url}.`);
    }
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

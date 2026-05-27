import { writeFile } from "node:fs/promises";
import { spawn } from "@loadout/exec";

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

  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status}`);
  }
  if (allowedHosts && allowedHosts.length > 0) {
    let finalHost: string;
    try {
      finalHost = new URL(res.url).host;
    } catch {
      throw new Error(`Download refused: couldn't parse final URL "${res.url}".`);
    }
    if (!allowedHosts.includes(finalHost)) {
      throw new Error(
        `Download refused: response redirected to host "${finalHost}", not in allowed list [${allowedHosts.join(", ")}]. Pin the mod's declared host (or the GitHub object CDN) on the manifest.`,
      );
    }
  }

  const totalSize = Number(res.headers.get("content-length") ?? 0);
  let downloaded = 0;

  const body = res.body;
  if (!body) throw new Error("No response body");

  const chunks: Uint8Array[] = [];
  const reader = body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    downloaded += value.byteLength;
    onProgress?.(downloaded, totalSize);
  }

  const totalLength = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  await writeFile(dest, result);
}

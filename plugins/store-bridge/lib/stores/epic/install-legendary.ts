import { join } from "node:path";
import { chmod, access, mkdir, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { runFull, commandExists } from "@loadout/exec";
import { binDir } from "../../platform";
import { downloadFile, fetchLatestRelease, type GitHubRelease } from "../../download";
import type { PipelineEmit } from "../../types";

const LEGENDARY_REPO = "derrod/legendary";
const SELF_INSTALL_ID = "epic:install-legendary";

/**
 * Trust model for the bundled legendary binary.
 *
 * derrod/legendary does NOT publish per-release SHA / minisign / PGP
 * signatures, so we cannot independently verify the binary. The trust
 * chain is the same one `gh`, `brew`, and every other npm/binary
 * auto-installer relies on:
 *
 *   1. TLS to api.github.com (CA-pinned by the OS root store).
 *   2. TLS to objects.githubusercontent.com (the asset CDN).
 *   3. GitHub's account security around the repo owner.
 *
 * That's "good enough" for an opt-in self-install path (the user
 * clicks Install Legendary), and matches the bar the legendary
 * project itself publishes installs at. We compute the SHA-256 of
 * what landed on disk and log it unconditionally so any tampering
 * can be retroactively investigated against the journal.
 *
 * Users who want a stricter posture set `settings.pinnedLegendaryVersion`
 * (e.g. "v0.20.34") — we then refuse to pick anything else, and the
 * user is free to vet that specific release once.
 */

/** Where the plugin keeps its self-installed legendary binary. */
export function bundledLegendaryPath(): string {
  return join(binDir(), "legendary");
}

/**
 * Locate a usable `legendary` binary. Order of precedence:
 *   1. `settingsOverride` (user-set path in Settings).
 *   2. The plugin's bundled binary at `~/.local/share/loadout/store-bridge/bin/legendary`.
 *   3. `legendary` on $PATH (for users who already manage it themselves).
 *
 * Returns the resolved path, or `null` if none of the above exist.
 */
export async function resolveLegendaryBinary(
  settingsOverride?: string,
): Promise<string | null> {
  if (settingsOverride && (await fileExists(settingsOverride))) {
    return settingsOverride;
  }
  const bundled = bundledLegendaryPath();
  if (await fileExists(bundled)) return bundled;
  if (await commandExists("legendary")) return "legendary";
  return null;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Download the latest upstream `legendary` PyInstaller binary and
 * write it to `bundledLegendaryPath()`. After the write, runs the
 * binary with `--version` to sanity-check that it's usable.
 *
 * Emits `PipelineEvent` updates so the UI can render a progress
 * bar. The single-event id `epic:install-legendary` is stable, so
 * the UI keeps the same progress widget across the download +
 * sanity-check phases.
 */
export async function installLegendary(
  emit: PipelineEmit,
  opts: { pinnedVersion?: string } = {},
): Promise<string> {
  emit({ kind: "progress", id: SELF_INSTALL_ID, percent: 0, label: "Looking up release" });

  const release = await resolveRelease(opts.pinnedVersion);
  // Linux upstream asset is just `legendary` (single PyInstaller exe,
  // no extension, no archive). We accept any case + dot-prefixes so
  // the upstream could rename to `legendary.bin` etc. and we wouldn't
  // silently break.
  const asset = release.assets.find(
    (a) => a.name === "legendary" || a.name === "legendary.bin",
  );
  if (!asset) {
    throw new Error(
      `Could not find a 'legendary' asset on release ${release.tag_name}. ` +
        `Upstream may have renamed the binary — set Settings → Legendary binary manually.`,
    );
  }

  await mkdir(binDir(), { recursive: true });
  const dest = bundledLegendaryPath();

  emit({
    kind: "progress",
    id: SELF_INSTALL_ID,
    percent: 5,
    label: `Downloading ${asset.name} (${formatMiB(asset.size)})`,
  });

  await downloadFile(asset.browser_download_url, dest, (downloaded, total) => {
    if (!total) return;
    // Map raw download progress into the 5–95% slot so we leave
    // room for the sanity-check pass at the end.
    const pct = 5 + Math.round((downloaded / total) * 90);
    emit({
      kind: "progress",
      id: SELF_INSTALL_ID,
      percent: pct,
      bytes: downloaded,
      label: `Downloading legendary ${release.tag_name}`,
    });
  });

  await chmod(dest, 0o755);

  emit({
    kind: "progress",
    id: SELF_INSTALL_ID,
    percent: 96,
    label: "Verifying legendary",
  });

  // Compute the SHA-256 of what landed on disk and log it. See the
  // trust-model comment at the top of this file — this isn't
  // "verification" against an authoritative source (none exists),
  // it's a forensics breadcrumb. If something pulls this from the
  // journal and cross-checks against a community-collected hash
  // later, that's the realistic detection path.
  const blob = await readFile(dest);
  const sha256 = createHash("sha256").update(blob).digest("hex");
  console.log(
    `[store-bridge] installed legendary ${release.tag_name} from ${asset.browser_download_url} sha256:${sha256}`,
  );

  const sanity = await runFull([dest, "--version"], { timeoutMs: 15_000 });
  if (sanity.exitCode !== 0) {
    throw new Error(
      `legendary --version failed (exit ${sanity.exitCode}): ${sanity.stderr.trim() || sanity.stdout.trim() || "no output"}`,
    );
  }

  emit({
    kind: "complete",
    id: SELF_INSTALL_ID,
    payload: { path: dest, version: parseVersion(sanity.stdout), sha256 },
  });
  return dest;
}

/**
 * Resolve which release to install. Without a pinned version we hit
 * `/releases/latest` and always pull the newest. With a pinned
 * version (e.g. "v0.20.34" from Settings) we fetch that specific
 * tag — letting security-conscious users vet a release once and
 * stop auto-updating. We deliberately don't fall back from a
 * missing pinned tag to "latest"; the whole point of pinning is
 * "this version or none".
 */
async function resolveRelease(pinned?: string): Promise<GitHubRelease> {
  if (!pinned || pinned.trim() === "") {
    return fetchLatestRelease(LEGENDARY_REPO);
  }
  const tag = pinned.trim();
  // "latest" is the sentinel GitHub already exposes via /releases/latest —
  // treating it as a tag would 404. Honour it as "unset".
  if (tag.toLowerCase() === "latest") {
    return fetchLatestRelease(LEGENDARY_REPO);
  }
  // Tag values flow straight into the GitHub API path — validate
  // before letting them shape the URL. Real legendary tags look like
  // "0.20.34" or "v0.20.34"; nothing exotic. First char must be
  // alnum so a literal `..` or `.foo` doesn't sail through as a
  // pseudo-traversal candidate (encodeURIComponent doesn't escape
  // dots; GitHub would 404 it but it's still sloppy).
  if (!/^v?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag)) {
    throw new Error(
      `Pinned legendary version "${tag}" is malformed. Expected something like "v0.20.34".`,
    );
  }
  const url = `https://api.github.com/repos/${LEGENDARY_REPO}/releases/tags/${encodeURIComponent(tag)}`;
  const headers: Record<string, string> = {
    "User-Agent": "SteamLoader-StoreBridge/0.1.0",
    Accept: "application/vnd.github+json",
  };
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(
      `Pinned legendary version "${tag}" not found on GitHub (HTTP ${res.status}). ` +
        `Clear Settings → Pinned legendary version to fall back to latest.`,
    );
  }
  return (await res.json()) as GitHubRelease;
}

/** "legendary version 0.20.34, codename Snowflake" → "0.20.34". */
export function parseVersion(stdout: string): string {
  const m = stdout.match(/version\s+(\S+)/i);
  return m ? m[1].replace(/[,.]$/, "") : stdout.split(/\s+/)[1] ?? "unknown";
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Lightweight "is the binary present and runnable?" probe. */
export async function probeLegendary(
  binary: string,
): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  try {
    const { exitCode, stdout, stderr } = await runFull([binary, "--version"], {
      timeoutMs: 10_000,
    });
    if (exitCode !== 0) return { ok: false, error: stderr.trim() || stdout.trim() };
    return { ok: true, version: parseVersion(stdout) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

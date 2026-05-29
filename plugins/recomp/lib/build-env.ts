import { readFile } from "node:fs/promises";
import { commandExists, runFull, runStreaming } from "@loadout/exec";
import { shellQuote } from "./shell";

/**
 * The build environment a `build_from_source` install runs in.
 *
 * Always a distrobox container. Bazzite/SteamOS/Aurora/Bluefin
 * (immutable) need it because the host is read-only; CachyOS /
 * Arch / Fedora / Ubuntu (mutable) get it too because:
 *   • per-game setup scripts then only need to know one set of
 *     package names (Fedora's), instead of N×distros.
 *   • the host stays clean — `make install` from the source-port
 *     never lands files outside the container.
 *   • build artefacts are reproducible across hosts.
 *
 * Build outputs are still Linux ELFs that run natively on the host
 * (distrobox shares /home with the host so the binary path is the
 * same inside and outside the container).
 */

export type BuildEnvKind = "distrobox";

export interface BuildEnv {
  kind: BuildEnvKind;
  /** Display string for the UI (e.g. "distrobox: recomp-build"). */
  label: string;
  /** Run a shell command in this env. Output is line-streamed via
   *  `onLine` exactly like the underlying `runStreaming` helper. */
  run(
    command: string,
    cwd: string,
    opts: { onLine: (line: string) => void; timeoutMs?: number },
  ): Promise<{ exitCode: number }>;
  /** Probe for an executable on PATH inside this env. */
  has(cmd: string): Promise<boolean>;
  /** Install one or more Fedora packages inside the container.
   *  Idempotent (dnf returns 0 if already installed). */
  installPackages(
    pkgs: string[],
    onLine: (line: string) => void,
  ): Promise<{ exitCode: number }>;
}

/** Container name we manage per host. Persistent across runs. */
export const RECOMP_CONTAINER = "recomp-build";

/** Image we provision the container from. */
const RECOMP_IMAGE = "registry.fedoraproject.org/fedora:latest";

/**
 * Thrown when distrobox / podman aren't available on the host.
 * Carries a per-distro install command so the UI can render a
 * single actionable next step instead of "figure it out".
 */
export class MissingDistroboxError extends Error {
  constructor(
    public readonly missing: string[],
    public readonly installHint: string,
    public readonly distroId: string,
  ) {
    super(
      `${missing.join(" + ")} not installed. Recomp builds run inside a ` +
        `distrobox container so they don't pollute the host. ` +
        `Install via: ${installHint}`,
    );
    this.name = "MissingDistroboxError";
  }
}

/**
 * Probe distrobox + podman, return the build env. Throws
 * `MissingDistroboxError` with a concrete install command if the
 * tooling is missing.
 */
export async function detectBuildEnv(): Promise<BuildEnv> {
  await assertDistroboxAvailable();
  return distroboxEnv(RECOMP_CONTAINER);
}

/**
 * Lightweight probe — true if a build can proceed without further
 * setup steps. Safe to call from UI render paths (no spawning the
 * container, just `command -v` checks).
 */
export async function isBuildEnvReady(): Promise<{
  ok: boolean;
  missing: string[];
  installHint?: string;
  distroId?: string;
}> {
  const missing: string[] = [];
  if (!(await commandExists("distrobox"))) missing.push("distrobox");
  if (!(await commandExists("podman"))) missing.push("podman");
  if (missing.length === 0) {
    return { ok: true, missing: [] };
  }
  const distroId = await detectDistroId();
  return {
    ok: false,
    missing,
    distroId,
    installHint: installHintFor(distroId, missing),
  };
}

async function assertDistroboxAvailable(): Promise<void> {
  const probe = await isBuildEnvReady();
  if (probe.ok) return;
  throw new MissingDistroboxError(
    probe.missing,
    probe.installHint ?? `install ${probe.missing.join(" ")} via your package manager`,
    probe.distroId ?? "unknown",
  );
}

function distroboxEnv(name: string): BuildEnv {
  // distrobox-enter forwards the host's interactive shell rcfiles
  // into the container; Bazzite exports BASH_FUNC_* entries the
  // container's older bash can't parse. Strip them before invoking.
  const enterEnv = stripBashFuncs(process.env);
  return {
    kind: "distrobox",
    label: `distrobox: ${name}`,
    run: (command, cwd, opts) =>
      runStreaming(
        // `bash -lc` so the container's PATH is fully sourced.
        // distrobox-enter has no --cwd flag, so prepend `cd`.
        [
          "distrobox",
          "enter",
          name,
          "--",
          "bash",
          "-lc",
          `cd ${shellQuote(cwd)} && ${command}`,
        ],
        { onLine: opts.onLine, timeoutMs: opts.timeoutMs, env: enterEnv },
      ),
    has: async (cmd) => {
      const r = await runFull(
        ["distrobox", "enter", name, "--", "bash", "-lc", `command -v ${shellQuote(cmd)}`],
        { env: enterEnv, timeoutMs: 10_000 },
      );
      return r.exitCode === 0;
    },
    installPackages: async (pkgs, onLine) => {
      if (pkgs.length === 0) return { exitCode: 0 };
      return runStreaming(
        [
          "distrobox",
          "enter",
          name,
          "--",
          "sudo",
          "dnf",
          "install",
          "-y",
          ...pkgs,
        ],
        { onLine, timeoutMs: 10 * 60 * 1000, env: enterEnv },
      );
    },
  };
}

/**
 * Provision the managed container if missing. Idempotent.
 * Image pull on first creation can take 30-60s; surface the pull
 * output via `onLine` so the UI doesn't look frozen.
 */
export async function ensureRecompContainer(
  onLine: (line: string) => void,
): Promise<void> {
  const list = await runFull(["distrobox", "list", "--no-color"], {
    timeoutMs: 10_000,
  });
  const exists = new RegExp(`\\b${RECOMP_CONTAINER}\\b`).test(list.stdout);
  if (exists) {
    // A container can appear in `distrobox list` while being broken /
    // half-created (e.g. podman storage corruption, an interrupted
    // create, or the underlying image was pruned). The cheapest probe
    // that catches all of these is actually entering it and running
    // `true`. We use a short timeout so a hung create surfaces fast.
    const probe = await runFull(
      ["distrobox", "enter", RECOMP_CONTAINER, "--", "true"],
      { timeoutMs: 10_000 },
    );
    if (probe.exitCode === 0) return;
    // Auto-recreate would surprise the user with a 30-60s image pull
    // and could mask a deeper podman issue. Surface a clear, actionable
    // error instead.
    throw new Error(
      `Recomp build container '${RECOMP_CONTAINER}' exists but isn't usable ` +
        `(distrobox enter exited ${probe.exitCode}). This usually means a ` +
        `previous create was interrupted or podman storage is corrupted. ` +
        `Recover with: distrobox rm -f ${RECOMP_CONTAINER} && retry the install.`,
    );
  }
  onLine(`Creating distrobox container '${RECOMP_CONTAINER}' from ${RECOMP_IMAGE}…`);
  const create = await runStreaming(
    [
      "distrobox",
      "create",
      "--yes",
      "--name",
      RECOMP_CONTAINER,
      "--image",
      RECOMP_IMAGE,
    ],
    { onLine, timeoutMs: 15 * 60 * 1000 },
  );
  if (create.exitCode !== 0) {
    throw new Error(
      `Failed to create distrobox container (exit ${create.exitCode}). ` +
        `If this is the first run on a slow network, the image pull may ` +
        `have timed out — try again.`,
    );
  }
}

// ── Distro detection + install hints ─────────────────────────────────

/**
 * Read /etc/os-release ID field. Falls back to "unknown".
 * Returns the lowercase ID (e.g. "bazzite", "steamos", "cachyos",
 * "arch", "fedora", "ubuntu", "debian").
 */
export async function detectDistroId(): Promise<string> {
  try {
    const text = await readFile("/etc/os-release", "utf8");
    const match = text.match(/^ID=("?)([^"\n]+)\1/m);
    return match?.[2]?.toLowerCase() ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Best-known install command per distro for the given missing
 * packages. Bazzite / SteamOS / Silverblue need extra steps
 * (rpm-ostree reboot or steamos-readonly toggle) that mutable
 * distros don't, so they get distinct hints.
 */
export function installHintFor(distroId: string, pkgs: string[]): string {
  const list = pkgs.join(" ");
  switch (distroId) {
    case "bazzite":
    case "silverblue":
    case "kinoite":
    case "ublue-os":
    case "fedora-iot":
      return `rpm-ostree install ${list} && systemctl reboot`;
    case "steamos":
    case "holo":
      return `sudo steamos-readonly disable && sudo pacman -Sy --noconfirm ${list}`;
    case "cachyos":
    case "arch":
    case "manjaro":
    case "endeavouros":
      return `sudo pacman -Sy --noconfirm ${list}`;
    case "fedora":
    case "nobara":
    case "rhel":
    case "centos":
      return `sudo dnf install -y ${list}`;
    case "ubuntu":
    case "debian":
    case "linuxmint":
    case "pop":
      return `sudo apt update && sudo apt install -y ${list}`;
    case "opensuse":
    case "opensuse-tumbleweed":
    case "opensuse-leap":
      return `sudo zypper install -y ${list}`;
    default:
      return `install ${list} via your distro's package manager`;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function stripBashFuncs(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("BASH_FUNC_")) continue;
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { commandExists, runFull } from "@loadout/exec";

/**
 * Native file-picker for plugins running inside steam-loader's
 * systemd user service. Wraps zenity / kdialog / yad — whichever is
 * installed — and presents a consistent surface to plugin code.
 *
 * Why this exists as a shared package: keeping it in one place means
 *
 *   - One audit surface for DISPLAY / XAUTHORITY semantics across
 *     Gamescope / Plasma / GNOME sessions
 *   - One starting-directory default (`~/Downloads` when present,
 *     `~` otherwise) so plugins don't have to special-case
 *   - Future improvements (in-overlay native picker, GTK4-based
 *     `xdg-desktop-portal` integration) only have to land here
 *
 * Consumed by recomp (more callers expected as the remaining plugins
 * migrate).
 */

export interface PickFileOptions {
  /** Dialog title. Defaults to "Select file". */
  title?: string;
  /** Filter extensions (no leading dot necessary, e.g.
   *  `["z64", "zip"]`). Empty / omitted = no filter. */
  extensions?: string[];
  /** Human label for the filter row, e.g. "ROM files" /
   *  "Mod archives". Defaults to "Files". */
  filterLabel?: string;
  /**
   * Absolute path the picker should open at. Falls back to
   * `$HOME/Downloads` when present, then `$HOME`, then `.` so a
   * blank-startDirectory caller still lands in a sensible place
   * across distros where `$HOME` might not be set in the service
   * environment.
   */
  startDirectory?: string;
}

interface PickFileNormalised {
  title: string;
  filterLabel: string;
  startDir: string;
  startDirSlash: string;
  filterExts: string[];
}

type PickerSpec = {
  cmd: string;
  buildArgs: (opts: PickFileNormalised) => string[];
};

/**
 * Picker registry — preference order:
 *   1. zenity (GTK) — installed by default on Bazzite / SteamOS
 *   2. kdialog (Qt) — preferred when KDE is the desktop session
 *   3. yad (GTK fork of zenity) — last resort
 *
 * One table, one loop, one log site — adding a fourth picker is
 * a single entry instead of a fourth copy-pasted branch.
 */
const PICKERS: PickerSpec[] = [
  {
    cmd: "zenity",
    buildArgs: ({ title, filterLabel, startDirSlash, filterExts }) => {
      const args = [
        "--file-selection",
        `--title=${title}`,
        // Trailing slash so zenity treats the path as a directory
        // and lists its contents rather than treating it as a file.
        `--filename=${startDirSlash}`,
      ];
      if (filterExts.length > 0) {
        args.push(
          `--file-filter=${filterLabel} | ${filterExts.map((e) => `*.${e}`).join(" ")}`,
          "--file-filter=All files | *",
        );
      }
      return args;
    },
  },
  {
    cmd: "kdialog",
    buildArgs: ({ filterLabel, startDir, filterExts }) => {
      const filter =
        filterExts.length > 0
          ? `${filterExts.map((e) => `*.${e}`).join(" ")} | ${filterLabel}\n* | All files`
          : "*";
      return ["--getopenfilename", startDir, filter];
    },
  },
  {
    cmd: "yad",
    buildArgs: ({ title, filterLabel, startDirSlash, filterExts }) => {
      const args = [
        "--file",
        `--title=${title}`,
        `--filename=${startDirSlash}`,
      ];
      if (filterExts.length > 0) {
        args.push(
          `--file-filter=${filterLabel} | ${filterExts.map((e) => `*.${e}`).join(" ")}`,
        );
      }
      return args;
    },
  },
];

/**
 * Pop a native file-selection dialog and return the absolute path
 * the user picks, or `null` on cancel / no picker installed.
 *
 * Under Gamescope (Bazzite / SteamOS Gaming Mode) the dialog opens as
 * a separate top-level X11 window. Gamescope shows it in its window
 * list — the user reaches it with Steam button + dpad. Not as smooth
 * as a true in-overlay picker, but no custom file-browser UI to
 * maintain. Switching to a portal-based picker is a follow-up.
 *
 * The loader runs as a systemd user service with no DISPLAY env;
 * `resolveX11Env()` probes `$XDG_RUNTIME_DIR/xauth_*` (the
 * gamescope-session-plus pattern on stock SteamOS) before falling
 * back to `~/.Xauthority` (KDE/GNOME desktop sessions).
 */
export async function pickFile(opts: PickFileOptions = {}): Promise<string | null> {
  const startDir = resolveStartDirectory(opts.startDirectory);
  const startDirSlash = startDir.replace(/\/?$/, "/");
  const normalised: PickFileNormalised = {
    title: opts.title ?? "Select file",
    filterLabel: opts.filterLabel ?? "Files",
    startDir,
    startDirSlash,
    filterExts: (opts.extensions ?? [])
      .map((e) => e.replace(/^\./, "").toLowerCase())
      .filter((e) => e.length > 0),
  };

  // Diagnostic log so a "nothing happened" report can be unambiguously
  // attributed (no picker installed vs. user cancelled vs. dialog
  // opened in a window the user didn't switch to).
  console.log(
    `[file-picker] pickFile title=${JSON.stringify(normalised.title)} startDir=${JSON.stringify(startDir)} extensions=${JSON.stringify(normalised.filterExts)}`,
  );

  const env = { ...process.env, ...(await resolveX11Env()) };

  for (const picker of PICKERS) {
    if (!(await commandExists(picker.cmd))) continue;
    const args = picker.buildArgs(normalised);
    const r = await runFull([picker.cmd, ...args], { env, timeoutMs: 5 * 60 * 1000 });
    console.log(
      `[file-picker] ${picker.cmd} exit=${r.exitCode} stdout=${JSON.stringify(r.stdout)}`,
    );
    if (r.exitCode !== 0) return null;
    const trimmed = r.stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  console.warn(
    "[file-picker] No native file picker found (tried zenity / kdialog / yad). Install one to enable Browse buttons.",
  );
  return null;
}

/**
 * Best-effort starting directory. Caller's explicit value wins;
 * otherwise prefer `~/Downloads` (where users land 95% of the time
 * for mod / theme imports), then `~`, then `.`. We `existsSync` each
 * candidate so a missing `~/Downloads` (rare but possible on a fresh
 * install) doesn't silently land the picker at the filesystem root.
 *
 * Exported for test access — the rest of the picker spawns external
 * processes (zenity / kdialog / yad) and is hard to unit-test, but
 * this helper is pure and worth pinning directly so a regression in
 * the fallback chain is caught locally.
 */
export function resolveStartDirectory(explicit?: string): string {
  if (explicit && existsSync(explicit)) return explicit;
  const home = process.env.HOME ?? "";
  if (home) {
    const downloads = join(home, "Downloads");
    if (existsSync(downloads)) return downloads;
    return home;
  }
  return ".";
}

/**
 * Resolve `DISPLAY` + `XAUTHORITY` for the picker subprocess.
 *
 * The systemd user service has no X11 env by default. Stock SteamOS
 * Gaming Mode runs Steam under gamescope-session-plus, which puts the
 * X auth cookie at `$XDG_RUNTIME_DIR/xauth_<random>` — NOT at
 * `~/.Xauthority` — and on a non-`:0` display. Hardcoding `:0` /
 * `~/.Xauthority` silently fails on stock Deck.
 *
 * Probe order:
 *   - `$DISPLAY` from env if set, else leave unset (picker will fail
 *     with a clear "can't open display" error rather than guessing).
 *   - `$XAUTHORITY` from env if set, else `$XDG_RUNTIME_DIR/xauth_*`
 *     (gamescope-session-plus), else `~/.Xauthority` if it exists.
 *
 * Exported for test access.
 */
export async function resolveX11Env(): Promise<{ DISPLAY?: string; XAUTHORITY?: string }> {
  const env: { DISPLAY?: string; XAUTHORITY?: string } = {};
  if (process.env.DISPLAY) env.DISPLAY = process.env.DISPLAY;

  if (process.env.XAUTHORITY) {
    env.XAUTHORITY = process.env.XAUTHORITY;
    return env;
  }

  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (runtimeDir) {
    try {
      const entries = await readdir(runtimeDir);
      const xauth = entries.find((e) => e.startsWith("xauth_"));
      if (xauth) {
        env.XAUTHORITY = `${runtimeDir}/${xauth}`;
        return env;
      }
    } catch {
      // runtime dir not readable — fall through to ~/.Xauthority
    }
  }

  if (process.env.HOME) {
    const homeAuth = `${process.env.HOME}/.Xauthority`;
    if (existsSync(homeAuth)) env.XAUTHORITY = homeAuth;
  }

  return env;
}

import { existsSync } from "node:fs";
import { join } from "node:path";
import { commandExists, runFull } from "@loadout/exec";

/**
 * Native file-picker for plugins running inside loadout's
 * systemd user service. Wraps zenity / kdialog / yad — whichever is
 * installed — and presents a consistent surface to plugin code.
 *
 * Why this exists as a shared package: every plugin that needs the
 * user to point at a file on disk (recomp ROM/mod picker,
 * store-bridge custom artwork, sound-loader / theme-loader local
 * import) wires the same loop. Keeping it in one place means:
 *
 *   - One audit surface for DISPLAY / XAUTHORITY semantics across
 *     Gamescope / Plasma / GNOME sessions
 *   - One starting-directory default (`~/Downloads` when present,
 *     `~` otherwise) so plugins don't have to special-case
 *   - Future improvements (in-overlay native picker, GTK4-based
 *     `xdg-desktop-portal` integration) only have to land here
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

/**
 * Pop a native file-selection dialog and return the absolute path
 * the user picks, or `null` on cancel / no picker installed.
 *
 * Picker preference order:
 *   1. zenity (GTK) — installed by default on Bazzite / SteamOS
 *   2. kdialog (Qt) — preferred when KDE is the desktop session
 *   3. yad (GTK fork of zenity) — last resort
 *
 * Under Gamescope (Bazzite Gaming Mode) the dialog opens as a
 * separate top-level X11 window. Gamescope shows it in its window
 * list — the user reaches it with Steam button + dpad. Not as smooth
 * as a true in-overlay picker, but no custom file-browser UI to
 * maintain. Switching to a portal-based picker is a follow-up.
 *
 * The loader runs as a systemd user service with no DISPLAY env;
 * we hard-set DISPLAY=:0 (the inner Gamescope X server in
 * gamescope-session-plus). Falls back to the user's existing env
 * if `process.env.DISPLAY` is set (desktop testing).
 */
export async function pickFile(opts: PickFileOptions = {}): Promise<string | null> {
  const title = opts.title ?? "Select file";
  const filterLabel = opts.filterLabel ?? "Files";
  const startDir = resolveStartDirectory(opts.startDirectory);
  const display = process.env.DISPLAY ?? ":0";
  const env = {
    DISPLAY: display,
    XAUTHORITY: process.env.XAUTHORITY ?? `${process.env.HOME}/.Xauthority`,
  };
  const filterExts = (opts.extensions ?? [])
    .map((e) => e.replace(/^\./, "").toLowerCase())
    .filter((e) => e.length > 0);

  // Diagnostic log so a "nothing happened" report can be unambiguously
  // attributed (no picker installed vs. user cancelled vs. dialog
  // opened in a window the user didn't switch to).
  console.log(
    `[file-picker] pickFile title=${JSON.stringify(title)} startDir=${JSON.stringify(startDir)} extensions=${JSON.stringify(filterExts)}`,
  );

  if (await commandExists("zenity")) {
    const args = [
      "--file-selection",
      `--title=${title}`,
      // Trailing slash so zenity treats `startDir` as a directory
      // and lists its contents rather than treating it as a file.
      `--filename=${startDir.replace(/\/?$/, "/")}`,
    ];
    if (filterExts.length > 0) {
      args.push(
        `--file-filter=${filterLabel} | ${filterExts.map((e) => `*.${e}`).join(" ")}`,
        "--file-filter=All files | *",
      );
    }
    const r = await runFull(["zenity", ...args], { env, timeoutMs: 5 * 60 * 1000 });
    console.log(
      `[file-picker] zenity exit=${r.exitCode} stdout=${JSON.stringify(r.stdout.slice(0, 200))}`,
    );
    return parseSelection(r.stdout, r.exitCode);
  }

  if (await commandExists("kdialog")) {
    const filter =
      filterExts.length > 0
        ? `${filterExts.map((e) => `*.${e}`).join(" ")} | ${filterLabel}\n* | All files`
        : "*";
    const r = await runFull(
      ["kdialog", "--getopenfilename", startDir, filter],
      { env, timeoutMs: 5 * 60 * 1000 },
    );
    console.log(
      `[file-picker] kdialog exit=${r.exitCode} stdout=${JSON.stringify(r.stdout.slice(0, 200))}`,
    );
    return parseSelection(r.stdout, r.exitCode);
  }

  if (await commandExists("yad")) {
    const args = [
      "--file",
      `--title=${title}`,
      `--filename=${startDir.replace(/\/?$/, "/")}`,
    ];
    if (filterExts.length > 0) {
      args.push(
        `--file-filter=${filterLabel} | ${filterExts.map((e) => `*.${e}`).join(" ")}`,
      );
    }
    const r = await runFull(["yad", ...args], { env, timeoutMs: 5 * 60 * 1000 });
    console.log(
      `[file-picker] yad exit=${r.exitCode} stdout=${JSON.stringify(r.stdout.slice(0, 200))}`,
    );
    return parseSelection(r.stdout, r.exitCode);
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
    if (existsSync(home)) return home;
  }
  return ".";
}

/**
 * `zenity` / `kdialog` / `yad` all print the selected path to stdout
 * and exit non-zero on cancel. Trim and normalise to null when the
 * dialog was dismissed.
 */
function parseSelection(stdout: string, exitCode: number): string | null {
  if (exitCode !== 0) return null;
  const trimmed = stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
}

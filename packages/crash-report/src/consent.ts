/**
 * Consent — tri-state, fail-closed.
 *
 * `undefined` is a real state and carries weight: it means *not asked yet*,
 * which is what makes the upgrade path work. Every existing install already
 * has `welcomeCompleted: true`, so a consent step bolted onto the welcome
 * wizard would only ever be seen by fresh installs. Distinguishing "not
 * asked" from "said no" is what lets the UI prompt upgraders exactly once
 * without ever re-asking someone who declined.
 *
 * Fail-closed is absolute: anything that is not literally `"granted"` —
 * a missing file, a parse error, a permissions problem, an unexpected type
 * — means do not report. There is no path through this module where an
 * error results in sending data.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import type { ConsentState } from "./types";

/** Config key in `~/.config/loadout/config.json`. */
export const CRASH_REPORTING_KEY = "crashReporting";

/**
 * Candidate config paths, in read order.
 *
 * There is a trap here worth spelling out. `user-config.ts` honours
 * `$XDG_CONFIG_HOME`, but the two processes that need to read consent do not
 * see the same environment: `loadout.service` is a *system* unit that sets
 * only `Environment=HOME=<user home>`, while `loadout-overlay.service` is a
 * *user* unit that inherits the whole session environment. So on a machine
 * where the user sets `XDG_CONFIG_HOME`, the root backend writes to
 * `$HOME/.config/loadout` while the overlay would look in
 * `$XDG_CONFIG_HOME/loadout` — and find nothing.
 *
 * Reading both, XDG first, makes every process agree regardless of which
 * environment it was handed. The failure mode this avoids is quiet: consent
 * would read as "not asked" forever and reporting would simply never work.
 */
export function userConfigPathsFrom(
  env: Record<string, string | undefined>,
  home: string,
): string[] {
  const paths: string[] = [];
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) paths.push(join(xdg, "loadout", "config.json"));
  const fallback = join(home, ".config", "loadout", "config.json");
  if (!paths.includes(fallback)) paths.push(fallback);
  return paths;
}

/** The path a writer should use — XDG when set, else `~/.config`. */
export function userConfigPathFrom(
  env: Record<string, string | undefined>,
  home: string,
): string {
  return userConfigPathsFrom(env, home)[0] as string;
}

/** Interpret a raw config value. Anything unexpected reads as "not asked". */
export function parseConsent(raw: unknown): ConsentState {
  if (raw === "granted") return "granted";
  if (raw === "denied") return "denied";
  return undefined;
}

/** The only question callers should ask. */
export function isGranted(state: ConsentState): boolean {
  return state === "granted";
}

/**
 * Read consent straight off disk, synchronously.
 *
 * Synchronous and file-based on purpose. This runs on the crash path, where
 * the process may be moments from death, and in the overlay's Bun process,
 * which has no other reader for `config.json` and *cannot* be told over RPC —
 * the webview may be the very thing that just died.
 */
export function readConsentSync(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): ConsentState {
  for (const path of userConfigPathsFrom(env, home)) {
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const state = parseConsent(parsed[CRASH_REPORTING_KEY]);
      // A file that exists but has no answer is not authoritative — the
      // other candidate path may hold the real one.
      if (state !== undefined) return state;
    } catch {
      // Missing, unreadable, or malformed — try the next candidate.
    }
  }
  // Nothing anywhere said "granted", so: do not report.
  return undefined;
}

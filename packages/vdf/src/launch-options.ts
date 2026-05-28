/**
 * Launch-options string surgery.
 *
 * Steam's "launch options" field (per game) is a single string that the
 * client substitutes into the actual exec string at launch time. Conventions:
 *
 *   - `%command%` is the placeholder for the game's own command + args.
 *     Tokens before `%command%` are wrappers (`mangohud`, `gamemoderun`,
 *     `~/lsfg`); tokens after `%command%` are extra args appended to the
 *     game.
 *   - If `%command%` is omitted, Steam appends the game args after whatever
 *     the user wrote — so `PROTON_LOG=1` and `PROTON_LOG=1 %command%` are
 *     equivalent. We canonicalise on the explicit form.
 *
 * This module exposes three pure helpers for adding / removing / detecting a
 * single token, used by plugins that want to inject a wrapper without
 * stomping on whatever the user (or another plugin) already configured.
 *
 * Used by:
 *   - `plugins/launch-options` — exposes these as RPCs
 *   - `plugins/lsfg-vk` — adds `~/lsfg` for frame-gen
 *   - any future wrapper-style plugin
 */

const COMMAND_MARKER = "%command%";

export interface LaunchTokenOpts {
  /**
   * Idempotency key. If a token whose canonical form starts with `key`
   * (treating `key=` as an env-var prefix match) is already present, the
   * append is a no-op. Defaults to `token` itself.
   */
  key?: string;
  /**
   * Where to insert relative to `%command%`. Default `"before"` — the
   * common case for shell wrappers.
   */
  position?: "before" | "after";
  /**
   * If the existing string has no `%command%` marker, add one. Default
   * `true` (canonicalises to the explicit form).
   */
  ensureCommand?: boolean;
}

/**
 * Whitespace-separated tokenizer that respects single and double quotes.
 * Quoted segments stay intact (including the quotes) so re-joining with
 * spaces is faithful.
 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch as '"' | "'";
      buf += ch;
      continue;
    }

    if (ch === " " || ch === "\t" || ch === "\n") {
      if (buf.length > 0) {
        tokens.push(buf);
        buf = "";
      }
      continue;
    }

    buf += ch;
  }

  if (buf.length > 0) tokens.push(buf);
  return tokens;
}

/**
 * Strip surrounding quotes (if any) for comparison purposes. We match
 * "wrapper" tokens regardless of how the user quoted them.
 */
function unquote(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return token.slice(1, -1);
    }
  }
  return token;
}

/**
 * Does any token in `tokens` match `key` — either exactly, or as the
 * `KEY=value` env-var form where `key === "KEY"` or `key === "KEY=…"`.
 */
function tokenMatchesKey(tokens: string[], key: string): boolean {
  const keyHead = key.includes("=") ? key.slice(0, key.indexOf("=") + 1) : key;
  for (const raw of tokens) {
    const tok = unquote(raw);
    if (tok === key) return true;
    // env-var match: token starts with "KEY=" and key is "KEY" (no =)
    if (!key.includes("=") && tok.startsWith(`${key}=`)) return true;
    // env-var match: both have = and prefixes line up exactly
    if (key.includes("=") && tok === key) return true;
    // supplied key is a prefix like "FOO=" and token starts with it
    if (key.endsWith("=") && tok.startsWith(keyHead)) return true;
  }
  return false;
}

/**
 * Find the index of the rightmost `%command%` marker in the token list.
 * Returns -1 if none.
 */
function findCommandIndex(tokens: string[]): number {
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i] === COMMAND_MARKER) return i;
  }
  return -1;
}

/**
 * Append `token` to the launch-options string `existing`, respecting
 * `%command%` position and idempotency.
 *
 * Pure. Returns the new string.
 *
 * Examples:
 *   appendLaunchToken("",                    "~/lsfg")              → "~/lsfg %command%"
 *   appendLaunchToken("%command%",           "~/lsfg")              → "~/lsfg %command%"
 *   appendLaunchToken("mangohud %command%",  "~/lsfg")              → "mangohud ~/lsfg %command%"
 *   appendLaunchToken("~/lsfg %command%",    "~/lsfg")              → "~/lsfg %command%"  (idempotent)
 *   appendLaunchToken("PROTON_LOG=1",        "~/lsfg")              → "PROTON_LOG=1 ~/lsfg %command%"
 *   appendLaunchToken("a %command% --foo",   "~/lsfg", { position: "after" })
 *                                                                   → "a %command% ~/lsfg --foo"
 */
export function appendLaunchToken(
  existing: string,
  token: string,
  opts?: LaunchTokenOpts,
): string {
  const key = opts?.key ?? token;
  const position = opts?.position ?? "before";
  const ensureCommand = opts?.ensureCommand ?? true;

  const tokens = tokenize(existing);

  // Idempotency — already present, no-op.
  if (tokenMatchesKey(tokens, key)) {
    return existing;
  }

  const cmdIdx = findCommandIndex(tokens);

  if (cmdIdx === -1) {
    if (!ensureCommand) {
      // Append at the end without a marker.
      tokens.push(token);
      return tokens.join(" ");
    }
    // No %command% present — append `token %command%` to the right.
    tokens.push(token, COMMAND_MARKER);
    return tokens.join(" ");
  }

  const insertAt = position === "before" ? cmdIdx : cmdIdx + 1;
  tokens.splice(insertAt, 0, token);
  return tokens.join(" ");
}

/**
 * Remove the first token matching `key` from `existing`. If the result
 * collapses to nothing more than `%command%`, return an empty string
 * (back to "no launch options"). Pure.
 *
 * Examples:
 *   removeLaunchToken("mangohud ~/lsfg %command%", "~/lsfg")  → "mangohud %command%"
 *   removeLaunchToken("~/lsfg %command%",          "~/lsfg")  → ""
 *   removeLaunchToken("%command%",                 "~/lsfg")  → "%command%"  (no-op)
 *   removeLaunchToken("PROTON_LOG=1 %command%",    "PROTON_LOG") → "%command%"
 */
export function removeLaunchToken(existing: string, key: string): string {
  const tokens = tokenize(existing);

  let removed = false;
  const filtered: string[] = [];
  const keyHead = key.includes("=") ? key.slice(0, key.indexOf("=") + 1) : key;

  for (const raw of tokens) {
    if (removed) {
      filtered.push(raw);
      continue;
    }
    const tok = unquote(raw);
    const isMatch =
      tok === key ||
      (!key.includes("=") && tok.startsWith(`${key}=`)) ||
      (key.endsWith("=") && tok.startsWith(keyHead));
    if (isMatch) {
      removed = true;
      continue;
    }
    filtered.push(raw);
  }

  if (!removed) return existing;

  // Collapse to "" if all that's left is %command%.
  if (filtered.length === 1 && filtered[0] === COMMAND_MARKER) return "";
  if (filtered.length === 0) return "";

  return filtered.join(" ");
}

/**
 * True if a token matching `key` is present in `existing`. Pure.
 */
export function hasLaunchToken(existing: string, key: string): boolean {
  return tokenMatchesKey(tokenize(existing), key);
}

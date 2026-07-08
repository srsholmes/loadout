/**
 * Pure parser for a single Steam appmanifest_*.acf (Valve KeyValues)
 * file. Extracts `appid` + `name` from the *top level* of the
 * `AppState` block — nested blocks like `InstalledDepots` or
 * `UserConfig` are skipped via brace depth tracking, so a hypothetical
 * inner `"appid"` or `"name"` can't shadow the real one.
 */

export interface AcfManifest {
  appId: string;
  name: string;
}

type Token = { type: "string"; value: string } | { type: "open" } | { type: "close" };

const TOKEN_RE = /"((?:[^"\\]|\\.)*)"|\{|\}/g;

function tokenize(content: string): Token[] {
  const tokens: Token[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(content)) !== null) {
    if (m[0] === "{") tokens.push({ type: "open" });
    else if (m[0] === "}") tokens.push({ type: "close" });
    else tokens.push({ type: "string", value: m[1] ?? "" });
  }
  return tokens;
}

export function parseAcf(content: string): AcfManifest | null {
  const tokens = tokenize(content);

  // Locate `"AppState" {` at the outermost level.
  let bodyStart = -1;
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i]!; // i < length - 1, in bounds
    const next = tokens[i + 1]!; // i + 1 < length, in bounds
    if (t.type === "string" && t.value === "AppState" && next.type === "open") {
      bodyStart = i + 2;
      break;
    }
  }
  if (bodyStart === -1) return null;

  // Walk the body. Keys/values alternate at depth 1; nested blocks
  // ({...}) bump the depth and their contents are ignored. When a key
  // is followed by `{` instead of a string, that key was a block-key —
  // discard it so we don't misalign the next sibling pair.
  let depth = 1;
  let pendingKey: string | null = null;
  let appId: string | null = null;
  let name: string | null = null;

  for (let i = bodyStart; i < tokens.length && depth > 0; i++) {
    const tok = tokens[i]!; // i < length, in bounds
    if (tok.type === "open") {
      depth++;
      if (depth === 2) pendingKey = null;
      continue;
    }
    if (tok.type === "close") {
      depth--;
      continue;
    }
    if (depth !== 1) continue;
    if (pendingKey === null) {
      pendingKey = tok.value;
    } else {
      if (pendingKey === "appid" && /^\d+$/.test(tok.value)) appId = tok.value;
      else if (pendingKey === "name") name = tok.value;
      pendingKey = null;
    }
  }

  if (appId === null || name === null) return null;
  return { appId, name };
}

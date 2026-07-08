/**
 * @loadout/vdf — Valve Data Format parsing, serialization, and surgical editing.
 *
 * VDF is used by Steam config files (localconfig.vdf, libraryfolders.vdf, appmanifest_*.acf).
 */

/**
 * Recursive VDF node — every leaf is a string, every interior node is a
 * `{ [key: string]: VdfNode }` map. VDF has no native number/bool/array
 * types; everything serializes as quoted strings on disk. Callers that
 * need stronger typing of a specific known subtree should narrow on
 * read via `as` at the boundary.
 */
export type VdfNode = string | { [key: string]: VdfNode };

/** Convenience alias for the object branch — the parser always returns one of these. */
export type VdfObject = { [key: string]: VdfNode };

// ---------------------------------------------------------------------------
// parseVdf
// ---------------------------------------------------------------------------

/**
 * Parse VDF text into a nested JS object.
 * Handles quoted keys/values, nested braces, and // comments.
 */
export function parseVdf(content: string): VdfObject {
  const lines = content.split("\n");
  const root: VdfObject = {};
  const stack: VdfObject[] = [root];
  let pendingKey: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Skip empty lines and comments
    if (!line || line.startsWith("//")) continue;

    // Opening brace — push a new object onto the stack under pendingKey
    if (line === "{") {
      const obj: VdfObject = {};
      const parent = stack[stack.length - 1];
      if (parent && pendingKey !== null) {
        parent[pendingKey] = obj;
        pendingKey = null;
      }
      stack.push(obj);
      continue;
    }

    // Closing brace — pop the stack
    if (line === "}") {
      stack.pop();
      continue;
    }

    // Try to match "key" "value" on the same line (tab or space separated)
    const kvMatch = line.match(/^"([^"]*)"[\t\s]+"([^"]*)"$/);
    if (kvMatch) {
      const parent = stack[stack.length - 1];
      // The regex guarantees both capture groups when it matches.
      const [, key = "", value = ""] = kvMatch;
      if (parent) parent[key] = value;
      continue;
    }

    // Otherwise it should be a standalone "key" (section header)
    const keyMatch = line.match(/^"([^"]*)"$/);
    if (keyMatch) {
      pendingKey = keyMatch[1] ?? null;
      continue;
    }
  }

  return root;
}

// ---------------------------------------------------------------------------
// serializeVdf
// ---------------------------------------------------------------------------

/**
 * Serialize a nested JS object back to VDF format with proper indentation.
 */
export function serializeVdf(obj: VdfObject, indent: number = 0): string {
  const tab = "\t".repeat(indent);
  let out = "";

  for (const key of Object.keys(obj)) {
    const value = obj[key];

    if (typeof value === "object" && value !== null) {
      out += `${tab}"${key}"\n`;
      out += `${tab}{\n`;
      out += serializeVdf(value, indent + 1);
      out += `${tab}}\n`;
    } else {
      out += `${tab}"${key}"\t\t"${String(value)}"\n`;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// patchVdfValue
// ---------------------------------------------------------------------------

/**
 * Surgical text-level edit: navigate to a key via keyPath and replace ONLY its
 * value, preserving all other formatting, comments, whitespace, and key ordering.
 *
 * If the final key doesn't exist at the target location, it is inserted.
 *
 * @param content  Raw VDF text
 * @param keyPath  Array of nested keys, e.g. ["UserLocalConfigStore", "Software", "Valve", "Steam", "apps", "123456", "LaunchOptions"]
 * @param newValue The new value string to set
 * @returns Modified VDF text
 */
export function patchVdfValue(
  content: string,
  keyPath: string[],
  newValue: string,
): string {
  if (keyPath.length === 0) return content;

  const lines = content.split("\n");
  const sectionPath = keyPath.slice(0, -1); // sections to navigate into
  const targetKey = keyPath[keyPath.length - 1]; // leaf key to patch

  // Track which depth of sectionPath we've matched so far.
  // depth 0 = looking for sectionPath[0], etc.
  let matchDepth = 0;
  // The actual brace-nesting level inside the VDF text.
  let braceDepth = 0;
  // The brace depth at which we expect to see the section header for matchDepth.
  let expectedBraceDepth = 0;
  // Whether the previous meaningful line was the section header we're looking for.
  let pendingSectionMatch = false;
  // Whether we've fully navigated into the target section.
  let insideTarget = false;
  // The brace depth of the target section (so we know when we leave it).
  let targetBraceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim(); // i < lines.length, so in bounds
    if (!trimmed || trimmed.startsWith("//")) continue;

    if (trimmed === "{") {
      braceDepth++;
      if (pendingSectionMatch) {
        pendingSectionMatch = false;
        if (matchDepth >= sectionPath.length) {
          // We've navigated through all section keys; we're now inside the target section.
          insideTarget = true;
          targetBraceDepth = braceDepth;
        } else {
          expectedBraceDepth = braceDepth;
        }
      }
      continue;
    }

    if (trimmed === "}") {
      if (insideTarget && braceDepth === targetBraceDepth) {
        // We're closing the target section without finding the key — insert it.
        const indent = "\t".repeat(braceDepth);
        const insertLine = `${indent}"${targetKey}"\t\t"${newValue}"`;
        lines.splice(i, 0, insertLine);
        return lines.join("\n");
      }
      braceDepth--;
      // If we drop below the level where we matched a section, reset.
      if (matchDepth > 0 && braceDepth < expectedBraceDepth) {
        // We left a section we were tracking — this shouldn't happen in a valid
        // path, but be defensive.
        matchDepth--;
        expectedBraceDepth--;
        insideTarget = false;
      }
      continue;
    }

    // If we're inside the target section, look for the leaf key.
    if (insideTarget && braceDepth === targetBraceDepth) {
      const kvMatch = trimmed.match(/^"([^"]*)"([\t\s]+)"([^"]*)"$/);
      if (kvMatch && kvMatch[1] === targetKey) {
        // Replace just the value portion in the original (non-trimmed) line.
        const original = lines[i]!; // i < lines.length, so in bounds
        const oldValue = kvMatch[3] ?? ""; // group 3 present when regex matches
        // Find the last quoted value in the line and replace it.
        const lastQuotePair = original.lastIndexOf(`"${oldValue}"`);
        if (lastQuotePair !== -1) {
          lines[i] =
            original.substring(0, lastQuotePair) +
            `"${newValue}"` +
            original.substring(lastQuotePair + oldValue.length + 2);
          return lines.join("\n");
        }
      }

      // Also check if targetKey is a section header at this level (standalone key).
      const secMatch = trimmed.match(/^"([^"]*)"$/);
      if (secMatch && secMatch[1] === targetKey) {
        // The "leaf" is actually a section — this shouldn't normally happen
        // for patchVdfValue (which patches scalar values), so skip.
      }

      continue;
    }

    // Not yet inside target — try to match the next section in sectionPath.
    if (!insideTarget && matchDepth < sectionPath.length) {
      const secMatch = trimmed.match(/^"([^"]*)"$/);
      if (
        secMatch &&
        secMatch[1] === sectionPath[matchDepth] &&
        braceDepth === expectedBraceDepth
      ) {
        matchDepth++;
        pendingSectionMatch = true;
      }
    }
  }

  // If we get here and never found the target section at all, the keyPath doesn't
  // match the document structure. Return content unchanged.
  return content;
}

// ---------------------------------------------------------------------------
// removeVdfKey
// ---------------------------------------------------------------------------

/**
 * Remove a specific key (and its value or sub-section) from VDF text,
 * preserving all other content.
 *
 * @param content  Raw VDF text
 * @param keyPath  Array of nested keys leading to the key to remove
 * @returns Modified VDF text
 */
export function removeVdfKey(content: string, keyPath: string[]): string {
  if (keyPath.length === 0) return content;

  const lines = content.split("\n");
  const sectionPath = keyPath.slice(0, -1);
  const targetKey = keyPath[keyPath.length - 1];

  let matchDepth = 0;
  let braceDepth = 0;
  let expectedBraceDepth = 0;
  let pendingSectionMatch = false;
  let insideTarget = false;
  let targetBraceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim(); // i < lines.length, so in bounds
    if (!trimmed || trimmed.startsWith("//")) continue;

    if (trimmed === "{") {
      braceDepth++;
      if (pendingSectionMatch) {
        pendingSectionMatch = false;
        if (matchDepth >= sectionPath.length) {
          insideTarget = true;
          targetBraceDepth = braceDepth;
        } else {
          expectedBraceDepth = braceDepth;
        }
      }
      continue;
    }

    if (trimmed === "}") {
      if (insideTarget && braceDepth === targetBraceDepth) {
        // Leaving target section without finding key — nothing to remove.
        return content;
      }
      braceDepth--;
      if (matchDepth > 0 && braceDepth < expectedBraceDepth) {
        matchDepth--;
        expectedBraceDepth--;
        insideTarget = false;
      }
      continue;
    }

    if (insideTarget && braceDepth === targetBraceDepth) {
      // Check for key-value pair
      const kvMatch = trimmed.match(/^"([^"]*)"[\t\s]+"([^"]*)"$/);
      if (kvMatch && kvMatch[1] === targetKey) {
        lines.splice(i, 1);
        return lines.join("\n");
      }

      // Check for section header
      const secMatch = trimmed.match(/^"([^"]*)"$/);
      if (secMatch && secMatch[1] === targetKey) {
        // Remove the section header, its opening brace, all content, and closing brace.
        const removeStart = i;
        let j = i + 1;
        // Find the opening brace.
        while (j < lines.length) {
          const t = lines[j]!.trim(); // j < lines.length, so in bounds
          if (!t || t.startsWith("//")) {
            j++;
            continue;
          }
          if (t === "{") break;
          break; // unexpected — bail
        }
        if (j < lines.length && lines[j]!.trim() === "{") {
          // Find the matching closing brace.
          let depth = 1;
          let k = j + 1;
          while (k < lines.length && depth > 0) {
            const t = lines[k]!.trim(); // k < lines.length, so in bounds
            if (t === "{") depth++;
            else if (t === "}") depth--;
            k++;
          }
          // Remove lines[removeStart..k-1]
          lines.splice(removeStart, k - removeStart);
          return lines.join("\n");
        }
        // If we couldn't find the brace, just remove the header line.
        lines.splice(i, 1);
        return lines.join("\n");
      }

      continue;
    }

    // Navigate sections
    if (!insideTarget && matchDepth < sectionPath.length) {
      const secMatch = trimmed.match(/^"([^"]*)"$/);
      if (
        secMatch &&
        secMatch[1] === sectionPath[matchDepth] &&
        braceDepth === expectedBraceDepth
      ) {
        matchDepth++;
        pendingSectionMatch = true;
      }
    }
  }

  return content;
}

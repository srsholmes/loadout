/**
 * Pure parsing + hashing helpers for the disable-controller-input plugin.
 *
 * - djb2: small stable hash of an InputPlumber composite-device name.
 *   Kept on disk as the UI's identity for a device, so the UI can refer
 *   to a device whose DBus path has shifted across reconnects.
 * - parseStringProp / parseObjectPathArrayProp: parse the value half of
 *   `busctl get-property` output. Format is `<sig> <value...>` where the
 *   value rendering depends on the signature. We handle the two shapes
 *   this plugin actually reads:
 *     s  "string"
 *     ao 2 "/path1" "/path2"
 */

/** djb2 hash of a string — same algorithm as the source plugin. */
export function djb2(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff;
  }
  return hash >>> 0;
}

/** Parse a `s "value"` busctl property line. Returns null if the
 *  output isn't a quoted string. Unescapes `\"` and `\\`. */
export function parseStringProp(stdout: string): string | null {
  const trimmed = stdout.trim();
  const m = trimmed.match(/^s\s+"((?:\\.|[^"\\])*)"$/);
  if (!m) return null;
  return m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/** Parse a `ao N "/p1" "/p2" …` busctl property line. Returns null if
 *  the output isn't an object-path array; returns `[]` for `ao 0`. */
export function parseObjectPathArrayProp(stdout: string): string[] | null {
  const trimmed = stdout.trim();
  const m = trimmed.match(/^ao\s+(\d+)((?:\s+"[^"]*")*)$/);
  if (!m) return null;
  const count = parseInt(m[1], 10);
  if (count === 0) return [];
  const paths: string[] = [];
  const re = /"([^"]*)"/g;
  let p: RegExpExecArray | null;
  while ((p = re.exec(m[2])) !== null) paths.push(p[1]);
  return paths;
}

/** Match exactly `/org/shadowblip/InputPlumber/CompositeDevice<digits>`
 *  (ignoring child paths and the Manager / devices subtrees). Used to
 *  pluck the composite-device paths out of `busctl tree --list` output. */
const COMPOSITE_PATH_RE =
  /^\/org\/shadowblip\/InputPlumber\/CompositeDevice\d+$/;

/** Filter `busctl tree --list` output down to top-level CompositeDevice paths. */
export function pickCompositePaths(treeStdout: string): string[] {
  const paths: string[] = [];
  for (const line of treeStdout.split("\n")) {
    const t = line.trim();
    if (COMPOSITE_PATH_RE.test(t)) paths.push(t);
  }
  return paths;
}

/**
 * POSIX-safe single-quote shell escape. Wraps the string in single quotes
 * and escapes any single quotes inside it. Use whenever interpolating
 * untrusted strings into a `bash -lc` or similar shell-evaluated context.
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

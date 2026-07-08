/**
 * Pure size-formatting + parsing helpers used by both the backend
 * (`du -sb` output → human bytes) and the UI (`df -h` strings → GB).
 */

/**
 * Format bytes into human-readable MB/GB string.
 */
export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Parse a `df -h`-style size ("312G", "1.4T", "512M") into GB.
 */
export function parseSizeToGB(s: string): number {
  if (!s) return 0;
  const m = s.match(/^([\d.]+)\s*([KMGTP]?)/i);
  if (!m) return 0;
  const n = parseFloat(m[1]!); // group 1 is required, present on match
  const unit = (m[2] || "G").toUpperCase();
  switch (unit) {
    case "K": return n / (1024 * 1024);
    case "M": return n / 1024;
    case "G": return n;
    case "T": return n * 1024;
    case "P": return n * 1024 * 1024;
    default:  return n;
  }
}

export function bytesToGB(bytes: number): number {
  return bytes / (1024 * 1024 * 1024);
}

export function formatGB(gb: number): string {
  if (gb >= 100) return gb.toFixed(0);
  if (gb >= 10)  return gb.toFixed(1);
  return gb.toFixed(2);
}

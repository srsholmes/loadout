/**
 * Pure parser for `df -h <paths...>` stdout. Splits the table by
 * whitespace, skips the header row, dedups by filesystem (so a
 * shared `/` + `$HOME` partition collapses to one entry).
 */

export interface DiskPartition {
  filesystem: string;
  size: string;
  used: string;
  available: string;
  usePercent: string;
  mountpoint: string;
}

export function parseDfOutput(stdout: string): DiskPartition[] {
  const lines = stdout.split("\n").slice(1); // skip header
  const seen = new Set<string>();
  const partitions: DiskPartition[] = [];

  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length < 6) continue; // expect parts[0..5] present
    const [filesystem, size, used, available, usePercent] = parts;
    if (
      filesystem === undefined ||
      size === undefined ||
      used === undefined ||
      available === undefined ||
      usePercent === undefined
    ) {
      console.warn("[storage-cleaner] unexpected missing df column");
      continue;
    }
    if (seen.has(filesystem)) continue;
    seen.add(filesystem);

    partitions.push({
      filesystem,
      size,
      used,
      available,
      usePercent,
      // Mountpoint can contain spaces (rare — user-mounted volumes
      // with literal spaces in their label). The fixed columns 0..4
      // are always single tokens, so everything from index 5 onwards
      // is the mountpoint.
      mountpoint: parts.slice(5).join(" "),
    });
  }

  return partitions;
}

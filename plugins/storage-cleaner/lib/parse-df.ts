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
    if (parts.length < 6) continue;
    const filesystem = parts[0];
    if (seen.has(filesystem)) continue;
    seen.add(filesystem);

    partitions.push({
      filesystem,
      size: parts[1],
      used: parts[2],
      available: parts[3],
      usePercent: parts[4],
      mountpoint: parts[5],
    });
  }

  return partitions;
}

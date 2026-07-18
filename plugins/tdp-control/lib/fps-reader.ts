/**
 * Reads a game's live FPS by tailing the CSV that MangoHud writes when
 * logging is enabled (see lib/mangohud.ts for how logging is turned on).
 *
 * MangoHud writes one timestamped CSV per session into the configured
 * `output_folder`. The file begins with a hardware/preamble section, then a
 * header row whose columns include `fps`, then one data row per `log_interval`.
 * We locate the newest CSV (the active session), tail only the bytes appended
 * since the last read, and return a rolling average of the recent `fps` column.
 *
 * Notes that match the rest of the plugin:
 *   - No `Bun.file(...).exists()` gate before reading (see readFileText in
 *     backend.ts): a genuinely missing file just throws and is caught.
 *   - Reads are incremental (byte offset) so a multi-minute log isn't
 *     re-parsed every tick.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface FpsReaderOptions {
  /** Directory MangoHud logs into for this game (MangoHud `output_folder`). */
  outputFolder: string;
  /** How many recent samples to average. Default 15 (~3s at 200ms interval). */
  sampleWindow?: number;
  /** A log whose newest file is older than this (ms) is treated as dead. */
  staleMs?: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

export function createFpsReader(options: FpsReaderOptions) {
  const { outputFolder } = options;
  const sampleWindow = options.sampleWindow ?? 15;
  const staleMs = options.staleMs ?? 5000;
  const now = options.now ?? (() => Date.now());

  let currentFile: string | null = null;
  let byteOffset = 0;
  let fpsColIndex = -1;
  let partialLine = "";
  let samples: number[] = [];

  function reset(): void {
    currentFile = null;
    byteOffset = 0;
    fpsColIndex = -1;
    partialLine = "";
    samples = [];
  }

  function switchFile(path: string): void {
    currentFile = path;
    byteOffset = 0;
    fpsColIndex = -1;
    partialLine = "";
    samples = [];
  }

  /** Find the newest *.csv in the output folder, or null if none/unreadable. */
  function newestCsv(): { path: string; mtimeMs: number } | null {
    let entries: string[];
    try {
      entries = readdirSync(outputFolder);
    } catch {
      // Folder doesn't exist yet — MangoHud hasn't created it.
      return null;
    }
    let best: { path: string; mtimeMs: number } | null = null;
    for (const name of entries) {
      if (!name.toLowerCase().endsWith(".csv")) continue;
      const path = join(outputFolder, name);
      try {
        const st = statSync(path);
        if (!st.isFile()) continue;
        if (best === null || st.mtimeMs > best.mtimeMs) {
          best = { path, mtimeMs: st.mtimeMs };
        }
      } catch {
        // Race with rotation/removal — skip.
      }
    }
    return best;
  }

  function processChunk(chunk: string): void {
    const text = partialLine + chunk;
    const lines = text.split("\n");
    // If the chunk didn't end on a newline, the last element is incomplete.
    partialLine = text.endsWith("\n") ? "" : (lines.pop() ?? "");

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const fields = line.split(",");

      if (fpsColIndex === -1) {
        // Still looking for the data header row (columns include "fps").
        const idx = fields.findIndex((f) => f.trim().toLowerCase() === "fps");
        if (idx !== -1) fpsColIndex = idx;
        continue; // header or preamble line — never a data sample
      }

      const val = parseFloat(fields[fpsColIndex] ?? "");
      if (Number.isFinite(val) && val > 0) samples.push(val);
    }

    if (samples.length > sampleWindow) {
      samples = samples.slice(samples.length - sampleWindow);
    }
  }

  /**
   * Read any newly-appended rows and return the smoothed current FPS, or null
   * when there's no fresh data (no log yet, stale session, or still warming up).
   */
  async function readSmoothedFps(): Promise<number | null> {
    const newest = newestCsv();
    if (newest === null) return null;

    // A log that stopped growing means the game exited or logging stopped.
    if (now() - newest.mtimeMs > staleMs) return null;

    if (newest.path !== currentFile) switchFile(newest.path);

    try {
      const file = Bun.file(currentFile!);
      const size = file.size;
      // File was truncated or replaced under the same name — restart from top.
      if (size < byteOffset) {
        byteOffset = 0;
        fpsColIndex = -1;
        partialLine = "";
      }
      if (size > byteOffset) {
        const chunk = await file.slice(byteOffset, size).text();
        byteOffset = size;
        processChunk(chunk);
      }
    } catch {
      // Missing/unreadable file: fall through to whatever we have buffered.
      return samples.length ? mean(samples) : null;
    }

    return samples.length ? mean(samples) : null;
  }

  return { readSmoothedFps, reset };
}

function mean(xs: number[]): number {
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

export type FpsReader = ReturnType<typeof createFpsReader>;

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFpsReader } from "./fps-reader";

let dir: string;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fps-reader-test-"));
  clock = 1_000_000;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const now = () => clock;

// MangoHud-style log: hardware preamble, then a data header including `fps`,
// then data rows.
function logHeader(): string {
  return [
    "os,cpu,gpu,ram,kernel,driver",
    "Arch Linux,AMD Ryzen Z1,AMD 780M,16GB,6.9,mesa",
    "fps,frametime,cpu_load,gpu_load,cpu_temp,gpu_temp,elapsed",
  ].join("\n");
}

function rows(...fps: number[]): string {
  return fps.map((f) => `${f},16.6,40,90,60,70,1000`).join("\n");
}

/** Write a file and force its mtime to the current test clock. */
function writeLog(name: string, content: string) {
  const path = join(dir, name);
  writeFileSync(path, content);
  const secs = clock / 1000;
  utimesSync(path, secs, secs);
  return path;
}

describe("FPS reader", () => {
  test("returns null when the folder does not exist", async () => {
    const r = createFpsReader({ outputFolder: join(dir, "nope"), now });
    expect(await r.readSmoothedFps()).toBeNull();
  });

  test("returns null when there are no CSV files", async () => {
    writeFileSync(join(dir, "notes.txt"), "hello");
    const r = createFpsReader({ outputFolder: dir, now });
    expect(await r.readSmoothedFps()).toBeNull();
  });

  test("averages the fps column, tolerating extra columns", async () => {
    writeLog("session.csv", logHeader() + "\n" + rows(58, 60, 62) + "\n");
    const r = createFpsReader({ outputFolder: dir, now });
    expect(await r.readSmoothedFps()).toBeCloseTo(60, 5);
  });

  test("reads only appended rows across calls (incremental offset)", async () => {
    const path = writeLog("session.csv", logHeader() + "\n" + rows(50) + "\n");
    const r = createFpsReader({ outputFolder: dir, now });
    expect(await r.readSmoothedFps()).toBeCloseTo(50, 5);

    appendFileSync(path, rows(70) + "\n");
    utimesSync(path, clock / 1000, clock / 1000);
    // Average of 50 and 70 = 60 (both within the sample window).
    expect(await r.readSmoothedFps()).toBeCloseTo(60, 5);
  });

  test("honours the sample window", async () => {
    writeLog("session.csv", logHeader() + "\n" + rows(10, 10, 10, 100) + "\n");
    const r = createFpsReader({ outputFolder: dir, now, sampleWindow: 1 });
    // Only the last sample is kept.
    expect(await r.readSmoothedFps()).toBeCloseTo(100, 5);
  });

  test("returns null when the newest log is stale", async () => {
    writeLog("session.csv", logHeader() + "\n" + rows(60) + "\n");
    const r = createFpsReader({ outputFolder: dir, now, staleMs: 5000 });
    clock += 10_000; // advance well past staleMs; file mtime stays old
    expect(await r.readSmoothedFps()).toBeNull();
  });

  test("picks the newest file and resets on rotation", async () => {
    writeLog("old.csv", logHeader() + "\n" + rows(30) + "\n");
    const r = createFpsReader({ outputFolder: dir, now });
    expect(await r.readSmoothedFps()).toBeCloseTo(30, 5);

    // A newer session file appears.
    clock += 1000;
    writeLog("new.csv", logHeader() + "\n" + rows(90) + "\n");
    // Should switch to the new file and only reflect its samples.
    expect(await r.readSmoothedFps()).toBeCloseTo(90, 5);
  });

  test("buffers a partial trailing line until it completes", async () => {
    const path = writeLog(
      "session.csv",
      logHeader() + "\n" + "58,16.6,40,90,60,70,1000\n" + "62,16.6,40,90", // no newline: partial
    );
    const r = createFpsReader({ outputFolder: dir, now });
    // Only the first complete row is counted so far.
    expect(await r.readSmoothedFps()).toBeCloseTo(58, 5);

    // Complete the partial row and add another.
    appendFileSync(path, ",60,70,1000\n" + rows(60) + "\n");
    utimesSync(path, clock / 1000, clock / 1000);
    // Now 58, 62, 60 -> average 60.
    expect(await r.readSmoothedFps()).toBeCloseTo(60, 5);
  });

  test("reset drops state", async () => {
    writeLog("session.csv", logHeader() + "\n" + rows(60) + "\n");
    const r = createFpsReader({ outputFolder: dir, now });
    await r.readSmoothedFps();
    r.reset();
    // After reset it re-reads the file from scratch and still returns a value.
    expect(await r.readSmoothedFps()).toBeCloseTo(60, 5);
  });
});

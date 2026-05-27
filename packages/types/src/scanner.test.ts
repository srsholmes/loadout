import { describe, it, expect, mock } from "bun:test";
import { createRetryScanner } from "./scanner";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createRetryScanner", () => {
  it("returns true from start() when the first scan finds the target", async () => {
    const scan = mock(() => true);
    const scanner = createRetryScanner({ scan, intervalMs: 1000 });
    const initial = await scanner.start();
    expect(initial).toBe(true);
    expect(scanner.isFound()).toBe(true);
    expect(scan).toHaveBeenCalledTimes(1);
    scanner.stop();
  });

  it("keeps polling until a later scan finds the target, then stops", async () => {
    let attempts = 0;
    const scan = mock(() => {
      attempts++;
      return attempts >= 3;
    });
    const onFound = mock(() => {});
    const scanner = createRetryScanner({
      scan,
      intervalMs: 10,
      onFound,
    });

    const initial = await scanner.start();
    expect(initial).toBe(false);
    expect(scanner.isFound()).toBe(false);

    // Wait long enough for 2+ interval fires
    await sleep(50);

    expect(scanner.isFound()).toBe(true);
    expect(onFound).toHaveBeenCalledTimes(1);
    scanner.stop();

    const callsAtStop = scan.mock.calls.length;
    await sleep(30);
    expect(scan).toHaveBeenCalledTimes(callsAtStop);
  });

  it("fires onFound exactly once on the not-found -> found transition", async () => {
    let attempts = 0;
    const scan = mock(() => {
      attempts++;
      return attempts >= 2;
    });
    const onFound = mock(() => {});
    const scanner = createRetryScanner({
      scan,
      intervalMs: 5,
      onFound,
    });

    await scanner.start();
    await sleep(30);
    expect(onFound).toHaveBeenCalledTimes(1);

    await scanner.rescan();
    await scanner.rescan();
    expect(onFound).toHaveBeenCalledTimes(1);
    scanner.stop();
  });

  it("rescan() runs the scan immediately and reports found state", async () => {
    let available = false;
    const scanner = createRetryScanner({
      scan: () => available,
      intervalMs: 60_000,
    });

    await scanner.start();
    expect(scanner.isFound()).toBe(false);

    available = true;
    const found = await scanner.rescan();
    expect(found).toBe(true);
    expect(scanner.isFound()).toBe(true);
    scanner.stop();
  });

  it("stop() is idempotent", async () => {
    const scanner = createRetryScanner({ scan: () => false, intervalMs: 10 });
    await scanner.start();
    scanner.stop();
    scanner.stop();
    expect(scanner.isFound()).toBe(false);
  });

  it("supports async scan functions", async () => {
    const scan = mock(async () => {
      await sleep(2);
      return true;
    });
    const scanner = createRetryScanner({ scan, intervalMs: 1000 });
    const initial = await scanner.start();
    expect(initial).toBe(true);
    scanner.stop();
  });

  it("swallows onFound errors without killing the scanner", async () => {
    const onFound = mock(() => {
      throw new Error("boom");
    });
    const scanner = createRetryScanner({
      scan: () => true,
      onFound,
      intervalMs: 1000,
    });
    const initial = await scanner.start();
    expect(initial).toBe(true);
    expect(onFound).toHaveBeenCalledTimes(1);
    scanner.stop();
  });
});

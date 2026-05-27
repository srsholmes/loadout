/**
 * Retry scanner — a small lifecycle helper for plugins that discover
 * hardware or external tools whose availability is not guaranteed at the
 * moment the plugin loads.
 *
 * The canonical failure this solves: a plugin's `onLoad` runs before a
 * kernel module, daemon, or device is ready. A one-shot scan misses it,
 * and the plugin stays broken until the process restarts.
 *
 * Usage:
 *
 *   this.scanner = createRetryScanner({
 *     scan: async () => {
 *       this.device = await this.findDevice();
 *       return this.device !== null;
 *     },
 *     onFound: async () => this.emit?.({ event: "ready", data: ... }),
 *     label: "my-plugin",
 *   });
 *   await this.scanner.start();
 *
 *   // In onUnload:
 *   this.scanner.stop();
 *
 * The scanner runs `scan` once immediately, and then on an interval
 * until `scan` returns true. After the found transition, polling stops
 * and `onFound` fires once. Call `rescan()` to force an immediate scan
 * at any time (e.g. from a user-triggered RPC).
 */
export interface RetryScannerOptions {
  /** Run one scan. Return true if the target was found. */
  scan: () => boolean | Promise<boolean>;
  /** Interval between retries while not found. Default 30_000ms. */
  intervalMs?: number;
  /** Called once when a scan flips from not-found to found. */
  onFound?: () => void | Promise<void>;
  /** Optional label used in the console log when the target is found. */
  label?: string;
}

export interface RetryScanner {
  /** Run the first scan and start the retry interval. Resolves with whether the first scan found the target. */
  start(): Promise<boolean>;
  /** Stop the retry interval. Idempotent. */
  stop(): void;
  /** Force an immediate scan, bypassing the interval. Returns whether the target is now found. */
  rescan(): Promise<boolean>;
  /** Whether the most recent scan found the target. */
  isFound(): boolean;
}

export function createRetryScanner(opts: RetryScannerOptions): RetryScanner {
  const intervalMs = opts.intervalMs ?? 30_000;
  let timer: ReturnType<typeof setInterval> | undefined;
  let found = false;

  const runScan = async (): Promise<boolean> => {
    const result = await opts.scan();
    if (result && !found) {
      found = true;
      if (opts.label) {
        console.log(`[${opts.label}] Hardware detected`);
      }
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      try {
        await opts.onFound?.();
      } catch (err) {
        console.error(
          `[${opts.label ?? "retry-scanner"}] onFound handler threw:`,
          err,
        );
      }
    }
    return found;
  };

  return {
    async start() {
      const initial = await runScan();
      if (!initial && timer === undefined) {
        timer = setInterval(() => {
          runScan().catch((err) =>
            console.error(
              `[${opts.label ?? "retry-scanner"}] scan threw:`,
              err,
            ),
          );
        }, intervalMs);
      }
      return initial;
    },
    stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    rescan() {
      return runScan();
    },
    isFound() {
      return found;
    },
  };
}

/**
 * Crash reporting for the overlay's Bun main process.
 *
 * **Import order matters and is load-bearing.** This module must be imported
 * before `electrobun/bun`, which registers its own `uncaughtException`
 * listener (node_modules/electrobun/dist/api/bun/proc/native.ts) that calls a
 * native `forceExit(1)`. Node runs listeners in registration order, so a
 * handler registered after that import never executes — the process is gone
 * before it is reached. `src/bun/index.ts` imports this at the very top,
 * alongside the `display-detect` side-effect import that exists for the same
 * class of reason.
 *
 * The handlers use `captureFatalSync`, which writes to disk rather than
 * sending. Electrobun's `forceExit` would kill an in-flight request, so the
 * report is spooled and shipped by the next successful start.
 */

import { initCrashReporting, captureFatalSync, captureErrorSync } from "@loadout/crash-report";
import { OVERLAY_BUN_VERSION } from "./version";
import { trace } from "./native/trace";

initCrashReporting({ process: "overlay-bun", release: OVERLAY_BUN_VERSION });

process.on("uncaughtException", (err) => {
  console.error("[overlay] uncaught exception:", err);
  trace(`uncaught exception: ${err.stack ?? err.message}`);
  // Synchronous: Electrobun's listener force-exits right after this one.
  captureFatalSync(err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[overlay] unhandled rejection:", reason);
  trace(`unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : reason}`);
  // Electrobun's rejection listener only logs, so the process survives and an
  // ordinary async send has time to complete.
  captureErrorSync(reason);
});

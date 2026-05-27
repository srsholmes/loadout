import { getDriver } from "./stores/registry";
import type { PreflightResult } from "./stores/driver";
import type { StoreId } from "./types";

/**
 * Aggregate "is this store ready to use" check. Per-driver logic
 * lives in each driver's `preflight()`; this wrapper just looks up
 * the driver and reports "no driver registered" cleanly when the
 * caller asks about a store we don't support yet.
 */
export async function checkPreflight(storeId: StoreId): Promise<PreflightResult> {
  const driver = getDriver(storeId);
  if (!driver) {
    return {
      ok: false,
      missing: [storeId],
      canSelfInstall: false,
      installHint: `No driver registered for store "${storeId}".`,
    };
  }
  return driver.preflight();
}

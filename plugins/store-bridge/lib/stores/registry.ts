import type { StoreId } from "../types";
import type { StoreDriver } from "./driver";

/**
 * Driver registry — module-level so a driver only has to call
 * `registerDriver()` once at import time. The backend looks drivers
 * up by id on every RPC; the registry is the seam where new stores
 * plug in.
 */
const registry = new Map<StoreId, StoreDriver>();

export function registerDriver(driver: StoreDriver): void {
  registry.set(driver.id, driver);
}

export function getDriver(id: StoreId): StoreDriver | null {
  return registry.get(id) ?? null;
}

export function listDrivers(): StoreDriver[] {
  return [...registry.values()];
}

/** Test helper — drop everything so specs don't leak state. */
export function clearDrivers(): void {
  registry.clear();
}

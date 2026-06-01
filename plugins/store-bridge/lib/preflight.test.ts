import { describe, it, expect, beforeEach } from "bun:test";
import { checkPreflight } from "./preflight";
import { registerDriver, clearDrivers } from "./stores/registry";
import type { StoreDriver } from "./stores/driver";

function stub(overrides: Partial<StoreDriver> = {}): StoreDriver {
  const todo = async () => {
    throw new Error("nope");
  };
  return {
    id: "epic",
    displayName: "Epic",
    preflight: async () => ({ ok: true, missing: [], canSelfInstall: false }),
    selfInstall: async () => {},
    authStatus: async () => "unknown",
    startAuth: async () => ({ url: "" }),
    completeAuth: todo,
    signOut: todo,
    listLibrary: async () => [],
    install: todo,
    uninstall: todo,
    launchSpec: () => ({ exe: "", args: "" }),
    identifyInstall: async () => null,
    importExisting: todo,
    ...overrides,
  } as StoreDriver;
}

describe("checkPreflight", () => {
  beforeEach(() => clearDrivers());

  it("returns not-ok when no driver is registered for the store", async () => {
    const r = await checkPreflight("epic");
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("epic");
  });

  it("delegates to the driver's preflight when one is registered", async () => {
    registerDriver(
      stub({
        preflight: async () => ({
          ok: false,
          missing: ["legendary"],
          canSelfInstall: true,
        }),
      }),
    );
    const r = await checkPreflight("epic");
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["legendary"]);
    expect(r.canSelfInstall).toBe(true);
  });
});

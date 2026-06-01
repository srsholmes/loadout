import { describe, it, expect, beforeEach } from "bun:test";
import {
  registerDriver,
  getDriver,
  listDrivers,
  clearDrivers,
} from "./registry";
import type { StoreDriver } from "./driver";

function fakeDriver(overrides: Partial<StoreDriver> = {}): StoreDriver {
  const stub = async () => {
    throw new Error("not implemented");
  };
  return {
    id: "epic",
    displayName: "Epic",
    preflight: async () => ({ ok: true, missing: [], canSelfInstall: false }),
    selfInstall: async () => {},
    authStatus: async () => "unknown",
    startAuth: async () => ({ url: "https://example.test" }),
    completeAuth: stub,
    signOut: stub,
    listLibrary: async () => [],
    install: stub,
    uninstall: stub,
    launchSpec: () => ({ exe: "", args: "" }),
    identifyInstall: async () => null,
    importExisting: stub,
    ...overrides,
  } as StoreDriver;
}

describe("driver registry", () => {
  beforeEach(() => clearDrivers());

  it("returns null for an unregistered id", () => {
    expect(getDriver("epic")).toBeNull();
  });

  it("registers and looks up a driver by id", () => {
    registerDriver(fakeDriver({ id: "epic", displayName: "Epic" }));
    const d = getDriver("epic");
    expect(d?.displayName).toBe("Epic");
  });

  it("last registration wins for the same id", () => {
    registerDriver(fakeDriver({ id: "epic", displayName: "First" }));
    registerDriver(fakeDriver({ id: "epic", displayName: "Second" }));
    expect(getDriver("epic")?.displayName).toBe("Second");
  });

  it("two stores coexist without collision", () => {
    registerDriver(fakeDriver({ id: "epic", displayName: "Epic" }));
    registerDriver(fakeDriver({ id: "gog", displayName: "GOG" }));
    expect(getDriver("epic")?.displayName).toBe("Epic");
    expect(getDriver("gog")?.displayName).toBe("GOG");
    expect(listDrivers().map((d) => d.id).sort()).toEqual(["epic", "gog"]);
  });
});

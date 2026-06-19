import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { RecompSDK, RecompRuntime } from "./index";

/**
 * Spec for the recomp recipe SDK proxy (`@recomp/sdk`). The proxy
 * reads its live runtime from `globalThis.__recomp_runtime`, which the
 * installer-host (`lib/installer-host.ts`) binds for the duration of a
 * single install. Direct use of the proxy outside the host (e.g. a
 * recipe imported standalone) MUST throw an actionable error.
 *
 * Mirrors the style of `sdk/mod.test.ts`: bind a stub runtime, assert
 * every getter reads through and every method dispatches with the
 * exact args it was handed.
 */

const slot = globalThis as unknown as {
  __recomp_runtime?: RecompRuntime;
};
const original = slot.__recomp_runtime;

beforeEach(() => {
  delete slot.__recomp_runtime;
});

afterEach(() => {
  if (original !== undefined) slot.__recomp_runtime = original;
  else delete slot.__recomp_runtime;
});

describe("recomp sdk proxy — unbound runtime", () => {
  it("throws an actionable error when a getter is read with no bound runtime", async () => {
    const { sdk } = await import("./index");
    expect(() => sdk.installDir).toThrow(/no recomp runtime bound/);
  });

  it("throws when an env method is called with no bound runtime", async () => {
    const { sdk } = await import("./index");
    expect(() => sdk.env.kind).toThrow(/no recomp runtime bound/);
  });

  it("error message names the host module so the user knows where to look", async () => {
    const { sdk } = await import("./index");
    expect(() => sdk.installDir).toThrow(
      /plugins\/recomp\/lib\/installer-host\.ts/,
    );
  });
});

interface Calls {
  [k: string]: unknown[];
}

function makeStub(calls: Calls): { stub: RecompRuntime; sdk: RecompSDK } {
  const envStub: RecompSDK["env"] = {
    kind: "distrobox",
    label: "recomp-build",
    ensurePackages: async (...args: unknown[]) => {
      calls.ensurePackages = args;
    },
    has: async (...args: unknown[]) => {
      calls.has = args;
      return true;
    },
    run: async (...args: unknown[]) => {
      calls.run = args;
    },
  };
  const sdkStub: RecompSDK = {
    installDir: "/install",
    romPath: "/roms/game.z64",
    platform: "linux",
    id: "super-mario-64",
    env: envStub,
    ready: Promise.resolve(),
    cloneFromGitHub: async (...args: unknown[]) => {
      calls.cloneFromGitHub = args;
    },
    placeRom: async (...args: unknown[]) => {
      calls.placeRom = args;
    },
    declareOutput: (...args: unknown[]) => {
      calls.declareOutput = args;
    },
    declareLaunchCommand: (...args: unknown[]) => {
      calls.declareLaunchCommand = args;
    },
    declarePlatform: (...args: unknown[]) => {
      calls.declarePlatform = args;
    },
    reportVersion: (...args: unknown[]) => {
      calls.reportVersion = args;
    },
    progress: (...args: unknown[]) => {
      calls.progress = args;
    },
    writeLauncher: async (...args: unknown[]) => {
      calls.writeLauncher = args;
      return "/install/launcher.sh";
    },
  };
  return { stub: { sdk: sdkStub }, sdk: sdkStub };
}

describe("recomp sdk proxy — bound runtime getters", () => {
  it("reads scalar getters through to the bound runtime", async () => {
    const { stub } = makeStub({});
    slot.__recomp_runtime = stub;

    const { sdk } = await import("./index");
    expect(sdk.installDir).toBe("/install");
    expect(sdk.romPath).toBe("/roms/game.z64");
    expect(sdk.platform).toBe("linux");
    expect(sdk.id).toBe("super-mario-64");
    expect(sdk.ready).toBeInstanceOf(Promise);
  });

  it("reflects a live runtime swap (proxy holds no cached reference)", async () => {
    const a = makeStub({});
    a.sdk.installDir = "/a";
    slot.__recomp_runtime = a.stub;
    const { sdk } = await import("./index");
    expect(sdk.installDir).toBe("/a");

    const b = makeStub({});
    b.sdk.installDir = "/b";
    slot.__recomp_runtime = b.stub;
    expect(sdk.installDir).toBe("/b");
  });

  it("exposes env getters through the nested env proxy", async () => {
    const { stub } = makeStub({});
    slot.__recomp_runtime = stub;
    const { sdk } = await import("./index");
    expect(sdk.env.kind).toBe("distrobox");
    expect(sdk.env.label).toBe("recomp-build");
  });
});

describe("recomp sdk proxy — method dispatch", () => {
  it("forwards each method's args verbatim to the bound runtime", async () => {
    const calls: Calls = {};
    const { stub } = makeStub(calls);
    slot.__recomp_runtime = stub;

    const { sdk } = await import("./index");

    await sdk.cloneFromGitHub("owner/repo", "main");
    await sdk.placeRom("baserom.us.z64");
    sdk.declareOutput("build/game");
    sdk.declareLaunchCommand("{installDir}/build/game --foo");
    sdk.declarePlatform("windows");
    sdk.reportVersion("abc123");
    sdk.progress("building", 42);

    expect(calls.cloneFromGitHub).toEqual(["owner/repo", "main"]);
    expect(calls.placeRom).toEqual(["baserom.us.z64"]);
    expect(calls.declareOutput).toEqual(["build/game"]);
    expect(calls.declareLaunchCommand).toEqual([
      "{installDir}/build/game --foo",
    ]);
    expect(calls.declarePlatform).toEqual(["windows"]);
    expect(calls.reportVersion).toEqual(["abc123"]);
    expect(calls.progress).toEqual(["building", 42]);
  });

  it("forwards env methods (ensurePackages / has / run) verbatim", async () => {
    const calls: Calls = {};
    const { stub } = makeStub(calls);
    slot.__recomp_runtime = stub;

    const { sdk } = await import("./index");

    await sdk.env.ensurePackages(["gcc", "make"]);
    const present = await sdk.env.has("cmake");
    await sdk.env.run("make -j4", { cwd: "/install", stage: "building" });

    expect(calls.ensurePackages).toEqual([["gcc", "make"]]);
    expect(calls.has).toEqual(["cmake"]);
    expect(present).toBe(true);
    expect(calls.run).toEqual([
      "make -j4",
      { cwd: "/install", stage: "building" },
    ]);
  });

  it("forwards writeLauncher opts and returns the host's resolved path", async () => {
    const calls: Calls = {};
    const { stub } = makeStub(calls);
    slot.__recomp_runtime = stub;

    const { sdk } = await import("./index");

    const opts = {
      exe: "build/game",
      args: ["--fullscreen"],
      env: { LIBGL_ALWAYS_SOFTWARE: "0" },
    };
    const result = await sdk.writeLauncher(opts);

    expect(calls.writeLauncher).toEqual([opts]);
    expect(result).toBe("/install/launcher.sh");
  });
});

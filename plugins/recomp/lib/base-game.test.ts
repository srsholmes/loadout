import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readlink, readFile, lstat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findSteamAppInstallDir,
  linkBaseGameInto,
  resolveBaseGameDir,
} from "./base-game";
import type { BaseGameInfo } from "./types";

const SKATE: BaseGameInfo = {
  steamAppId: 3354750,
  name: "skate.",
  requiredFile: "Skate.exe",
};

let sandbox = "";
let library = "";

/** Write a minimal appmanifest for `appId` into `library`. */
async function writeManifest(
  lib: string,
  appId: number,
  installdir: string,
): Promise<void> {
  await writeFile(
    join(lib, `appmanifest_${appId}.acf`),
    `"AppState"\n{\n\t"appid"\t\t"${appId}"\n\t"name"\t\t"skate."\n\t"installdir"\t\t"${installdir}"\n}\n`,
  );
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "recomp-base-game-"));
  library = join(sandbox, "steamapps");
  await mkdir(join(library, "common"), { recursive: true });
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe("findSteamAppInstallDir", () => {
  it("resolves common/<installdir> from the manifest in any library", async () => {
    const other = join(sandbox, "sd", "steamapps");
    await mkdir(join(other, "common", "Skate"), { recursive: true });
    await writeManifest(other, 3354750, "Skate");
    const dir = await findSteamAppInstallDir(3354750, [library, other]);
    expect(dir).toBe(join(other, "common", "Skate"));
  });

  it("returns null when no library has the manifest", async () => {
    expect(await findSteamAppInstallDir(3354750, [library])).toBeNull();
  });

  it("ignores a manifest whose installdir escapes the library's common/ folder", async () => {
    const outside = join(sandbox, "elsewhere");
    await mkdir(outside, { recursive: true });
    await writeManifest(library, 3354750, "../../elsewhere");
    expect(await findSteamAppInstallDir(3354750, [library])).toBeNull();
  });

  it("returns null when the manifest's installdir doesn't exist yet", async () => {
    await writeManifest(library, 3354750, "Skate");
    expect(await findSteamAppInstallDir(3354750, [library])).toBeNull();
  });
});

describe("resolveBaseGameDir", () => {
  it("prefers a picked folder that holds the required file", async () => {
    const picked = join(sandbox, "my-skate");
    await mkdir(picked);
    await writeFile(join(picked, "Skate.exe"), "MZ");
    const res = await resolveBaseGameDir(SKATE, picked, [library]);
    expect(res).toEqual({ ok: true, dir: picked, source: "picked" });
  });

  it("rejects a picked folder without the required file, naming the file", async () => {
    const picked = join(sandbox, "wrong");
    await mkdir(picked);
    const res = await resolveBaseGameDir(SKATE, picked, [library]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("Skate.exe");
  });

  it("falls back to the Steam library when nothing was picked", async () => {
    const dir = join(library, "common", "Skate");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "Skate.exe"), "MZ");
    await writeManifest(library, 3354750, "Skate");
    const res = await resolveBaseGameDir(SKATE, undefined, [library]);
    expect(res).toEqual({ ok: true, dir, source: "steam" });
  });

  it("treats a blank picked path like no pick", async () => {
    const dir = join(library, "common", "Skate");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "Skate.exe"), "MZ");
    await writeManifest(library, 3354750, "Skate");
    const res = await resolveBaseGameDir(SKATE, "   ", [library]);
    expect(res.ok).toBe(true);
  });

  it("explains a Steam install that is still downloading", async () => {
    // Manifest + folder exist (Steam creates both at download start)
    // but the game's exe isn't there yet.
    await mkdir(join(library, "common", "Skate"), { recursive: true });
    await writeManifest(library, 3354750, "Skate");
    const res = await resolveBaseGameDir(SKATE, undefined, [library]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/still downloading/);
  });

  it("explains a game that isn't installed through Steam at all", async () => {
    const res = await resolveBaseGameDir(SKATE, undefined, [library]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/isn't installed through Steam/);
  });
});

describe("linkBaseGameInto", () => {
  it("symlinks every top-level entry with absolute targets, keeping the release's own files", async () => {
    const base = join(sandbox, "Skate");
    await mkdir(join(base, "Data"), { recursive: true });
    await writeFile(join(base, "Skate.exe"), "MZ");
    await writeFile(join(base, "LICENSE.txt"), "game license");
    const stage = join(sandbox, "reskate.partial");
    await mkdir(stage);
    await writeFile(join(stage, "ReSkateLauncher.exe"), "MZ");
    await writeFile(join(stage, "LICENSE.txt"), "reskate license");

    const { linked, skipped } = await linkBaseGameInto(stage, base);

    expect(linked.sort()).toEqual(["Data", "Skate.exe"]);
    expect(skipped).toEqual(["LICENSE.txt"]);
    expect(await readlink(join(stage, "Skate.exe"))).toBe(join(base, "Skate.exe"));
    expect((await lstat(join(stage, "Data"))).isSymbolicLink()).toBe(true);
    // The release's own file was not replaced.
    expect(await readFile(join(stage, "LICENSE.txt"), "utf-8")).toBe("reskate license");
  });

  it("does not link names listed in skip (the entry's preservePaths)", async () => {
    const base = join(sandbox, "Skate");
    await mkdir(join(base, "Mods"), { recursive: true });
    await mkdir(join(base, "saves"), { recursive: true });
    await writeFile(join(base, "Skate.exe"), "MZ");
    const stage = join(sandbox, "stage");
    await mkdir(stage);

    const { linked, skipped } = await linkBaseGameInto(stage, base, {
      skip: ["Mods", "saves/profile.dat"],
    });

    expect(linked).toEqual(["Skate.exe"]);
    expect(skipped.sort()).toEqual(["Mods", "saves"]);
    expect(existsSync(join(stage, "Mods"))).toBe(false);
  });

  it("removing the install dir recursively leaves the base game untouched", async () => {
    const base = join(sandbox, "Skate");
    await mkdir(join(base, "Data"), { recursive: true });
    await writeFile(join(base, "Data", "big.cas"), "bytes");
    await writeFile(join(base, "Skate.exe"), "MZ");
    const stage = join(sandbox, "reskate");
    await mkdir(stage);
    await linkBaseGameInto(stage, base);

    // Same call the pipeline's uninstall / re-install promotion makes.
    await rm(stage, { recursive: true, force: true });

    expect(existsSync(stage)).toBe(false);
    expect(existsSync(join(base, "Skate.exe"))).toBe(true);
    expect(existsSync(join(base, "Data", "big.cas"))).toBe(true);
  });

  it("refuses to link when the two directories overlap", async () => {
    const base = join(sandbox, "Skate");
    await mkdir(join(base, "inner"), { recursive: true });
    await expect(linkBaseGameInto(join(base, "inner"), base)).rejects.toThrow(/overlap/);
    await expect(linkBaseGameInto(base, join(base, "inner"))).rejects.toThrow(/overlap/);
  });
});

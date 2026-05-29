import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile, lstat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareStagingDir,
  reclaimStagingParent,
  stagePackFiles,
  clearStagedFiles,
  listStagedFiles,
} from "./steam-injector";

describe("reclaimStagingParent", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "sound-loader-staging-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("does nothing when the parent does not exist yet", async () => {
    const stagingDir = join(workDir, "sounds_custom", "loadout");
    await reclaimStagingParent(stagingDir);
    // Parent should still not exist — the function only removes broken symlinks
    let exists = false;
    try {
      await lstat(join(workDir, "sounds_custom"));
      exists = true;
    } catch { /* ENOENT */ }
    expect(exists).toBe(false);
  });

  it("leaves a real directory at the parent alone", async () => {
    const parent = join(workDir, "sounds_custom");
    const stagingDir = join(parent, "loadout");
    await mkdir(parent);
    await reclaimStagingParent(stagingDir);
    const info = await lstat(parent);
    expect(info.isDirectory()).toBe(true);
    expect(info.isSymbolicLink()).toBe(false);
  });

  it("leaves a symlink to an existing directory alone (Decky still installed)", async () => {
    const target = join(workDir, "decky-real");
    const parent = join(workDir, "sounds_custom");
    const stagingDir = join(parent, "loadout");
    await mkdir(target);
    await symlink(target, parent);
    await reclaimStagingParent(stagingDir);
    const info = await lstat(parent);
    expect(info.isSymbolicLink()).toBe(true);
  });

  it("removes a symlink whose target does not exist (Decky leftover)", async () => {
    const parent = join(workDir, "sounds_custom");
    const stagingDir = join(parent, "loadout");
    await symlink(join(workDir, "does-not-exist"), parent);
    await reclaimStagingParent(stagingDir);
    let still = false;
    try {
      await lstat(parent);
      still = true;
    } catch { /* ENOENT */ }
    expect(still).toBe(false);
  });
});

describe("prepareStagingDir", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "sound-loader-staging-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("creates the full path when nothing exists", async () => {
    const stagingDir = join(workDir, "sounds_custom", "loadout");
    await prepareStagingDir(stagingDir);
    const info = await lstat(stagingDir);
    expect(info.isDirectory()).toBe(true);
  });

  it("succeeds even when sounds_custom is a broken Decky symlink", async () => {
    const parent = join(workDir, "sounds_custom");
    const stagingDir = join(parent, "loadout");
    await symlink(join(workDir, "homebrew", "sounds"), parent);
    await prepareStagingDir(stagingDir);
    const info = await lstat(stagingDir);
    expect(info.isDirectory()).toBe(true);
  });

  it("is idempotent on a clean install", async () => {
    const stagingDir = join(workDir, "sounds_custom", "loadout");
    await prepareStagingDir(stagingDir);
    await prepareStagingDir(stagingDir);
    const info = await lstat(stagingDir);
    expect(info.isDirectory()).toBe(true);
  });
});

// Minimal valid WAV header so cp doesn't choke on empty files.
function minimalWav(): Buffer {
  const buf = Buffer.alloc(46);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(38, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(44100, 24);
  buf.writeUInt32LE(88200, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(2, 40);
  buf.writeInt16LE(0, 44);
  return buf;
}

describe("stagePackFiles", () => {
  let workDir: string;
  let packDir: string;
  let stagingDir: string;

  const DECKY_TO_LOADER = {
    "deck_ui_navigation.wav": "nav",
    "deck_ui_default_activation.wav": "select",
    "deck_ui_misc_10.wav": "nav",
  };

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "sound-loader-stage-"));
    packDir = join(workDir, "pack");
    stagingDir = join(workDir, "sounds_custom", "loadout");
    await mkdir(packDir);
    await writeFile(join(packDir, "nav.wav"), minimalWav());
    await writeFile(join(packDir, "select.wav"), minimalWav());
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("stages pack files and returns canonical Decky-name → loopback URL map", async () => {
    const map = await stagePackFiles(
      {
        manifest: { mappings: { nav: "nav.wav", select: "select.wav" } },
        dir: packDir,
      },
      DECKY_TO_LOADER,
      stagingDir,
    );

    // Both Decky filenames mapping to "nav" share a single staged URL.
    expect(map["deck_ui_navigation.wav"]).toContain("steamloopback.host");
    expect(map["deck_ui_misc_10.wav"]).toBe(map["deck_ui_navigation.wav"]);
    expect(map["deck_ui_default_activation.wav"]).toContain("deck_ui_default_activation.wav");

    const staged = await readdir(stagingDir);
    expect(staged).toContain("deck_ui_default_activation.wav");
  });

  it("recovers from a Decky symlink that points nowhere", async () => {
    const parent = join(workDir, "sounds_custom");
    await symlink(join(workDir, "homebrew", "sounds"), parent);

    const map = await stagePackFiles(
      {
        manifest: { mappings: { select: "select.wav" } },
        dir: packDir,
      },
      DECKY_TO_LOADER,
      stagingDir,
    );

    expect(Object.keys(map).length).toBeGreaterThan(0);
    const info = await lstat(stagingDir);
    expect(info.isDirectory()).toBe(true);
  });

  it("clears stale files from a previous pack before staging", async () => {
    await mkdir(stagingDir, { recursive: true });
    await writeFile(join(stagingDir, "stale.wav"), minimalWav());

    await stagePackFiles(
      {
        manifest: { mappings: { nav: "nav.wav" } },
        dir: packDir,
      },
      DECKY_TO_LOADER,
      stagingDir,
    );

    const staged = await listStagedFiles(stagingDir);
    expect(staged).not.toContain("stale.wav");
  });
});

describe("clearStagedFiles", () => {
  it("does not throw when the staging dir is missing", async () => {
    await clearStagedFiles(join(tmpdir(), `nope-${Date.now()}`));
  });
});

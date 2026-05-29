/**
 * Unit tests for the pure scan helpers in @loadout/game-library.
 *
 * `os.homedir()` ignores `$HOME` on Linux (reads from passwd), so we
 * can't redirect the steam-paths helpers via env vars. We mock the
 * `@loadout/steam-paths` module and let each test point the scan at
 * its own per-test temp tree. The mock is module-local to this file
 * — there's no cross-spec leakage to worry about because our
 * `test:backend` runner is one-process-per-file
 * (`scripts/test-backend.sh`).
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempRoot: string;

mock.module("@loadout/steam-paths", () => ({
  getLibraryPaths: async () => {
    if (!tempRoot) return [];
    return [join(tempRoot, "steamapps")];
  },
  getUserdataDir: () => join(tempRoot, "userdata"),
  getUserIds: async () => {
    if (!tempRoot) return [];
    try {
      const { readdirSync } = await import("node:fs");
      return readdirSync(join(tempRoot, "userdata"), {
        withFileTypes: true,
      })
        .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
        .map((d) => d.name);
    } catch {
      return [];
    }
  },
}));

import { getCollectionsFromGames, scanLibrary } from "./index";
import type { GameInfo } from "@loadout/types";

// --- Binary VDF builder helpers (mirror packages/vdf binary-vdf.test.ts) ---

function strField(key: string, value: string): Uint8Array {
  const k = Buffer.from(key + "\0", "utf-8");
  const v = Buffer.from(value + "\0", "utf-8");
  const buf = Buffer.alloc(1 + k.length + v.length);
  buf[0] = 0x01;
  buf.set(k, 1);
  buf.set(v, 1 + k.length);
  return buf;
}

function int32Field(key: string, value: number): Uint8Array {
  const k = Buffer.from(key + "\0", "utf-8");
  const buf = Buffer.alloc(1 + k.length + 4);
  buf[0] = 0x02;
  buf.set(k, 1);
  // Steam stores appids as uint32, but the binary VDF type byte is
  // generic int32. Use the unsigned writer so callers can pass uint32
  // values with the top bit set; the parser sign-extends and the
  // production reader does `>>> 0` to recover the unsigned form.
  buf.writeUInt32LE(value >>> 0, 1 + k.length);
  return buf;
}

function objectFieldHeader(key: string): Uint8Array {
  const k = Buffer.from(key + "\0", "utf-8");
  const buf = Buffer.alloc(1 + k.length);
  buf[0] = 0x00;
  buf.set(k, 1);
  return buf;
}

const END = Buffer.from([0x08]);

function concat(parts: Uint8Array[]): Buffer {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = Buffer.alloc(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function buildShortcutsVdf(
  shortcuts: Array<{ appid: number; appname: string; tags?: string[] }>,
): Buffer {
  const inner: Uint8Array[] = [];
  shortcuts.forEach((sc, idx) => {
    inner.push(objectFieldHeader(String(idx)));
    inner.push(int32Field("appid", sc.appid));
    inner.push(strField("appname", sc.appname));
    if (sc.tags && sc.tags.length > 0) {
      inner.push(objectFieldHeader("tags"));
      sc.tags.forEach((t, ti) => inner.push(strField(String(ti), t)));
      inner.push(END); // close tags
    }
    inner.push(END); // close this shortcut
  });
  // Top-level: `shortcuts` object containing the entries, then root end.
  return concat([objectFieldHeader("shortcuts"), ...inner, END, END]);
}

function writeAcf(
  appsPath: string,
  appId: string,
  name: string,
  size = 0,
): void {
  mkdirSync(appsPath, { recursive: true });
  const body = `"AppState"\n{\n\t"appid"\t\t"${appId}"\n\t"name"\t\t"${name}"\n\t"SizeOnDisk"\t\t"${size}"\n}\n`;
  writeFileSync(join(appsPath, `appmanifest_${appId}.acf`), body, "utf-8");
}

function writeShortcuts(
  userdataRoot: string,
  userId: string,
  shortcuts: Array<{ appid: number; appname: string; tags?: string[] }>,
): void {
  const cfg = join(userdataRoot, userId, "config");
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, "shortcuts.vdf"), buildShortcutsVdf(shortcuts));
}

function writeLocalConfigWithCollections(
  userdataRoot: string,
  userId: string,
  collections: Record<string, { id: string; added: number[] }>,
): void {
  const cfg = join(userdataRoot, userId, "config");
  mkdirSync(cfg, { recursive: true });
  // Steam serialises user-collections as an escaped JSON string. The
  // surgical regex only needs a `"user-collections" "<escaped>"` pair.
  const escaped = JSON.stringify(collections)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  const body = `"UserLocalConfigStore"\n{\n\t"WebStorage"\n\t{\n\t\t"user-collections"\t\t"${escaped}"\n\t}\n}\n`;
  writeFileSync(join(cfg, "localconfig.vdf"), body, "utf-8");
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "game-library-spec-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = "";
});

describe("scanLibrary", () => {
  test("returns an empty array when no library paths or users exist", async () => {
    const games = await scanLibrary();
    expect(games).toEqual([]);
  });

  test("merges one ACF + one shortcut into the library", async () => {
    writeAcf(join(tempRoot, "steamapps"), "504230", "Celeste", 1234567);
    writeShortcuts(join(tempRoot, "userdata"), "12345", [
      { appid: 2147483649, appname: "Yuzu", tags: ["Emulation"] },
    ]);

    const games = await scanLibrary();

    expect(games).toHaveLength(2);
    const celeste = games.find((g) => g.appId === "504230");
    expect(celeste).toBeDefined();
    expect(celeste?.source).toBe("steam");
    expect(celeste?.sizeOnDisk).toBe(1234567);
    // Steam apps now expose the loader's local route as the canonical
    // header URL so the per-userdata custom-art lookup wins over the
    // public CDN, and freshly-applied SGDB art shows up the next time
    // the grid mounts. The CDN URL is still available as
    // `cdnHeaderUrl` for plugins that explicitly want it.
    expect(celeste?.headerUrl).toContain(
      "/api/steam-grid/504230/12345/header",
    );
    expect(celeste?.capsuleUrl).toContain(
      "/api/steam-grid/504230/12345/capsule",
    );
    expect(celeste?.localHeaderUrl).toContain(
      "/api/steam-grid/504230/12345/header",
    );
    expect(celeste?.cdnHeaderUrl).toContain(
      "cdn.cloudflare.steamstatic.com/steam/apps/504230/header.jpg",
    );
    expect(celeste?.cdnCapsuleUrl).toContain("library_600x900.jpg");

    const shortcut = games.find((g) => g.source === "shortcut");
    expect(shortcut).toBeDefined();
    expect(shortcut?.name).toBe("Yuzu");
    // appid 2147483649 has the top bit set; reader recovers via `>>> 0`.
    expect(shortcut?.appId).toBe(String(2147483649 >>> 0));
    expect(shortcut?.tags).toEqual(["Emulation"]);
    expect(shortcut?.headerUrl).toContain("/api/steam-grid/");
    expect(shortcut?.localHeaderUrl).toEqual(shortcut?.headerUrl);
  });

  test("attaches user-collection tags from localconfig.vdf to matching Steam apps", async () => {
    writeAcf(join(tempRoot, "steamapps"), "504230", "Celeste");
    // Need a shortcuts.vdf so the user-config dir is materialised; an
    // empty payload is fine.
    writeShortcuts(join(tempRoot, "userdata"), "12345", []);
    writeLocalConfigWithCollections(join(tempRoot, "userdata"), "12345", {
      favorite: { id: "favorite", added: [504230] },
    });

    const games = await scanLibrary();
    const celeste = games.find((g) => g.appId === "504230");
    expect(celeste?.tags).toEqual(["favorite"]);
  });

  test("respects a custom loaderOrigin for local-art URLs", async () => {
    writeAcf(join(tempRoot, "steamapps"), "504230", "Celeste");
    writeShortcuts(join(tempRoot, "userdata"), "12345", []);

    const games = await scanLibrary({ loaderOrigin: "http://example:1234" });
    const celeste = games.find((g) => g.appId === "504230");
    expect(celeste?.localHeaderUrl).toBe(
      "http://example:1234/api/steam-grid/504230/12345/header",
    );
  });
});

describe("getCollectionsFromGames", () => {
  function game(appId: string, tags: string[]): GameInfo {
    return {
      appId,
      name: appId,
      sizeOnDisk: 0,
      headerUrl: "",
      capsuleUrl: "",
      localHeaderUrl: "",
      localCapsuleUrl: "",
      source: "steam",
      tags,
    };
  }

  test("returns [] for an empty library", () => {
    expect(getCollectionsFromGames([])).toEqual([]);
  });

  test("counts tag occurrences and sorts most-populated first", () => {
    const out = getCollectionsFromGames([
      game("1", ["fav", "rpg"]),
      game("2", ["fav"]),
      game("3", ["rpg"]),
      game("4", ["fav", "rpg", "indie"]),
    ]);
    expect(out).toEqual([
      { id: "fav", count: 3 },
      { id: "rpg", count: 3 },
      { id: "indie", count: 1 },
    ]);
  });
});

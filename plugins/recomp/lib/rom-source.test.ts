import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sniffRomSourceKind,
  extractXgdIso,
  extractStfs,
  locateDumpFile,
  stageRomSource,
} from "./rom-source";

let sandbox: string;

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "recomp-rom-source-spec-"));
});

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

// ── Synthetic image builders ─────────────────────────────────────────

const SECTOR = 2048;

/** One GDF directory entry: u16 left, u16 right, u32 startSector,
 *  u32 size, u8 attrs, u8 nameLen, name — offsets in 4-byte units. */
function gdfEntry(opts: {
  left: number;
  right: number;
  startSector: number;
  size: number;
  attrs: number;
  name: string;
}): Buffer {
  const name = Buffer.from(opts.name, "latin1");
  const buf = Buffer.alloc(14 + name.length);
  buf.writeUInt16LE(opts.left, 0);
  buf.writeUInt16LE(opts.right, 2);
  buf.writeUInt32LE(opts.startSector, 4);
  buf.writeUInt32LE(opts.size, 8);
  buf[12] = opts.attrs;
  buf[13] = name.length;
  name.copy(buf, 14);
  return buf;
}

/**
 * Minimal XGD image, game-partition base 0:
 *
 *   /DATA/inner.bin  ("abc")
 *   /b.txt           ("hello")
 *
 * Root table (sector 33): entry "b.txt" at offset 0 with its left
 * child "DATA" at byte 32 (= offset unit 8). DATA's table lives at
 * sector 34; file payloads at sectors 40 and 41.
 */
function buildXgdImage(opts?: { evilName?: string }): Buffer {
  // Padded past locateDumpFile's 1 MiB size floor so the synthetic
  // image is treated like a real dump; the tail is unreferenced.
  const img = Buffer.alloc(Math.max(42 * SECTOR, 1024 * 1024 + SECTOR));
  // Volume descriptor at sector 32
  Buffer.from("MICROSOFT*XBOX*MEDIA", "ascii").copy(img, 32 * SECTOR);
  img.writeUInt32LE(33, 32 * SECTOR + 20); // root dir sector
  img.writeUInt32LE(SECTOR, 32 * SECTOR + 24); // root dir size

  // Root directory table
  const rootBase = 33 * SECTOR;
  img.fill(0xff, rootBase, rootBase + SECTOR);
  gdfEntry({
    left: 8, right: 0, startSector: 40, size: 5, attrs: 0,
    name: opts?.evilName ?? "b.txt",
  }).copy(img, rootBase);
  gdfEntry({
    left: 0, right: 0, startSector: 34, size: SECTOR, attrs: 0x10,
    name: "DATA",
  }).copy(img, rootBase + 32);

  // DATA directory table
  const dataBase = 34 * SECTOR;
  img.fill(0xff, dataBase, dataBase + SECTOR);
  gdfEntry({
    left: 0, right: 0, startSector: 41, size: 3, attrs: 0,
    name: "inner.bin",
  }).copy(img, dataBase);

  Buffer.from("hello").copy(img, 40 * SECTOR);
  Buffer.from("abc").copy(img, 41 * SECTOR);
  return img;
}

/** One STFS file-table entry (0x40 bytes). */
function stfsEntry(opts: {
  name: string;
  dir?: boolean;
  blocks?: number;
  startBlock?: number;
  parent: number;
  size?: number;
}): Buffer {
  const buf = Buffer.alloc(0x40);
  const name = Buffer.from(opts.name, "latin1");
  name.copy(buf, 0);
  buf[0x28] = (opts.dir ? 0x80 : 0) | name.length;
  const blocks = opts.blocks ?? 0;
  buf[0x29] = blocks & 0xff;
  buf[0x2a] = (blocks >> 8) & 0xff;
  buf[0x2b] = (blocks >> 16) & 0xff;
  const start = opts.startBlock ?? 0;
  buf[0x2f] = start & 0xff;
  buf[0x30] = (start >> 8) & 0xff;
  buf[0x31] = (start >> 16) & 0xff;
  buf.writeUInt16BE(opts.parent, 0x32);
  buf.writeUInt32BE(opts.size ?? 0, 0x34);
  return buf;
}

/**
 * Minimal LIVE package:
 *
 *   /sub/a.bin      ("abc")
 *   /default.xex    ("hello")
 *
 * File table at 0xC000 (logical block 0). Payload blocks: logical 1
 * (physical 0x0D → offset 0xD000) and logical 2 (0xE000). Single-block
 * files never consult the hash chain.
 *
 * Sets the header-size field at 0x340 to 0xAD0E (matching a real LIVE
 * package) so `stfsTableSizeShift` derives shift 0.
 */
function buildStfsPackage(opts?: { evilName?: string; headerSize?: number }): Buffer {
  // Padded past locateDumpFile's 1 MiB size floor (see buildXgdImage).
  const img = Buffer.alloc(Math.max(0x10000, 1024 * 1024 + 0x1000));
  Buffer.from("LIVE", "ascii").copy(img, 0);
  img.writeUInt32BE(opts?.headerSize ?? 0xad0e, 0x340); // ⇒ table_size_shift 0
  const table = 0xc000;
  stfsEntry({ name: "sub", dir: true, parent: 0xffff }).copy(img, table);
  stfsEntry({
    name: opts?.evilName ?? "default.xex",
    blocks: 1, startBlock: 1, parent: 0xffff, size: 5,
  }).copy(img, table + 0x40);
  stfsEntry({
    name: "a.bin", blocks: 1, startBlock: 2, parent: 0, size: 3,
  }).copy(img, table + 0x80);
  Buffer.from("hello").copy(img, 0xd000);
  Buffer.from("abc").copy(img, 0xe000);
  return img;
}

// ── sniffRomSourceKind ───────────────────────────────────────────────

describe("sniffRomSourceKind", () => {
  it("detects zip / 7z / rar / gzip as archive", async () => {
    const cases: [string, Buffer][] = [
      ["a.zip", Buffer.from("PK\x03\x04rest")],
      ["a.7z", Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 0])],
      ["a.rar", Buffer.from("Rar!\x1a\x07\x00")],
      ["a.tgz", Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0])],
    ];
    for (const [name, bytes] of cases) {
      const p = join(sandbox, `sniff-${name}`);
      await writeFile(p, bytes);
      expect(await sniffRomSourceKind(p)).toBe("archive");
    }
  });

  it("detects STFS package magics", async () => {
    for (const magic of ["LIVE", "PIRS", "CON "]) {
      const p = join(sandbox, `sniff-stfs-${magic.trim()}`);
      await writeFile(p, Buffer.from(`${magic}rest-of-header`));
      expect(await sniffRomSourceKind(p)).toBe("stfs");
    }
  });

  it("detects an XGD image by its volume descriptor", async () => {
    const p = join(sandbox, "sniff-xgd.iso");
    await writeFile(p, buildXgdImage());
    expect(await sniffRomSourceKind(p)).toBe("xgd-iso");
  });

  it("returns unknown for a plain file", async () => {
    const p = join(sandbox, "sniff-unknown.bin");
    await writeFile(p, Buffer.from("just some bytes, nothing special"));
    expect(await sniffRomSourceKind(p)).toBe("unknown");
  });
});

// ── extractXgdIso ────────────────────────────────────────────────────

describe("extractXgdIso", () => {
  it("extracts the directory tree with contents intact", async () => {
    const iso = join(sandbox, "mini.iso");
    await writeFile(iso, buildXgdImage());
    const dest = join(sandbox, "xgd-out");

    const result = await extractXgdIso(iso, dest);

    expect(result.files).toBe(2);
    expect(await readFile(join(dest, "b.txt"), "utf-8")).toBe("hello");
    expect(await readFile(join(dest, "DATA/inner.bin"), "utf-8")).toBe("abc");
  });

  it("reports progress with real totals", async () => {
    const iso = join(sandbox, "mini2.iso");
    await writeFile(iso, buildXgdImage());
    const seen: number[] = [];
    await extractXgdIso(iso, join(sandbox, "xgd-out2"), (p) => {
      seen.push(p.filesTotal);
      expect(p.bytesTotal).toBe(8);
    });
    expect(seen).toEqual([2, 2]);
  });

  it("rejects an image whose entry name escapes the dest dir", async () => {
    const iso = join(sandbox, "evil.iso");
    await writeFile(iso, buildXgdImage({ evilName: "../evil.txt" }));
    const dest = join(sandbox, "xgd-evil-out");
    await expect(extractXgdIso(iso, dest)).rejects.toThrow(
      /escapes the install directory/,
    );
    expect(existsSync(join(sandbox, "evil.txt"))).toBe(false);
  });

  it("rejects a non-XGD file", async () => {
    const p = join(sandbox, "not-an-iso.iso");
    await writeFile(p, Buffer.alloc(1024 * 1024));
    await expect(extractXgdIso(p, join(sandbox, "nope"))).rejects.toThrow(
      /no XDVDFS volume descriptor/,
    );
  });
});

// ── extractStfs ──────────────────────────────────────────────────────

describe("extractStfs", () => {
  it("extracts files with parent-chain paths intact", async () => {
    const pkg = join(sandbox, "mini.stfs");
    await writeFile(pkg, buildStfsPackage());
    const dest = join(sandbox, "stfs-out");

    const result = await extractStfs(pkg, dest);

    expect(result.files).toBe(2);
    expect(await readFile(join(dest, "default.xex"), "utf-8")).toBe("hello");
    expect(await readFile(join(dest, "sub/a.bin"), "utf-8")).toBe("abc");
  });

  it("rejects a package whose entry name escapes the dest dir", async () => {
    const pkg = join(sandbox, "evil.stfs");
    await writeFile(pkg, buildStfsPackage({ evilName: "../evil.xex" }));
    await expect(
      extractStfs(pkg, join(sandbox, "stfs-evil-out")),
    ).rejects.toThrow(/escapes the install directory/);
  });

  it("rejects a non-STFS file", async () => {
    const p = join(sandbox, "not-stfs.bin");
    await writeFile(p, Buffer.from("NOPE-not-a-package"));
    await expect(extractStfs(p, join(sandbox, "nope2"))).rejects.toThrow(
      /not an Xbox 360 STFS package/,
    );
  });
});

// ── locateDumpFile ───────────────────────────────────────────────────

describe("locateDumpFile", () => {
  it("finds a dump nested in subdirectories, ignoring small files", async () => {
    const dir = join(sandbox, "locate");
    await mkdir(join(dir, "nested/deeper"), { recursive: true });
    await writeFile(join(dir, "readme.txt"), "not a dump");
    // Small file with the right magic — must be skipped by the size floor.
    await writeFile(join(dir, "tiny.iso"), Buffer.from("LIVE"));
    await writeFile(join(dir, "nested/deeper/game.iso"), buildXgdImage());

    expect(await locateDumpFile(dir, "xgd-iso")).toBe(
      join(dir, "nested/deeper/game.iso"),
    );
    expect(await locateDumpFile(dir, "stfs")).toBeNull();
  });

  it("prefers the largest candidate when several match", async () => {
    const dir = join(sandbox, "locate-multi");
    await mkdir(dir, { recursive: true });
    const small = buildXgdImage();
    const big = Buffer.concat([buildXgdImage(), Buffer.alloc(SECTOR)]);
    await writeFile(join(dir, "a.iso"), small);
    await writeFile(join(dir, "b.iso"), big);
    expect(await locateDumpFile(dir, "xgd-iso")).toBe(join(dir, "b.iso"));
  });
});

// ── stageRomSource ───────────────────────────────────────────────────

// sha1("hello") — the payload of the synthetic images' anchor files.
const HELLO_SHA1 = "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d";

describe("stageRomSource", () => {
  const baseRomInfo = {
    description: "test",
    validChecksums: [],
    extractionCommand: "",
  };

  it("stages a bare XGD iso into extractTo and validates the anchor", async () => {
    const iso = join(sandbox, "stage.iso");
    await writeFile(iso, buildXgdImage());
    const stageDir = join(sandbox, "stage-install");
    await mkdir(stageDir, { recursive: true });

    const messages: string[] = [];
    const { files, warnings } = await stageRomSource({
      romInfo: {
        ...baseRomInfo,
        sourceFormat: "xgd-iso",
        extractTo: "assets",
        anchorFile: "b.txt",
        anchorChecksums: [HELLO_SHA1],
      },
      romPath: iso,
      stageDir,
      scratchDir: join(sandbox, "stage-scratch"),
      onProgress: (m) => messages.push(m),
    });

    expect(files).toBe(2);
    expect(warnings).toEqual([]);
    expect(
      await readFile(join(stageDir, "assets/b.txt"), "utf-8"),
    ).toBe("hello");
    expect(messages.length).toBeGreaterThan(0);
  });

  it("stages a zip-wrapped dump by locating it inside the archive", async () => {
    // Build a real zip via the system tools the extractor itself uses.
    // Bun.spawn THROWS synchronously when the executable is missing, so
    // a bare try/exit-code guard would error rather than skip on a host
    // without `zip`; gate on Bun.which so the skip is explicit and a
    // non-zero exit for any OTHER reason fails loudly instead of passing
    // vacuously.
    if (!Bun.which("zip")) return;
    const payloadDir = join(sandbox, "zip-payload");
    await mkdir(payloadDir, { recursive: true });
    await writeFile(join(payloadDir, "game.stfs"), buildStfsPackage());
    const zipPath = join(sandbox, "wrapped.zip");
    const proc = Bun.spawn(["zip", "-j", zipPath, join(payloadDir, "game.stfs")], {
      stdout: "ignore", stderr: "ignore",
    });
    expect(await proc.exited).toBe(0);

    const stageDir = join(sandbox, "stage-zip-install");
    await mkdir(stageDir, { recursive: true });
    const { files, warnings } = await stageRomSource({
      romInfo: {
        ...baseRomInfo,
        sourceFormat: "stfs",
        anchorFile: "default.xex",
        anchorChecksums: [HELLO_SHA1],
      },
      romPath: zipPath,
      stageDir,
      scratchDir: join(sandbox, "stage-zip-scratch"),
      onProgress: () => {},
    });

    expect(files).toBe(2);
    expect(warnings).toEqual([]);
    // extractTo defaults to "assets"
    expect(
      await readFile(join(stageDir, "assets/default.xex"), "utf-8"),
    ).toBe("hello");
  });

  it("warns (but succeeds) on an anchor checksum mismatch", async () => {
    const iso = join(sandbox, "stage-warn.iso");
    await writeFile(iso, buildXgdImage());
    const stageDir = join(sandbox, "stage-warn-install");
    await mkdir(stageDir, { recursive: true });

    const { warnings } = await stageRomSource({
      romInfo: {
        ...baseRomInfo,
        sourceFormat: "xgd-iso",
        anchorFile: "b.txt",
        anchorChecksums: ["0000000000000000000000000000000000000000"],
      },
      romPath: iso,
      stageDir,
      scratchDir: join(sandbox, "stage-warn-scratch"),
      onProgress: () => {},
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/doesn't match a known-good dump/);
  });

  it("fails when the anchor file is missing from the dump", async () => {
    const iso = join(sandbox, "stage-noanchor.iso");
    await writeFile(iso, buildXgdImage());
    const stageDir = join(sandbox, "stage-noanchor-install");
    await mkdir(stageDir, { recursive: true });

    await expect(
      stageRomSource({
        romInfo: {
          ...baseRomInfo,
          sourceFormat: "xgd-iso",
          anchorFile: "default.xex",
        },
        romPath: iso,
        stageDir,
        scratchDir: join(sandbox, "stage-noanchor-scratch"),
        onProgress: () => {},
      }),
    ).rejects.toThrow(/default\.xex is missing/);
  });

  it("fails clearly when handed the wrong kind of file", async () => {
    const p = join(sandbox, "stage-wrong.bin");
    await writeFile(p, Buffer.from("some random file"));
    await expect(
      stageRomSource({
        romInfo: { ...baseRomInfo, sourceFormat: "xgd-iso" },
        romPath: p,
        stageDir: join(sandbox, "stage-wrong-install"),
        scratchDir: join(sandbox, "stage-wrong-scratch"),
        onProgress: () => {},
      }),
    ).rejects.toThrow(/not a supported dump/);
  });

  it("confines a hostile extractTo to the stage dir", async () => {
    const iso = join(sandbox, "stage-evil-to.iso");
    await writeFile(iso, buildXgdImage());
    await expect(
      stageRomSource({
        romInfo: {
          ...baseRomInfo,
          sourceFormat: "xgd-iso",
          extractTo: "../../outside",
        },
        romPath: iso,
        stageDir: join(sandbox, "stage-evil-install"),
        scratchDir: join(sandbox, "stage-evil-scratch"),
        onProgress: () => {},
      }),
    ).rejects.toThrow(/escapes the install directory/);
  });
});

// ── Regression: the format-parser hardening (review findings) ────────

describe("GDF walk hardening", () => {
  // Full mini-image whose root table's second entry ("bbb") has a left
  // pointer of 0x01FF — low byte 0xFF. The OLD `data[pos] === 0xff`
  // padding check read that low byte and silently dropped "bbb" and its
  // subtree (finding C1). Build it directly so the regression is exact.
  function imageWith0xFFLeftByte(): Buffer {
    const img = Buffer.alloc(1024 * 1024 + SECTOR);
    Buffer.from("MICROSOFT*XBOX*MEDIA", "ascii").copy(img, 32 * SECTOR);
    img.writeUInt32LE(33, 32 * SECTOR + 20);
    img.writeUInt32LE(SECTOR, 32 * SECTOR + 24);
    const rootBase = 33 * SECTOR;
    img.fill(0xff, rootBase, rootBase + SECTOR);
    // offset 0: "aaa", left → dword offset 8 (byte 32, "bbb"), no right.
    gdfEntry({ left: 8, right: 0xffff, startSector: 40, size: 5, attrs: 0, name: "aaa" })
      .copy(img, rootBase);
    // byte 32: "bbb", left = 0x01FF (low byte 0xFF) → dword offset 511
    // (byte 2044), past the table end → skipped. The old code instead
    // read that 0xFF low byte and dropped "bbb" itself.
    gdfEntry({ left: 0x01ff, right: 0xffff, startSector: 41, size: 3, attrs: 0, name: "bbb" })
      .copy(img, rootBase + 32);
    Buffer.from("hello").copy(img, 40 * SECTOR);
    Buffer.from("abc").copy(img, 41 * SECTOR);
    return img;
  }

  it("does NOT drop an entry whose left-pointer low byte is 0xFF (C1)", async () => {
    const iso = join(sandbox, "gdf-0xff.iso");
    await writeFile(iso, imageWith0xFFLeftByte());
    const dest = join(sandbox, "gdf-0xff-out");
    const r = await extractXgdIso(iso, dest);
    expect(r.files).toBe(2);
    expect(await readFile(join(dest, "aaa"), "utf-8")).toBe("hello");
    expect(await readFile(join(dest, "bbb"), "utf-8")).toBe("abc"); // was dropped
  });

  it("terminates on a directory-tree cycle instead of blowing the stack (S1)", async () => {
    // Root entry whose left points back at itself (offset 0) — a naive
    // recursive walk would loop forever; the visited-set must stop it.
    const img = Buffer.alloc(1024 * 1024 + SECTOR);
    Buffer.from("MICROSOFT*XBOX*MEDIA", "ascii").copy(img, 32 * SECTOR);
    img.writeUInt32LE(33, 32 * SECTOR + 20);
    img.writeUInt32LE(SECTOR, 32 * SECTOR + 24);
    const rootBase = 33 * SECTOR;
    img.fill(0xff, rootBase, rootBase + SECTOR);
    // "self" points left → dword offset 8 (byte 32), which points left
    // back to offset 0 → cycle.
    gdfEntry({ left: 8, right: 0xffff, startSector: 40, size: 5, attrs: 0, name: "self" })
      .copy(img, rootBase);
    gdfEntry({ left: 0, right: 0xffff, startSector: 40, size: 5, attrs: 0, name: "back" })
      .copy(img, rootBase + 32);
    Buffer.from("hello").copy(img, 40 * SECTOR);
    const iso = join(sandbox, "gdf-cycle.iso");
    await writeFile(iso, img);
    // Must return promptly with both distinct entries, not hang/overflow.
    const r = await extractXgdIso(iso, join(sandbox, "gdf-cycle-out"));
    expect(r.files).toBe(2);
  });

  it("reads an entry that lives beyond the first sector of a 2-sector table", async () => {
    const img = Buffer.alloc(1024 * 1024 + 3 * SECTOR);
    Buffer.from("MICROSOFT*XBOX*MEDIA", "ascii").copy(img, 32 * SECTOR);
    img.writeUInt32LE(33, 32 * SECTOR + 20);
    img.writeUInt32LE(2 * SECTOR, 32 * SECTOR + 24); // 2-sector root table
    const rootBase = 33 * SECTOR;
    img.fill(0xff, rootBase, rootBase + 2 * SECTOR);
    // root "first" with left → dword offset 512 (byte 2048 = sector 2).
    gdfEntry({ left: 512, right: 0xffff, startSector: 40, size: 5, attrs: 0, name: "first" })
      .copy(img, rootBase);
    gdfEntry({ left: 0xffff, right: 0xffff, startSector: 41, size: 3, attrs: 0, name: "second" })
      .copy(img, rootBase + 2048);
    Buffer.from("hello").copy(img, 40 * SECTOR);
    Buffer.from("abc").copy(img, 41 * SECTOR);
    const iso = join(sandbox, "gdf-2sector.iso");
    await writeFile(iso, img);
    const dest = join(sandbox, "gdf-2sector-out");
    const r = await extractXgdIso(iso, dest);
    expect(r.files).toBe(2);
    expect(await readFile(join(dest, "second"), "utf-8")).toBe("abc");
  });
});

describe("STFS multi-block + hardening", () => {
  const HELLO2 = "hello".repeat(1000); // 5000 bytes = 2 blocks

  /** LIVE package with one 2-block file whose block chain steps through
   *  the group-0 hash table (exercises stfsNextBlock / hash math that no
   *  single-block fixture reached — finding C9). File logical blocks 1→2;
   *  the next-block pointer for logical 1 lives at hash offset 0xB018+0x15. */
  function buildMultiBlockStfs(): Buffer {
    const img = Buffer.alloc(0x11000);
    Buffer.from("LIVE", "ascii").copy(img, 0);
    img.writeUInt32BE(0xad0e, 0x340); // shift 0
    const table = 0xc000;
    stfsEntry({
      name: "big.bin", blocks: 2, startBlock: 1, parent: 0xffff, size: HELLO2.length,
    }).copy(img, table);
    // Group-0 hash entry for logical block 1: next block = 2 (u24 BE @ +0x15).
    const hashEntry1 = 0x0b * 0x1000 + 1 * 0x18;
    img.writeUIntBE(2, hashEntry1 + 0x15, 3);
    // Payload: logical 1 → physical 0x0D (0xD000), logical 2 → 0x0E (0xE000).
    Buffer.from(HELLO2.slice(0, 0x1000)).copy(img, 0xd000);
    Buffer.from(HELLO2.slice(0x1000)).copy(img, 0xe000);
    return img;
  }

  it("extracts a multi-block file by following the hash-table chain", async () => {
    const pkg = join(sandbox, "stfs-multiblock.stfs");
    await writeFile(pkg, buildMultiBlockStfs());
    const dest = join(sandbox, "stfs-multiblock-out");
    const r = await extractStfs(pkg, dest);
    expect(r.files).toBe(1);
    expect(await readFile(join(dest, "big.bin"), "utf-8")).toBe(HELLO2);
  });

  it("rejects a resigned (shift-1) package instead of extracting corrupt data (C2)", async () => {
    // headerSize 0x9000 ⇒ ((0x9000+0xFFF)&0xF000)>>12 = 0x9 ≠ 0xB ⇒ shift 1.
    const pkg = join(sandbox, "stfs-con.stfs");
    await writeFile(pkg, buildStfsPackage({ headerSize: 0x9000 }));
    await expect(extractStfs(pkg, join(sandbox, "stfs-con-out"))).rejects.toThrow(
      /resigned\/read-write STFS package/,
    );
  });

  it("throws on a cyclic block chain rather than amplifying writes (S3)", async () => {
    // A 2-block file whose logical block 1 chains back to itself, with a
    // size that would otherwise drive many iterations.
    const img = Buffer.alloc(0x11000);
    Buffer.from("LIVE", "ascii").copy(img, 0);
    img.writeUInt32BE(0xad0e, 0x340);
    stfsEntry({
      name: "loop.bin", blocks: 5, startBlock: 1, parent: 0xffff, size: 5 * 0x1000,
    }).copy(img, 0xc000);
    img.writeUIntBE(1, 0x0b * 0x1000 + 1 * 0x18 + 0x15, 3); // logical 1 → 1 (self)
    Buffer.alloc(0x1000, 0x41).copy(img, 0xd000);
    const pkg = join(sandbox, "stfs-cycle.stfs");
    await writeFile(pkg, img);
    await expect(extractStfs(pkg, join(sandbox, "stfs-cycle-out"))).rejects.toThrow(
      /[Cc]yclic block chain/,
    );
  });
});

describe("archive dispatch by magic (C5)", () => {
  it("unwraps a magic-detected archive whose name lacks an extension", async () => {
    if (!Bun.which("zip")) return;
    // A real zip wrapping an STFS package, but named with no recognized
    // archive extension — sniffs as archive, must still extract.
    const payloadDir = join(sandbox, "noext-payload");
    await mkdir(payloadDir, { recursive: true });
    await writeFile(join(payloadDir, "content"), buildStfsPackage());
    const zipReal = join(sandbox, "mkzip.zip");
    expect(
      await Bun.spawn(["zip", "-j", zipReal, join(payloadDir, "content")], {
        stdout: "ignore", stderr: "ignore",
      }).exited,
    ).toBe(0);
    // Rename to an extensionless path — the SOTN "type the path manually"
    // case: the extractor dispatches by extension, so without the
    // magic-derived symlink this would be "unsupported format".
    const noExt = join(sandbox, "downloaded_file");
    await writeFile(noExt, await readFile(zipReal));

    const stageDir = join(sandbox, "noext-install");
    await mkdir(stageDir, { recursive: true });
    const { files } = await stageRomSource({
      romInfo: {
        description: "t", validChecksums: [], extractionCommand: "",
        sourceFormat: "stfs", anchorFile: "default.xex",
      },
      romPath: noExt,
      stageDir,
      scratchDir: join(sandbox, "noext-scratch"),
      onProgress: () => {},
    });
    expect(files).toBe(2);
    expect(existsSync(join(stageDir, "assets/default.xex"))).toBe(true);
  });
});

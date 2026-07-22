/**
 * Game-data staging for recomps whose "ROM" is a disc image or
 * container package rather than a single flat file.
 *
 * The ReXGlue family of Xbox 360 recomps (NocturneRecomp / SVR07 /
 * TiP-Recomp) ships no game data: the engine reads its files from
 * `--game_data_root` (default `assets/` next to the binary) and exits
 * with "game_data_root does not exist" when the folder is missing.
 * Users hold their dump as a 7z/zip/rar wrapping either a raw XGD
 * disc ISO (retail titles) or an STFS/LIVE package (XBLA titles).
 *
 * This module turns the user-picked file into a populated data dir:
 *
 *   picked file ── sniff ──▶ archive? ─ unwrap ─▶ locate dump by magic
 *                     │                                  │
 *                     └── already a dump ────────────────┤
 *                                                        ▼
 *                              format extractor (XGD / STFS) ─▶ extractTo/
 *                                                        │
 *                                        anchor-file validation
 *
 * Everything is magic-byte driven — filenames are hints at best (XBLA
 * content files have no extension at all), so nothing here trusts them.
 *
 * Legal boundary (deliberate): this only ever restructures a dump the
 * user already owns, locally. Both XGD and STFS are plain unencrypted
 * filesystems — no keys, no DRM circumvention, no downloads.
 */
import { open, mkdir, readdir, stat, rm, symlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join, basename, resolve } from "node:path";
import { resolveWithinDir } from "./path-confine";
import { extractArchive } from "./pipeline-archive";
import type { RomInfo } from "./types";

// ── Format detection ─────────────────────────────────────────────────

export type RomSourceKind =
  | "archive"   // zip / 7z / rar / tar(.gz) — unwrap first
  | "xgd-iso"   // Xbox / Xbox 360 disc image (XDVDFS a.k.a. GDF)
  | "stfs"      // Xbox 360 STFS package (LIVE / PIRS / CON)
  | "unknown";

const SECTOR = 2048;
const XGD_MAGIC = Buffer.from("MICROSOFT*XBOX*MEDIA", "ascii");
/** Game-partition base offsets to probe: a game-partition-only rip,
 *  XGD3, XGD2, XGD1 — in that order. The volume descriptor lives at
 *  sector 32 of the partition. */
const XGD_BASES = [0x0, 0x2080000, 0xfd90000, 0x18300000] as const;

async function readAt(
  fh: FileHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  return bytesRead === length ? buf : buf.subarray(0, bytesRead);
}

/** Find the XGD game-partition base offset, or null if `fh` isn't an
 *  Xbox disc image. */
async function findXgdBase(fh: FileHandle): Promise<number | null> {
  for (const base of XGD_BASES) {
    const magic = await readAt(fh, base + 32 * SECTOR, XGD_MAGIC.length);
    if (magic.equals(XGD_MAGIC)) return base;
  }
  return null;
}

/**
 * Classify a file by magic bytes. `archive` covers every wrapper
 * format `extractArchive` can unpack; the two dump formats are the
 * ones `stageRomSource` knows how to restructure.
 */
export async function sniffRomSourceKind(path: string): Promise<RomSourceKind> {
  const fh = await open(path, "r");
  try {
    const head = await readAt(fh, 0, 8);
    if (head.length >= 4) {
      const ascii4 = head.subarray(0, 4).toString("latin1");
      // zip: "PK" followed by a real record signature — \x03\x04 (local
      // file), \x05\x06 (empty archive end-of-central-dir), or \x07\x08
      // (spanned). Checking the third/fourth bytes avoids misrouting an
      // arbitrary file that merely starts with the letters "PK".
      if (
        head[0] === 0x50 && head[1] === 0x4b &&
        ((head[2] === 0x03 && head[3] === 0x04) ||
          (head[2] === 0x05 && head[3] === 0x06) ||
          (head[2] === 0x07 && head[3] === 0x08))
      ) {
        return "archive";
      }
      if (head.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) {
        return "archive"; // 7z
      }
      if (ascii4 === "Rar!") return "archive";
      if (head[0] === 0x1f && head[1] === 0x8b) return "archive"; // gzip
      if (ascii4 === "LIVE" || ascii4 === "PIRS" || ascii4 === "CON ") {
        return "stfs";
      }
    }
    if ((await findXgdBase(fh)) != null) return "xgd-iso";
    // Plain tar has its magic at offset 257 ("ustar").
    const tarMagic = await readAt(fh, 257, 5);
    if (tarMagic.toString("latin1") === "ustar") return "archive";
    return "unknown";
  } finally {
    await fh.close();
  }
}

/** Archive extensions `extractArchive` (lib/pipeline-archive.ts)
 *  dispatches on. Kept in sync with that module. */
const EXTRACTABLE_EXTENSIONS = [
  ".zip", ".tar.gz", ".tgz", ".tar", ".rar", ".7z", ".appimage",
] as const;

/** Map a file's magic bytes to the archive extension `extractArchive`
 *  needs, or null if it isn't an archive we can unpack. */
async function archiveExtensionByMagic(path: string): Promise<string | null> {
  const fh = await open(path, "r");
  try {
    const head = await readAt(fh, 0, 8);
    if (head.length >= 4) {
      if (head[0] === 0x50 && head[1] === 0x4b) return ".zip";
      if (head.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) {
        return ".7z";
      }
      if (head.subarray(0, 4).toString("latin1") === "Rar!") return ".rar";
      if (head[0] === 0x1f && head[1] === 0x8b) return ".tar.gz";
    }
    const tarMagic = await readAt(fh, 257, 5);
    if (tarMagic.toString("latin1") === "ustar") return ".tar";
    return null;
  } finally {
    await fh.close();
  }
}

/**
 * Return a path `extractArchive` will accept for `archivePath`. If its
 * real name already ends in an extractable extension, use it as-is;
 * otherwise create a symlink named `<scratch>/rom-source-input<ext>`
 * with a magic-derived extension so the extension-dispatching extractor
 * picks the right unpacker. Symlink (not copy) keeps this O(1) for a
 * multi-GB archive.
 */
async function archivePathForExtraction(
  archivePath: string,
  scratchDir: string,
): Promise<string> {
  const lower = basename(archivePath).toLowerCase();
  if (EXTRACTABLE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return archivePath;
  }
  const ext = await archiveExtensionByMagic(archivePath);
  if (!ext) return archivePath; // let extractArchive throw its own error
  await mkdir(scratchDir, { recursive: true });
  const linkPath = join(scratchDir, `rom-source-input${ext}`);
  try {
    await rm(linkPath, { force: true });
    await symlink(resolve(archivePath), linkPath);
    return linkPath;
  } catch {
    return archivePath; // symlink unsupported → fall back to real path
  }
}

// ── XGD / XDVDFS (GDF) extraction ────────────────────────────────────

interface GdfEntry {
  name: string;
  attrs: number;
  startSector: number;
  size: number;
}

const GDF_ATTR_DIR = 0x10;
/** No-child sentinels for a subtree pointer: 0xFFFF is the XDVDFS
 *  sentinel; 0 doubles as "none" everywhere except the table root
 *  (which lives at offset 0). */
const GDF_NO_CHILD = new Set([0, 0xffff]);
/** Hard ceiling on entries in a single directory table. Real tables
 *  hold at most a few thousand; this only bounds a crafted table. */
const GDF_MAX_ENTRIES_PER_TABLE = 1 << 20;

/**
 * Collect one directory table's entries by walking its binary tree.
 * Entries are `u16 left, u16 right, u32 startSector, u32 size,
 * u8 attrs, u8 nameLen, name`, with left/right in 4-byte units from
 * the table start.
 *
 * Iterative with an explicit stack + a visited-offset set: a crafted
 * table can point two parents at the same child (a DAG) or form a
 * cycle, which a naive recursive walk would follow into 2^depth calls
 * — a synchronous CPU/heap bomb in the root backend. Visiting each
 * offset once makes the walk O(table size) and also lets a legitimate
 * but deeply-unbalanced tree extract without a depth-limit false
 * positive.
 *
 * Padding detection: the walk only ever LANDS on a real entry, because
 * every child pointer is filtered through `GDF_NO_CHILD` before being
 * pushed — so a pointer never targets the 0xFF fill between/after
 * entries. The one exception is the root of an empty directory, whose
 * whole slot is 0xFF fill (nameLen 0xFF, size 0xFFFFFFFF); that is
 * skipped explicitly. (The previous `data[pos] === 0xff` check was
 * wrong: `data[pos]` is the low byte of the entry's own `left`
 * pointer, so any real entry whose left child sat at an offset ending
 * in 0xFF — e.g. 0x02FF — was silently dropped along with both its
 * subtrees.)
 */
function walkGdfTable(data: Buffer, entries: GdfEntry[]): void {
  const visited = new Set<number>();
  const stack: number[] = [0]; // root entry sits at table offset 0
  while (stack.length > 0) {
    const offset = stack.pop()!;
    if (visited.has(offset)) continue;
    visited.add(offset);
    if (visited.size > GDF_MAX_ENTRIES_PER_TABLE) {
      throw new Error("XGD directory table has too many entries (corrupt image?)");
    }
    const pos = offset * 4;
    if (pos + 14 > data.length) continue;
    const left = data.readUInt16LE(pos);
    const right = data.readUInt16LE(pos + 2);
    const startSector = data.readUInt32LE(pos + 4);
    const size = data.readUInt32LE(pos + 8);
    const attrs = data[pos + 12]!;
    const nameLen = data[pos + 13]!;
    // 0xFF fill (empty-table root, or a malformed slot the walk should
    // never reach): a padding slot has nameLen 0xFF and size 0xFFFFFFFF.
    // A zero-length name is never a valid entry either.
    const isPadding = nameLen === 0 || (nameLen === 0xff && size === 0xffffffff);
    if (!isPadding) {
      const name = data.subarray(pos + 14, pos + 14 + nameLen).toString("latin1");
      if (name.length > 0) entries.push({ name, attrs, startSector, size });
    }
    if (!GDF_NO_CHILD.has(left)) stack.push(left);
    if (!GDF_NO_CHILD.has(right)) stack.push(right);
  }
}

async function readGdfDirTable(
  fh: FileHandle,
  base: number,
  sector: number,
  size: number,
): Promise<GdfEntry[]> {
  if (size === 0 || size > 64 * 1024 * 1024) return [];
  const data = await readAt(fh, base + sector * SECTOR, size);
  const entries: GdfEntry[] = [];
  walkGdfTable(data, entries);
  return entries;
}

/**
 * Global budget threaded through a whole disc/package extraction to
 * bound total work regardless of how a crafted image inflates it
 * (directory cycles, thousands of entries pointing at the same extent).
 * Ceilings are far above any real dump: an XGD3 dual-layer disc is
 * ~7.9 GB / a few thousand files.
 */
interface ExtractBudget {
  files: number;
  bytes: number;
}
const MAX_TOTAL_FILES = 200_000;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024 * 1024; // 24 GiB

function chargeFile(budget: ExtractBudget, size: number, label: string): void {
  budget.files += 1;
  budget.bytes += size;
  if (budget.files > MAX_TOTAL_FILES) {
    throw new Error(`${label}: image declares too many files (corrupt or hostile?).`);
  }
  if (budget.bytes > MAX_TOTAL_BYTES) {
    throw new Error(`${label}: image declares more data than any real disc (corrupt or hostile?).`);
  }
}

export interface ExtractProgress {
  /** Files written so far / total (listing pass runs first). */
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  currentFile: string;
}

interface GdfFileRef {
  /** Path relative to the image root, "/"-joined. */
  relPath: string;
  startSector: number;
  size: number;
}

/** Recursively list every file in the image (cheap — directory tables
 *  only). Separated from extraction so progress can show real totals.
 *
 *  `visitedDirs` (keyed by directory start sector) breaks cycles a
 *  crafted image can form between directory tables — without it, a
 *  dir whose entry points back at an ancestor sector recurses until
 *  the depth cap, re-reading tables the whole way. `budget` bounds the
 *  total file count so a table of thousands of entries all pointing at
 *  the same subdirectory can't inflate `out` without limit. */
async function listGdfFiles(
  fh: FileHandle,
  base: number,
  sector: number,
  size: number,
  prefix: string,
  out: GdfFileRef[],
  budget: ExtractBudget,
  visitedDirs: Set<number>,
  depth = 0,
): Promise<void> {
  if (depth > 64) throw new Error("XGD directory nesting too deep (corrupt image?)");
  if (visitedDirs.has(sector)) return; // cycle between directory tables
  visitedDirs.add(sector);
  const entries = await readGdfDirTable(fh, base, sector, size);
  for (const e of entries) {
    const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
    if (e.attrs & GDF_ATTR_DIR) {
      await listGdfFiles(fh, base, e.startSector, e.size, rel, out, budget, visitedDirs, depth + 1);
    } else {
      chargeFile(budget, e.size, "XGD image");
      out.push({ relPath: rel, startSector: e.startSector, size: e.size });
    }
  }
}

const COPY_CHUNK = 4 * 1024 * 1024;

async function copyOut(
  fh: FileHandle,
  position: number,
  size: number,
  destPath: string,
): Promise<void> {
  const out = await open(destPath, "w");
  try {
    let remaining = size;
    let pos = position;
    const buf = Buffer.alloc(Math.min(COPY_CHUNK, Math.max(size, 1)));
    while (remaining > 0) {
      const want = Math.min(buf.length, remaining);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (bytesRead <= 0) {
        throw new Error(`Truncated image while reading ${basename(destPath)}`);
      }
      await out.write(buf, 0, bytesRead);
      remaining -= bytesRead;
      pos += bytesRead;
    }
  } finally {
    await out.close();
  }
}

/**
 * Extract every file of an XGD disc image's game partition into
 * `destDir`, preserving the directory tree. Each destination path is
 * confined to `destDir` — entry names come from the image and are not
 * trusted.
 */
export async function extractXgdIso(
  isoPath: string,
  destDir: string,
  onProgress?: (p: ExtractProgress) => void,
): Promise<{ files: number; bytes: number }> {
  const fh = await open(isoPath, "r");
  try {
    const base = await findXgdBase(fh);
    if (base == null) {
      throw new Error(
        `${basename(isoPath)} has no XDVDFS volume descriptor — not an Xbox disc image.`,
      );
    }
    const desc = await readAt(fh, base + 32 * SECTOR + XGD_MAGIC.length, 8);
    const rootSector = desc.readUInt32LE(0);
    const rootSize = desc.readUInt32LE(4);

    const files: GdfFileRef[] = [];
    await listGdfFiles(
      fh, base, rootSector, rootSize, "", files,
      { files: 0, bytes: 0 }, new Set<number>(),
    );
    if (files.length === 0) {
      throw new Error(`${basename(isoPath)}: image contains no files.`);
    }
    const bytesTotal = files.reduce((acc, f) => acc + f.size, 0);

    await mkdir(destDir, { recursive: true });
    let filesDone = 0;
    let bytesDone = 0;
    for (const f of files) {
      const dest = resolveWithinDir(destDir, f.relPath, "XGD image entry");
      await mkdir(join(dest, ".."), { recursive: true });
      await copyOut(fh, base + f.startSector * SECTOR, f.size, dest);
      filesDone += 1;
      bytesDone += f.size;
      onProgress?.({
        filesDone, filesTotal: files.length,
        bytesDone, bytesTotal, currentFile: f.relPath,
      });
    }
    return { files: filesDone, bytes: bytesDone };
  } finally {
    await fh.close();
  }
}

// ── STFS (LIVE / PIRS / CON) extraction ──────────────────────────────
//
// Narrow-but-sufficient reader for the fixed STFS layout XBLA releases
// use (single file table at 0xC000, 0x1000-byte blocks, one hash table
// per 0xAA-block group). Mirrors the extraction script NocturneRecomp
// bundles, which this replaces so the root backend never has to spawn
// an interpreter from inside a downloaded release.

const STFS_BLOCK = 0x1000;
const STFS_FILE_TABLE_OFFSET = 0xc000;
const STFS_ENTRY_SIZE = 0x40;
const STFS_ROOT_PARENT = 0xffff;
const STFS_END_OF_CHAIN = 0xffffff;
const STFS_ATTR_DIR = 0x80;

interface StfsEntry {
  index: number;
  name: string;
  flags: number;
  blocks: number;
  startBlock: number;
  parent: number;
  size: number;
}

/**
 * STFS packages come in two hash-table layouts: "read-only" (one hash
 * block per 0xAA-block group — `table_size_shift = 0`) and
 * "read-write"/resigned (doubled hash blocks — shift 1). Marketplace
 * XBLA content (what these catalog entries target) is LIVE-signed and
 * always shift 0; the block-mapping math below is derived and verified
 * for shift 0 only. We read the header-size field and, rather than
 * silently mis-map a shift-1 package into corrupt output (the previous
 * behavior — the only symptom was a *non-fatal* checksum warning),
 * reject it with an actionable message. `extractStfs` calls this and
 * throws on a non-zero shift.
 *
 * Formula matches py360 / Velocity: `((headerSize + 0xFFF) & 0xF000)
 * >> 12 == 0xB` ⇒ shift 0, else shift 1. (Verified: SOTN's real LIVE
 * package has headerSize 0xAD0E ⇒ 0xB ⇒ shift 0.)
 */
async function stfsTableSizeShift(fh: FileHandle): Promise<number> {
  const headerSize = (await readAt(fh, 0x340, 4)).readUInt32BE(0);
  return ((headerSize + 0xfff) & 0xf000) >> 12 === 0xb ? 0 : 1;
}

function stfsPhysicalBlock(logicalBlock: number): number {
  const group = Math.floor(logicalBlock / 0xaa);
  const level1Groups = Math.floor(group / 0xaa);
  const level1Overhead = level1Groups > 0 ? level1Groups + 1 : 0;
  return (
    logicalBlock + 0x0c + group + (group > 0 ? 1 : 0) + level1Overhead
  );
}

function stfsHashEntryOffset(logicalBlock: number): number {
  const group = Math.floor(logicalBlock / 0xaa);
  const index = logicalBlock % 0xaa;
  const level1Groups = Math.floor(group / 0xaa);
  const level1Overhead = level1Groups > 0 ? level1Groups + 1 : 0;
  const tableBlock =
    0x0b + group * 0xab + (group > 0 ? 1 : 0) + level1Overhead;
  return tableBlock * STFS_BLOCK + index * 0x18;
}

async function stfsNextBlock(
  fh: FileHandle,
  logicalBlock: number,
): Promise<number> {
  const raw = await readAt(fh, stfsHashEntryOffset(logicalBlock) + 0x15, 3);
  if (raw.length < 3) throw new Error("Truncated STFS package (hash table)");
  return (raw[0]! << 16) | (raw[1]! << 8) | raw[2]!;
}

/** File-table length in entries, from the STFS volume descriptor's
 *  block count (u16 LE at 0x37C). Bounds the linear scan below so a
 *  table that exactly fills its block(s) — no zero terminator — can't
 *  run on into the following data block and parse content as entries.
 *  Falls back to a generous cap if the field is missing/absurd. */
async function stfsFileTableEntryCap(fh: FileHandle): Promise<number> {
  const blockCount = (await readAt(fh, 0x37c, 2)).readUInt16LE(0);
  const entriesPerBlock = STFS_BLOCK / STFS_ENTRY_SIZE; // 64
  const cap = blockCount * entriesPerBlock;
  return cap > 0 && cap <= 1_000_000 ? cap : 1_000_000;
}

async function stfsParseEntries(
  fh: FileHandle,
  maxEntries: number,
): Promise<StfsEntry[]> {
  const entries: StfsEntry[] = [];
  let offset = STFS_FILE_TABLE_OFFSET;
  for (let index = 0; index < maxEntries; index++, offset += STFS_ENTRY_SIZE) {
    const raw = await readAt(fh, offset, STFS_ENTRY_SIZE);
    if (raw.length !== STFS_ENTRY_SIZE || raw.every((b) => b === 0)) break;
    const nameFlags = raw[0x28]!;
    // Name length is the low 6 bits (max 63), but the name field is
    // only 0x28 (40) bytes — clamp so a corrupt length can't read the
    // blocks/startBlock fields into the filename.
    const nameLen = Math.min(nameFlags & 0x3f, 0x28);
    if (nameLen === 0) break;
    entries.push({
      index,
      name: raw.subarray(0, nameLen).toString("latin1"),
      flags: nameFlags,
      blocks: raw[0x29]! | (raw[0x2a]! << 8) | (raw[0x2b]! << 16),
      startBlock: raw[0x2f]! | (raw[0x30]! << 8) | (raw[0x31]! << 16),
      parent: raw.readUInt16BE(0x32),
      size: raw.readUInt32BE(0x34),
    });
  }
  return entries;
}

/** Rebuild an entry's path from its parent chain ("/"-joined, root-relative). */
function stfsEntryPath(entry: StfsEntry, entries: StfsEntry[]): string {
  const parts = [entry.name];
  const seen = new Set([entry.index]);
  let parent = entry.parent;
  while (parent !== STFS_ROOT_PARENT) {
    const p = entries[parent];
    if (!p || seen.has(parent)) {
      throw new Error(`Invalid STFS parent chain for ${entry.name}`);
    }
    parts.push(p.name);
    seen.add(parent);
    parent = p.parent;
  }
  return parts.reverse().join("/");
}

/**
 * Extract every file of an STFS package into `destDir`. Destination
 * paths are confined to `destDir` — entry names are untrusted.
 */
export async function extractStfs(
  pkgPath: string,
  destDir: string,
  onProgress?: (p: ExtractProgress) => void,
): Promise<{ files: number; bytes: number }> {
  const fh = await open(pkgPath, "r");
  try {
    const magic = (await readAt(fh, 0, 4)).toString("latin1");
    if (magic !== "LIVE" && magic !== "PIRS" && magic !== "CON ") {
      throw new Error(
        `${basename(pkgPath)} is not an Xbox 360 STFS package (LIVE/PIRS/CON).`,
      );
    }
    // Only the shift-0 (read-only, LIVE-signed marketplace) layout is
    // supported; a resigned/read-write package has doubled hash tables
    // that this mapping would mis-read into corrupt output. Reject it
    // loudly rather than ship garbage assets.
    const shift = await stfsTableSizeShift(fh);
    if (shift !== 0) {
      throw new Error(
        `${basename(pkgPath)} is a resigned/read-write STFS package (doubled hash tables), ` +
          `which isn't supported. Provide the original LIVE-signed XBLA content file.`,
      );
    }
    const entries = await stfsParseEntries(fh, await stfsFileTableEntryCap(fh));
    const files = entries.filter((e) => (e.flags & STFS_ATTR_DIR) === 0);
    if (files.length === 0) {
      throw new Error(`${basename(pkgPath)}: package contains no files.`);
    }
    const bytesTotal = files.reduce((acc, f) => acc + f.size, 0);

    await mkdir(destDir, { recursive: true });
    const budget: ExtractBudget = { files: 0, bytes: 0 };
    let filesDone = 0;
    let bytesDone = 0;
    for (const entry of files) {
      chargeFile(budget, entry.size, "STFS package");
      const relPath = stfsEntryPath(entry, entries);
      const dest = resolveWithinDir(destDir, relPath, "STFS package entry");
      await mkdir(join(dest, ".."), { recursive: true });

      const out = await open(dest, "w");
      try {
        let remaining = entry.size;
        let logicalBlock = entry.startBlock;
        const blocksToCopy = Math.max(
          entry.blocks,
          Math.ceil(entry.size / STFS_BLOCK),
        );
        // Track visited blocks: a crafted block chain can form a cycle
        // (A→B→A) that never reaches END_OF_CHAIN, which — combined with
        // a large declared size — would otherwise re-read two blocks for
        // millions of iterations, amplifying a tiny package into a
        // disk-filling write.
        const visitedBlocks = new Set<number>();
        for (let i = 0; i < blocksToCopy && remaining > 0; i++) {
          if (logicalBlock === STFS_END_OF_CHAIN) {
            throw new Error(
              `Unexpected end of block chain extracting ${entry.name}`,
            );
          }
          if (visitedBlocks.has(logicalBlock)) {
            throw new Error(`Cyclic block chain extracting ${entry.name} (corrupt package?)`);
          }
          visitedBlocks.add(logicalBlock);
          const want = Math.min(STFS_BLOCK, remaining);
          const chunk = await readAt(
            fh,
            stfsPhysicalBlock(logicalBlock) * STFS_BLOCK,
            want,
          );
          // A short (but non-empty) read means the package is truncated
          // mid-block: writing it and advancing the chain would splice
          // wrong bytes into the file. Fail instead.
          if (chunk.length < want) {
            throw new Error(`Truncated STFS package extracting ${entry.name}`);
          }
          await out.write(chunk);
          remaining -= chunk.length;
          if (i + 1 < blocksToCopy) {
            logicalBlock = await stfsNextBlock(fh, logicalBlock);
          }
        }
      } finally {
        await out.close();
      }
      filesDone += 1;
      bytesDone += entry.size;
      onProgress?.({
        filesDone, filesTotal: files.length,
        bytesDone, bytesTotal, currentFile: relPath,
      });
    }
    return { files: filesDone, bytes: bytesDone };
  } finally {
    await fh.close();
  }
}

// ── Locate the dump inside an unwrapped archive ──────────────────────

/**
 * Walk `dir` looking for files matching `format` by magic. Multiple
 * candidates resolve to the largest (a real dump always dwarfs any
 * readme/artwork siblings). Returns null when nothing matches.
 */
export async function locateDumpFile(
  dir: string,
  format: "xgd-iso" | "stfs",
): Promise<string | null> {
  const candidates: { path: string; size: number }[] = [];
  const visit = async (d: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        await visit(full, depth + 1);
      } else if (e.isFile()) {
        // Every plausible dump is at least 1 MiB; skip the tiny stuff
        // before paying for a magic sniff.
        const info = await stat(full);
        if (info.size < 1024 * 1024) continue;
        if ((await sniffRomSourceKind(full)) === format) {
          candidates.push({ path: full, size: info.size });
        }
      }
    }
  };
  await visit(dir, 0);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.size - a.size);
  return candidates[0]!.path;
}

// ── Anchor validation ────────────────────────────────────────────────

async function sha1File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha1");
  const stream = Bun.file(path).stream();
  for await (const chunk of stream) hasher.update(chunk);
  return hasher.digest("hex").toLowerCase();
}

// ── Orchestrator ─────────────────────────────────────────────────────

export interface StageRomSourceOptions {
  romInfo: RomInfo;
  /** The user-picked file (archive or bare dump). */
  romPath: string;
  /** The staged install dir (`${installDir}.partial` during install). */
  stageDir: string;
  /** Scratch dir for the archive unwrap; caller owns cleanup (the
   *  install pipeline's tmpGameDir teardown covers it). */
  scratchDir: string;
  onProgress: (message: string, percent?: number) => void;
}

/**
 * Populate `stageDir/{extractTo}` from the user's dump, per the
 * catalog's `romInfo.sourceFormat`. Returns the list of non-fatal
 * warnings (anchor-checksum mismatch etc.) for the caller to surface.
 *
 * Throws on: unrecognizable input, an archive with no dump inside,
 * a dump missing the declared `anchorFile`.
 */
export async function stageRomSource(
  opts: StageRomSourceOptions,
): Promise<{ files: number; warnings: string[] }> {
  const { romInfo, romPath, stageDir, scratchDir, onProgress } = opts;
  const format = romInfo.sourceFormat;
  if (format !== "xgd-iso" && format !== "stfs") {
    throw new Error(`stageRomSource called for sourceFormat=${format}`);
  }

  // 1. What did the user actually hand us?
  let dumpPath = romPath;
  const kind = await sniffRomSourceKind(romPath);
  if (kind === "archive") {
    onProgress(`Unpacking ${basename(romPath)}…`);
    const unwrapDir = join(scratchDir, "rom-source");
    await mkdir(unwrapDir, { recursive: true });
    // `extractArchive` dispatches by file EXTENSION, but we detected the
    // archive by MAGIC — so a correctly-identified archive with a wrong
    // or absent extension (the SOTN entry warns users their file may be
    // extensionless) would be rejected as "unsupported format". Present
    // it to the extractor under a magic-derived extension via a symlink
    // (no multi-GB copy) when the real name wouldn't dispatch.
    const archiveInput = await archivePathForExtraction(romPath, scratchDir);
    await extractArchive(archiveInput, unwrapDir);
    const located = await locateDumpFile(unwrapDir, format);
    if (!located) {
      throw new Error(
        `${basename(romPath)} does not contain a ${format === "stfs" ? "Xbox 360 XBLA package" : "Xbox disc image"}. ` +
          `Check that you picked the right archive.`,
      );
    }
    dumpPath = located;
  } else if (kind !== format) {
    throw new Error(
      `${basename(romPath)} is not a supported dump for this game ` +
        `(expected ${format === "stfs" ? "an XBLA STFS package" : "an Xbox disc image"} or an archive containing one).`,
    );
  }

  // 2. Extract into the (confined) data dir.
  const destDir = resolveWithinDir(
    stageDir,
    romInfo.extractTo ?? "assets",
    "romInfo.extractTo",
  );
  const report = (p: ExtractProgress) => {
    const pct = p.bytesTotal > 0 ? (p.bytesDone / p.bytesTotal) * 100 : 0;
    onProgress(
      `Extracting game data ${p.filesDone}/${p.filesTotal} files…`,
      pct,
    );
  };
  const result =
    format === "xgd-iso"
      ? await extractXgdIso(dumpPath, destDir, report)
      : await extractStfs(dumpPath, destDir, report);

  // 3. Anchor validation: presence is fatal (the port cannot boot
  //    without it), checksum mismatch is a warning (other-region dumps
  //    frequently work; upstream docs mostly say "untested", not "no").
  const warnings: string[] = [];
  if (romInfo.anchorFile) {
    const anchorPath = resolveWithinDir(
      destDir,
      romInfo.anchorFile,
      "romInfo.anchorFile",
    );
    let anchorOk = false;
    try {
      anchorOk = (await stat(anchorPath)).isFile();
    } catch {
      anchorOk = false;
    }
    if (!anchorOk) {
      throw new Error(
        `The dump extracted, but ${romInfo.anchorFile} is missing — this doesn't look ` +
          `like the right game. Nothing was installed from it.`,
      );
    }
    const expected = (romInfo.anchorChecksums ?? []).map((c) =>
      c.trim().toLowerCase(),
    );
    if (expected.length > 0) {
      const got = await sha1File(anchorPath);
      if (!expected.includes(got)) {
        warnings.push(
          `${romInfo.anchorFile} doesn't match a known-good dump (sha1 ${got}). ` +
            `Probably a different region/revision — the game may still work.`,
        );
      }
    }
  }

  return { files: result.files, warnings };
}

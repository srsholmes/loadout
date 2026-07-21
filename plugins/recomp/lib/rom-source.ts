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
import { open, mkdir, readdir, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join, basename } from "node:path";
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
      // zip (incl. empty/spanned variants) — "PK" + 03/05/07
      if (ascii4.startsWith("PK")) return "archive";
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

// ── XGD / XDVDFS (GDF) extraction ────────────────────────────────────

interface GdfEntry {
  name: string;
  attrs: number;
  startSector: number;
  size: number;
}

const GDF_ATTR_DIR = 0x10;
/** Padding / no-child sentinels in the directory entry tree. */
const GDF_NO_CHILD = new Set([0, 0xffff]);

/**
 * In-order walk of one directory table's entry tree. Entries are
 * `u16 left, u16 right, u32 startSector, u32 size, u8 attrs,
 * u8 nameLen, name` with left/right in 4-byte units from the table
 * start. `atRoot` unrolls the offset-0 root entry, since offset 0
 * doubles as the "no child" sentinel everywhere else.
 */
function walkGdfTable(
  data: Buffer,
  offset: number,
  entries: GdfEntry[],
  atRoot = false,
  depth = 0,
): void {
  if (depth > 64) throw new Error("XGD directory tree too deep (corrupt image?)");
  if (!atRoot && GDF_NO_CHILD.has(offset)) return;
  const pos = offset * 4;
  if (pos + 14 > data.length || data[pos] === 0xff) return;
  const left = data.readUInt16LE(pos);
  const right = data.readUInt16LE(pos + 2);
  const startSector = data.readUInt32LE(pos + 4);
  const size = data.readUInt32LE(pos + 8);
  const attrs = data[pos + 12]!;
  const nameLen = data[pos + 13]!;
  const name = data
    .subarray(pos + 14, pos + 14 + nameLen)
    .toString("latin1");
  walkGdfTable(data, left, entries, false, depth + 1);
  if (name.length > 0) entries.push({ name, attrs, startSector, size });
  walkGdfTable(data, right, entries, false, depth + 1);
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
  walkGdfTable(data, 0, entries, true);
  return entries;
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
 *  only). Separated from extraction so progress can show real totals. */
async function listGdfFiles(
  fh: FileHandle,
  base: number,
  sector: number,
  size: number,
  prefix: string,
  out: GdfFileRef[],
  depth = 0,
): Promise<void> {
  if (depth > 32) throw new Error("XGD directory nesting too deep (corrupt image?)");
  const entries = await readGdfDirTable(fh, base, sector, size);
  for (const e of entries) {
    const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
    if (e.attrs & GDF_ATTR_DIR) {
      await listGdfFiles(fh, base, e.startSector, e.size, rel, out, depth + 1);
    } else {
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
    await listGdfFiles(fh, base, rootSector, rootSize, "", files);
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

async function stfsParseEntries(fh: FileHandle): Promise<StfsEntry[]> {
  const entries: StfsEntry[] = [];
  let offset = STFS_FILE_TABLE_OFFSET;
  for (let index = 0; ; index++, offset += STFS_ENTRY_SIZE) {
    const raw = await readAt(fh, offset, STFS_ENTRY_SIZE);
    if (raw.length !== STFS_ENTRY_SIZE || raw.every((b) => b === 0)) break;
    const nameFlags = raw[0x28]!;
    const nameLen = nameFlags & 0x3f;
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
    const entries = await stfsParseEntries(fh);
    const files = entries.filter((e) => (e.flags & STFS_ATTR_DIR) === 0);
    if (files.length === 0) {
      throw new Error(`${basename(pkgPath)}: package contains no files.`);
    }
    const bytesTotal = files.reduce((acc, f) => acc + f.size, 0);

    await mkdir(destDir, { recursive: true });
    let filesDone = 0;
    let bytesDone = 0;
    for (const entry of files) {
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
        for (let i = 0; i < blocksToCopy && remaining > 0; i++) {
          if (logicalBlock === STFS_END_OF_CHAIN) {
            throw new Error(
              `Unexpected end of block chain extracting ${entry.name}`,
            );
          }
          const chunk = await readAt(
            fh,
            stfsPhysicalBlock(logicalBlock) * STFS_BLOCK,
            Math.min(STFS_BLOCK, remaining),
          );
          if (chunk.length === 0) {
            throw new Error(`Unexpected EOF extracting ${entry.name}`);
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
    await extractArchive(romPath, unwrapDir);
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

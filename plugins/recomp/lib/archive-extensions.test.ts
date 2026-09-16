import { describe, expect, it } from "bun:test";
import {
  ARCHIVE_EXTENSIONS,
  ARCHIVE_PICKER_TOKENS,
  hasArchiveExtension,
  supportedImportExtensions,
} from "./archive-extensions";

// Issue #125: catalog mods declare `acceptExtensions: ["zip","7z","rar"]`
// and the extractor has handled .7z/.rar via bsdtar since #167/#221, but
// the two gates in front of it still only allowed zip/tar — so .7z/.rar
// -only mods could not be imported at all.

describe("archive-extensions", () => {
  it("accepts every format the extractor supports, case-insensitively", () => {
    for (const ext of ARCHIVE_EXTENSIONS) {
      expect(hasArchiveExtension(`/x/mod${ext}`)).toBe(true);
      expect(hasArchiveExtension(`/x/MOD${ext.toUpperCase()}`)).toBe(true);
    }
    expect(hasArchiveExtension("/x/Henriko 4K (3.0c).7z")).toBe(true);
    expect(hasArchiveExtension("/x/GoldenEye-Recomp.rar")).toBe(true);
  });

  it("rejects non-archives and download-only formats", () => {
    expect(hasArchiveExtension("/x/readme.txt")).toBe(false);
    expect(hasArchiveExtension("/x/game.appimage")).toBe(false);
    expect(hasArchiveExtension("/x/archive.7z.part")).toBe(false);
    expect(hasArchiveExtension("/x/noext")).toBe(false);
  });

  it("derives picker tokens from the same list (.tar.gz → gz, no dupes)", () => {
    expect(ARCHIVE_PICKER_TOKENS).toEqual(["zip", "tar", "gz", "tgz", "7z", "rar"]);
  });

  it("narrows a catalog entry's acceptExtensions to what the backend unpacks", () => {
    // The henriko-4k shape from games.json — the case #125 reported.
    expect(supportedImportExtensions(["zip", "7z", "rar"])).toEqual(["zip", "7z", "rar"]);
    // Leading dots + case are normalised; unsupported entries drop out.
    expect(supportedImportExtensions([".RAR", "xz", "Zip"])).toEqual(["rar", "zip"]);
  });

  it("falls back to the full supported set when nothing usable is declared", () => {
    expect(supportedImportExtensions(["xz", "iso"])).toEqual([...ARCHIVE_PICKER_TOKENS]);
    expect(supportedImportExtensions(undefined)).toEqual([...ARCHIVE_PICKER_TOKENS]);
    expect(supportedImportExtensions([])).toEqual([...ARCHIVE_PICKER_TOKENS]);
  });
});

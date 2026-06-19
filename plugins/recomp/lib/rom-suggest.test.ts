import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { suggestRomsForTitle } from "./rom-suggest";

/**
 * Spec for ROM-to-game suggestion ranking. The module walks a real
 * directory, so each test materialises files in a temp sandbox and
 * exercises the real `readdir` + `fuzzysort` codepath (no mocking).
 *
 * Coverage:
 *  - the obvious match surfaces first (region/fork annotations on
 *    both sides are stripped, so they don't drag the score down);
 *  - extension filtering excludes non-ROM files;
 *  - the lenient-fuzzy false-positive concern — a ROM for a different
 *    game must not out-rank (or, ideally, appear above) the real one;
 *  - empty inputs and empty directories return `[]`;
 *  - recursion + hidden-dir / depth / breadth caps behave.
 */

let sandbox = "";

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "recomp-romsuggest-spec-"));
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

async function touch(rel: string): Promise<string> {
  const full = join(sandbox, rel);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, "");
  return full;
}

const N64 = ["z64", "n64", "v64"] as const;

describe("suggestRomsForTitle — happy path", () => {
  it("surfaces the obvious ROM despite region + fork annotations on both sides", async () => {
    await touch("Super Mario 64 (USA).z64");
    await touch("random-notes.txt");

    const hits = await suggestRomsForTitle(
      "Super Mario 64 (Render96 HD)",
      sandbox,
      N64,
    );

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.basename).toBe("Super Mario 64 (USA).z64");
    expect(hits[0]!.path).toBe(join(sandbox, "Super Mario 64 (USA).z64"));
  });

  it("ranks the matching game above an unrelated ROM in the same dir", async () => {
    await touch("Super Mario 64 (USA).z64");
    await touch("The Legend of Zelda - Ocarina of Time (USA).z64");

    const hits = await suggestRomsForTitle("Super Mario 64", sandbox, N64);

    expect(hits[0]!.basename).toBe("Super Mario 64 (USA).z64");
  });
});

describe("suggestRomsForTitle — fuzzy false-positive concern", () => {
  it("does not put a sibling-series ROM first when its own ROM is present", async () => {
    // "Mario Kart 64" must not out-rank "Super Mario 64" when the
    // query is the latter — the lenient threshold shouldn't promote a
    // partial-token overlap over the genuine title.
    await touch("Super Mario 64 (USA).z64");
    await touch("Mario Kart 64 (USA).z64");

    const hits = await suggestRomsForTitle("Super Mario 64", sandbox, N64);

    expect(hits[0]!.basename).toBe("Super Mario 64 (USA).z64");
  });

  it("when only an unrelated ROM exists, it does not score better than the true match would", async () => {
    // Only Mario Kart present; query is Super Mario 64. fuzzysort may
    // still return it (loose threshold), but its score must be worse
    // than the score the exact title earns — guard against a regression
    // where the threshold is so loose any file is treated as a match.
    await touch("Mario Kart 64 (USA).z64");
    const looseHits = await suggestRomsForTitle(
      "Super Mario 64",
      sandbox,
      N64,
    );
    const looseTop = looseHits[0]?.score ?? -Infinity;

    await touch("Super Mario 64 (USA).z64");
    const exactHits = await suggestRomsForTitle(
      "Super Mario 64",
      sandbox,
      N64,
    );
    const exactTop = exactHits.find(
      (h) => h.basename === "Super Mario 64 (USA).z64",
    )!.score;

    expect(exactTop).toBeGreaterThan(looseTop);
  });
});

describe("suggestRomsForTitle — extension filtering", () => {
  it("excludes files whose extension is not in the allow list", async () => {
    await touch("Super Mario 64 (USA).z64");
    await touch("Super Mario 64 manual.pdf");
    await touch("Super Mario 64 cover.png");

    const hits = await suggestRomsForTitle("Super Mario 64", sandbox, N64);

    const names = hits.map((h) => h.basename);
    expect(names).toContain("Super Mario 64 (USA).z64");
    expect(names).not.toContain("Super Mario 64 manual.pdf");
    expect(names).not.toContain("Super Mario 64 cover.png");
  });

  it("treats extensions case-insensitively and tolerates a leading dot", async () => {
    await touch("Super Mario 64 (USA).Z64");

    const hits = await suggestRomsForTitle(
      "Super Mario 64",
      sandbox,
      [".z64"],
    );

    expect(hits.map((h) => h.basename)).toContain("Super Mario 64 (USA).Z64");
  });

  it("with an empty extension list, considers every file", async () => {
    await touch("Super Mario 64 baserom");

    const hits = await suggestRomsForTitle("Super Mario 64", sandbox, []);

    expect(hits.map((h) => h.basename)).toContain("Super Mario 64 baserom");
  });
});

describe("suggestRomsForTitle — recursion + caps", () => {
  it("finds ROMs in nested subdirectories", async () => {
    await touch("n64/usa/Super Mario 64 (USA).z64");

    const hits = await suggestRomsForTitle("Super Mario 64", sandbox, N64);

    expect(hits.map((h) => basename(h.path))).toContain(
      "Super Mario 64 (USA).z64",
    );
  });

  it("skips hidden directories", async () => {
    await touch(".trash/Super Mario 64 (USA).z64");

    const hits = await suggestRomsForTitle("Super Mario 64", sandbox, N64);

    expect(hits).toEqual([]);
  });
});

describe("suggestRomsForTitle — empty / no-match cases", () => {
  it("returns [] for an empty game title", async () => {
    await touch("Super Mario 64 (USA).z64");

    expect(await suggestRomsForTitle("", sandbox, N64)).toEqual([]);
  });

  it("returns [] for a title that is entirely stopwords / punctuation", async () => {
    await touch("Super Mario 64 (USA).z64");

    // After normalisation this query has zero usable tokens.
    expect(await suggestRomsForTitle("(HD) the of", sandbox, N64)).toEqual([]);
  });

  it("returns [] when the directory has no candidate files", async () => {
    expect(await suggestRomsForTitle("Super Mario 64", sandbox, N64)).toEqual(
      [],
    );
  });

  it("returns [] when the directory does not exist (unreadable walk)", async () => {
    const hits = await suggestRomsForTitle(
      "Super Mario 64",
      join(sandbox, "does-not-exist"),
      N64,
    );
    expect(hits).toEqual([]);
  });
});

describe("suggestRomsForTitle — options", () => {
  it("respects the limit option", async () => {
    await touch("Super Mario 64 (USA).z64");
    await touch("Super Mario 64 (Europe).z64");
    await touch("Super Mario 64 (Japan).z64");

    const hits = await suggestRomsForTitle("Super Mario 64", sandbox, N64, {
      limit: 2,
    });

    expect(hits.length).toBeLessThanOrEqual(2);
  });
});

/**
 * `READ_LIBRARY` is one in-page program, and everything downstream — every
 * rule, every tab, the mirror — is built on what it returns. So the program is
 * **executed** here against a fake `collectionStore`/`appStore` rather than
 * inspected as text.
 *
 * The cases that matter are the conversions. Steam writes `0` for "no answer"
 * on dates and scores where this repo's convention is `-1`, and collapsing the
 * two makes a "released before 2015" rule silently match every game Steam has
 * no date for.
 */

import { describe, expect, it } from "bun:test";
import { readSteamLibrary } from "./library-overview";
import { SteamClientUnreachableError, type SteamClient } from "./steam-client";

type FakeApp = { appid: number; display_name?: string; [k: string]: unknown };

function app(appid: number, over: Partial<FakeApp> = {}): FakeApp {
  return { appid, display_name: `App ${appid}`, ...over };
}

function fakeSteam(opts: {
  games?: FakeApp[];
  tools?: FakeApp[];
  installed?: number[];
  userCollections?: Array<{ id: string; allApps: Array<{ appid: number }> }>;
}) {
  const { games = [], tools = [], installed = [], userCollections = [] } = opts;
  const byId = new Map<number, FakeApp>([...games, ...tools].map((a) => [a.appid, a]));
  const named: Record<string, { allApps: Array<{ appid: number }> }> = {
    "local-install": { allApps: installed.map((appid) => ({ appid })) },
  };
  for (const c of userCollections) named[c.id] = { allApps: c.allApps };

  return {
    collectionStore: {
      appTypeCollectionMap: new Map([
        ["type-games", { allApps: games }],
        ["type-tools", { allApps: tools }],
      ]),
      userCollections,
      GetCollection: (id: string) => named[id],
    },
    appStore: {
      GetAppOverviewByAppID: (id: number) => byId.get(id),
      GetLocalizationForStoreTag: (t: number) => `tag-${t}`,
    },
    atob: (s: string) => Buffer.from(s, "base64").toString("utf8"),
  };
}

function clientFor(win: Record<string, unknown>): SteamClient {
  return {
    _evaluateAsync: async (expr: string) =>
      await new Function("window", "atob", `return (${expr});`)(win, win.atob),
  } as unknown as SteamClient;
}

describe("readSteamLibrary — the owned library", () => {
  it("returns owned games, not just installed ones", async () => {
    // The premise of the module: `type-games` is the account's library while
    // `local-install` is this machine's.
    const snap = await readSteamLibrary(
      clientFor(fakeSteam({ games: [app(10), app(20), app(30)], installed: [10] })),
    );
    expect(snap.entries.map((e) => e.appId).sort()).toEqual(["10", "20", "30"]);
    expect(snap.installedCount).toBe(1);
  });

  it("uses local-install as the authority on what is installed", async () => {
    // The per-app `installed` getter reports true for ~91% of a real library,
    // so it plainly means something else.
    const snap = await readSteamLibrary(
      clientFor(
        fakeSteam({
          games: [app(10, { installed: true }), app(20, { installed: true })],
          installed: [20],
        }),
      ),
    );
    expect(snap.entries.find((e) => e.appId === "10")!.installed).toBe(false);
    expect(snap.entries.find((e) => e.appId === "20")!.installed).toBe(true);
  });

  it("does not list an app twice when it sits in two type collections", async () => {
    const shared = app(10);
    const snap = await readSteamLibrary(clientFor(fakeSteam({ games: [shared], tools: [shared] })));
    expect(snap.entries).toHaveLength(1);
  });
});

describe("readSteamLibrary — Steam's 0 versus our -1", () => {
  it("maps a zero release date to unknown, not to 1970", async () => {
    const snap = await readSteamLibrary(
      clientFor(fakeSteam({ games: [app(10, { GetCanonicalReleaseDate: () => 0 })] })),
    );
    expect(snap.entries[0]!.releaseDate).toBe(-1);
  });

  it("keeps a real release date", async () => {
    // Read through `GetCanonicalReleaseDate()`, not an own key: both `rt_*`
    // date fields are populated on under 15% of a real library.
    const snap = await readSteamLibrary(
      clientFor(fakeSteam({ games: [app(10, { GetCanonicalReleaseDate: () => 1_600_000_000 })] })),
    );
    expect(snap.entries[0]!.releaseDate).toBe(1_600_000_000);
  });

  it("maps a zero score to unknown", async () => {
    const snap = await readSteamLibrary(
      clientFor(fakeSteam({ games: [app(10, { metacritic_score: 0, review_percentage: 0 })] })),
    );
    expect(snap.entries[0]!.metacritic).toBe(-1);
    expect(snap.entries[0]!.reviewPercentage).toBe(-1);
  });

  it("keeps zero playtime as a real answer, because never-played is an answer", async () => {
    // The one place 0 must survive: `never-played` is a shipped builtin and
    // depends on this distinction.
    const snap = await readSteamLibrary(
      clientFor(
        fakeSteam({
          games: [app(10, { minutes_playtime_forever: 0, rt_last_time_played: 0 })],
        }),
      ),
    );
    expect(snap.entries[0]!.playtimeMinutes).toBe(0);
    expect(snap.entries[0]!.lastPlayed).toBe(0);
  });

  it("maps a non-numeric field to unknown rather than NaN", async () => {
    const snap = await readSteamLibrary(
      clientFor(fakeSteam({ games: [app(10, { metacritic_score: "n/a" })] })),
    );
    expect(snap.entries[0]!.metacritic).toBe(-1);
  });
});

describe("readSteamLibrary — ROM classification", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64");

  it("derives a platform from a Steam ROM Manager collection id", async () => {
    // `srm-<base64 platform>` is the only signal distinguishing a ROM from any
    // other non-Steam shortcut, which otherwise look identical.
    const snap = await readSteamLibrary(
      clientFor(
        fakeSteam({
          games: [app(10)],
          userCollections: [{ id: `srm-${b64("Nintendo 64")}`, allApps: [{ appid: 10 }] }],
        }),
      ),
    );
    expect(snap.entries[0]!.romPlatform).toBe("Nintendo 64");
  });

  it("prefers the specific console over the generic Emulation bucket", async () => {
    // SRM files most ROMs under both; last-write-wins would leave half the
    // library labelled "Emulation".
    const snap = await readSteamLibrary(
      clientFor(
        fakeSteam({
          games: [app(10)],
          userCollections: [
            { id: `srm-${b64("Emulation")}`, allApps: [{ appid: 10 }] },
            { id: `srm-${b64("Sega Genesis")}`, allApps: [{ appid: 10 }] },
          ],
        }),
      ),
    );
    expect(snap.entries[0]!.romPlatform).toBe("Sega Genesis");
  });

  it("leaves an ordinary collection unclassified but recorded", async () => {
    const snap = await readSteamLibrary(
      clientFor(
        fakeSteam({
          games: [app(10)],
          userCollections: [{ id: "uc-mine", allApps: [{ appid: 10 }] }],
        }),
      ),
    );
    expect(snap.entries[0]!.romPlatform).toBeNull();
    expect(snap.entries[0]!.collections).toContain("uc-mine");
  });
});

describe("readSteamLibrary — Steam not ready", () => {
  it("throws rather than reporting an empty library", async () => {
    // An unreachable Steam must not look like "you own nothing" — that would
    // empty every tab and, with the mirror on, every Steam collection.
    expect(readSteamLibrary(clientFor({}))).rejects.toBeInstanceOf(SteamClientUnreachableError);
  });

  it("throws when appStore is missing too", async () => {
    expect(
      readSteamLibrary(clientFor({ collectionStore: { appTypeCollectionMap: new Map() } })),
    ).rejects.toBeInstanceOf(SteamClientUnreachableError);
  });
});

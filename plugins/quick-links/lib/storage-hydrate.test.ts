import { describe, it, expect } from "bun:test";
import {
  emptyStorage,
  hydrate,
  type InstalledShortcutShape,
  type LinkTemplateShape,
} from "./storage-hydrate";

const DEFAULTS: LinkTemplateShape[] = [
  {
    id: "youtube",
    name: "YouTube",
    description: "YT",
    urlTemplate: "https://yt/{name}+{suffix}",
    suffixGroup: "youtube",
    builtin: true,
    enabled: true,
  },
  {
    id: "protondb",
    name: "ProtonDB",
    description: "PDB",
    urlTemplate: "https://protondb/{appId}",
    steamOnly: true,
    builtin: true,
    enabled: true,
  },
];

const DEFAULT_SUFFIXES = { youtube: ["tips", "review"] };

const SAMPLE_INSTALLED: InstalledShortcutShape = {
  browserId: "firefox-native",
  name: "Firefox",
  kind: "native",
  appId: 1,
  gameId64: "1",
  exe: "/usr/bin/firefox",
  launchOptionsBase: "--new-tab {url}",
};

describe("emptyStorage", () => {
  it("clones defaults so callers cannot mutate the shared arrays", () => {
    const a = emptyStorage(DEFAULTS, DEFAULT_SUFFIXES);
    a.templates[0]!.name = "MUTATED";
    a.suffixes.youtube.push("MUTATED");
    const b = emptyStorage(DEFAULTS, DEFAULT_SUFFIXES);
    expect(b.templates[0]!.name).toBe("YouTube");
    expect(b.suffixes.youtube).toEqual(["tips", "review"]);
  });

  it("ships version 1 with empty perGame / hidden / installedBrowsers", () => {
    const s = emptyStorage(DEFAULTS, DEFAULT_SUFFIXES);
    expect(s.version).toBe(1);
    expect(s.perGame).toEqual({});
    expect(s.hidden).toEqual([]);
    expect(s.installedBrowsers).toEqual([]);
  });
});

describe("hydrate", () => {
  it("returns empty-storage shape when raw is empty", () => {
    const s = hydrate({}, [], DEFAULTS, DEFAULT_SUFFIXES);
    expect(s.templates.map((t) => t.id)).toEqual(["youtube", "protondb"]);
    expect(s.installedBrowsers).toEqual([]);
    expect(s.selectedBrowserId).toBeNull();
  });

  it("preserves user overrides on built-ins (name + enabled) but keeps builtin flag", () => {
    const s = hydrate(
      {
        templates: [
          {
            id: "youtube",
            name: "Custom YT",
            urlTemplate: "https://override/{name}",
            builtin: true,
            enabled: false,
          },
        ],
      },
      [],
      DEFAULTS,
      DEFAULT_SUFFIXES,
    );
    const yt = s.templates.find((t) => t.id === "youtube")!;
    expect(yt.name).toBe("Custom YT");
    expect(yt.urlTemplate).toBe("https://override/{name}");
    expect(yt.enabled).toBe(false);
    expect(yt.builtin).toBe(true);
  });

  it("adds new built-ins from defaults even when raw lacks them", () => {
    const s = hydrate(
      { templates: [{ ...DEFAULTS[0]! }] },
      [],
      DEFAULTS,
      DEFAULT_SUFFIXES,
    );
    expect(s.templates.find((t) => t.id === "protondb")).toBeTruthy();
  });

  it("appends user-added (non-builtin) templates after built-ins, ignoring malformed entries", () => {
    const s = hydrate(
      {
        templates: [
          {
            id: "my-wiki",
            name: "Wiki",
            urlTemplate: "https://wiki/{name}",
            builtin: false,
            enabled: true,
          },
          // malformed — no urlTemplate
          { id: "broken", name: "x", builtin: false, enabled: true } as unknown as LinkTemplateShape,
        ],
      },
      [],
      DEFAULTS,
      DEFAULT_SUFFIXES,
    );
    const ids = s.templates.map((t) => t.id);
    expect(ids).toEqual(["youtube", "protondb", "my-wiki"]);
  });

  it("merges custom suffix groups with defaults", () => {
    const s = hydrate(
      { suffixes: { youtube: ["only-this"], extra: ["x"] } },
      [],
      DEFAULTS,
      DEFAULT_SUFFIXES,
    );
    expect(s.suffixes.youtube).toEqual(["only-this"]);
    expect(s.suffixes.extra).toEqual(["x"]);
  });

  it("imports legacy installed shortcuts when raw.installedBrowsers is absent", () => {
    const s = hydrate({}, [SAMPLE_INSTALLED], DEFAULTS, DEFAULT_SUFFIXES);
    expect(s.installedBrowsers).toEqual([SAMPLE_INSTALLED]);
  });

  it("ignores legacy shortcuts once raw.installedBrowsers is present (even if empty array)", () => {
    const s = hydrate(
      { installedBrowsers: [] },
      [SAMPLE_INSTALLED],
      DEFAULTS,
      DEFAULT_SUFFIXES,
    );
    expect(s.installedBrowsers).toEqual([]);
  });

  it("filters non-string entries out of `hidden`", () => {
    const s = hydrate(
      {
        hidden: ["protondb", 42 as unknown as string, "youtube"],
      },
      [],
      DEFAULTS,
      DEFAULT_SUFFIXES,
    );
    expect(s.hidden).toEqual(["protondb", "youtube"]);
  });

  it("coerces empty / non-string selectedBrowserId to null", () => {
    expect(
      hydrate({ selectedBrowserId: "" }, [], DEFAULTS, DEFAULT_SUFFIXES)
        .selectedBrowserId,
    ).toBeNull();
    expect(
      hydrate(
        { selectedBrowserId: 7 as unknown as string },
        [],
        DEFAULTS,
        DEFAULT_SUFFIXES,
      ).selectedBrowserId,
    ).toBeNull();
    expect(
      hydrate(
        { selectedBrowserId: "firefox-native" },
        [],
        DEFAULTS,
        DEFAULT_SUFFIXES,
      ).selectedBrowserId,
    ).toBe("firefox-native");
  });
});

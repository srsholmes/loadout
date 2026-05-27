import { describe, it, expect } from "bun:test";
import {
  buildChips,
  isSteamApp,
  renderUrl,
  type QuickLinksStorageLike,
} from "./lib";

describe("isSteamApp", () => {
  it("returns true for normal Steam appids", () => {
    expect(isSteamApp(620)).toBe(true);          // Portal 2
    expect(isSteamApp(2147483647)).toBe(true);   // exactly 2^31 - 1
  });
  it("returns false for shortcut appids (top bit set)", () => {
    expect(isSteamApp(0x80000000)).toBe(false);
    expect(isSteamApp(3000000001)).toBe(false);
  });
  it("returns false for zero or negative", () => {
    expect(isSteamApp(0)).toBe(false);
    expect(isSteamApp(-5)).toBe(false);
  });
});

describe("renderUrl", () => {
  it("substitutes {appId}, {name}, {name_raw}, {suffix}", () => {
    const url = renderUrl(
      "https://x/?app={appId}&q={name}&raw={name_raw}&s={suffix}",
      { appId: 620, name: "Portal 2", suffix: "before you begin" },
    );
    expect(url).toBe(
      "https://x/?app=620&q=Portal%202&raw=Portal 2&s=before%20you%20begin",
    );
  });
  it("substitutes {name_raw} before {name} so the longer key wins", () => {
    // Without longest-first ordering, `{name}` would replace the `{name`
    // prefix of `{name_raw}` and leave `_raw}` orphaned in the URL.
    const url = renderUrl("https://x/?a={name}&b={name_raw}", {
      appId: 1,
      name: "Half Life",
    });
    expect(url).toBe("https://x/?a=Half%20Life&b=Half Life");
  });
  it("substitutes an empty string when {suffix} is provided no value", () => {
    expect(renderUrl("https://x/?q={name}&s={suffix}", {
      appId: 1,
      name: "x",
    })).toBe("https://x/?q=x&s=");
  });
});

describe("buildChips", () => {
  const baseStorage: QuickLinksStorageLike = {
    templates: [
      {
        id: "youtube",
        name: "YT",
        description: "youtube desc",
        urlTemplate: "https://yt/?q={name}+{suffix}",
        suffixGroup: "youtube",
        builtin: true,
        enabled: true,
      },
      {
        id: "protondb",
        name: "ProtonDB",
        description: "protondb desc",
        urlTemplate: "https://protondb/app/{appId}",
        steamOnly: true,
        builtin: true,
        enabled: true,
      },
      {
        id: "google",
        name: "Google",
        description: "google desc",
        urlTemplate: "https://g/?q={name}",
        builtin: true,
        enabled: true,
      },
      {
        id: "disabled",
        name: "Disabled",
        urlTemplate: "https://d",
        builtin: false,
        enabled: false,
      },
    ],
    suffixes: { youtube: ["before you begin", "tips"] },
    hidden: [],
  };

  it("expands suffix-group templates into one chip per suffix", () => {
    const chips = buildChips(baseStorage, 620, "Portal 2", undefined);
    const ytChips = chips.filter((c) => c.key.startsWith("youtube"));
    expect(ytChips).toHaveLength(2);
    expect(ytChips[0].label).toBe("YT · before you begin");
    expect(ytChips[0].url).toContain("Portal%202");
    expect(ytChips[0].url).toContain("before%20you%20begin");
  });

  it("collapses suffix-group templates with an empty suffix list into a single chip", () => {
    const storage = { ...baseStorage, suffixes: { youtube: [] } };
    const chips = buildChips(storage, 620, "Portal 2", undefined);
    const ytChips = chips.filter((c) => c.label.startsWith("YT"));
    expect(ytChips).toHaveLength(1);
  });

  it("hides steamOnly templates for shortcut appids", () => {
    const chips = buildChips(baseStorage, 3000000001, "Yuzu", undefined);
    expect(chips.some((c) => c.key === "protondb")).toBe(false);
    // Non-steamOnly templates still appear.
    expect(chips.some((c) => c.key === "google")).toBe(true);
  });

  it("filters out disabled and hidden templates", () => {
    const storage = { ...baseStorage, hidden: ["google"] };
    const chips = buildChips(storage, 620, "Portal 2", undefined);
    expect(chips.some((c) => c.key === "google")).toBe(false);
    expect(chips.some((c) => c.key === "disabled")).toBe(false);
  });

  it("pinned templates float to the top of the chip list", () => {
    const chips = buildChips(baseStorage, 620, "Portal 2", {
      pinnedTemplateIds: ["protondb"],
      customLinks: [],
    });
    expect(chips[0].key).toBe("protondb");
  });

  it("appends per-game customLinks after the template-derived chips", () => {
    const chips = buildChips(baseStorage, 620, "Portal 2", {
      pinnedTemplateIds: [],
      customLinks: [{ name: "My note", url: "https://my/" }],
    });
    expect(chips[chips.length - 1]).toEqual({
      key: "custom::0",
      label: "My note",
      url: "https://my/",
      templateId: "custom",
      description: "",
    });
  });

  it("carries description + templateId from the source template onto each chip (incl. suffix-expanded variants)", () => {
    const chips = buildChips(baseStorage, 620, "Portal 2", undefined);
    const ytChip = chips.find((c) => c.key.startsWith("youtube"));
    const googleChip = chips.find((c) => c.key === "google");
    expect(ytChip?.templateId).toBe("youtube");
    expect(ytChip?.description).toBe("youtube desc");
    expect(googleChip?.templateId).toBe("google");
    expect(googleChip?.description).toBe("google desc");
  });

  it("falls back to an empty description when the source template has none", () => {
    // Same shape as baseStorage but the visible template has no description.
    const storage: QuickLinksStorageLike = {
      templates: [
        {
          id: "bare",
          name: "Bare",
          urlTemplate: "https://b/",
          builtin: false,
          enabled: true,
        },
      ],
      suffixes: {},
      hidden: [],
    };
    const chips = buildChips(storage, 1, "x", undefined);
    expect(chips).toHaveLength(1);
    expect(chips[0].description).toBe("");
    expect(chips[0].templateId).toBe("bare");
  });
});

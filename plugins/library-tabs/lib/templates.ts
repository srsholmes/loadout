/**
 * Builtin tabs and the template gallery.
 *
 * Two distinct things live here:
 *
 * - **Builtin tabs** ship with the plugin. They can be hidden and
 *   reordered but not edited or deleted — duplicate one to get an editable
 *   copy. This mirrors how Steam's own default tabs behave, which is what
 *   makes the plugin "feel like it has always been part of SteamOS".
 * - **Templates** are one-tap starting points that create a normal,
 *   fully-editable tab. TabMaster calls these Quick Tabs; the difference is
 *   that ours lead with the ones people actually build.
 *
 * The ordering of `TEMPLATES` is a product decision, not alphabetical. The
 * job-to-be-done, from TabMaster's own community, is **backlog
 * suppression** — "I hide all tabs except installed and favorites so I
 * cannot see everything I can install". So "Installed & unplayed" and
 * "Short games" come first, and the genre/store slicing comes last.
 *
 * Isomorphic: pure, no I/O.
 */

import type { BuiltinTabId, GroupRule, Rule, SortSpec, Tab } from "./types";

/** Deterministic id builder, so templates produce stable rule trees. */
function rid(tabId: string, n: number): string {
  return `${tabId}-r${n}`;
}

const DEFAULT_DISPLAY: Tab["display"] = {
  tileWidth: 150,
  showLabels: true,
  badges: ["deckCompat"],
};

const BY_NAME: SortSpec[] = [{ field: "sortAs", dir: "asc" }];
const RECENT_FIRST: SortSpec[] = [{ field: "lastPlayed", dir: "desc" }];

/** Assemble a Tab from the parts a template or builtin actually varies. */
function makeTab(
  id: string,
  label: string,
  children: Rule[],
  overrides: Partial<Tab> = {},
): Tab {
  const root: GroupRule = {
    id: `${id}-root`,
    kind: "group",
    combinator: "all",
    children,
  };
  return {
    id,
    label,
    visible: true,
    autoHide: false,
    root,
    sort: BY_NAME,
    limit: null,
    group: { kind: "none" },
    display: { ...DEFAULT_DISPLAY },
    mirror: { enabled: false, collectionName: label },
    indeterminatePolicy: "pass",
    ...overrides,
  };
}

// ── Builtin tabs ───────────────────────────────────────────────────────

/**
 * The tabs a fresh install shows, in strip order.
 *
 * "All" deliberately has an empty rule tree: an empty `all` group is
 * vacuously true, so it matches the whole library without a special case in
 * the evaluator.
 */
export function builtinTabs(): Tab[] {
  return [
    makeTab("all", "All", [], { builtin: "all", icon: "FaLayerGroup" }),

    makeTab("installed", "Installed", [{ id: rid("installed", 1), kind: "installed" }], {
      builtin: "installed",
      icon: "FaHardDrive",
    }),

    makeTab(
      "recent",
      "Recently played",
      [
        {
          id: rid("recent", 1),
          kind: "lastPlayed",
          // Anything with a real timestamp. The sort does the work; the rule
          // only excludes never-played and unknown.
          epochSec: { min: 0 },
        },
      ],
      // autoHide: a tab with nothing in it drops out of the strip while keeping
      // its position for when it fills up again. That matters more than it
      // looks here — until a provider populates `lastPlayed`, this tab can
      // never match anything, and a permanently-empty tab sitting in the strip
      // reads as a broken plugin rather than as missing data.
      {
        builtin: "recent",
        icon: "FaClockRotateLeft",
        sort: RECENT_FIRST,
        limit: 30,
        autoHide: true,
      },
    ),

    makeTab(
      "never-played",
      "Never played",
      [
        { id: rid("never-played", 1), kind: "installed" },
        {
          id: rid("never-played", 2),
          kind: "lastPlayed",
          epochSec: {},
          neverPlayedOnly: true,
        },
      ],
      { builtin: "never-played", icon: "FaSeedling", autoHide: true },
    ),

    makeTab(
      "non-steam",
      "Non-Steam",
      [{ id: rid("non-steam", 1), kind: "source", sources: ["shortcut"] }],
      { builtin: "non-steam", icon: "FaGamepad", autoHide: true },
    ),
  ];
}

/** Ids of the tabs we ship, for validation and migration. */
export const BUILTIN_TAB_IDS: readonly BuiltinTabId[] = [
  "all",
  "installed",
  "recent",
  "never-played",
  "non-steam",
];

// ── Templates ──────────────────────────────────────────────────────────

export interface TabTemplate {
  id: string;
  label: string;
  /** One line shown under the label in the gallery. */
  description: string;
  /** react-icons export name. */
  icon: string;
  /**
   * Rule kinds this template uses that may be unavailable early on. The
   * gallery greys a template and explains why rather than offering a tab
   * that will render empty.
   */
  needs?: Array<Rule["kind"]>;
  /** Build the tab. `id` is supplied by the caller so it stays unique. */
  build: (id: string) => Tab;
}

const DAY = 86_400;

/**
 * `now` is passed in rather than read from the clock so templates are
 * deterministic in specs and so a tab built today doesn't silently drift.
 * Relative-date templates store an absolute bound at creation time; the
 * user can edit it afterwards.
 */
export function templates(now: number = Math.floor(Date.now() / 1000)): TabTemplate[] {
  return [
    {
      id: "backlog",
      label: "Installed & unplayed",
      description: "Games you've installed but never started — your actual backlog",
      icon: "FaSeedling",
      // Without lastPlayed this can only ever be empty. Declaring it is what
      // makes the gallery grey it out and say why, instead of offering a
      // template that looks ready and produces nothing.
      needs: ["lastPlayed"],
      build: (id) =>
        makeTab(
          id,
          "Backlog",
          [
            { id: rid(id, 1), kind: "installed" },
            { id: rid(id, 2), kind: "lastPlayed", epochSec: {}, neverPlayedOnly: true },
          ],
          { icon: "FaSeedling" },
        ),
    },
    {
      id: "short-games",
      label: "Short games",
      description: "Under 10 hours to beat, for when you don't want a commitment",
      icon: "FaHourglassHalf",
      needs: ["hltbMain"],
      build: (id) =>
        makeTab(
          id,
          "Short games",
          [{ id: rid(id, 1), kind: "hltbMain", hours: { max: 10 } }],
          { icon: "FaHourglassHalf" },
        ),
    },
    {
      id: "deck-verified",
      label: "Deck Verified",
      description: "Games Valve has verified for Steam Deck",
      icon: "FaCircleCheck",
      needs: ["deckCompat"],
      build: (id) =>
        makeTab(
          id,
          "Deck Verified",
          [{ id: rid(id, 1), kind: "deckCompat", categories: ["verified"] }],
          { icon: "FaCircleCheck" },
        ),
    },
    {
      id: "pick-up-again",
      label: "Pick up again",
      description: "Played before, but not in the last three months",
      icon: "FaRotateLeft",
      needs: ["lastPlayed", "playtime"],
      build: (id) =>
        makeTab(
          id,
          "Pick up again",
          [
            {
              id: rid(id, 1),
              kind: "lastPlayed",
              epochSec: { min: 0, max: now - 90 * DAY },
            },
            { id: rid(id, 2), kind: "playtime", minutes: { min: 60 } },
          ],
          { icon: "FaRotateLeft", sort: RECENT_FIRST },
        ),
    },
    {
      id: "recently-added",
      label: "Recently added",
      description: "Everything that arrived in your library this month",
      icon: "FaCartShopping",
      needs: ["purchaseDate"],
      build: (id) =>
        makeTab(
          id,
          "Recently added",
          [{ id: rid(id, 1), kind: "purchaseDate", epochSec: { min: now - 30 * DAY } }],
          { icon: "FaCartShopping", sort: [{ field: "releaseDate", dir: "desc" }] },
        ),
    },
    {
      id: "space-hogs",
      label: "Space hogs",
      description: "Installed games over 20 GB — start here when freeing up space",
      icon: "FaHardDrive",
      build: (id) =>
        makeTab(
          id,
          "Space hogs",
          [
            { id: rid(id, 1), kind: "installed" },
            { id: rid(id, 2), kind: "sizeOnDisk", bytes: { min: 20 * 1024 ** 3 } },
          ],
          { icon: "FaHardDrive", sort: [{ field: "sizeOnDisk", dir: "desc" }] },
        ),
    },
    {
      id: "couch-coop",
      label: "Couch co-op",
      description: "Local multiplayer with full controller support",
      icon: "FaUsers",
      needs: ["feature"],
      build: (id) =>
        makeTab(
          id,
          "Couch co-op",
          [
            {
              id: rid(id, 1),
              kind: "feature",
              features: ["coop", "fullControllerSupport"],
              mode: "allOf",
            },
          ],
          { icon: "FaUsers" },
        ),
    },
    {
      id: "emulation",
      label: "Emulated games",
      description: "Non-Steam shortcuts, grouped by platform",
      icon: "FaGamepad",
      build: (id) =>
        makeTab(
          id,
          "Emulation",
          [{ id: rid(id, 1), kind: "source", sources: ["shortcut"] }],
          {
            icon: "FaGamepad",
            // The payoff of sub-tabs on the most-requested use case: one
            // strip per console, from the collection tags EmuDeck writes.
            group: {
              kind: "field",
              field: "collection",
              sortGroups: "countDesc",
              otherLabel: "Other",
            },
          },
        ),
    },
    {
      id: "hidden-gems",
      label: "Hidden gems",
      description: "Very well reviewed, and you haven't played them yet",
      icon: "FaGem",
      needs: ["reviewScore"],
      build: (id) =>
        makeTab(
          id,
          "Hidden gems",
          [
            { id: rid(id, 1), kind: "reviewScore", percent: { min: 90 } },
            { id: rid(id, 2), kind: "playtime", minutes: { max: 30 } },
          ],
          { icon: "FaGem", sort: [{ field: "reviewPercentage", dir: "desc" }] },
        ),
    },
    {
      id: "declutter",
      label: "Hide the clutter",
      description: "Everything that is not a demo, soundtrack, tool or video",
      icon: "FaBroom",
      needs: ["appKind"],
      build: (id) =>
        makeTab(
          id,
          "Games only",
          [
            {
              id: rid(id, 1),
              kind: "appKind",
              kinds: ["demo", "music", "tool", "video", "dlc"],
              invert: true,
            },
          ],
          { icon: "FaBroom" },
        ),
    },
    {
      id: "friends-playing",
      label: "Friends playing now",
      description: "Games a friend is in right now",
      icon: "FaUserGroup",
      needs: ["friendsPlaying"],
      build: (id) =>
        makeTab(
          id,
          "Friends playing",
          [{ id: rid(id, 1), kind: "friendsPlaying", minCount: 1 }],
          { icon: "FaUserGroup", autoHide: true },
        ),
    },
    {
      id: "blank",
      label: "Start from scratch",
      description: "An empty tab you build yourself",
      icon: "FaPlus",
      build: (id) => makeTab(id, "New tab", [], { icon: "FaPlus" }),
    },
  ];
}

/** Look up a template by id. */
export function findTemplate(
  id: string,
  now?: number,
): TabTemplate | undefined {
  return templates(now).find((t) => t.id === id);
}

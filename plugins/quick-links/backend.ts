import type { PluginBackend, EmitPayload, PluginLogger } from "@loadout/types";
import { run, runFull, spawn } from "@loadout/exec";
import {
  readPluginStorage,
  writePluginStorage,
} from "@loadout/plugin-storage";
import { withSteamClient, SteamClientUnreachableError } from "@loadout/steam-cdp";
import { getUserdataDir, getUserIds } from "@loadout/steam-paths";
import { parseBinaryVdf, shortcutGameId64 } from "@loadout/vdf";
import { readFile } from "fs/promises";
import { join } from "path";
import { isChromeOrFirefoxBrowserId } from "./lib/browser-id";
import { buildLaunchOptionsBase } from "./lib/browser-launch-options";
import { detectDisplayResolution } from "./lib/display-resolution";
import { isValidFlatpakAppId } from "./lib/flatpak";
import {
  emptyStorage as emptyStorageImpl,
  hydrate as hydrateImpl,
} from "./lib/storage-hydrate";

/**
 * Quick Links plugin backend.
 *
 * Persists the user's link templates, suffix groups (for YouTube
 * search variants), per-game pins, and which built-in templates the
 * user has hidden.
 *
 * URL placeholder substitution happens on the React side (the
 * frontend already has the current game via `useCurrentGame()`), so
 * the template-CRUD part of this backend is pure storage.
 *
 * Browser shortcuts: this plugin also owns the "register a desktop
 * browser as a non-Steam game" flow (formerly the standalone
 * `gaming-mode-browser` plugin, folded in for issue #121). The
 * landing/settings page combines the two surfaces — pick a browser
 * once, then every link click routes through that shortcut via
 * `launchUrl(url[, browserId])`. Other plugins (store-bridge, etc.)
 * call quick-links's `launchUrl` directly via cross-plugin RPC for
 * any "open this URL in the user's chosen browser" need.
 */

// ─── Schema (also exported from app.tsx as the wire shape) ───────────

export interface LinkTemplate {
  /** Stable id. Built-in templates use well-known ids ("youtube",
   *  "protondb", …); user-added templates use crypto-style random
   *  ids generated client-side. */
  id: string;
  name: string;
  /**
   * URL with placeholders:
   *   {appId}     → numeric Steam app id (or shortcut appid for
   *                 non-Steam shortcuts; only meaningful for Steam-app
   *                 templates like ProtonDB / SteamDB).
   *   {name}      → URL-encoded game name.
   *   {name_raw}  → unencoded game name (use sparingly — for wikis
   *                 that need underscore-separated paths the user is
   *                 expected to add the underscores in the template).
   *   {suffix}    → one entry from the suffix group. If absent, the
   *                 template renders as a single chip; if present and
   *                 `suffixGroup` is set, the template expands to one
   *                 chip per suffix.
   */
  urlTemplate: string;
  /** Short, human description shown under the title on the landing
   *  page card. Optional — built-ins all carry one; user-added
   *  templates may omit it (the card falls back to the URL host). */
  description?: string;
  /** Optional suffix-group key into `suffixes`. */
  suffixGroup?: string;
  /** If true, only render when the running game is a Steam-app
   *  (appid < 2^31). Used to hide ProtonDB / SteamDB links for
   *  non-Steam shortcuts where those services have nothing to show. */
  steamOnly?: boolean;
  /** Shipped with the plugin. Built-ins can't be deleted, only
   *  hidden via `hidden`. */
  builtin: boolean;
  enabled: boolean;
}

export interface GamePins {
  /** Template ids that should sort first in the widget. Order matters
   *  — first id = top chip. */
  pinnedTemplateIds: string[];
  /** Per-game custom links (raw URLs, no placeholders). Always shown
   *  after pins and before built-in templates in the widget. */
  customLinks: { name: string; url: string }[];
}

// ─── Browser shortcut types (folded in from gaming-mode-browser) ─────

export type BrowserKind = "native" | "flatpak";

export interface BrowserCandidate {
  /** Stable id used in storage and the UI radio group. */
  id: string;
  /** Display name shown in the picker. */
  name: string;
  kind: BrowserKind;
  /** Absolute path to the executable Steam will launch. */
  exe: string;
  /**
   * Static prefix prepended to per-launch URLs. For native browsers
   * this is `""` (Steam exec runs `<exe> <url>` directly). For flatpak
   * it's `run <flatpak-app-id>` (Steam exec runs
   * `/usr/bin/flatpak run <id> <url>`).
   */
  launchOptionsBase: string;
  /** Only set for flatpak entries — the flatpak application id. */
  flatpakAppId?: string;
}

export interface InstalledShortcut {
  /** Which candidate id was registered (e.g. "firefox-native"). */
  browserId: string;
  /** Display name written to `shortcuts.vdf` — needed for the AddShortcut
   *  read-back fallback when Steam doesn't return the appid directly. */
  name: string;
  kind: BrowserKind;
  /** 32-bit Steam-allocated appid (the `appid` field in `shortcuts.vdf`). */
  appId: number;
  /** 64-bit gameid (`steam://rungameid/<gameId64>`). */
  gameId64: string;
  /** Path that ended up as the shortcut's `Exe`. */
  exe: string;
  /** Static launch-options prefix; see `BrowserCandidate.launchOptionsBase`. */
  launchOptionsBase: string;
}

export interface QuickLinksStorage {
  version: 1;
  templates: LinkTemplate[];
  suffixes: Record<string, string[]>;
  perGame: Record<string, GamePins>;
  /** Built-in template ids the user has hidden. */
  hidden: string[];
  /** Browser shortcut to use when launching links. Maps to a
   *  `BrowserCandidate.id` from the browser picker. Null / undefined
   *  means "use the default" (most-recently-installed). */
  selectedBrowserId?: string | null;
  /** All registered browser shortcuts. Order is install order; the
   *  last entry is the implicit default. Persisted so the UI can show
   *  the install state on mount without re-detecting. */
  installedBrowsers: InstalledShortcut[];
}

// ─── Defaults ────────────────────────────────────────────────────────

/**
 * Default built-in templates. Order = display order in the widget for
 * games with no pins. Resist the urge to add too many — every extra
 * chip pushes the "real" content the user wants further down.
 */
export const DEFAULT_TEMPLATES: LinkTemplate[] = [
  {
    id: "youtube",
    name: "YouTube",
    description: "Search YouTube for guides, reviews, and gameplay clips",
    urlTemplate:
      "https://www.youtube.com/results?search_query={name}+{suffix}",
    suffixGroup: "youtube",
    builtin: true,
    enabled: true,
  },
  {
    id: "google",
    name: "Google",
    description: "Web search for this game",
    urlTemplate: "https://www.google.com/search?q={name}",
    builtin: true,
    enabled: true,
  },
  {
    id: "protondb",
    name: "ProtonDB",
    description: "Linux compatibility reports from other Proton users",
    urlTemplate: "https://www.protondb.com/app/{appId}",
    steamOnly: true,
    builtin: true,
    enabled: true,
  },
  {
    id: "steamdb",
    name: "SteamDB",
    description: "Price history, depots, and detailed app metadata",
    urlTemplate: "https://steamdb.info/app/{appId}",
    steamOnly: true,
    builtin: true,
    enabled: true,
  },
  {
    id: "hltb",
    name: "HowLongToBeat",
    description: "How long this game takes to beat — main story and 100%",
    urlTemplate: "https://howlongtobeat.com/?q={name}",
    builtin: true,
    enabled: true,
  },
  {
    id: "pcgw",
    name: "PCGamingWiki",
    description: "PC tweaks, fixes, and engine info on PCGamingWiki",
    urlTemplate: "https://www.pcgamingwiki.com/w/index.php?search={name}",
    builtin: true,
    enabled: true,
  },
  {
    id: "gamefaqs",
    name: "GameFAQs",
    description: "Walkthroughs and FAQs from GameFAQs",
    urlTemplate:
      "https://gamefaqs.gamespot.com/search?game={name}",
    builtin: true,
    enabled: true,
  },
  {
    id: "ign",
    name: "IGN Wiki",
    description: "IGN articles, reviews, and wiki entries",
    urlTemplate: "https://www.ign.com/search?q={name}",
    builtin: true,
    enabled: true,
  },
  {
    id: "steam-guides",
    name: "Steam Guides",
    description: "Community-written guides on Steam",
    urlTemplate: "https://steamcommunity.com/app/{appId}/guides/",
    steamOnly: true,
    builtin: true,
    enabled: true,
  },
  {
    id: "steam-discuss",
    name: "Steam Discussions",
    description: "Bug reports, tips, and threads on the Steam forum",
    urlTemplate: "https://steamcommunity.com/app/{appId}/discussions/",
    steamOnly: true,
    builtin: true,
    enabled: true,
  },
  {
    id: "reddit",
    name: "Reddit",
    description: "Discussion across all subreddits",
    urlTemplate: "https://www.reddit.com/search/?q={name}",
    builtin: true,
    enabled: true,
  },
  {
    id: "nexus",
    name: "Nexus Mods",
    description: "Mod listings on Nexus Mods",
    urlTemplate: "https://www.nexusmods.com/games?BH=0&keywords={name}",
    builtin: true,
    enabled: true,
  },
  {
    id: "wikipedia",
    name: "Wikipedia",
    description: "Encyclopedia entry",
    urlTemplate:
      "https://en.wikipedia.org/wiki/Special:Search?search={name}",
    builtin: true,
    enabled: true,
  },
  {
    id: "itad",
    name: "IsThereAnyDeal",
    description: "Lowest historical price across stores",
    urlTemplate: "https://isthereanydeal.com/search/?q={name}",
    builtin: true,
    enabled: true,
  },
  {
    id: "metacritic",
    name: "Metacritic",
    description: "Aggregated critic and user scores",
    urlTemplate:
      "https://www.metacritic.com/search/{name}/?category=13",
    builtin: true,
    enabled: true,
  },
  {
    id: "opencritic",
    name: "OpenCritic",
    description: "Aggregated critic scores (no user reviews)",
    urlTemplate: "https://opencritic.com/search?term={name}",
    builtin: true,
    enabled: true,
  },
  {
    id: "speedrun",
    name: "Speedrun.com",
    description: "Speedrun leaderboards and category info",
    urlTemplate: "https://www.speedrun.com/search?query={name}",
    builtin: true,
    enabled: true,
  },
  {
    id: "twitch",
    name: "Twitch",
    description: "Live streams and recent VODs for this game",
    urlTemplate: "https://www.twitch.tv/search?term={name}",
    builtin: true,
    enabled: true,
  },
  {
    id: "backloggd",
    name: "Backloggd",
    description: "Community ratings, reviews, and lists",
    urlTemplate: "https://www.backloggd.com/search/games/{name}",
    builtin: true,
    enabled: true,
  },
];

export const DEFAULT_SUFFIXES: Record<string, string[]> = {
  youtube: [
    "before you begin",
    "things I wish I knew",
    "tips and tricks",
    "review",
  ],
};

const PLUGIN_ID = "quick-links";

// ─── Browser catalogue (folded in from gaming-mode-browser) ──────────

/**
 * Native-binary candidates probed via `which`. Listed in preferred order
 * within each browser family — the first one that resolves to a path on
 * disk is what the user sees in the picker (we don't want both
 * `google-chrome` and `google-chrome-stable` in the list when they're
 * the same binary symlinked).
 */
const NATIVE_BROWSERS: { id: string; name: string; bins: string[] }[] = [
  { id: "firefox-native", name: "Firefox", bins: ["firefox"] },
  {
    id: "chrome-native",
    name: "Google Chrome",
    bins: ["google-chrome-stable", "google-chrome"],
  },
  {
    id: "brave-native",
    name: "Brave",
    bins: ["brave-browser", "brave"],
  },
  { id: "chromium-native", name: "Chromium", bins: ["chromium", "chromium-browser"] },
  {
    id: "edge-native",
    name: "Microsoft Edge",
    bins: ["microsoft-edge-stable", "microsoft-edge"],
  },
  { id: "vivaldi-native", name: "Vivaldi", bins: ["vivaldi", "vivaldi-stable"] },
];

/**
 * Flatpak candidates. Detected by parsing `flatpak list --app` output
 * (same pattern as the flatpak-manager plugin) and filtering to ids
 * known to be browsers.
 */
const FLATPAK_BROWSERS: { id: string; name: string; flatpakAppId: string }[] = [
  { id: "firefox-flatpak", name: "Firefox (Flatpak)", flatpakAppId: "org.mozilla.firefox" },
  { id: "chrome-flatpak", name: "Google Chrome (Flatpak)", flatpakAppId: "com.google.Chrome" },
  { id: "brave-flatpak", name: "Brave (Flatpak)", flatpakAppId: "com.brave.Browser" },
  { id: "chromium-flatpak", name: "Chromium (Flatpak)", flatpakAppId: "org.chromium.Chromium" },
  { id: "edge-flatpak", name: "Microsoft Edge (Flatpak)", flatpakAppId: "com.microsoft.Edge" },
  { id: "vivaldi-flatpak", name: "Vivaldi (Flatpak)", flatpakAppId: "com.vivaldi.Vivaldi" },
  { id: "librewolf-flatpak", name: "LibreWolf (Flatpak)", flatpakAppId: "io.gitlab.librewolf-community" },
];

// Re-exported from `./lib/display-resolution` so the existing test
// suite (and any external import path) continues to work after the
// pure-helper extraction.
export { detectDisplayResolution };

// ---------------------------------------------------------------------------
// Browser detection helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a binary name to an absolute path via `which`. Returns
 * `null` if the binary isn't on PATH or `which` exited non-zero.
 */
async function resolveBinary(name: string): Promise<string | null> {
  try {
    const { stdout, exitCode } = await run(["which", name], { timeoutMs: 2000 });
    if (exitCode !== 0) return null;
    const path = stdout.trim();
    return path.length > 0 ? path : null;
  } catch {
    return null;
  }
}

/**
 * Enumerate flatpak app ids the user has installed. Returns an empty
 * set on any failure.
 */
async function listFlatpakAppIds(): Promise<Set<string>> {
  try {
    const { stdout, exitCode } = await run(
      ["flatpak", "list", "--app", "--columns=application"],
      { timeoutMs: 5000 },
    );
    if (exitCode !== 0) return new Set();
    return new Set(
      stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && isValidFlatpakAppId(l)),
    );
  } catch {
    return new Set();
  }
}

/**
 * Locate the flatpak launcher binary. Required because Steam stores
 * an absolute path in the shortcut's `Exe` field — relying on the
 * user's shell PATH at launch time would silently break for users
 * whose Steam was started from a desktop file without `/usr/bin` in
 * PATH.
 */
async function resolveFlatpakBin(): Promise<string | null> {
  return resolveBinary("flatpak");
}

// ---------------------------------------------------------------------------
// Gamescope focus + browser-running detection
// ---------------------------------------------------------------------------

/**
 * Prepend `appId` to the gamescope `GAMESCOPECTRL_BASELAYER_APPID`
 * root atom so gamescope picks the matching window as focused.
 * Returns `{ ok: true, list, display }` with the new list, or
 * `{ ok: false, reason }`.
 */
async function raiseAppViaGamescope(
  appId: number,
): Promise<
  | { ok: true; list: number[]; display: string }
  | { ok: false; reason: string }
> {
  const reasons: string[] = [];
  for (const display of [":0", ":1", ":2"]) {
    const env = { DISPLAY: display };
    const read = await runFull(
      ["xprop", "-root", "GAMESCOPECTRL_BASELAYER_APPID"],
      { env, timeoutMs: 800 },
    );
    if (read.exitCode !== 0) {
      reasons.push(
        `${display}: read exit=${read.exitCode} stderr=${read.stderr.trim().slice(0, 120)}`,
      );
      continue;
    }
    const m = read.stdout.match(/=\s*([\d,\s]+)/);
    const ids = m
      ? m[1]! // group 1 always captures when the match succeeds
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n) && n > 0)
      : [];
    const filtered = ids.filter((x) => x !== appId);
    const next = [appId, ...filtered];
    const write = await runFull(
      [
        "xprop",
        "-root",
        "-f",
        "GAMESCOPECTRL_BASELAYER_APPID",
        "32c",
        "-set",
        "GAMESCOPECTRL_BASELAYER_APPID",
        next.join(", "),
      ],
      { env, timeoutMs: 800 },
    );
    if (write.exitCode !== 0) {
      reasons.push(
        `${display}: write exit=${write.exitCode} stderr=${write.stderr.trim().slice(0, 120)}`,
      );
      continue;
    }
    return { ok: true, list: next, display };
  }
  return { ok: false, reason: reasons.join(" | ") || "no DISPLAY worked" };
}

async function isBrowserRunning(installed: InstalledShortcut): Promise<boolean> {
  if (installed.kind === "flatpak") {
    const m = installed.launchOptionsBase.match(
      /^run\s+([a-zA-Z][a-zA-Z0-9._-]*)/,
    );
    if (!m) return false;
    const flatpakAppId = m[1];
    try {
      const { stdout, exitCode } = await run(
        [
          "systemctl",
          "--user",
          "list-units",
          "--type=scope",
          "--state=running",
          "--no-legend",
          "--plain",
          "--no-pager",
        ],
        { timeoutMs: 2000 },
      );
      if (exitCode !== 0) return false;
      return stdout.includes(`app-flatpak-${flatpakAppId}-`);
    } catch {
      return false;
    }
  }
  try {
    const { exitCode } = await run(["pgrep", "-fx", installed.exe], {
      timeoutMs: 2000,
    });
    return exitCode === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// shortcuts.vdf read-back (AddShortcut fallback)
// ---------------------------------------------------------------------------

/**
 * Walk every Steam user's `shortcuts.vdf`, find the entry whose
 * `appname` matches `name`, return its 32-bit appid (uint32). Used as
 * the fallback when `SteamClient.Apps.AddShortcut` resolves with
 * `undefined` on the current Steam build.
 */
async function findShortcutAppIdByName(name: string): Promise<number | null> {
  const userIds = await getUserIds();
  const attempts = [0, 100, 250, 500, 1000]; // ms

  for (const delay of attempts) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));

    for (const userId of userIds) {
      const path = join(getUserdataDir(), userId, "config", "shortcuts.vdf");
      let buf: Buffer;
      try {
        buf = await readFile(path);
      } catch {
        continue;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = parseBinaryVdf(buf) as Record<string, unknown>;
      } catch {
        continue;
      }
      const shortcuts = (parsed.shortcuts ?? {}) as Record<string, unknown>;
      for (const entry of Object.values(shortcuts)) {
        if (typeof entry !== "object" || entry === null) continue;
        const sc = entry as Record<string, unknown>;
        const appName =
          (typeof sc.appname === "string" && sc.appname) ||
          (typeof sc.AppName === "string" && sc.AppName) ||
          "";
        if (appName !== name) continue;
        if (typeof sc.appid !== "number") continue;
        /*
         * Signed → unsigned coercion. shortcuts.vdf stores `appid` as a
         * little-endian int32, so non-Steam shortcut appids (top bit
         * set, i.e. >= 0x80000000) come out of `parseBinaryVdf` as
         * negative JavaScript numbers. `shortcutGameId64` expects an
         * unsigned 32-bit value; without the `>>> 0` the derived
         * gameId64 silently drifts (BigInt(-1) << 32 ≠ BigInt(0xFFFF_FFFF) << 32).
         *
         * Pinned by a regression test in backend.test.ts — if
         * `shortcutGameId64` ever changes its input contract this MUST
         * be revisited or the gameId64 written into Steam's URL will
         * point at the wrong shortcut.
         */
        return sc.appid >>> 0;
      }
    }
  }
  return null;
}

// ─── Storage hydrate / migration ─────────────────────────────────────

function emptyStorage(): QuickLinksStorage {
  return emptyStorageImpl(DEFAULT_TEMPLATES, DEFAULT_SUFFIXES) as QuickLinksStorage;
}

/**
 * Legacy gaming-mode-browser storage shape. Read at onLoad so users
 * upgrading from before #121 land keep their installed shortcuts —
 * we don't want to force every user to re-install Firefox/Chrome as
 * a non-Steam game just because the plugin moved. Schema:
 *   v1: { installed: InstalledShortcut }
 *   v2: { installedList: InstalledShortcut[] }
 */
interface LegacyBrowserStorage {
  installed?: InstalledShortcut;
  installedList?: InstalledShortcut[];
}

const LEGACY_BROWSER_PLUGIN_ID = "gaming-mode-browser";

async function loadLegacyBrowserShortcuts(): Promise<InstalledShortcut[]> {
  try {
    const raw = (await readPluginStorage<LegacyBrowserStorage>(
      LEGACY_BROWSER_PLUGIN_ID,
    )) as LegacyBrowserStorage;
    if (Array.isArray(raw.installedList)) return raw.installedList;
    if (raw.installed) return [raw.installed];
  } catch {
    /* no legacy data */
  }
  return [];
}

function hydrate(
  raw: Partial<QuickLinksStorage>,
  legacyInstalled: InstalledShortcut[],
): QuickLinksStorage {
  return hydrateImpl(
    raw,
    legacyInstalled,
    DEFAULT_TEMPLATES,
    DEFAULT_SUFFIXES,
  ) as QuickLinksStorage;
}

// ─── Backend ─────────────────────────────────────────────────────────

export default class QuickLinksBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;
  log?: PluginLogger;

  private state: QuickLinksStorage = emptyStorage();

  async onLoad(): Promise<void> {
    const raw = (await readPluginStorage<QuickLinksStorage>(
      PLUGIN_ID,
    )) as Partial<QuickLinksStorage>;
    const legacy =
      Array.isArray(raw.installedBrowsers) ? [] : await loadLegacyBrowserShortcuts();
    this.state = hydrate(raw, legacy);
    this.log?.info(
      `[quick-links] loaded ${this.state.templates.length} templates, ${this.state.installedBrowsers.length} browser shortcut(s)`,
    );
  }

  private async persist(): Promise<void> {
    await writePluginStorage<QuickLinksStorage>(PLUGIN_ID, this.state);
    this.emit?.({ event: "stateChanged", data: this.state });
  }

  /** Snapshot of the entire stored state. UI reads this once on mount
   *  and subscribes to `stateChanged` for live updates. */
  async getState(): Promise<QuickLinksStorage> {
    return this.state;
  }

  /**
   * Are we currently running under gamescope (i.e. Gaming Mode)?
   * Used by the UI to decide whether to show the "install a browser"
   * banner — outside Gaming Mode the user can just open URLs in
   * their normal desktop browser, so the banner would just be noise.
   *
   * The original check (`GAMESCOPE_DISPLAY` / `GAMESCOPE_WAYLAND_DISPLAY`)
   * only catches contexts INSIDE Steam BPM's nested gamescope — the
   * loadout systemd service runs at the session level, where
   * those env vars aren't set even when gamescope-session is the
   * active desktop. We also accept the session-level `XDG_CURRENT_DESKTOP`
   * / `DESKTOP_SESSION` indicators that Bazzite / SteamOS set for the
   * gaming-mode boot.
   */
  async isGamingMode(): Promise<boolean> {
    if (process.env.GAMESCOPE_DISPLAY || process.env.GAMESCOPE_WAYLAND_DISPLAY) {
      return true;
    }
    const xdg = (process.env.XDG_CURRENT_DESKTOP ?? "").toLowerCase();
    const session = (process.env.DESKTOP_SESSION ?? "").toLowerCase();
    return xdg.includes("gamescope") || session.includes("gamescope");
  }

  // ─── Template mutations ──────────────────────────────────────────

  async addCustomTemplate(t: Omit<LinkTemplate, "builtin">): Promise<QuickLinksStorage> {
    if (!t || typeof t.id !== "string" || t.id.length === 0) {
      throw new Error("addCustomTemplate: missing id");
    }
    if (this.state.templates.some((x) => x.id === t.id)) {
      throw new Error(`Template id "${t.id}" already exists`);
    }
    this.state = {
      ...this.state,
      templates: [...this.state.templates, { ...t, builtin: false }],
    };
    await this.persist();
    return this.state;
  }

  async updateTemplate(
    id: string,
    patch: Partial<Omit<LinkTemplate, "id" | "builtin">>,
  ): Promise<QuickLinksStorage> {
    this.state = {
      ...this.state,
      templates: this.state.templates.map((t) =>
        t.id === id ? { ...t, ...patch, id: t.id, builtin: t.builtin } : t,
      ),
    };
    await this.persist();
    return this.state;
  }

  async deleteTemplate(id: string): Promise<QuickLinksStorage> {
    const target = this.state.templates.find((t) => t.id === id);
    if (!target) return this.state;
    if (target.builtin) {
      // Built-ins can't be hard-deleted — add to the hidden list so
      // they stop rendering but can be restored from settings.
      if (!this.state.hidden.includes(id)) {
        this.state = {
          ...this.state,
          hidden: [...this.state.hidden, id],
        };
        await this.persist();
      }
      return this.state;
    }
    this.state = {
      ...this.state,
      templates: this.state.templates.filter((t) => t.id !== id),
    };
    await this.persist();
    return this.state;
  }

  async unhideTemplate(id: string): Promise<QuickLinksStorage> {
    this.state = {
      ...this.state,
      hidden: this.state.hidden.filter((x) => x !== id),
    };
    await this.persist();
    return this.state;
  }

  // ─── Suffix mutations ────────────────────────────────────────────

  async setSuffixes(
    group: string,
    suffixes: string[],
  ): Promise<QuickLinksStorage> {
    if (!group || typeof group !== "string") {
      throw new Error("setSuffixes: missing group key");
    }
    this.state = {
      ...this.state,
      suffixes: { ...this.state.suffixes, [group]: [...suffixes] },
    };
    await this.persist();
    return this.state;
  }

  // ─── Per-game mutations ──────────────────────────────────────────

  async setPinnedTemplateIds(
    appId: string,
    ids: string[],
  ): Promise<QuickLinksStorage> {
    const prev = this.state.perGame[appId] ?? {
      pinnedTemplateIds: [],
      customLinks: [],
    };
    this.state = {
      ...this.state,
      perGame: {
        ...this.state.perGame,
        [appId]: { ...prev, pinnedTemplateIds: [...ids] },
      },
    };
    await this.persist();
    return this.state;
  }

  async addCustomLink(
    appId: string,
    link: { name: string; url: string },
  ): Promise<QuickLinksStorage> {
    if (!link.name || !link.url) {
      throw new Error("addCustomLink: name and url are required");
    }
    // Custom links are dispatched through the browser shortcut, so the
    // URL must be a real web address. Reject schemes like javascript:
    // and data: that could execute in the browser context, and
    // scheme-less strings that `new URL` can't parse.
    let parsed: URL;
    try {
      parsed = new URL(link.url);
    } catch {
      throw new Error(`addCustomLink: invalid URL: ${link.url}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(
        `addCustomLink: only http(s) URLs are allowed (got ${parsed.protocol})`,
      );
    }
    const prev = this.state.perGame[appId] ?? {
      pinnedTemplateIds: [],
      customLinks: [],
    };
    this.state = {
      ...this.state,
      perGame: {
        ...this.state.perGame,
        [appId]: {
          ...prev,
          customLinks: [...prev.customLinks, { ...link }],
        },
      },
    };
    await this.persist();
    return this.state;
  }

  async removeCustomLink(
    appId: string,
    index: number,
  ): Promise<QuickLinksStorage> {
    const prev = this.state.perGame[appId];
    if (!prev || index < 0 || index >= prev.customLinks.length) {
      return this.state;
    }
    const customLinks = [...prev.customLinks];
    customLinks.splice(index, 1);
    this.state = {
      ...this.state,
      perGame: {
        ...this.state.perGame,
        [appId]: { ...prev, customLinks },
      },
    };
    await this.persist();
    return this.state;
  }

  // ─── Browser selection ───────────────────────────────────────────

  /**
   * Pick which browser shortcut Quick Links should use to open URLs.
   * Pass `null` to fall back to the default (most-recently-installed).
   * The chosen id maps to a `BrowserCandidate.id`; if it later gets
   * uninstalled, launchUrl silently degrades to the default rather
   * than failing.
   */
  async setSelectedBrowserId(
    browserId: string | null,
  ): Promise<QuickLinksStorage> {
    this.state = {
      ...this.state,
      selectedBrowserId:
        typeof browserId === "string" && browserId.length > 0
          ? browserId
          : null,
    };
    await this.persist();
    return this.state;
  }

  // ─── Browser shortcut detection / install / uninstall ────────────

  /**
   * Return every browser candidate the user has actually installed.
   * Native and flatpak entries can coexist (a user who has both
   * `firefox` and `org.mozilla.firefox` sees both — they pick).
   */
  async detectBrowsers(): Promise<BrowserCandidate[]> {
    const out: BrowserCandidate[] = [];
    const res = await detectDisplayResolution();

    for (const b of NATIVE_BROWSERS) {
      for (const bin of b.bins) {
        const path = await resolveBinary(bin);
        if (path) {
          out.push({
            id: b.id,
            name: b.name,
            kind: "native",
            exe: path,
            launchOptionsBase: buildLaunchOptionsBase(b.id, res, ""),
          });
          break; // first match per family wins
        }
      }
    }

    const flatpakBin = await resolveFlatpakBin();
    if (flatpakBin) {
      const installed = await listFlatpakAppIds();
      for (const b of FLATPAK_BROWSERS) {
        if (!installed.has(b.flatpakAppId)) continue;
        out.push({
          id: b.id,
          name: b.name,
          kind: "flatpak",
          exe: flatpakBin,
          launchOptionsBase: buildLaunchOptionsBase(
            b.id,
            res,
            `run ${b.flatpakAppId}`,
          ),
          flatpakAppId: b.flatpakAppId,
        });
      }
    }

    return out;
  }

  /**
   * What's currently the default browser (the most-recently-installed
   * one). Used by launchUrl when the caller doesn't specify a
   * browserId. Returns null if nothing installed.
   */
  async getInstalledBrowser(): Promise<InstalledShortcut | null> {
    const list = this.state.installedBrowsers;
    return list[list.length - 1] ?? null;
  }

  /**
   * All registered browser shortcuts. Used by the settings UI to
   * populate its "open in" dropdown. Order is install order (oldest
   * first); the last entry is the implicit default.
   */
  async getAllInstalledBrowsers(): Promise<InstalledShortcut[]> {
    return this.state.installedBrowsers;
  }

  /**
   * Convenience for the gaming-mode banner: true if any installed
   * shortcut is Chrome or Firefox (any flavour). The issue
   * specifically calls out Chrome/Firefox; users with Brave/Edge as
   * their primary still trigger the banner so they know they need
   * to register one.
   */
  async hasChromeOrFirefoxShortcut(): Promise<boolean> {
    return this.state.installedBrowsers.some((s) =>
      isChromeOrFirefoxBrowserId(s.browserId),
    );
  }

  /**
   * Is the Steam JS API reachable? Plugin UIs gate the Install button
   * on this so users see an actionable empty state rather than a
   * cryptic CDP error.
   */
  async isSteamReachable(): Promise<boolean> {
    try {
      return await withSteamClient((sc) => sc.isReachable());
    } catch {
      return false;
    }
  }

  /**
   * Register the picked browser as a non-Steam shortcut. Persists
   * the install record to plugin storage. Throws if Steam isn't
   * reachable or the chosen `browserId` isn't currently detected.
   */
  async installBrowserShortcut(browserId: string): Promise<InstalledShortcut> {
    const candidates = await this.detectBrowsers();
    const picked = candidates.find((c) => c.id === browserId);
    if (!picked) {
      throw new Error(
        `Browser id "${browserId}" not detected. Re-open the plugin to refresh the list.`,
      );
    }

    // The value WRITTEN TO STEAM substitutes `{url}` with about:blank
    // so a direct-from-Steam launch (BPM library click, no URL passed
    // via launchUrl) doesn't try to navigate Firefox/Chrome to the
    // literal string "{url}".
    const defaultLaunchOptions = picked.launchOptionsBase.replaceAll(
      "{url}",
      "about:blank",
    );
    let appId = await withSteamClient((sc) =>
      sc.apps.addShortcut(picked.name, picked.exe, defaultLaunchOptions, ""),
    );

    if (appId == null) {
      this.log?.info(
        "[quick-links] AddShortcut returned no appid — reading back from shortcuts.vdf",
      );
      appId = await findShortcutAppIdByName(picked.name);
    }

    if (appId == null) {
      throw new Error(
        "Steam accepted the shortcut but didn't expose an appid for it. Open Big Picture > Library to see it; restart this plugin to pick it up.",
      );
    }

    // AddShortcut on modern Steam ignores the display-name arg and
    // doesn't persist to shortcuts.vdf on its own — fix by following
    // up with SetShortcutName + SetShortcutLaunchOptions, which both
    // sets the value and flushes the dirty entry to disk on Steam's
    // next save cycle.
    const finalAppId = appId;
    try {
      await withSteamClient(async (sc) => {
        await sc.apps.setShortcutName(finalAppId, picked.name);
        await sc.apps.setShortcutLaunchOptions(finalAppId, defaultLaunchOptions);
      });
    } catch (err) {
      this.log?.warn(
        `[quick-links] couldn't commit shortcut name/launch options: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const installed: InstalledShortcut = {
      browserId: picked.id,
      name: picked.name,
      kind: picked.kind,
      appId,
      gameId64: shortcutGameId64(appId),
      exe: picked.exe,
      launchOptionsBase: picked.launchOptionsBase,
    };

    // Append to the multi-install list. If this browser-id is already
    // registered, drop the old entry first so we don't accumulate
    // duplicates with stale appIds. Other browsers' entries are
    // untouched — users can have Firefox AND Chrome installed.
    const next = this.state.installedBrowsers
      .filter((s) => s.browserId !== picked.id)
      .concat(installed);
    this.state = { ...this.state, installedBrowsers: next };
    await this.persist();
    this.emit?.({ event: "browserInstalled", data: installed });
    return installed;
  }

  /**
   * Remove a registered shortcut from Steam and the plugin's storage.
   * Pass `browserId` to remove a specific entry; pass `undefined` (or
   * call with no args) to remove ALL entries.
   */
  async uninstallBrowserShortcut(browserId?: string): Promise<void> {
    const targets =
      browserId === undefined
        ? this.state.installedBrowsers
        : this.state.installedBrowsers.filter((s) => s.browserId === browserId);
    if (targets.length === 0) return;

    for (const t of targets) {
      try {
        await withSteamClient((sc) => sc.apps.removeShortcut(t.appId));
      } catch (err) {
        this.log?.warn(
          `[quick-links] RemoveShortcut failed for ${t.name} (${t.appId}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const next =
      browserId === undefined
        ? []
        : this.state.installedBrowsers.filter((s) => s.browserId !== browserId);
    this.state = { ...this.state, installedBrowsers: next };
    await this.persist();
    this.emit?.({ event: "browserUninstalled", data: { browserId: browserId ?? null } });
  }

  // ─── Cross-plugin RPC: launch a URL ──────────────────────────────

  /**
   * Open `url` in the registered browser shortcut, going through
   * Steam so the launch is part of the BPM session. Other plugins
   * (store-bridge, etc.) call this directly via cross-plugin RPC.
   *
   * Returns `{ launched: false, reason }` rather than throwing on
   * known recoverable conditions (no shortcut installed, Steam not
   * running) so the calling UI can copy-to-clipboard fallback
   * without try/catch noise.
   */
  async launchUrl(
    url: string,
    browserId?: string,
  ): Promise<
    | { launched: true }
    | {
        launched: false;
        reason: "not-installed" | "steam-unreachable" | "launch-failed";
        message: string;
      }
  > {
    if (typeof url !== "string" || url.length === 0) {
      throw new Error("launchUrl: url must be a non-empty string");
    }

    // Resolve to a specific shortcut. Honor caller's browserId hint;
    // otherwise use the user's saved selectedBrowserId; otherwise the
    // most-recently-installed default. Stale ids degrade to the
    // default rather than failing.
    const list = this.state.installedBrowsers;
    const requestedId =
      browserId ??
      (typeof this.state.selectedBrowserId === "string"
        ? this.state.selectedBrowserId
        : undefined);
    const installed = requestedId
      ? (list.find((s) => s.browserId === requestedId) ??
        list[list.length - 1] ??
        null)
      : (list[list.length - 1] ?? null);
    if (!installed) {
      return {
        launched: false,
        reason: "not-installed",
        message:
          "No browser is registered yet. Open the Quick Links plugin settings and install one.",
      };
    }

    // Build the per-launch launch-options string.
    const base = installed.launchOptionsBase;
    const launchOptions = base.includes("{url}")
      ? base.replaceAll("{url}", url)
      : base.length > 0
        ? `${base} ${url}`
        : url;

    // Fast path: if the browser process is already alive, going
    // through Steam's `steam://rungameid` either hits "game already
    // running" or spawns a duplicate browser. Direct-exec the binary
    // with a MINIMAL tab-routing argv (NOT the stored
    // launchOptionsBase, which has window-size / scale flags meant
    // for cold-start) — Firefox / Chrome's remote-control IPC then
    // opens the URL as a new TAB in the existing window.
    if (await isBrowserRunning(installed)) {
      this.log?.info(
        `[quick-links] launchUrl: appId=${installed.appId} url=${url} (fast path: browser already running, direct exec)`,
      );
      const isFirefox =
        installed.browserId.includes("firefox") ||
        installed.browserId.includes("librewolf");
      const tabFlag = isFirefox ? ["--new-tab"] : [];
      let argv: string[] | null = null;
      if (installed.kind === "flatpak") {
        const m = installed.launchOptionsBase.match(
          /^run\s+([a-zA-Z][a-zA-Z0-9._-]*)/,
        );
        const flatpakAppId = m?.[1];
        if (!flatpakAppId) {
          this.log?.warn(
            `[quick-links] launchUrl: fast-path skipped — couldn't parse flatpak app id from launchOptionsBase=${JSON.stringify(installed.launchOptionsBase)}`,
          );
        } else {
          argv = ["run", flatpakAppId, ...tabFlag, url];
        }
      } else {
        argv = [...tabFlag, url];
      }

      if (argv) {
        try {
          spawn([installed.exe, ...argv], {
            stdout: "ignore",
            stderr: "ignore",
            stdin: "ignore",
          });
        } catch (err) {
          this.log?.error(
            `[quick-links] launchUrl: direct exec failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          // Mirror the slow-path contract (documented above): report
          // failure via the result object instead of throwing, so every
          // caller handles one shape.
          return {
            launched: false,
            reason: "launch-failed",
            message: `Couldn't launch the browser: ${err instanceof Error ? err.message : String(err)}`,
          };
        }

        // Best-effort focus: prepend the browser's appId to
        // gamescope's GAMESCOPECTRL_BASELAYER_APPID root atom.
        const gsResult = await raiseAppViaGamescope(installed.appId);
        if (gsResult.ok) {
          this.log?.info(
            `[quick-links] launchUrl: gamescope focus → BASELAYER_APPID=[${gsResult.list.join(", ")}] (DISPLAY=${gsResult.display})`,
          );
        } else {
          this.log?.warn(
            `[quick-links] launchUrl: gamescope focus failed: ${gsResult.reason}`,
          );
        }

        this.emit?.({ event: "launched", data: { url } });
        return { launched: true };
      }
    }

    // Retry once on SteamClientUnreachableError. Steam's CEF debug
    // port intermittently fails to respond mid-transition.
    const attempt = () =>
      withSteamClient(async (sc) => {
        await sc.apps.setShortcutLaunchOptions(installed.appId, launchOptions);
        // Fixed 150 ms sleep is comfortably more than the ~tens-of-ms
        // IPC roundtrip and avoids dependence on GetShortcutData
        // (which newer Steam builds don't expose on the apprunning
        // SharedJSContext).
        await new Promise((r) => setTimeout(r, 150));
        await sc.url.executeSteamURL(`steam://rungameid/${installed.gameId64}`);
      });

    this.log?.info(
      `[quick-links] launchUrl: appId=${installed.appId} url=${url}`,
    );
    try {
      await attempt();
      this.log?.info(`[quick-links] launchUrl: first attempt OK`);
    } catch (err) {
      if (err instanceof SteamClientUnreachableError) {
        this.log?.warn(
          `[quick-links] launchUrl: first attempt unreachable: ${err.message}; retrying after 600ms`,
        );
        await new Promise((r) => setTimeout(r, 600));
        try {
          await attempt();
          this.log?.info(`[quick-links] launchUrl: retry attempt OK`);
        } catch (err2) {
          if (err2 instanceof SteamClientUnreachableError) {
            this.log?.warn(
              `[quick-links] launchUrl: retry attempt also unreachable: ${err2.message}`,
            );
            return {
              launched: false,
              reason: "steam-unreachable",
              message:
                "Steam isn't responding on its debug port. Make sure Steam is running with -cef-enable-debugging.",
            };
          }
          this.log?.error(
            `[quick-links] launchUrl: retry threw non-unreachable: ${err2 instanceof Error ? err2.message : String(err2)}`,
          );
          throw err2;
        }
      } else {
        this.log?.error(
          `[quick-links] launchUrl: first attempt threw non-unreachable: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
    }

    this.emit?.({ event: "launched", data: { url } });
    return { launched: true };
  }

  // ─── Reset ───────────────────────────────────────────────────────

  /** Reset templates + suffixes only. Browser shortcuts are not
   *  touched — those represent on-disk Steam library entries, and
   *  wiping them here would orphan the shortcut entries in
   *  shortcuts.vdf without removing them. Use uninstallBrowserShortcut
   *  for that. */
  async resetToDefaults(): Promise<QuickLinksStorage> {
    const installedBrowsers = this.state.installedBrowsers;
    const selectedBrowserId = this.state.selectedBrowserId;
    this.state = { ...emptyStorage(), installedBrowsers, selectedBrowserId };
    await this.persist();
    return this.state;
  }
}

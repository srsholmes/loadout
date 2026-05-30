import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  Badge,
  Button,
  GameCard,
  HeaderBackButton,
  IconButton,
  Panel,
  PluginHeader,
  SearchField,
  SegmentedItem,
  Spinner,
  TabBar,
  Text,
  TextInput,
  mountComponent,
  mountHeaderStub,
  notify,
  useBackend,
} from "@loadout/ui";
import { FaGear, FaPlus, FaTrash, FaRotate } from "react-icons/fa6";
import { extractAuthCode } from "./lib/auth-code";
import { PIPELINE_ADD_TO_STEAM_PREFIX } from "./lib/types";

/**
 * Close the overlay via the Electrobun host's `hide` RPC after the
 * user fires a launch. Same pattern recomp + quick-links use — there
 * isn't a sanctioned `useHost()` hook yet, so we reach into
 * `window.__electroview` directly. No-op outside Electrobun (vite
 * dev / unit tests) and swallows host errors so a broken host can't
 * tank the click.
 */
function dismissOverlay(): void {
  try {
    const w = window as unknown as {
      __electroview?: {
        rpc?: { request?: Record<string, (...a: unknown[]) => Promise<unknown>> };
      };
    };
    const fn = w.__electroview?.rpc?.request?.hide;
    if (typeof fn === "function") void fn();
  } catch {
    /* best-effort */
  }
}

// ── Types — shape of payloads coming out of the backend ──────────────────

type StoreId = "epic" | "gog" | "amazon" | "ubisoft" | "xcloud";
type AuthStatus = "unknown" | "authed" | "expired";

interface StoreInfo {
  id: StoreId;
  displayName: string;
  authStatus: AuthStatus;
  enabled: boolean;
  preflightOk: boolean;
}

interface InstalledGame {
  id: string;
  title: string;
  installedAt: string;
  installDir: string;
  installSize?: number;
  version?: string;
  source: "installed" | "imported";
  addedToSteam: boolean;
  steamAppId?: number;
  steamGameId64?: string;
}

interface GameInfo {
  storeId: StoreId;
  id: string;
  title: string;
  coverUrl?: string;
  heroUrl?: string;
  logoUrl?: string;
  installSize?: number;
  status: "library" | "installed" | "imported";
  installed?: InstalledGame;
  description?: string;
  longDescription?: string;
  developer?: string;
  publisher?: string;
  releaseDate?: string;
  tags?: string[];
  platforms?: string[];
}

interface DriverOverrides {
  binary?: string;
  pinnedVersion?: string;
}

interface Settings {
  enabledStores: StoreId[];
  driverOverrides?: Partial<Record<StoreId, DriverOverrides>>;
  scanPaths: string[];
  lastScanAt?: number;
}

interface PreflightResult {
  ok: boolean;
  missing: string[];
  canSelfInstall: boolean;
  installHint?: string;
}

interface DetectedInstall {
  storeId: StoreId;
  gameId: string;
  title: string;
  dir: string;
}

type PipelineEvent =
  | { kind: "progress"; id: string; percent: number; label?: string; storeId?: StoreId; gameId?: string }
  | { kind: "complete"; id: string; storeId?: StoreId; gameId?: string }
  | { kind: "error"; id: string; message: string; storeId?: StoreId; gameId?: string };

// ── Internal nav (list → detail → settings) ──────────────────────────────

type View =
  | { kind: "list" }
  | { kind: "detail"; storeId: StoreId; gameId: string }
  | { kind: "settings" };

interface Nav {
  toList: () => void;
  toDetail: (storeId: StoreId, gameId: string) => void;
  toSettings: () => void;
}

const NavContext = createContext<Nav | null>(null);
function useNav(): Nav {
  const ctx = useContext(NavContext);
  if (!ctx) throw new Error("useNav() outside <App>");
  return ctx;
}

// ── Top-level app ────────────────────────────────────────────────────────

function App() {
  const [view, setView] = useState<View>({ kind: "list" });
  const nav = useMemo<Nav>(
    () => ({
      toList: () => setView({ kind: "list" }),
      toDetail: (storeId, gameId) => setView({ kind: "detail", storeId, gameId }),
      toSettings: () => setView({ kind: "settings" }),
    }),
    [],
  );
  // Mount the install-completion toast listener at the App level
  // (not inside CatalogView) so it survives when the user navigates
  // to the detail view or settings while an install is running.
  // Without this, a user clicking Install from the detail view sees
  // the progress bar finish then complete silence — the toast lives
  // on a component that's no longer mounted.
  useGlobalInstallToasts();
  return (
    <NavContext.Provider value={nav}>
      {view.kind === "list" && <CatalogView />}
      {view.kind === "detail" && <DetailView storeId={view.storeId} gameId={view.gameId} />}
      {view.kind === "settings" && <SettingsView />}
    </NavContext.Provider>
  );
}

/**
 * Top-level subscription to `gameStatusChanged` for the install-
 * completion toast. Lives on `App` so it persists across view
 * transitions. We deliberately don't reach for game titles via a
 * separate state slice — the toast uses the gameId verbatim when no
 * title is cached, which is rare in practice (the catalog populates
 * before installs ever finish).
 */
function useGlobalInstallToasts(): void {
  const { useEvent } = useBackend("store-bridge");
  useEvent({
    event: "gameStatusChanged",
    handler: (raw: unknown) => {
      const data = raw as
        | {
            storeId?: string;
            gameId?: string;
            status?: string;
            addedToSteam?: boolean;
            title?: string;
          }
        | undefined;
      if (
        (data?.status === "installed" || data?.status === "imported") &&
        data.gameId &&
        data.addedToSteam !== undefined
      ) {
        const title = data.title || data.gameId;
        const verb = data.status === "imported" ? "imported" : "installed";
        if (data.addedToSteam) {
          notify(`${title} ${verb} and added to Steam`);
        } else {
          notify(
            `${title} ${verb}. Add to Steam failed — open the game's detail page to retry.`,
            { kind: "error" },
          );
        }
      }
    },
  });
}

// ── Catalog view ─────────────────────────────────────────────────────────

const TAB_DEFS = [
  { id: "library", label: "Library" },
  { id: "installed", label: "Installed" },
  { id: "downloads", label: "Downloads" },
  { id: "detected", label: "Detected" },
] as const;
type TabId = (typeof TAB_DEFS)[number]["id"];

/**
 * Short labels for the per-tile store badge. We don't fetch these
 * from `getStores` to keep tile renders synchronous — the catalog
 * already pulls the full driver list on mount, so leaving the
 * mapping hardcoded here just mirrors what the backend already
 * registered. Add an entry when a new driver lands.
 */
const STORE_LABELS: Record<StoreId, string> = {
  epic: "Epic",
  gog: "GOG",
  amazon: "Amazon",
  ubisoft: "Ubisoft",
  xcloud: "xCloud",
};

interface InProgressInstall {
  storeId: StoreId;
  gameId: string;
  percent: number;
  label?: string;
}

function CatalogView() {
  const nav = useNav();
  const { call, useEvent } = useBackend("store-bridge");
  // quick-links hosts the cross-plugin "launch URL via a browser shortcut"
  // RPC (it absorbed the retired gaming-mode-browser flow). Read once at
  // the top level — calling useBackend() from inside an event handler
  // would violate the rules of hooks.
  const browser = useBackend("quick-links");

  const [stores, setStores] = useState<StoreInfo[]>([]);
  const [activeStore, setActiveStore] = useState<StoreId>("epic");
  const [tab, setTab] = useState<TabId>("library");
  const [search, setSearch] = useState("");
  const [games, setGames] = useState<GameInfo[]>([]);
  const [detected, setDetected] = useState<DetectedInstall[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [selfInstallPct, setSelfInstallPct] = useState<number | null>(null);
  const [authCode, setAuthCode] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);

  // Track install progress per gameId so the cards can render a bar.
  const [installPct, setInstallPct] = useState<Record<string, number>>({});

  const loadStoresAndGames = useCallback(async () => {
    setLoading(true);
    try {
      const ss = (await call("getStores")) as StoreInfo[];
      setStores(ss);
      const cur = ss.find((s) => s.id === activeStore) ?? ss[0];
      if (cur) setActiveStore(cur.id);
      const pf = (await call("checkPreflight", cur?.id ?? "epic")) as PreflightResult;
      setPreflight(pf);
      if (pf.ok) {
        const lib = (await call("getLibrary", cur?.id ?? "epic")) as GameInfo[];
        setGames(lib);
      } else {
        setGames([]);
      }
    } finally {
      setLoading(false);
    }
  }, [activeStore, call]);

  useEffect(() => {
    void loadStoresAndGames();
  }, [loadStoresAndGames]);

  // Seed install-progress map from backend's in-flight registry so
  // the catalog renders running installs correctly after a remount,
  // not just after the next pipelineEvent.
  useEffect(() => {
    let cancelled = false;
    void call("getAllInProgressInstalls").then((raw: unknown) => {
      if (cancelled) return;
      const list = (raw as InProgressInstall[]) ?? [];
      if (list.length === 0) return;
      setInstallPct((m) => {
        const next = { ...m };
        for (const e of list) next[e.gameId] = e.percent;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [call]);

  // Live progress + status events from the backend.
  useEvent({
    event: "pipelineEvent",
    handler: (raw: unknown) => {
      const e = raw as PipelineEvent;
      if (e.kind === "progress") {
        if (e.id.startsWith("epic:install-legendary")) {
          setSelfInstallPct(e.percent);
        } else if (e.gameId) {
          setInstallPct((m) => ({ ...m, [e.gameId!]: e.percent }));
        }
      } else if (e.kind === "complete") {
        if (e.id.startsWith("epic:install-legendary")) {
          setSelfInstallPct(null);
          void loadStoresAndGames();
        }
        // Game-install completes are intentionally NOT toasted here:
        // the legendary download is only half of the install
        // pipeline — the add-to-Steam tail can still fail. We wait
        // for `gameStatusChanged` (which carries `addedToSteam`) so
        // the toast wording stays honest.
      } else if (e.kind === "error") {
        if (e.id.startsWith("epic:install-legendary")) {
          setSelfInstallPct(null);
          notify(`Couldn't install legendary: ${e.message}`, { kind: "error" });
        } else if (e.id.includes(PIPELINE_ADD_TO_STEAM_PREFIX)) {
          // Add-to-Steam failures arrive here too (they share the
          // gameId), but the install itself succeeded. The honest
          // "Add to Steam failed" toast is fired by the App-level
          // gameStatusChanged handler that knows `addedToSteam:false`.
          // Surfacing a second "install failed" toast here would
          // contradict that one — drop this event entirely.
        } else if (e.gameId) {
          // Errors leave the game at status="library", so the
          // games-reconciliation effect can't clear installPct on
          // its own. Do it here so the tile flips back to "Install"
          // (re-enabled) instead of stuck "Installing…".
          setInstallPct((m) => {
            const { [e.gameId!]: _, ...rest } = m;
            return rest;
          });
          // Toast the failure so the user knows the install didn't
          // just silently revert. "Install cancelled" is the user's
          // own action — softer phrasing, no scary "error" kind.
          const id = e.gameId;
          const title = games.find((g) => g.id === id)?.title ?? id;
          const isCancel = /cancelled/i.test(e.message);
          const isAlreadyDone = /already finished|nothing to cancel/i.test(
            e.message,
          );
          if (isAlreadyDone) {
            notify(`${title}: ${e.message}`, { kind: "success" });
          } else {
            notify(
              isCancel
                ? `${title}: install cancelled`
                : `${title}: install failed — ${friendlyErrorMessage(e.message)}`,
              { kind: isCancel ? "success" : "error" },
            );
          }
        }
      }
    },
  });

  useEvent({
    event: "gameStatusChanged",
    handler: () => {
      // Install-completion toast lives on the App-level
      // `useGlobalInstallToasts` hook so it survives detail/settings
      // navigation. Here we only reload the catalog state.
      void loadStoresAndGames();
    },
  });
  useEvent({
    event: "libraryRefreshed",
    handler: () => {
      setRefreshing(false);
      void loadStoresAndGames();
    },
  });

  // Reconcile installPct against the latest games snapshot. We hold
  // onto installPct entries past `pipelineEvent.complete` so the
  // tile doesn't flash back to "Install" during the
  // addToSteam/artwork tail. Once the reload settles and the game
  // is no longer in "library" status, drop the entry — the tile's
  // pickTileAction takes over and shows "Play".
  useEffect(() => {
    setInstallPct((prev) => {
      let changed = false;
      const next: Record<string, number> = {};
      for (const [id, pct] of Object.entries(prev)) {
        const g = games.find((x) => x.id === id);
        if (g && g.status !== "library") {
          changed = true; // drop — install finalized
        } else {
          next[id] = pct;
        }
      }
      return changed ? next : prev;
    });
  }, [games]);

  const filteredGames = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = games;
    if (tab === "installed") list = list.filter((g) => g.status !== "library");
    if (tab === "downloads") list = list.filter((g) => installPct[g.id] !== undefined);
    if (q) list = list.filter((g) => g.title.toLowerCase().includes(q));
    return list;
  }, [games, search, tab, installPct]);

  // Active-install count for the Downloads tab badge. Read straight
  // off installPct (the source of truth on the frontend); the
  // games-reconciliation effect ensures stale entries are pruned
  // once the title's status flips off "library".
  const downloadCount = useMemo(
    () => Object.keys(installPct).length,
    [installPct],
  );

  // ── Onboarding states — preflight not ok, or not authed ─────────────
  const activeStoreInfo = stores.find((s) => s.id === activeStore);
  const showLegendaryInstall = preflight && !preflight.ok && preflight.canSelfInstall;
  const showAuth =
    preflight?.ok && activeStoreInfo?.authStatus !== "authed";

  const startSelfInstall = async () => {
    setSelfInstallPct(0);
    try {
      await call("selfInstallTooling", activeStore);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[store-bridge] self-install failed", err);
      setSelfInstallPct(null);
      // Surface the failure — without this the button just resets
      // to "Install legendary" and the user has no idea their
      // network failed, the rate limit hit, or the pinned tag is
      // bogus.
      notify(`Couldn't install legendary — ${friendlyErrorMessage(msg)}`, {
        kind: "error",
      });
    }
  };

  const startAuth = async () => {
    setAuthBusy(true);
    let opened = false;
    try {
      const { url } = (await call("startAuth", activeStore)) as { url: string };
      setAuthUrl(url);
      // Hand the URL off to the quick-links plugin, which launches
      // the user's chosen browser via a Steam shortcut. quick-links'
      // launchUrl resolves with a `{ launched: false, reason,
      // message }` payload when no browser is registered (the most
      // common case for a fresh gaming-mode install). Surface the
      // backend's actionable message as a toast so the user knows
      // to open Quick Links settings and install Firefox/Chrome,
      // and keep the overlay open so they can read the URL and
      // paste the code manually as a fallback.
      try {
        const r = (await browser.call("launchUrl", url)) as
          | { launched: true }
          | { launched: false; reason: string; message: string };
        if (r.launched) {
          opened = true;
        } else {
          notify(r.message, { kind: "error" });
        }
      } catch {
        // RPC itself failed (quick-links plugin disabled, transport
        // blip) — degrade to the manual-URL surface, keep overlay open.
      }
    } catch (err) {
      // startAuth on the driver itself failed (legendary missing,
      // driver doesn't expose auth, etc.) — surface a toast so the
      // user isn't stuck staring at an unchanged Sign in button.
      const msg = err instanceof Error ? err.message : String(err);
      notify(`Sign-in failed — ${friendlyErrorMessage(msg)}`, { kind: "error" });
    } finally {
      setAuthBusy(false);
      // Same shape as the launch button — once the browser shortcut
      // is dispatched, dismiss the overlay so it doesn't obscure
      // Steam's launch UI / the Epic login page. We only close on a
      // successful launchUrl call; the manual-paste fallback keeps
      // the overlay open so the user can see the URL and the auth-
      // code input.
      if (opened) dismissOverlay();
    }
  };

  const completeAuth = async () => {
    const code = extractAuthCode(authCode);
    if (!code) return;
    setAuthBusy(true);
    try {
      await call("completeAuth", activeStore, code);
      setAuthCode("");
      setAuthUrl(null);
      await loadStoresAndGames();
    } catch (err) {
      // Scrub the code from any echo in the error message before
      // logging. Backend's completeAuth already does this on the
      // legendary stderr path, but a network/transport-layer error
      // could include the args we sent.
      const raw = err instanceof Error ? err.message : String(err);
      const safe = code ? raw.split(code).join("<redacted>") : raw;
      console.error("[store-bridge] auth failed:", safe);
      notify(`Sign-in failed — ${friendlyErrorMessage(safe)}`, { kind: "error" });
    } finally {
      setAuthBusy(false);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      await call("refreshLibrary", activeStore);
    } catch {
      setRefreshing(false);
    }
  };

  const runScan = async () => {
    const r = (await call("scanForInstalls")) as { detected: DetectedInstall[] };
    setDetected(r.detected);
    setTab("detected");
  };

  return (
    <div className="flex flex-col h-full">
      <PluginHeader>
        <h2 className="text-lg font-semibold text-base-content m-0">Store Bridge</h2>
        <div className="ml-auto flex items-center gap-2">
          <SearchField value={search} onChange={setSearch} placeholder="Search games..." />
          <IconButton aria-label="Refresh library" onClick={refresh} disabled={refreshing}>
            <FaRotate />
          </IconButton>
          <IconButton aria-label="Settings" onClick={nav.toSettings}>
            <FaGear />
          </IconButton>
        </div>
      </PluginHeader>

      {/* Store chip row — only renders once we have >1 driver registered.
          Uses SegmentedItem so each chip is d-pad-reachable (issue #134).
          The raw `<button>` previously used here had no useFocusable
          wiring, so the gamepad couldn't switch active stores. */}
      {stores.length > 1 && (
        <div className="segmented gap-2 p-3 border-b border-base-300/40">
          {stores.map((s) => (
            <SegmentedItem
              key={s.id}
              active={activeStore === s.id}
              onSelect={() => setActiveStore(s.id)}
              style={{ fontSize: 12 }}
            >
              {s.displayName}
            </SegmentedItem>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div className="px-3 pt-2">
        <TabBar
          tabs={TAB_DEFS.map((t) => ({
            id: t.id,
            // Surface the active-download count on the Downloads
            // tab so the user can see at a glance that an install
            // is in flight even when they're on a different tab.
            label:
              t.id === "downloads" && downloadCount > 0
                ? `${t.label} (${downloadCount})`
                : t.label,
          }))}
          activeTab={tab}
          onTabChange={(id) => setTab(id as TabId)}
        />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        {/* Self-install legendary CTA. */}
        {showLegendaryInstall && (
          <Panel title={`Install ${activeStore === "epic" ? "legendary" : "store tooling"}`}>
            <Text>
              {preflight?.installHint ??
                `${activeStoreInfo?.displayName ?? activeStore} needs a CLI tool that isn't installed yet.`}
            </Text>
            {selfInstallPct !== null && (
              <div className="mt-3">
                <Text variant="secondary">Downloading… {selfInstallPct}%</Text>
                <div className="w-full h-2 bg-base-300 rounded-full overflow-hidden mt-1">
                  <div
                    className="h-full bg-primary"
                    style={{ width: `${selfInstallPct}%` }}
                  />
                </div>
              </div>
            )}
            <div className="mt-3 flex gap-2">
              <Button
                variant="primary"
                onClick={startSelfInstall}
                disabled={selfInstallPct !== null}
              >
                {selfInstallPct !== null ? "Installing…" : "Install legendary"}
              </Button>
            </div>
          </Panel>
        )}

        {/* Auth flow. */}
        {showAuth && (
          <Panel title="Sign in to Epic Games">
            <Text>
              1) Tap <strong>Open login page</strong>. Your browser opens
              to Epic's sign-in.
            </Text>
            <Text>
              2) Sign in. Epic shows a page of JSON text — don't worry
              about reading it. Select all of it and copy. Anything
              works: the whole JSON, just the URL on the page, or just
              the code — we'll figure out the right value.
            </Text>
            <Text>
              3) Paste into the field below — open the on-screen
              keyboard (Steam button + X on the Deck), tap the
              clipboard tile, then click Complete sign-in. On a
              physical keyboard Ctrl+V also works.
            </Text>
            {authUrl && (
              <div className="mt-2 px-3 py-2 rounded bg-base-300 text-sm break-all">
                {authUrl}
              </div>
            )}
            <div className="mt-3 flex gap-2 items-center flex-wrap">
              <Button onClick={startAuth} disabled={authBusy}>
                Open login page
              </Button>
            </div>
            <div className="mt-3 flex gap-2 items-center">
              <TextInput
                value={authCode}
                onChange={setAuthCode}
                placeholder="Auth code / JSON / redirect URL"
                style={{ flex: 1 }}
              />
              <Button
                variant="primary"
                onClick={completeAuth}
                disabled={authBusy || !extractAuthCode(authCode)}
              >
                Complete sign-in
              </Button>
            </div>
          </Panel>
        )}

        {/* Detected installs tab */}
        {tab === "detected" && (
          <Panel title="Detected installs">
            {detected.length === 0 ? (
              <div className="flex flex-col gap-3 items-start">
                <Text>
                  Add a scan path in Settings, then run a scan to detect
                  already-installed Epic games on disk.
                </Text>
                <div className="flex gap-2">
                  <Button onClick={runScan}>Scan now</Button>
                  <Button variant="neutral" onClick={nav.toSettings}>
                    Open Settings
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {detected.map((d) => (
                  <DetectedRow key={`${d.storeId}:${d.dir}`} d={d} reload={loadStoresAndGames} />
                ))}
              </div>
            )}
          </Panel>
        )}

        {/* Game grid */}
        {tab !== "detected" && (
          <>
            {loading && (
              <div className="flex justify-center py-8">
                <Spinner />
              </div>
            )}
            {!loading && filteredGames.length === 0 && preflight?.ok && (
              <Text variant="secondary">
                {tab === "downloads"
                  ? "Nothing downloading. Installs you start from the Library tab appear here."
                  : "No games yet. Try refreshing the library."}
              </Text>
            )}
            {!loading && filteredGames.length > 0 && (
              <div className="grid grid-cols-4 sidebar-collapsed:grid-cols-6 gap-2.5">
                {filteredGames.map((g) => (
                  <CatalogTile
                    key={`${g.storeId}:${g.id}`}
                    g={g}
                    progress={installPct[g.id]}
                    onOpen={() => nav.toDetail(g.storeId, g.id)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function CatalogTile({
  g,
  progress,
  onOpen,
}: {
  g: GameInfo;
  progress?: number;
  onOpen: () => void;
}) {
  const { call } = useBackend("store-bridge");
  const isInstalling = typeof progress === "number";
  const action = pickTileAction(g, isInstalling);

  // ── Bottom-of-image overlay ─────────────────────────────────
  //
  // Two things compete for this slot: the store name (always
  // shown so a multi-store catalog reads clearly at a glance)
  // and the install progress strip (only while a download is in
  // flight). Stacking them vertically keeps both visible without
  // the progress bar covering the store badge.
  const overlayBadges = (
    <div className="w-full flex flex-col gap-1">
      {isInstalling && (
        <div className="w-full flex items-center gap-2">
          <div className="flex-1 h-1.5 bg-black/50 rounded-full overflow-hidden">
            <div className="h-full bg-primary" style={{ width: `${progress}%` }} />
          </div>
          <span className="text-[10px] font-mono text-white drop-shadow">
            {progress.toFixed(0)}%
          </span>
        </div>
      )}
      <span
        className="self-start inline-flex rounded-full"
        style={{ background: "var(--bg-inset)" }}
      >
        <Badge variant="info" size="xs">
          {STORE_LABELS[g.storeId] ?? g.storeId}
        </Badge>
      </span>
    </div>
  );

  const topRightBadge =
    g.status !== "library" ? (
      <Badge variant="primary" size="xs">
        {g.status === "imported" ? "Imported" : "Installed"}
      </Badge>
    ) : undefined;

  const runAction = async () => {
    try {
      switch (action.kind) {
        case "install":
          await call("installGame", g.storeId, g.id);
          break;
        case "cancel":
          await call("cancelInstall", g.storeId, g.id);
          break;
        case "launch":
          await call("launchGame", g.storeId, g.id);
          // Same shape as the detail-view launch button — close the
          // overlay so Steam's launch UI is visible.
          dismissOverlay();
          break;
        case "add-to-steam":
          await call("addInstalledToSteam", g.storeId, g.id);
          notify(`${g.title}: added to Steam`);
          break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify(`${g.title}: ${friendlyErrorMessage(msg)}`, { kind: "error" });
    }
  };

  return (
    <GameCard
      title={g.title}
      imageUrl={g.coverUrl ?? ""}
      onPick={onOpen}
      topRightBadge={topRightBadge}
      overlayBadges={overlayBadges}
      action={
        // GameCard wraps its body in an onClick that fires onPick.
        // Stop propagation here so tapping the button only runs the
        // primary action — doesn't *also* navigate to detail. Same
        // pattern recomp's catalog tile uses.
        <div className="w-full" onClick={(e) => e.stopPropagation()}>
          <Button
            size="sm"
            variant={action.variant}
            disabled={action.disabled}
            onClick={runAction}
          >
            {action.label}
          </Button>
        </div>
      }
    />
  );

}

type TileAction =
  | { kind: "install"; label: string; variant: "primary"; disabled?: boolean }
  | { kind: "cancel"; label: string; variant: "danger"; disabled?: boolean }
  | { kind: "launch"; label: string; variant: "primary"; disabled?: boolean }
  | { kind: "add-to-steam"; label: string; variant: "secondary"; disabled?: boolean };

function pickTileAction(g: GameInfo, isInstalling: boolean): TileAction {
  if (isInstalling) {
    // During install the tile's primary button becomes Cancel —
    // the install state is already visible in the progress strip
    // above, so the button doubles as the abort affordance rather
    // than a disabled "Installing…" placeholder.
    return { kind: "cancel", label: "Cancel", variant: "danger" };
  }
  if (g.status === "library") {
    return { kind: "install", label: "Install", variant: "primary" };
  }
  // Installed or imported — needs to land in Steam before launch
  // works via `steam://rungameid/`.
  if (g.installed?.addedToSteam) {
    return { kind: "launch", label: "Play", variant: "primary" };
  }
  return { kind: "add-to-steam", label: "Add to Steam", variant: "secondary" };
}

function DetectedRow({
  d,
  reload,
}: {
  d: DetectedInstall;
  reload: () => Promise<void>;
}) {
  const { call } = useBackend("store-bridge");
  const [busy, setBusy] = useState(false);
  const doImport = async () => {
    setBusy(true);
    try {
      await call("importDetected", d.storeId, d.gameId, d.dir);
      await reload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center gap-3 py-2 border-b border-base-300/40 last:border-0">
      <div className="flex-1 min-w-0">
        <Text>{d.title || d.gameId || "(unknown)"}</Text>
        <Text variant="secondary">{d.dir}</Text>
      </div>
      <Button onClick={doImport} disabled={busy || !d.gameId}>
        {busy ? "Importing…" : "Import"}
      </Button>
    </div>
  );
}

// ── Detail view ──────────────────────────────────────────────────────────

interface RemoteSize {
  downloadSize?: number;
  installSize?: number;
  version?: string;
}

function DetailView({ storeId, gameId }: { storeId: StoreId; gameId: string }) {
  const nav = useNav();
  const { call, useEvent } = useBackend("store-bridge");
  const [game, setGame] = useState<GameInfo | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installPct, setInstallPct] = useState<number | null>(null);

  // Re-derive `installing` from the backend's in-flight registry
  // when the detail view mounts. Without this, leaving and coming
  // back during a long install resets the local state and the
  // button flips back to "Install" until the next progress event
  // lands — which can be seconds away on a slow legendary stream.
  useEffect(() => {
    let cancelled = false;
    void call("getInProgressInstall", storeId, gameId).then((raw: unknown) => {
      if (cancelled) return;
      const inFlight = raw as InProgressInstall | null;
      if (inFlight) {
        setInstalling(true);
        setInstallPct(inFlight.percent);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [call, storeId, gameId]);
  // Remote size for uninstalled titles. Null = not loaded yet, then
  // either populated with the estimate or set to `{}` when the
  // driver can't fetch it. Lazy-fetched on mount so the catalog
  // grid stays snappy.
  const [remoteSize, setRemoteSize] = useState<RemoteSize | null>(null);

  const load = useCallback(async () => {
    const g = (await call("getGameDetail", storeId, gameId)) as GameInfo | null;
    setGame(g);
  }, [call, storeId, gameId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Pull a download + install size estimate for not-yet-installed
  // titles. Skipped once we have a local install record (the store
  // record's installSize is authoritative once on disk).
  useEffect(() => {
    if (!game) return;
    if (game.installed) return;
    if (remoteSize !== null) return;
    let cancelled = false;
    void call("getStoreGameSize", storeId, gameId)
      .then((r: unknown) => {
        if (cancelled) return;
        setRemoteSize((r as RemoteSize | null) ?? {});
      })
      .catch(() => {
        // Driver doesn't expose getRemoteSize, transport blip, etc.
        // Fall through to the "Unavailable" branch instead of leaving
        // the spinner running forever.
        if (cancelled) return;
        setRemoteSize({});
      });
    return () => {
      cancelled = true;
    };
  }, [game, remoteSize, call, storeId, gameId]);

  useEvent({
    event: "pipelineEvent",
    handler: (raw: unknown) => {
      const e = raw as PipelineEvent;
      if (e.gameId !== gameId) return;
      if (e.kind === "progress") {
        // Any progress event implies the install is still running.
        // Setting `installing` here covers two cases the on-mount
        // probe misses: (a) install started after we mounted, (b)
        // we mounted in the brief window before the backend's
        // first emit. Idempotent — flips `false → true` once.
        setInstalling(true);
        setInstallPct(e.percent);
      }
      if (e.kind === "complete") {
        // Don't clear `installing` here — pipelineEvent.complete
        // fires when the download finishes, but the backend's
        // addToSteam/artwork tail is still running. Clearing now
        // would race the reload and briefly show "Install" again.
        // Drop the progress bar (download is done) but hold the
        // button-cluster state until load() returns with
        // game.installed populated, then a status-effect below
        // clears `installing`.
        setInstallPct(null);
        void load();
      } else if (e.kind === "error") {
        // Add-to-Steam failures share the gameId. The App-level
        // gameStatusChanged handler will toast them with the
        // honest "add to Steam failed" message; treating it as an
        // install error here would double-toast and lie about the
        // install state. Drop it before the cluster logic below.
        if (e.id.includes(PIPELINE_ADD_TO_STEAM_PREFIX)) return;
        // Install failed — the game stays at status="library", so
        // the status-effect below won't trigger. Clear locally
        // here so the button re-enables.
        setInstallPct(null);
        setInstalling(false);
        const friendly = friendlyErrorMessage(e.message);
        const isCancel = /cancelled/i.test(e.message);
        const isAlreadyDone = /already finished|nothing to cancel/i.test(
          e.message,
        );
        if (isAlreadyDone) {
          notify(`${game?.title ?? "Install"}: ${e.message}`, {
            kind: "success",
          });
        } else {
          notify(
            isCancel
              ? `${game?.title ?? "Install"} cancelled`
              : `Install failed — ${friendly}`,
            { kind: isCancel ? "success" : "error" },
          );
        }
        void load();
      }
    },
  });

  useEvent({
    event: "gameStatusChanged",
    handler: () => {
      void load();
    },
  });

  // Clear `installing` once the reload settles and the game's
  // status reflects the new install. Without this, the
  // pipelineEvent.complete handler above would race the reload
  // and the button cluster would flash to "Install" before
  // becoming "Launch via Steam".
  // We deliberately key this on `game?.status` (the only field we
  // read) rather than the whole `game` object — depending on the
  // full game would fire on any field change instead of only when
  // the install state flips.
  const gameStatus = game?.status;
  useEffect(() => {
    if (game && gameStatus !== "library") {
      setInstalling(false);
    }
  }, [game, gameStatus]);

  if (!game) {
    return (
      <div className="flex flex-col h-full">
        <PluginHeader>
          <h2 className="text-lg font-semibold text-base-content m-0">Loading…</h2>
          <div className="ml-auto flex items-center gap-2">
            <HeaderBackButton onBack={nav.toList} title="Back to library" />
          </div>
        </PluginHeader>
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      </div>
    );
  }

  const installed = game.installed;
  const isInstalled = !!installed;
  const formattedRelease = formatReleaseDate(game.releaseDate);
  // Prefer the local install record's size, then the library entry's,
  // then the lazily-fetched remote estimate. Lets uninstalled titles
  // show "24 GiB" after the info call returns, without us having to
  // re-pivot the whole Details panel.
  const formattedSize = formatBytes(
    installed?.installSize ?? game.installSize ?? remoteSize?.installSize,
  );
  const formattedDownload = !isInstalled
    ? formatBytes(remoteSize?.downloadSize)
    : null;
  // Size-lookup state machine:
  //   null  → fetch hasn't fired
  //   {}    → fetched, driver returned no size (legendary not authed,
  //           CLI missing, etc.) — render explicit "Size unavailable"
  //   {…}   → got something; one of formattedSize/formattedDownload
  //           is non-null and the explicit row renders below.
  const sizeProbing = !isInstalled && remoteSize === null;
  const sizeUnavailable =
    !isInstalled &&
    remoteSize !== null &&
    !formattedSize &&
    !formattedDownload;

  return (
    <div className="flex flex-col h-full">
      <PluginHeader>
        <h2 className="text-lg font-semibold text-base-content m-0 truncate">
          {game.title}
        </h2>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <HeaderBackButton onBack={nav.toList} title="Back to library" />
        </div>
      </PluginHeader>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
        {game.heroUrl && (
          <img
            src={game.heroUrl}
            alt=""
            className="w-full rounded-lg object-cover max-h-64"
          />
        )}

        <Panel title="Actions">
          {installPct !== null && (
            <div className="mb-3">
              <Text variant="secondary">Installing… {installPct.toFixed(1)}%</Text>
              <div className="w-full h-2 bg-base-300 rounded-full overflow-hidden mt-1">
                <div className="h-full bg-primary" style={{ width: `${installPct}%` }} />
              </div>
            </div>
          )}
          <div className="flex gap-2 flex-wrap">
            {!isInstalled && !installing && (
              <Button
                variant="primary"
                onClick={async () => {
                  setInstalling(true);
                  setInstallPct(0);
                  try {
                    await call("installGame", storeId, gameId);
                  } catch {
                    setInstalling(false);
                    setInstallPct(null);
                  }
                }}
              >
                Install
              </Button>
            )}
            {!isInstalled && installing && (
              <Button
                variant="danger"
                onClick={async () => {
                  // cancelInstall on the backend SIGTERMs legendary,
                  // wipes the partial install dir, and emits the
                  // error event that clears installing/installPct
                  // via the pipelineEvent handler.
                  try {
                    await call("cancelInstall", storeId, gameId);
                  } catch (err) {
                    notify(
                      `Cancel failed — ${friendlyErrorMessage(
                        err instanceof Error ? err.message : String(err),
                      )}`,
                      { kind: "error" },
                    );
                  }
                }}
              >
                Cancel install
              </Button>
            )}
            {isInstalled && installed.addedToSteam && (
              <Button
                variant="primary"
                onClick={async () => {
                  try {
                    await call("launchGame", storeId, gameId);
                    // Close the overlay so Steam's launch UI / the
                    // game window are immediately visible. Same shape
                    // recomp uses after firing `steam://rungameid/…`.
                    dismissOverlay();
                  } catch (err) {
                    notify(
                      `Launch failed — ${friendlyErrorMessage(
                        err instanceof Error ? err.message : String(err),
                      )}`,
                      { kind: "error" },
                    );
                  }
                }}
              >
                Launch via Steam
              </Button>
            )}
            {isInstalled && !installed.addedToSteam && (
              <Button
                onClick={async () => {
                  try {
                    await call("addInstalledToSteam", storeId, gameId);
                    // Belt-and-braces: the backend also emits
                    // `gameStatusChanged` after this, but reloading
                    // synchronously here means the buttons swap as
                    // soon as the RPC resolves rather than waiting on
                    // the event round-trip.
                    await load();
                    notify(`${game.title}: added to Steam`);
                  } catch (err) {
                    notify(
                      `Add to Steam failed — ${friendlyErrorMessage(
                        err instanceof Error ? err.message : String(err),
                      )}`,
                      { kind: "error" },
                    );
                  }
                }}
              >
                Add to Steam
              </Button>
            )}
            {isInstalled && installed.addedToSteam && (
              <Button
                onClick={async () => {
                  try {
                    await call("removeFromSteam", storeId, gameId);
                    await load();
                  } catch (err) {
                    notify(
                      `Remove from Steam failed — ${friendlyErrorMessage(
                        err instanceof Error ? err.message : String(err),
                      )}`,
                      { kind: "error" },
                    );
                  }
                }}
              >
                Remove from Steam
              </Button>
            )}
            {isInstalled && (
              <Button
                variant="neutral"
                onClick={async () => {
                  try {
                    await call("uninstallGame", storeId, gameId);
                    await load();
                  } catch (err) {
                    notify(
                      `Uninstall failed — ${friendlyErrorMessage(
                        err instanceof Error ? err.message : String(err),
                      )}`,
                      { kind: "error" },
                    );
                  }
                }}
              >
                Uninstall
              </Button>
            )}
          </div>
        </Panel>

        {(game.description || game.longDescription) && (
          <Panel title="About">
            {game.longDescription && (
              <Text>{game.longDescription}</Text>
            )}
            {!game.longDescription && game.description && (
              <Text>{game.description}</Text>
            )}
          </Panel>
        )}

        {(game.developer ||
          game.publisher ||
          formattedRelease ||
          formattedSize ||
          formattedDownload ||
          sizeProbing ||
          sizeUnavailable ||
          (game.platforms && game.platforms.length > 0) ||
          (game.tags && game.tags.length > 0)) && (
          <Panel title="Details">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              {game.developer && <Detail label="Developer" value={game.developer} />}
              {game.publisher && <Detail label="Publisher" value={game.publisher} />}
              {formattedRelease && <Detail label="Released" value={formattedRelease} />}
              {formattedSize && (
                <Detail
                  label={isInstalled ? "Size on disk" : "Install size"}
                  value={formattedSize}
                />
              )}
              {formattedDownload && (
                <Detail label="Download" value={formattedDownload} />
              )}
              {sizeProbing && !formattedSize && (
                <Detail label="Install size" value="Checking…" />
              )}
              {sizeUnavailable && (
                <Detail label="Install size" value="Unavailable" />
              )}
              {game.platforms && game.platforms.length > 0 && (
                <Detail label="Platforms" value={game.platforms.join(", ")} />
              )}
              {game.tags && game.tags.length > 0 && (
                <Detail label="Tags" value={game.tags.join(", ")} />
              )}
            </div>
          </Panel>
        )}

        {isInstalled && (
          <Panel title="Install">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              {installed.version && <Detail label="Version" value={installed.version} />}
              <Detail label="Source" value={installed.source} />
              <Detail
                label="Steam"
                value={installed.addedToSteam ? "Added" : "Not added"}
              />
              <Detail
                label="Path"
                value={installed.installDir}
                fullWidth
                monospace
              />
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}

function Detail({
  label,
  value,
  fullWidth,
  monospace,
}: {
  label: string;
  value: string;
  fullWidth?: boolean;
  monospace?: boolean;
}) {
  return (
    <div
      className={`${fullWidth ? "col-span-2" : ""} flex flex-col gap-0.5 min-w-0`}
    >
      <span className="text-[10px] font-semibold uppercase tracking-wider text-base-content/40">
        {label}
      </span>
      <span
        className={`text-base-content/85 truncate ${monospace ? "font-mono text-[11px]" : ""}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function formatBytes(bytes?: number): string | null {
  if (!bytes || bytes <= 0) return null;
  const gib = bytes / (1024 * 1024 * 1024);
  if (gib >= 1) return `${gib.toFixed(2)} GiB`;
  const mib = bytes / (1024 * 1024);
  return `${mib.toFixed(1)} MiB`;
}

function formatReleaseDate(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // Use the locale's short month + year — Epic's release dates aren't
  // always accurate to the day, so a Mmm YYYY format reads cleaner.
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

/**
 * Rewrite raw legendary stderr / Error messages into something a
 * non-technical user can act on. We keep the original message as
 * the fall-through so anything we don't have a heuristic for
 * still surfaces — opaque is better than swallowed.
 */
function friendlyErrorMessage(raw: string): string {
  const m = raw.toLowerCase();
  if (/login session expired|refresh failed|no account|not logged in/.test(m)) {
    return "Epic sign-in expired. Sign out and sign in again in Settings.";
  }
  if (/no space left|enospc|disk full/.test(m)) {
    return "Out of disk space. Free up space or change the install location.";
  }
  if (/nameresolution|connection refused|network is unreachable|connection reset|timed out/.test(m)) {
    return "Couldn't reach Epic. Check your internet and retry.";
  }
  if (/blocked by a concurrent run/.test(m)) {
    return "Another install was running and blocked this one. Try again.";
  }
  if (/can't determine the launch executable/i.test(raw)) {
    // Already a friendly message — pass through.
    return raw;
  }
  // Trim very long stderr blobs so the toast stays legible.
  const trimmed = raw.trim();
  return trimmed.length > 160 ? trimmed.slice(0, 157) + "…" : trimmed;
}

// ── Settings view ────────────────────────────────────────────────────────

function SettingsView() {
  const nav = useNav();
  const { call } = useBackend("store-bridge");
  const sgdb = useBackend("steamgriddb");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [stores, setStores] = useState<StoreInfo[]>([]);
  const [scanInput, setScanInput] = useState("");
  const [scanBusy, setScanBusy] = useState(false);
  const [preflightHints, setPreflightHints] = useState<Record<string, PreflightResult>>({});
  // null = probing, true/false = settled. Surfaces a hint so the
  // user knows whether their next install will get nice artwork
  // before they fire it — mirroring recomp's Settings page.
  const [sgdbConfigured, setSgdbConfigured] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    setSettings((await call("getSettings")) as Settings);
    const ss = (await call("getStores")) as StoreInfo[];
    setStores(ss);
    const pfs: Record<string, PreflightResult> = {};
    for (const s of ss) {
      pfs[s.id] = (await call("checkPreflight", s.id)) as PreflightResult;
    }
    setPreflightHints(pfs);
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    // Probe the steamgriddb plugin's `hasApiKey` RPC. Rejection =
    // plugin not installed/enabled — treat the same as "no key".
    void sgdb
      .call("hasApiKey")
      .then((ok: unknown) => setSgdbConfigured(!!ok))
      .catch(() => setSgdbConfigured(false));
  }, [sgdb]);

  if (!settings) {
    return (
      <div className="flex flex-col h-full">
        <PluginHeader>
          <h2 className="text-lg font-semibold text-base-content m-0">Settings</h2>
          <div className="ml-auto flex items-center gap-2">
            <HeaderBackButton onBack={nav.toList} title="Back to library" />
          </div>
        </PluginHeader>
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      </div>
    );
  }

  const saveBinary = async (v: string) => {
    try {
      const epicOverride = settings.driverOverrides?.epic ?? {};
      const next = (await call("updateSettings", {
        driverOverrides: {
          ...settings.driverOverrides,
          epic: { ...epicOverride, binary: v },
        },
      })) as Settings;
      setSettings(next);
      notify("Legendary binary saved");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify(`Couldn't save binary path — ${friendlyErrorMessage(msg)}`, {
        kind: "error",
      });
    }
  };

  const addScan = async () => {
    if (!scanInput.trim()) return;
    try {
      const r = (await call("addScanPath", scanInput.trim())) as {
        ok: boolean;
        error?: string;
      };
      if (r.ok) {
        setScanInput("");
        await load();
      } else {
        // Surface the backend's actionable rejection (e.g. the
        // whitelist hint) — without this the input just sits there
        // looking unchanged.
        notify(r.error ?? "Couldn't add scan path", { kind: "error" });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify(`Couldn't add scan path — ${friendlyErrorMessage(msg)}`, {
        kind: "error",
      });
    }
  };

  const removeScan = async (path: string) => {
    try {
      await call("removeScanPath", path);
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify(`Couldn't remove scan path — ${friendlyErrorMessage(msg)}`, {
        kind: "error",
      });
    }
  };

  const runScan = async () => {
    setScanBusy(true);
    try {
      await call("scanForInstalls");
      await load();
    } finally {
      setScanBusy(false);
    }
  };

  const reinstallLegendary = async () => {
    try {
      await call("selfInstallTooling", "epic");
      await load();
    } catch (err) {
      // The pinned-version-not-found error and any other
      // self-install failure surface here. Without the catch the
      // carefully-worded backend message (e.g. "Clear Settings →
      // Pinned legendary version to fall back to latest") would
      // never reach the user — they'd just see the button stop
      // doing anything.
      const msg = err instanceof Error ? err.message : String(err);
      notify(`Reinstall failed — ${friendlyErrorMessage(msg)}`, {
        kind: "error",
      });
    }
  };

  return (
    <div className="flex flex-col h-full">
      <PluginHeader>
        <h2 className="text-lg font-semibold text-base-content m-0">Settings</h2>
        <div className="ml-auto flex items-center gap-2">
          <HeaderBackButton onBack={nav.toList} title="Back to library" />
        </div>
      </PluginHeader>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
        {stores.map((s) => {
          const pf = preflightHints[s.id];
          return (
            <Panel key={s.id} title={`${s.displayName} — preflight`}>
              {pf?.ok && <Text>Ready · auth: {s.authStatus}</Text>}
              {pf && !pf.ok && (
                <>
                  <Text>{pf.installHint ?? `Missing: ${pf.missing.join(", ")}`}</Text>
                  {pf.canSelfInstall && (
                    <div className="mt-2">
                      <Button onClick={reinstallLegendary}>
                        Install tooling
                      </Button>
                    </div>
                  )}
                </>
              )}
            </Panel>
          );
        })}

        <Panel title="Epic account">
          <Text variant="secondary">
            Sign out clears your locally-cached Epic credentials. The library
            view will prompt for sign-in again next time you open it.
          </Text>
          <div className="mt-2">
            <Button
              variant="neutral"
              onClick={async () => {
                try {
                  await call("signOut", "epic");
                  await load();
                  notify("Signed out of Epic Games");
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  notify(`Sign-out failed — ${friendlyErrorMessage(msg)}`, {
                    kind: "error",
                  });
                }
              }}
            >
              Sign out of Epic
            </Button>
          </div>
        </Panel>

        <Panel title="Legendary binary">
          <Text variant="secondary">
            Override the resolved path if you manage legendary yourself (pipx, distro
            package, etc.). Leave blank to use the bundled/PATH binary.
          </Text>
          <div className="mt-2 flex gap-2 items-center">
            <TextInput
              value={settings.driverOverrides?.epic?.binary ?? ""}
              onChange={(v) =>
                setSettings({
                  ...settings,
                  driverOverrides: {
                    ...settings.driverOverrides,
                    epic: { ...settings.driverOverrides?.epic, binary: v },
                  },
                })
              }
              placeholder="/usr/bin/legendary"
              style={{ flex: 1 }}
            />
            <Button onClick={() => saveBinary(settings.driverOverrides?.epic?.binary ?? "")}>
              Save
            </Button>
          </div>
          <div className="mt-3">
            <Text variant="secondary">
              Pin a specific upstream legendary release (e.g. <code>v0.20.34</code>). Empty
              means "always pull latest" — see the inline trust-model note in the source
              if you want to vet a release manually before updating.
            </Text>
          </div>
          <div className="mt-2 flex gap-2 items-center">
            <TextInput
              value={settings.driverOverrides?.epic?.pinnedVersion ?? ""}
              onChange={(v) =>
                setSettings({
                  ...settings,
                  driverOverrides: {
                    ...settings.driverOverrides,
                    epic: { ...settings.driverOverrides?.epic, pinnedVersion: v },
                  },
                })
              }
              placeholder="latest"
              style={{ flex: 1 }}
            />
            <Button
              onClick={async () => {
                try {
                  const epicOverride = settings.driverOverrides?.epic ?? {};
                  // Trim + cap so a multi-line / megabyte paste
                  // doesn't round-trip into state.json. Backend's
                  // regex still catches malformed values; this is
                  // just hygiene.
                  const raw =
                    settings.driverOverrides?.epic?.pinnedVersion ?? "";
                  const cleaned = raw
                    .trim()
                    .replace(/[^A-Za-z0-9._-]/g, "")
                    .slice(0, 64);
                  const next = (await call("updateSettings", {
                    driverOverrides: {
                      ...settings.driverOverrides,
                      epic: {
                        ...epicOverride,
                        pinnedVersion: cleaned,
                      },
                    },
                  })) as Settings;
                  setSettings(next);
                  notify(
                    cleaned
                      ? `Pinned legendary to ${cleaned}`
                      : "Cleared legendary pin (will pull latest)",
                  );
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  notify(
                    `Couldn't save pinned version — ${friendlyErrorMessage(msg)}`,
                    { kind: "error" },
                  );
                }
              }}
            >
              Save
            </Button>
          </div>
          <div className="mt-2">
            <Button variant="neutral" onClick={reinstallLegendary}>
              Reinstall / update legendary
            </Button>
          </div>
        </Panel>

        <Panel title="Artwork">
          {sgdbConfigured === null ? (
            <Text variant="secondary">Checking…</Text>
          ) : sgdbConfigured ? (
            <Text variant="secondary">
              SteamGridDB plugin configured. Custom artwork will apply
              automatically on each install.
            </Text>
          ) : (
            <Text variant="secondary">
              SteamGridDB plugin isn't set up. Shortcuts will fall back to
              Epic's own cover art — set an API key in the SteamGridDB
              plugin for higher-quality artwork.
            </Text>
          )}
        </Panel>

        <Panel title="Scan paths">
          <Text variant="secondary">
            Folders to walk when looking for already-installed games. The walker
            stops at the first Epic <code>.egstore</code> marker it finds and
            offers to import the install via legendary.
          </Text>
          <div className="mt-2 flex flex-col gap-2">
            {settings.scanPaths.length === 0 && (
              <Text variant="secondary">(none yet)</Text>
            )}
            {settings.scanPaths.map((p) => (
              <div
                key={p}
                className="flex items-center gap-2 py-1 border-b border-base-300/30 last:border-0"
              >
                <Text style={{ flex: 1, fontFamily: "monospace" }}>{p}</Text>
                <IconButton aria-label={`Remove ${p}`} onClick={() => removeScan(p)}>
                  <FaTrash />
                </IconButton>
              </div>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <TextInput
              value={scanInput}
              onChange={setScanInput}
              placeholder="/absolute/path/to/games"
              style={{ flex: 1 }}
            />
            <IconButton aria-label="Add scan path" onClick={addScan}>
              <FaPlus />
            </IconButton>
          </div>
          <div className="mt-3 flex gap-2">
            <Button onClick={runScan} disabled={scanBusy || settings.scanPaths.length === 0}>
              {scanBusy ? "Scanning…" : "Scan now"}
            </Button>
          </div>
        </Panel>
      </div>
    </div>
  );
}

// ── Mount ────────────────────────────────────────────────────────────────

export const mount = mountComponent(App);
export const mountHeader = mountHeaderStub;

import { useState, useEffect, useCallback, useMemo } from "react";

// Side-effect import: pulls in the `declare global { interface Window {
// __SL_SOUNDS__, __SL_ORIGINAL_SOUNDS__ } }` augmentation that lives
// next to the consumer so the typing follows the plugin, not the global
// catch-all.
import "./lib/types";
import { SOUND_EVENTS, type SoundEvent, type CommunityPackInfo } from "./shared";

export { MdVolumeUp as icon } from "react-icons/md";
import {
  Badge,
  Button,
  HeaderBackButton,
  mountComponent,
  mountHeaderStub,
  notify,
  PluginHeader,
  SearchField,
  SegmentedItem,
  Spinner,
  Toggle,
  useBackend,
  useFocusable,
} from "@loadout/ui";
import {
  FaCheck,
  FaFolderOpen,
  FaVolumeHigh,
} from "react-icons/fa6";

interface SoundPackInfo {
  id: string;
  name: string;
  author: string;
  description: string;
  version: string;
  mappedEvents: SoundEvent[];
  ignoredEvents: SoundEvent[];
}

interface PacksStatus {
  state: "pending" | "ready" | "error";
  syncedAt: number | null;
  entryCount: number;
  lastError: string | null;
}

type TabId = "my-packs" | "community";

/**
 * Capture the shell's original sound module exactly once and stash it on a
 * window global, so every module instance of this plugin (init() at startup
 * + mount() when the UI opens are separate `import()` calls) shares the
 * same "originals" — otherwise the second load would capture our own
 * overrides as "original" and breakage compounds.
 */
function getOriginalSounds(): NonNullable<Window["__SL_SOUNDS__"]> | undefined {
  if (!window.__SL_ORIGINAL_SOUNDS__) {
    window.__SL_ORIGINAL_SOUNDS__ = window.__SL_SOUNDS__;
  }
  return window.__SL_ORIGINAL_SOUNDS__;
}

/** Map sound event names to the playXxx method names the UI components call. */
const EVENT_TO_METHOD: Record<string, string> = {
  nav: "playNav",
  select: "playSelect",
  back: "playBack",
  toggleOn: "playToggleOn",
  toggleOff: "playToggleOff",
  sliderUp: "playSliderTick",
  error: "playError",
  sideMenuIn: "playSideMenuIn",
  sideMenuOut: "playSideMenuOut",
  tabTransition: "playTabTransition",
};

/** Shared AudioContext for custom pack playback (matches the sound engine approach). */
let audioCtx: AudioContext | null = null;

function getAudioCtx(): AudioContext | null {
  if (!audioCtx) {
    try { audioCtx = new AudioContext(); } catch { return null; }
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

/** Close + release the shared AudioContext. Called from `onUnload`. */
async function closeAudioCtx(): Promise<void> {
  decodedPackCache.clear();
  decodedPackCacheOrder.length = 0;
  const ctx = audioCtx;
  audioCtx = null;
  if (!ctx) return;
  try { await ctx.close(); } catch { /* best-effort */ }
}

/**
 * LRU cache of decoded AudioBuffer packs keyed by `packId`. Decoding
 * runs `atob` + `decodeAudioData` over every file in the pack — a few
 * MB worst case for music packs. The user toggling Apply To overlay
 * back and forth used to re-decode every byte; this dedupes.
 *
 * The order array is the eviction list; eldest entry leaves when we
 * exceed the cap. 5 packs is enough headroom for "switch between a
 * couple favorites" without growing unboundedly.
 */
type DecodedPack = Record<string, (() => void) | null>;
const PACK_CACHE_MAX = 5;
const decodedPackCache: Map<string, DecodedPack> = new Map();
const decodedPackCacheOrder: string[] = [];

function getCachedPack(packId: string): DecodedPack | null {
  const hit = decodedPackCache.get(packId);
  if (!hit) return null;
  // Refresh LRU position.
  const idx = decodedPackCacheOrder.indexOf(packId);
  if (idx >= 0) decodedPackCacheOrder.splice(idx, 1);
  decodedPackCacheOrder.push(packId);
  return hit;
}

function setCachedPack(packId: string, pack: DecodedPack): void {
  decodedPackCache.set(packId, pack);
  decodedPackCacheOrder.push(packId);
  while (decodedPackCacheOrder.length > PACK_CACHE_MAX) {
    const evict = decodedPackCacheOrder.shift();
    if (evict) decodedPackCache.delete(evict);
  }
}

/** Decode a base64 audio string into an AudioBuffer for Web Audio API playback. */
async function decodeBase64Audio(data: string, _mimeType: string): Promise<AudioBuffer | null> {
  const ac = getAudioCtx();
  if (!ac) return null;
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return await ac.decodeAudioData(bytes.buffer);
  } catch {
    return null;
  }
}

/** Play a decoded AudioBuffer through the Web Audio API. */
function playBuffer(buf: AudioBuffer): void {
  const ac = getAudioCtx();
  if (!ac) return;
  const vol = getOriginalSounds()?.getSoundVolume?.() ?? 0.3;
  if (vol <= 0) return;
  const source = ac.createBufferSource();
  source.buffer = buf;
  const gain = ac.createGain();
  gain.gain.value = vol;
  source.connect(gain);
  gain.connect(ac.destination);
  source.start();
}

/**
 * Install sound overrides into window.__SL_SOUNDS__ so the overlay's
 * sound engine picks up the active pack's audio files.
 *
 * Uses the Web Audio API (AudioContext/AudioBuffer) for playback — the same
 * approach the sound engine uses — since HTML5 Audio elements don't load
 * reliably from the overlay's custom-scheme origin.
 *
 * When `useInOverlay` is false, restores the original sound module
 * so the overlay uses its default Steam / synthesized sounds.
 */
async function installSoundOverrides(
  call: (method: string, ...args: unknown[]) => Promise<unknown>,
  useInOverlay: boolean,
): Promise<void> {
  // If overlay sounds disabled, restore original module
  if (!useInOverlay) {
    window.__SL_SOUNDS__ = getOriginalSounds();
    return;
  }

  const result = (await call("getActivePackMappings")) as {
    packId: string | null;
    mappings: Record<string, { data: string; mimeType: string } | { files: Array<{ data: string; mimeType: string }> }>;
    ignore: string[];
  };

  // Built-in modes don't need custom audio data — restore defaults
  if (result.packId === null || result.packId === "synthesized") {
    window.__SL_SOUNDS__ = getOriginalSounds();
    return;
  }

  // Reuse the decoded buffers for this pack if we've decoded them
  // recently. Eliminates the multi-MB `atob` + `decodeAudioData` round
  // on every Apply To toggle.
  let overrides = getCachedPack(result.packId);
  if (!overrides) {
    overrides = {};

    for (const [event, audioInfo] of Object.entries(result.mappings)) {
      if ("files" in audioInfo) {
        // Multiple files — decode all, pick random on each play
        const buffers = (await Promise.all(
          audioInfo.files.map((f) => decodeBase64Audio(f.data, f.mimeType)),
        )).filter((b): b is AudioBuffer => b !== null);
        if (buffers.length > 0) {
          overrides[event] = () => {
            // Random index is within [0, buffers.length); buffers is non-empty (checked above).
            const buf = buffers[Math.floor(Math.random() * buffers.length)];
            if (buf) playBuffer(buf);
          };
        }
      } else {
        const buf = await decodeBase64Audio(audioInfo.data, audioInfo.mimeType);
        if (buf) {
          overrides[event] = () => playBuffer(buf);
        }
      }
    }

    for (const event of result.ignore) {
      overrides[event] = null;
    }

    setCachedPack(result.packId, overrides);
  }

  // Build an object with the individual playXxx methods the UI components expect
  const soundObj: Record<string, unknown> = { ...getOriginalSounds() };
  for (const [event, methodName] of Object.entries(EVENT_TO_METHOD)) {
    const fn = overrides[event];
    if (fn === null) {
      // Ignored — no-op
      soundObj[methodName] = () => {};
    } else if (fn) {
      soundObj[methodName] = fn;
    }
    // If not in overrides, keep the original method from soundObj
  }

  window.__SL_SOUNDS__ = soundObj;
}

/** A focusable sound mode option (for gamepad navigation). */
function SoundModeOption({
  label,
  description,
  active,
  disabled,
  onSelect,
}: {
  label: string;
  description: string;
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const { ref, focused } = useFocusable({
    onEnterPress: () => { if (!disabled) onSelect(); },
  });

  return (
    <div
      ref={ref}
      className={`flex items-center gap-3 p-3.5 rounded-[10px] text-left transition-colors cursor-pointer border ${
        active
          ? "border-[var(--accent)] bg-[var(--accent-soft)]"
          : "border-[var(--line)] bg-[var(--bg-inset)] hover:border-base-content/20"
      } ${focused ? "ring-2 ring-[var(--accent)]/40" : ""} ${disabled ? "opacity-50 pointer-events-none" : ""}`}
      onClick={() => { if (!disabled) onSelect(); }}
      role="button"
      tabIndex={0}
    >
      <div
        className={`w-3 h-3 rounded-full flex-shrink-0 ${
          active ? "bg-[var(--accent)]" : "bg-base-content/20"
        }`}
      />
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-[13.5px]">{label}</div>
        <div className="text-[11.5px] text-base-content/60 mt-0.5">{description}</div>
      </div>
      {active && <Badge variant="accent">Active</Badge>}
    </div>
  );
}

/**
 * Community Packs tab content.
 *
 * The search query is lifted to the parent so the header (rendered
 * via `<PluginHeader>` portal) can drive it from the topbar.
 */
function CommunityPacks({
  call,
  query,
  onPackInstalled,
}: {
  call: (method: string, ...args: unknown[]) => Promise<unknown>;
  query: string;
  onPackInstalled: () => void;
}) {
  const [packs, setPacks] = useState<CommunityPackInfo[]>([]);
  const [status, setStatus] = useState<PacksStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [uninstallingId, setUninstallingId] = useState<string | null>(null);
  const [showMusic, setShowMusic] = useState(false);

  const loadPacks = useCallback(async () => {
    try {
      const [result, statusResult] = await Promise.all([
        call("listCommunityPacks") as Promise<CommunityPackInfo[]>,
        call("getCommunityPacksStatus") as Promise<PacksStatus>,
      ]);
      setPacks(result);
      setStatus(statusResult);
    } catch (err) {
      notify(
        err instanceof Error ? err.message : "Failed to load community packs",
        { kind: "error" },
      );
    } finally {
      setLoading(false);
    }
  }, [call]);

  useEffect(() => {
    loadPacks();
  }, [loadPacks]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await call("refreshCommunityPacksCache");
      await loadPacks();
    } catch (err) {
      notify(
        err instanceof Error ? err.message : "Refresh failed",
        { kind: "error" },
      );
    } finally {
      setRefreshing(false);
    }
  }, [call, loadPacks]);

  const filteredPacks = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = showMusic ? packs : packs.filter((p) => !p.music);
    if (q) {
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.author.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q),
      );
    }
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [packs, query, showMusic]);

  const handleInstall = useCallback(
    async (id: string) => {
      setInstallingId(id);
      try {
        const result = (await call("installCommunityPack", id)) as {
          success?: boolean;
          error?: string;
        };
        if (result.error) {
          notify(result.error, { kind: "error" });
        } else {
          await loadPacks();
          onPackInstalled();
          notify("Pack installed", { kind: "success" });
        }
      } catch (err) {
        notify(
          err instanceof Error ? err.message : "Install failed",
          { kind: "error" },
        );
      } finally {
        setInstallingId(null);
      }
    },
    [call, loadPacks, onPackInstalled],
  );

  const handleUninstall = useCallback(
    async (id: string) => {
      setUninstallingId(id);
      try {
        const result = (await call("uninstallCommunityPack", id)) as {
          success?: boolean;
          error?: string;
        };
        if (result.error) {
          notify(result.error, { kind: "error" });
        } else {
          await loadPacks();
          onPackInstalled();
          notify("Pack uninstalled", { kind: "success" });
        }
      } catch (err) {
        notify(
          err instanceof Error ? err.message : "Uninstall failed",
          { kind: "error" },
        );
      } finally {
        setUninstallingId(null);
      }
    },
    [call, loadPacks, onPackInstalled],
  );

  if (loading) {
    return (
      <div className="card">
        <div className="card-body p-4.5">
          <div className="flex items-center justify-center h-64">
            <Spinner size={32} />
          </div>
        </div>
      </div>
    );
  }

  // Pending: no cache yet, sync still in flight.
  if (status?.state === "pending" && filteredPacks.length === 0) {
    return (
      <div className="card">
        <div className="card-body p-4.5">
          <div className="flex flex-col items-center justify-center h-64 gap-3">
            <Spinner size={28} />
            <div className="text-[13px] text-base-content/70">
              Loading pack registry from deckthemes.com…
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Error with no usable cache: show a retry surface.
  if (status?.state === "error" && filteredPacks.length === 0) {
    return (
      <div className="card">
        <div className="card-body p-4.5">
          <div className="subsection-label mb-1.5" style={{ color: "var(--color-error)" }}>
            Could not reach deckthemes.com
          </div>
          <div className="text-sm mb-3">{status.lastError ?? "Unknown error"}</div>
          <Button variant="default" onClick={handleRefresh} disabled={refreshing}>
            {refreshing ? (
              <span className="flex items-center gap-1.5">
                <Spinner size={12} />
                Retrying…
              </span>
            ) : (
              "Retry"
            )}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="subsection">
        <div className="subsection-desc mb-3">
          Pack metadata is fetched live from deckthemes.com — kudos to the DeckThemes community.
        </div>

        <div className="flex items-center gap-3 p-3 rounded-[10px] border border-[var(--line)] bg-[var(--bg-inset)] mb-3">
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-[12.5px]">Show music packs</div>
            <div className="text-[11px] text-base-content/60 mt-0.5">
              Music-only packs use a different mapping from UI sound packs.
            </div>
          </div>
          <Toggle checked={showMusic} onChange={setShowMusic} />
        </div>

        {filteredPacks.length === 0 ? (
          <div className="p-5 rounded-[10px] border border-[var(--line)] bg-[var(--bg-inset)] text-center text-[13px] text-base-content/70">
            {query.trim()
              ? "No packs match your search."
              : "No packs available."}
          </div>
        ) : (
          <div className="grid gap-2">
            {filteredPacks.map((pack) => {
              const isInstalling = installingId === pack.id;
              const isUninstalling = uninstallingId === pack.id;
              const isBusy = isInstalling || isUninstalling;

              return (
                <div
                  key={pack.id}
                  className={`flex items-start gap-3 p-3.5 rounded-[10px] transition-colors border ${
                    pack.installed
                      ? "border-[var(--color-success,theme(colors.success))]/40 bg-success/5"
                      : "border-[var(--line)] bg-[var(--bg-inset)]"
                  }`}
                >
                  {pack.previewImageUrl && (
                    <img
                      src={pack.previewImageUrl}
                      alt=""
                      className="w-12 h-12 rounded-md object-cover flex-shrink-0 bg-base-300"
                      loading="lazy"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="font-semibold text-[13.5px]">{pack.name}</span>
                      {pack.version && (
                        <span className="mono text-[10.5px] text-base-content/50">{pack.version}</span>
                      )}
                      {pack.music && <Badge variant="neutral">Music</Badge>}
                      {pack.installed && <Badge variant="success">Installed</Badge>}
                    </div>
                    <div className="mono text-[11px] text-base-content/60 mt-0.5">
                      by {pack.author}
                    </div>
                    {pack.description && (
                      <div className="text-[11.5px] text-base-content/50 mt-1 line-clamp-2">
                        {pack.description}
                      </div>
                    )}
                  </div>

                  <div className="flex-shrink-0 pt-0.5">
                    {pack.installed ? (
                      <Button
                        variant="default"
                        onClick={() => handleUninstall(pack.id)}
                        disabled={isBusy}
                      >
                        {isUninstalling ? (
                          <span className="flex items-center gap-1.5">
                            <Spinner size={12} />
                            Removing...
                          </span>
                        ) : (
                          "Uninstall"
                        )}
                      </Button>
                    ) : (
                      <Button
                        variant="default"
                        onClick={() => handleInstall(pack.id)}
                        disabled={isBusy}
                      >
                        {isInstalling ? (
                          <span className="flex items-center gap-1.5">
                            <Spinner size={12} />
                            Installing...
                          </span>
                        ) : (
                          "Install"
                        )}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function SoundLoader() {
  const { call, useEvent } = useBackend("sound-loader");

  const [packs, setPacks] = useState<SoundPackInfo[]>([]);
  const [activePack, setActivePack] = useState<string | null>(null);
  const [useInOverlay, setUseInOverlay] = useState(false);
  const [useInSteam, setUseInSteam] = useState(false);
  const [steamError, setSteamError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>("my-packs");
  const [refreshKey, setRefreshKey] = useState(0);
  /**
   * Community-tab search query. Lifted out of `CommunityPacks` so the
   * header (rendered into the shell topbar via `<PluginHeader>`) and
   * the community grid body can share state without cross-root
   * plumbing. Cleared automatically when leaving the tab via the
   * back arrow.
   */
  const [communityQuery, setCommunityQuery] = useState("");

  // Load packs, active selection, and overlay setting on mount
  useEffect(() => {
    let cancelled = false;

    Promise.all([
      call("listPacks"),
      call("getActivePack"),
      call("getUseInOverlay"),
      call("getUseInSteam"),
    ])
      .then(([packsResult, activeResult, overlayResult, steamResult]) => {
        if (cancelled) return;
        setPacks(packsResult as SoundPackInfo[]);
        setActivePack(activeResult as string | null);
        setUseInOverlay(overlayResult as boolean);
        setUseInSteam(steamResult as boolean);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        notify(
          err instanceof Error ? err.message : "Failed to load sound packs",
          { kind: "error" },
        );
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [call, refreshKey]);

  // Listen for pack changes from backend
  useEvent({
    event: "activePackChanged",
    handler: (data) => {
      const { activePack: newPack } = data as { activePack: string | null };
      setActivePack(newPack);
    },
  });

  useEvent({
    event: "useInOverlayChanged",
    handler: (data) => {
      const { useInOverlay: val } = data as { useInOverlay: boolean };
      setUseInOverlay(val);
    },
  });

  useEvent({
    event: "useInSteamChanged",
    handler: (data) => {
      const { useInSteam: val } = data as { useInSteam: boolean };
      setUseInSteam(val);
    },
  });

  useEvent({
    event: "steamError",
    handler: (data) => {
      const { error: err } = data as { error: string | null };
      setSteamError(err);
    },
  });

  const handleSelectPack = useCallback(
    async (packId: string | null) => {
      setApplying(true);
      try {
        const result = (await call("setActivePack", packId)) as {
          success: boolean;
          error?: string;
        };
        if (!result.success) {
          notify(result.error ?? "Failed to set sound pack", { kind: "error" });
        } else {
          setActivePack(packId);
        }
      } catch (err) {
        notify(
          err instanceof Error ? err.message : "Failed to set sound pack",
          { kind: "error" },
        );
      } finally {
        setApplying(false);
      }
    },
    [call],
  );

  const handleUseInOverlayChange = useCallback(
    async (value: boolean) => {
      setUseInOverlay(value);
      try {
        await call("setUseInOverlay", value);
      } catch (err) {
        notify(
          err instanceof Error ? err.message : "Failed to update setting",
          { kind: "error" },
        );
        setUseInOverlay(!value); // revert on failure
      }
    },
    [call],
  );

  const handleUseInSteamChange = useCallback(
    async (value: boolean) => {
      setUseInSteam(value);
      try {
        await call("setUseInSteam", value);
      } catch (err) {
        notify(
          err instanceof Error ? err.message : "Failed to update setting",
          { kind: "error" },
        );
        setUseInSteam(!value); // revert on failure
      }
    },
    [call],
  );

  const handleReconnectSteam = useCallback(async () => {
    setReconnecting(true);
    try {
      await call("reconnectSteam");
    } catch (err) {
      notify(
        err instanceof Error ? err.message : "Reconnect failed",
        { kind: "error" },
      );
    } finally {
      setReconnecting(false);
    }
  }, [call]);

  /** Called when a community pack is installed or uninstalled — refresh local packs list. */
  const handleCommunityPackChange = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  // Apply or remove sound overrides when pack or overlay setting changes
  useEffect(() => {
    if (!loading) {
      installSoundOverrides(call, useInOverlay).catch((err) => {
        console.error("[sound-loader] Failed to install sound overrides:", err);
      });
    }
  }, [loading, call, activePack, useInOverlay]);

  // The Steam-side hook substitutes URL-based sound files at the
  // PlayAudioURL choke point — it has nowhere to splice synthesized
  // tones or Steam's built-in WAVs (those are the no-override path).
  // Disable the toggle when the active pack can't be staged.
  const steamToggleDisabled = activePack === null || activePack === "synthesized";

  // Dynamic header subtitle — surfaces the active pack so the user
  // doesn't have to scroll to the body to see what's playing.
  const headerSubtitle = useMemo(() => {
    if (loading) return "Loading…";
    if (activePack === null) return "Default Steam sounds";
    if (activePack === "synthesized") return "Synthesized tones";
    const pack = packs.find((p) => p.id === activePack);
    return pack ? `Active: ${pack.name}` : "Custom UI sound packs";
  }, [activePack, loading, packs]);

  // Dynamic topbar header. Same React tree as the body — `activeTab`,
  // `communityQuery`, and the back/clear callbacks are shared by
  // closure. Renders into the overlay shell's reserved 60px topbar
  // slot via `<PluginHeader>`. On the My Packs view the segmented
  // `[My Packs | Community]` toggle sits here; on the Community
  // drill-in it swaps for a search input + back arrow that returns
  // to My Packs.
  const headerNode = (
    <PluginHeader>
      <div className="flex items-center justify-between gap-4 w-full min-w-0">
        <div className="flex flex-col gap-0.5 min-w-0">
          <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">
            Sound Loader
          </h1>
          <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
            {headerSubtitle}
          </span>
        </div>

        {activeTab === "my-packs" && (
          <div className="flex items-center gap-2 shrink-0">
            <div className="segmented flex">
              <SegmentedItem
                active={true}
                onSelect={() => setActiveTab("my-packs")}
              >
                My Packs
              </SegmentedItem>
              <SegmentedItem
                active={false}
                onSelect={() => setActiveTab("community")}
              >
                Community
              </SegmentedItem>
            </div>
          </div>
        )}

        {activeTab === "community" && (
          <div className="flex items-center gap-2 shrink-0">
            <SearchField
              value={communityQuery}
              onChange={setCommunityQuery}
              onClear={() => setCommunityQuery("")}
              placeholder="Search by name, author, description…"
              width={280}
            />
            <HeaderBackButton
              onBack={() => {
                setCommunityQuery("");
                setActiveTab("my-packs");
              }}
              title="Back to My Packs"
            />
          </div>
        )}
      </div>
    </PluginHeader>
  );

  if (loading) {
    return (
      <>
        {headerNode}
        <div className="p-7 h-full overflow-y-auto">
          <div className="page-content">
            <div className="flex items-center justify-center h-64">
              <Spinner size={32} />
            </div>
          </div>
        </div>
      </>
    );
  }

  const totalPackCount = packs.length + 2; // built-ins + custom

  return (
    <>
      {headerNode}
      <div className="p-7 h-full overflow-y-auto">
        <div className="page-content">
          {activeTab === "my-packs" ? (
            <>
              {/* SOUND MODE + APPLY TARGETS */}
              <div className="card">
                <div className="card-header flex items-center justify-between py-3.5 px-4.5 border-b border-base-300">
                  <div className="card-title flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-base-content/50">
                    <FaVolumeHigh className="w-3 h-3" /> SOUND MODE
                  </div>
                </div>

                <div className="subsection">
                  <div className="subsection-label">Built-in Modes</div>
                  <div className="grid gap-2">
                    <SoundModeOption
                      label="Default (Steam Sounds)"
                      description="Uses Steam's built-in WAV files from disk"
                      active={activePack === null}
                      disabled={applying}
                      onSelect={() => handleSelectPack(null)}
                    />
                    <SoundModeOption
                      label="Synthesized"
                      description="Procedurally generated tones via Web Audio API"
                      active={activePack === "synthesized"}
                      disabled={applying}
                      onSelect={() => handleSelectPack("synthesized")}
                    />
                  </div>
                </div>

                <div className="subsection">
                  <div className="subsection-label">Apply To</div>
                  <div className="subsection-desc mb-3">
                    Choose where the active sound pack replaces default UI sounds.
                  </div>
                  <div className="grid gap-2">
                    <div className="flex items-center gap-3 p-3.5 rounded-[10px] border border-[var(--line)] bg-[var(--bg-inset)]">
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-[13.5px]">Overlay sounds</div>
                        <div className="text-[11.5px] text-base-content/60 mt-0.5">
                          Use the active sound pack for UI sounds in this app
                        </div>
                      </div>
                      <Toggle
                        checked={useInOverlay}
                        onChange={handleUseInOverlayChange}
                      />
                    </div>

                    <div className={`flex items-center gap-3 p-3.5 rounded-[10px] border border-[var(--line)] bg-[var(--bg-inset)] ${steamToggleDisabled ? "opacity-60" : ""}`}>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-[13.5px]">Steam UI sounds</div>
                        <div className="text-[11.5px] text-base-content/60 mt-0.5">
                          {steamToggleDisabled
                            ? "Pick an installed sound pack above to replace Steam's UI sounds (Default and Synthesized are overlay-only)."
                            : "Replaces sound effects in Steam Big Picture (requires Steam running)"}
                        </div>
                      </div>
                      <Toggle
                        checked={useInSteam}
                        onChange={handleUseInSteamChange}
                        disabled={steamToggleDisabled}
                      />
                    </div>
                  </div>

                  {useInSteam && steamError && (
                    <div className="mt-3 flex items-center justify-between gap-3 p-3.5 rounded-[10px] border border-warning/40 bg-warning/10">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <Badge variant="neutral">Inactive</Badge>
                          <span className="font-semibold text-[13.5px] text-warning">
                            Steam-side sounds unavailable
                          </span>
                        </div>
                        <div className="text-[11.5px] text-base-content/70 mt-1">{steamError}</div>
                      </div>
                      <Button
                        variant="default"
                        onClick={handleReconnectSteam}
                        disabled={reconnecting}
                      >
                        {reconnecting ? (
                          <span className="flex items-center gap-1.5">
                            <Spinner size={12} />
                            Connecting...
                          </span>
                        ) : (
                          "Reconnect"
                        )}
                      </Button>
                    </div>
                  )}
                </div>
              </div>

              {/* SOUND PACKS */}
              <div className="card">
                <div className="subsection">
                  <div className="flex items-center justify-between mb-3">
                    <div className="subsection-label mb-0">Sound Packs</div>
                    <Badge variant="neutral">{packs.length} installed</Badge>
                  </div>
                  {packs.length === 0 ? (
                    <div className="p-5 rounded-[10px] border border-[var(--line)] bg-[var(--bg-inset)] text-center">
                      <div className="font-semibold text-[13.5px] mb-1">No custom sound packs installed</div>
                      <div className="subsection-desc mb-2">
                        Add packs to{" "}
                        <code className="mono text-[11px] px-1.5 py-0.5 rounded bg-base-300">
                          ~/.local/share/loadout/sound-packs/
                        </code>
                      </div>
                      <div className="subsection-desc mb-3">
                        Each pack needs a <code className="mono text-[11px] px-1.5 py-0.5 rounded bg-base-300">pack.json</code> manifest and audio files.
                      </div>
                      <Button
                        variant="default"
                        onClick={() => setActiveTab("community")}
                      >
                        Browse Community Packs
                      </Button>
                    </div>
                  ) : (
                    <div className="grid gap-2">
                      {packs.map((pack) => {
                        const isActive = activePack === pack.id;

                        return (
                          <div
                            key={pack.id}
                            className={`w-full flex items-center gap-3 p-3.5 rounded-[10px] transition-colors border ${
                              isActive
                                ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                                : "border-[var(--line)] bg-[var(--bg-inset)]"
                            }`}
                          >
                            <div className="flex-1 min-w-0">
                              <div className="flex items-baseline gap-2 flex-wrap">
                                <span className="font-semibold text-[13.5px]">{pack.name}</span>
                                <span className="mono text-[10.5px] text-base-content/50">v{pack.version}</span>
                                {isActive && <Badge variant="accent">Active</Badge>}
                              </div>
                              {pack.author && (
                                <div className="mono text-[11px] text-base-content/60 mt-0.5">by {pack.author}</div>
                              )}
                              {pack.description && (
                                <div className="text-[11.5px] text-base-content/50 mt-1">
                                  {pack.description}
                                </div>
                              )}
                              <div className="mono text-[10.5px] text-base-content/40 mt-1.5">
                                {pack.mappedEvents.length} sound{pack.mappedEvents.length !== 1 ? "s" : ""} mapped
                                {pack.ignoredEvents.length > 0 && (
                                  <>
                                    {" "}&middot; {pack.ignoredEvents.length} ignored
                                  </>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              {isActive ? (
                                <span className="w-8 h-8 rounded-full grid place-items-center bg-[var(--accent)] text-[var(--on-accent)] flex-shrink-0">
                                  <FaCheck className="w-3 h-3" />
                                </span>
                              ) : (
                                <Button
                                  variant="primary"
                                  onClick={() => handleSelectPack(pack.id)}
                                  disabled={applying}
                                >
                                  Enable
                                </Button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* INFO subsection */}
                <div className="subsection">
                  <div className="subsection-label">Info</div>
                  <div className="row">
                    <span className="row-label flex items-center gap-1.5">
                      <FaFolderOpen className="w-3 h-3 opacity-60" /> Packs directory
                    </span>
                    <code className="row-value mono text-[11px]">~/.local/share/loadout/sound-packs/</code>
                  </div>
                  <div className="row">
                    <span className="row-label">Supported formats</span>
                    <span className="row-value mono">.wav, .mp3, .ogg</span>
                  </div>
                  <div className="row">
                    <span className="row-label">Sound events</span>
                    <span className="row-value mono">{SOUND_EVENTS.length} events</span>
                  </div>
                  <div className="row">
                    <span className="row-label">Total packs</span>
                    <span className="row-value mono">{totalPackCount}</span>
                  </div>
                  <div className="subsection-desc mt-3">
                    Each sound pack is a folder with a{" "}
                    <code className="mono text-[11px] px-1 py-0.5 rounded bg-base-300">pack.json</code>{" "}
                    manifest that maps sound events to audio files.
                  </div>
                </div>
              </div>
            </>
          ) : (
            <CommunityPacks
              call={call}
              query={communityQuery}
              onPackInstalled={handleCommunityPackChange}
            />
          )}
        </div>
      </div>
    </>
  );
}

// ---------- Mount entry points ----------
//
// Body: `mountComponent` factory from @loadout/ui handles the
// createRoot + PluginProvider boilerplate.
//
// Header: actual header content is portaled from inside `mount()` via
// `<PluginHeader>` (same React tree as the body, so `activeTab`,
// `communityQuery`, and the active-pack subtitle are shared without
// any cross-root pub/sub). The header export is the `mountHeaderStub`
// no-op — its mere presence tells the overlay shell to reserve the
// 60px topbar slot.

export const mount = mountComponent(SoundLoader);

export const mountHeader = mountHeaderStub;

/**
 * Outstanding `api.subscribe` unsubscribes captured from `init()`. The
 * shell may re-run `init()` (hot reload, plugin disable/enable); without
 * tearing the old subscriptions down each cycle accumulates a new pair
 * of `reapply` handlers firing on the same events.
 */
const initUnsubscribes: Array<() => void> = [];

/**
 * Plugin startup hook — called by the shell once at app startup (before
 * the user opens this plugin's UI). Reads the persisted active pack and
 * "use in overlay" config from the backend, installs sound overrides if
 * needed, and subscribes to backend events so config changes propagate
 * even when the UI isn't mounted.
 *
 * Triggered because `loadOnStartup: true` is set in `package.json`'s
 * `plugin` field.
 */
export async function init(api: {
  call: (method: string, ...args: unknown[]) => Promise<unknown>;
  subscribe: (event: string, handler: (data: unknown) => void) => () => void;
}): Promise<void> {
  // Tear down any subscriptions left over from a previous `init()` run
  // before we register fresh ones.
  while (initUnsubscribes.length > 0) {
    const fn = initUnsubscribes.pop();
    try { fn?.(); } catch { /* best-effort */ }
  }

  // Apply current settings.
  try {
    const useInOverlay = (await api.call("getUseInOverlay")) as boolean;
    await installSoundOverrides(api.call, useInOverlay);
  } catch (err) {
    console.error("[sound-loader] init: failed to apply current overrides:", err);
  }

  // Re-apply on any config change so the overrides stay in sync without
  // requiring the UI to be open.
  const reapply = async () => {
    try {
      const useInOverlay = (await api.call("getUseInOverlay")) as boolean;
      await installSoundOverrides(api.call, useInOverlay);
    } catch (err) {
      console.error("[sound-loader] init: failed to re-apply overrides:", err);
    }
  };
  initUnsubscribes.push(api.subscribe("activePackChanged", () => reapply()));
  initUnsubscribes.push(api.subscribe("useInOverlayChanged", () => reapply()));
}

/**
 * Plugin shutdown hook — paired with `init()`. Tears down event
 * subscriptions, drops the decoded-pack cache, and closes the shared
 * AudioContext so the plugin reload cycle doesn't leak system audio
 * handles.
 */
export async function onUnload(): Promise<void> {
  while (initUnsubscribes.length > 0) {
    const fn = initUnsubscribes.pop();
    try { fn?.(); } catch { /* best-effort */ }
  }
  await closeAudioCtx();
}

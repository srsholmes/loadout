/**
 * Tier A — does real Steam still expose what we read?
 *
 * Every field name and store shape this plugin depends on was *measured* on a
 * device (see `docs/steam-metadata-probe.md`) rather than read from
 * documentation, because none of it is documented. Measurements go stale: a
 * Steam client update can rename a getter or drop a collection and the plugin
 * would degrade silently, because a missing field reads as `undefined` and
 * turns into a definite `false` for the whole library.
 *
 * This file is that measurement as assertions. It is also the executable spec
 * the `appstore` provider gets written against — the provider's field list and
 * this file's field list are deliberately the same list.
 *
 * Read-only: it evaluates expressions in Steam's context and asserts on the
 * results. It creates nothing, writes nothing, and touches no collection.
 *
 * Run with `bun run test:live` on a device with Steam open.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { CDPClient } from "@loadout/steam-cdp";
import { acquireLiveLock, requireSteam, skipAllowed } from "./steam-guard";

const unavailable = skipAllowed();

let client: CDPClient | null = null;
let release: (() => Promise<void>) | null = null;

/** Evaluate in Steam's SharedJSContext and return the result. */
async function evaluate<T>(expression: string): Promise<T> {
  if (!client) throw new Error("no CDP client — beforeAll did not run");
  return (await client.evaluate(expression, { awaitPromise: false })) as T;
}

beforeAll(async () => {
  if (unavailable) return;
  release = await acquireLiveLock();
  const tab = await requireSteam();
  client = new CDPClient(tab.webSocketDebuggerUrl);
  await client.connect();
});

afterAll(async () => {
  client?.close();
  await release?.();
});

describe.skipIf(unavailable)("collectionStore — the owned-games source", () => {
  it("exposes appTypeCollectionMap with every app-type collection we read", async () => {
    const keys = await evaluate<string[]>(
      `[...window.collectionStore.appTypeCollectionMap.keys()]`,
    );
    // TabMaster sources its library from exactly these, and so must we —
    // `type-games` is where owned-but-not-installed comes from.
    for (const key of ["type-games", "type-software", "type-music", "type-videos", "type-tools"]) {
      expect(keys, `appTypeCollectionMap is missing ${key}`).toContain(key);
    }
  });

  it("knows about far more owned games than installed ones", async () => {
    // The entire premise of the appstore provider. If this ever inverts, the
    // provider is reading the wrong collection.
    const { owned, installed } = await evaluate<{ owned: number; installed: number }>(
      `({
         owned: window.collectionStore.GetCollection("type-games").allApps.length,
         installed: window.collectionStore.GetCollection("local-install").allApps.length,
       })`,
    );
    expect(owned).toBeGreaterThan(0);
    expect(installed).toBeGreaterThan(0);
    expect(owned).toBeGreaterThan(installed);
  });

  it("gives every app-type collection both allApps and visibleApps", async () => {
    const shape = await evaluate<Record<string, { all: boolean; visible: boolean }>>(
      `Object.fromEntries([...window.collectionStore.appTypeCollectionMap.entries()]
         .map(([k, v]) => [k, { all: Array.isArray(v.allApps), visible: Array.isArray(v.visibleApps) }]))`,
    );
    for (const [key, { all, visible }] of Object.entries(shape)) {
      expect(all, `${key}.allApps is not an array`).toBe(true);
      expect(visible, `${key}.visibleApps is not an array`).toBe(true);
    }
  });

  it("still has the collection methods the Phase-4 mirror needs", async () => {
    const missing = await evaluate<string[]>(
      `(() => {
         const store = ["GetCollection","GetUserCollectionsByName","NewUnsavedCollection",
                        "SaveCollection","DeleteCollection","GetCollectionListForAppID"]
           .filter(m => typeof window.collectionStore[m] !== "function");
         const first = window.collectionStore.userCollections?.[0];
         const coll = first
           ? ["AddApps","RemoveApps","SetApps","Save"].filter(m => typeof first[m] !== "function")
           : ["<no user collection to inspect>"];
         return [...store, ...coll];
       })()`,
    );
    // `RemoveApps` in particular decides whether the mirror can do a real
    // replace-set or has to create-then-delete and lose sidebar position.
    expect(missing).toEqual([]);
  });
});

describe.skipIf(unavailable)("appStore — the per-app overview surface", () => {
  it("exposes the prototype getters the provider reads", async () => {
    const missing = await evaluate<string[]>(
      `(() => {
         const proto = Object.getPrototypeOf(window.appStore.allApps.find(a => a));
         return ["steam_deck_compat_category","steam_os_compat_category","review_percentage",
                 "store_tag","store_category","display_status","installed"]
           .filter(n => !(n in proto) && !Object.getOwnPropertyDescriptor(proto, n));
       })()`,
    );
    expect(missing).toEqual([]);
  });

  it("exposes the prototype methods the provider calls", async () => {
    const missing = await evaluate<string[]>(
      `(() => {
         const proto = Object.getPrototypeOf(window.appStore.allApps.find(a => a));
         return ["BIsOwned","BIsDemo","BIsBorrowed","BIsUnreleased","BIsShortcut","BIsMusicAlbum",
                 "BHasStoreCategory","GetStoreTags","GetCanonicalReleaseDate","GetLastTimePlayed"]
           .filter(n => typeof proto[n] !== "function");
       })()`,
    );
    expect(missing).toEqual([]);
  });

  it("returns a DECODED deck-compat category, not the packed bitfield", async () => {
    // The own key `steam_hw_compat_category_packed` carries values like 33/162/227;
    // the getter decodes to 1|2|3. Reading the wrong one silently mis-categorises
    // every game, which no unit test against a fixture would ever catch.
    const sample = await evaluate<Array<{ decoded: number; packed: number }>>(
      `window.appStore.allApps
         .filter(a => a && a.steam_deck_compat_category)
         .slice(0, 20)
         .map(a => ({ decoded: a.steam_deck_compat_category, packed: a.steam_hw_compat_category_packed }))`,
    );
    expect(sample.length).toBeGreaterThan(0);
    for (const { decoded } of sample) {
      expect(decoded).toBeGreaterThanOrEqual(0);
      expect(decoded).toBeLessThanOrEqual(3);
    }
  });

  it("resolves store-tag ids to names", async () => {
    // `store_tag` / `GetStoreTags()` return numeric ids. Without this map the
    // storeTags rule can neither be authored nor displayed.
    const resolved = await evaluate<{ mapSize: number; sample: Array<[number, string | null]> }>(
      `(() => {
         const as = window.appStore;
         const app = as.allApps.find(a => a && a.store_tag && a.store_tag.length);
         const ids = app ? [...app.store_tag].slice(0, 5) : [];
         return {
           mapSize: Object.keys(as.m_mapStoreTagLocalization ?? {}).length,
           sample: ids.map(id => [id, as.GetLocalizationForStoreTag ? (as.GetLocalizationForStoreTag(id) ?? null) : null]),
         };
       })()`,
    );
    expect(resolved.mapSize).toBeGreaterThan(0);
    expect(resolved.sample.length).toBeGreaterThan(0);
    const named = resolved.sample.filter(([, name]) => typeof name === "string" && name.length > 0);
    expect(named.length, `no tag id resolved to a name: ${JSON.stringify(resolved.sample)}`)
      .toBeGreaterThan(0);
  });

  it("populates a canonical release date more often than either raw field", async () => {
    // Both `rt_*` date fields are under 15% populated, which is why the
    // releaseDate rule must read the canonical accessor instead.
    const counts = await evaluate<{ total: number; canonical: number; steam: number; original: number }>(
      `(() => {
         const apps = window.appStore.allApps.filter(a => a);
         let canonical = 0, steam = 0, original = 0;
         for (const a of apps) {
           if (a.GetCanonicalReleaseDate && a.GetCanonicalReleaseDate()) canonical++;
           if (a.rt_steam_release_date) steam++;
           if (a.rt_original_release_date) original++;
         }
         return { total: apps.length, canonical, steam, original };
       })()`,
    );
    expect(counts.canonical).toBeGreaterThanOrEqual(counts.steam);
    expect(counts.canonical).toBeGreaterThanOrEqual(counts.original);
  });
});

describe.skipIf(unavailable)("Steam ROM Manager — how ROMs are identified", () => {
  it("marks ROM shortcuts with srm- collection ids carrying a base64 platform", async () => {
    // This is the signal the `rom` app-kind is derived from. Without it a
    // ROM is indistinguishable from Konsole or an emulator launcher.
    const srm = await evaluate<Array<{ id: string; decoded: string | null; count: number }>>(
      `(() => {
         const out = [];
         for (const c of window.collectionStore.userCollections ?? []) {
           if (!c.id.startsWith("srm-")) continue;
           let decoded = null;
           try { decoded = atob(c.id.slice(4)); } catch {}
           out.push({ id: c.id, decoded, count: c.allApps?.length ?? 0 });
         }
         return out;
       })()`,
    );
    // A device with no Steam ROM Manager collections legitimately has none —
    // assert the shape only when there are any to assert on.
    for (const entry of srm) {
      expect(entry.decoded, `${entry.id} did not base64-decode to a platform name`)
        .toBeTruthy();
      expect(entry.count).toBeGreaterThanOrEqual(0);
    }
  });
});

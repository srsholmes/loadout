/**
 * Reading and writing Steam's user collections.
 *
 * `library-overview.ts` already reads collection *membership* as a side effect
 * of reading the library. This module is about the collections themselves —
 * listing them with the metadata needed to decide whether writing to one is
 * safe, and performing the writes.
 *
 * Why a separate module from `steam-client.ts`: `addAppToCollection` there
 * resolves collections **by name** and only ever adds. That is right for
 * recomp, which drops a shortcut into a bucket and never looks again, and it
 * is exactly wrong for a mirror, which must own a specific collection by id
 * across renames and must be able to remove apps. Changing it in place would
 * break its existing callers — `packages/steam-shortcut` uses it for the
 * add-to-Steam flow in `recomp` and `store-bridge` — so this is a sibling.
 *
 * Every write goes through `SaveCollection`. Without it a collection exists
 * only in memory, looks completely correct in Steam's UI, and is gone on the
 * next restart — which is why the roundtrip test re-reads through a fresh
 * session rather than trusting the write-side result.
 */

import { SteamClientUnreachableError, type SteamClient } from "./steam-client";

export interface SteamCollectionInfo {
  id: string;
  name: string;
  appIds: string[];
  /**
   * Tag- or filter-driven. Steam recomputes the contents, so writes either
   * throw or are silently reverted. Callers must check before writing.
   */
  isDynamic: boolean;
  isEditable: boolean;
}

/**
 * Shared preamble. Steam's collections expose their apps through several
 * shapes depending on build and collection type, so read defensively — an
 * empty `appIds` on a collection that actually has apps would make a mirror
 * sync add every one of them again.
 */
const HELPERS = `
  const appIdsOf = (c) => {
    const out = [];
    const push = (v) => {
      if (v == null) return;
      const id = typeof v === "object" ? v.appid : v;
      if (id != null) out.push(String(id));
    };
    if (c.m_setApps && typeof c.m_setApps.forEach === "function") c.m_setApps.forEach(push);
    else if (Array.isArray(c.m_rgApps)) c.m_rgApps.forEach(push);
    else if (Array.isArray(c.allApps)) c.allApps.forEach(push);
    return out;
  };
  const infoOf = (c) => ({
    id: String(c.id != null ? c.id : c.m_strId),
    name: String(c.displayName != null ? c.displayName : c.m_strName),
    appIds: appIdsOf(c),
    // A collection is dynamic when Steam derives its contents from a filter.
    // \`bIsDynamic\` is the modern flag; the filter spec is the older tell.
    isDynamic: Boolean(c.bIsDynamic || c.m_bIsDynamic || c.m_filterSpec),
    isEditable: c.bIsEditable !== false && c.m_bIsEditable !== false,
  });
  const findById = (cs, id) => {
    if (typeof cs.GetCollection === "function") {
      const direct = cs.GetCollection(id);
      if (direct) return direct;
    }
    return (cs.userCollections || []).find((c) => String(c.id != null ? c.id : c.m_strId) === id);
  };
`;

function unreachable(): never {
  throw new SteamClientUnreachableError(
    "window.collectionStore is not available on the SharedJSContext tab — " +
      "collections require Steam's modern Library UI to have opened this session.",
  );
}

/** Anything not `ok` is a message from the in-page program, not a value. */
function unwrap<T>(result: unknown, what: string): T {
  const r = result as { tag?: string; value?: T; error?: string };
  if (r?.tag === "no-store" || r?.tag === "no-api") unreachable();
  if (r?.tag !== "ok") {
    throw new Error(`${what} failed: ${r?.error ?? JSON.stringify(result)?.slice(0, 200)}`);
  }
  return r.value as T;
}

/** Every user collection, with enough metadata to decide if writing is safe. */
export async function listCollections(client: SteamClient): Promise<SteamCollectionInfo[]> {
  const expr = `(() => {
    const cs = window.collectionStore;
    if (!cs) return { tag: "no-store" };
    ${HELPERS}
    try {
      return { tag: "ok", value: (cs.userCollections || []).map(infoOf) };
    } catch (e) { return { tag: "error", error: String(e && e.message) }; }
  })()`;
  return unwrap<SteamCollectionInfo[]>(await client._evaluateAsync(expr), "listCollections");
}

/**
 * Create a collection and put exactly `appIds` in it. Returns its new id —
 * the only durable handle a caller has, since names are the user's to change.
 */
export async function createCollection(
  client: SteamClient,
  args: { name: string; appIds: readonly string[] },
): Promise<SteamCollectionInfo> {
  const { name, appIds } = args;
  if (!name.trim()) throw new Error("createCollection: name must not be blank");

  const expr = `(async () => {
    const cs = window.collectionStore;
    if (!cs) return { tag: "no-store" };
    if (typeof cs.NewUnsavedCollection !== "function" || typeof cs.SaveCollection !== "function") {
      return { tag: "no-api" };
    }
    ${HELPERS}
    try {
      // The 3-arg form takes wrapper objects, not raw appids — the store calls
      // \`.appid\` on each entry.
      const wrapped = ${JSON.stringify([...appIds])}.map((id) => ({ appid: Number(id) }));
      const col = cs.NewUnsavedCollection(${JSON.stringify(name)}, null, wrapped);
      if (!col) return { tag: "error", error: "NewUnsavedCollection returned nothing" };
      await cs.SaveCollection(col);
      return { tag: "ok", value: infoOf(col) };
    } catch (e) { return { tag: "error", error: String(e && e.message) }; }
  })()`;
  return unwrap<SteamCollectionInfo>(await client._evaluateAsync(expr), "createCollection");
}

/**
 * Make the collection's membership exactly `appIds`.
 *
 * Expressed as add + remove rather than a wholesale replace because Steam has
 * no replace primitive; and the diff is computed **in-page** against live
 * membership rather than taken from the caller, so a plan built against a
 * slightly stale read cannot leave strays behind.
 *
 * Refuses dynamic collections. Writing to one either throws or is reverted by
 * Steam on the next recompute, and the caller would have no way to tell.
 */
export async function setCollectionApps(
  client: SteamClient,
  args: { collectionId: string; appIds: readonly string[] },
): Promise<SteamCollectionInfo> {
  const { collectionId, appIds } = args;
  const expr = `(async () => {
    const cs = window.collectionStore;
    if (!cs) return { tag: "no-store" };
    if (typeof cs.SaveCollection !== "function") return { tag: "no-api" };
    ${HELPERS}
    try {
      const col = findById(cs, ${JSON.stringify(collectionId)});
      if (!col) return { tag: "error", error: "no collection with id " + ${JSON.stringify(collectionId)} };
      const info = infoOf(col);
      if (info.isDynamic || !info.isEditable) {
        return { tag: "error", error: "collection is dynamic or not editable" };
      }

      const want = new Set(${JSON.stringify([...appIds].map(String))});
      const have = new Set(info.appIds);
      const toAdd = [...want].filter((id) => !have.has(id));
      const toRemove = [...have].filter((id) => !want.has(id));

      // Remove first: on a collection at Steam's size limit, adding before
      // removing can throw and leave the write half-applied.
      if (toRemove.length && typeof col.RemoveApps === "function") {
        col.RemoveApps(toRemove.map((id) => ({ appid: Number(id) })));
      }
      if (toAdd.length && typeof col.AddApps === "function") {
        col.AddApps(toAdd.map((id) => ({ appid: Number(id) })));
      }
      if (!toRemove.length && !toAdd.length) return { tag: "ok", value: info };

      await cs.SaveCollection(col);
      return { tag: "ok", value: infoOf(col) };
    } catch (e) { return { tag: "error", error: String(e && e.message) }; }
  })()`;
  return unwrap<SteamCollectionInfo>(await client._evaluateAsync(expr), "setCollectionApps");
}

/** Rename in place. The id — and so the mirror's claim on it — is unchanged. */
export async function renameCollection(
  client: SteamClient,
  args: { collectionId: string; name: string },
): Promise<SteamCollectionInfo> {
  const { collectionId, name } = args;
  if (!name.trim()) throw new Error("renameCollection: name must not be blank");

  const expr = `(async () => {
    const cs = window.collectionStore;
    if (!cs) return { tag: "no-store" };
    if (typeof cs.SaveCollection !== "function") return { tag: "no-api" };
    ${HELPERS}
    try {
      const col = findById(cs, ${JSON.stringify(collectionId)});
      if (!col) return { tag: "error", error: "no collection with id " + ${JSON.stringify(collectionId)} };
      if (typeof col.SetDisplayName === "function") col.SetDisplayName(${JSON.stringify(name)});
      else col.m_strName = ${JSON.stringify(name)};
      await cs.SaveCollection(col);
      return { tag: "ok", value: infoOf(col) };
    } catch (e) { return { tag: "error", error: String(e && e.message) }; }
  })()`;
  return unwrap<SteamCollectionInfo>(await client._evaluateAsync(expr), "renameCollection");
}

/**
 * Delete a collection **by id**.
 *
 * By id and only by id, deliberately. Deleting by name is how an automated
 * mirror eats a collection the user built by hand and named the same thing.
 * Returns `false` when the id is already gone, which is a success for every
 * caller — the desired end state holds.
 */
export async function deleteCollection(
  client: SteamClient,
  args: { collectionId: string },
): Promise<boolean> {
  const { collectionId } = args;
  const expr = `(async () => {
    const cs = window.collectionStore;
    if (!cs) return { tag: "no-store" };
    ${HELPERS}
    try {
      const col = findById(cs, ${JSON.stringify(collectionId)});
      if (!col) return { tag: "ok", value: false };
      if (typeof cs.DeleteCollection === "function") await cs.DeleteCollection(col);
      else if (typeof col.Delete === "function") await col.Delete();
      else return { tag: "no-api" };
      return { tag: "ok", value: true };
    } catch (e) { return { tag: "error", error: String(e && e.message) }; }
  })()`;
  return unwrap<boolean>(await client._evaluateAsync(expr), "deleteCollection");
}

/**
 * The collection ids Steam itself associates with an app.
 *
 * Read through Steam's own index rather than by scanning `userCollections`,
 * because that index is what the library UI renders from. A collection can be
 * saved and still not appear here, and if it doesn't appear here the user
 * doesn't see the game in the collection — which is the entire point of
 * mirroring.
 */
export async function collectionsForApp(
  client: SteamClient,
  args: { appId: string | number },
): Promise<string[]> {
  const appId = Number(args.appId);
  if (!Number.isFinite(appId)) throw new Error(`collectionsForApp: invalid appId ${args.appId}`);

  const expr = `(() => {
    const cs = window.collectionStore;
    if (!cs) return { tag: "no-store" };
    if (typeof cs.GetCollectionListForAppID !== "function") return { tag: "no-api" };
    try {
      const list = cs.GetCollectionListForAppID(${appId}) || [];
      return {
        tag: "ok",
        value: list.map((c) => String(c && c.id != null ? c.id : c && c.m_strId)).filter(Boolean),
      };
    } catch (e) { return { tag: "error", error: String(e && e.message) }; }
  })()`;
  return unwrap<string[]>(await client._evaluateAsync(expr), "collectionsForApp");
}

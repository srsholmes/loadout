#!/usr/bin/env bun
/**
 * Maintainer tool. Dumps the real shape of Steam's metadata sources on a
 * real device, so Phases 2–4 can be written against measurements instead of
 * guesses.
 *
 *   bun plugins/library-tabs/scripts/probe-steam-metadata.ts > docs/steam-metadata-probe.md
 *
 * **Why this exists.** Loadout is developed on machines that have no Steam
 * install, and the three things Phases 2–4 depend on are all undocumented:
 *
 * 1. `window.appStore.allApps` overview objects. Loadout's existing
 *    `getAllApps` reads only `appid`, `app_type` and `display_name`. Every
 *    other field name Phase 2 needs (`rt_last_time_played`,
 *    `minutes_playtime_forever`, `steam_deck_compat_category`,
 *    `size_on_disk`, `store_tag`, `per_client_data`, `rt_purchased_time`,
 *    `display_status`, `steam_hw_compat_category_packed`) is inferred from
 *    reading TabMaster's source. Inferred, not verified.
 * 2. `appcache/appinfo.vdf`'s byte layout. The per-section header's trailing
 *    20-byte sha1 is the field implementations most often disagree about
 *    across v28/v29, and getting it wrong shifts every later section by 20
 *    bytes — which decodes as garbage rather than failing loudly.
 * 3. `collectionStore`'s method surface. Phase 4 needs a *remove* operation;
 *    only `AddApps` is confirmed to exist in loadout today. If `RemoveApps`
 *    is absent, the mirror has to create-and-replace instead, which loses
 *    the user's sidebar ordering — a design decision we can only make with
 *    this output in hand.
 *
 * Read-only: it evaluates expressions in Steam's context and reads bytes off
 * disk. It writes nothing, changes no collection, and touches no config.
 */

import { open } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { getSteamDir } from "@loadout/steam-paths";
import { CDPClient, findSharedJsTab } from "@loadout/steam-cdp";

const SAMPLE_APPS = 5;
const SAMPLE_SECTIONS = 3;

function heading(text: string): void {
  console.log(`\n## ${text}\n`);
}

function fence(body: string, lang = ""): void {
  console.log("```" + lang);
  console.log(body.trimEnd());
  console.log("```");
}

function note(text: string): void {
  console.log(`> ${text}\n`);
}

/**
 * Evaluate an expression in Steam's SharedJSContext.
 *
 * Goes through `CDPClient` rather than `SteamClient`: the latter is a typed
 * facade over specific Steam APIs, whereas this script's whole job is to look
 * at surfaces nobody has typed yet.
 */
async function evaluateInSteam<T>(expression: string): Promise<T> {
  const tab = await findSharedJsTab();
  if (!tab) {
    throw new Error(
      "SharedJSContext tab not found — is Steam running with its CEF debug port open?",
    );
  }
  const client = new CDPClient(tab.webSocketDebuggerUrl);
  await client.connect();
  try {
    return (await client.evaluate(expression, { awaitPromise: false })) as T;
  } finally {
    client.close();
  }
}

// ── appStore ───────────────────────────────────────────────────────────

/**
 * Dump the full key set of a few overview objects, with each value's type
 * and a truncated sample. Types matter as much as names: several of these
 * fields are documented in TabMaster as numbers but could plausibly be
 * strings, and a silent `Number(undefined)` is how a filter ends up matching
 * nothing.
 */
async function probeAppStore(): Promise<void> {
  heading("`window.appStore.allApps` overview shape");

  const expr = `(() => {
    const store = window.appStore;
    if (!store || !Array.isArray(store.allApps)) return { tag: "no-store" };

    const describe = (app) => {
      const out = {};
      for (const key of Object.keys(app)) {
        let value;
        try { value = app[key]; } catch (e) { out[key] = "<<throws>>"; continue; }
        const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
        let sample;
        if (type === "object" || type === "array") {
          try { sample = JSON.stringify(value).slice(0, 160); } catch { sample = "<<unserialisable>>"; }
        } else if (type === "function") {
          sample = "<<function>>";
        } else {
          sample = String(value).slice(0, 160);
        }
        out[key] = type + " = " + sample;
      }
      return out;
    };

    // Deliberately spread the sample across app types so we see fields that
    // only appear on shortcuts, demos or soundtracks.
    const byType = new Map();
    for (const app of store.allApps) {
      if (!app) continue;
      const t = app.app_type;
      if (!byType.has(t)) byType.set(t, app);
      if (byType.size >= ${SAMPLE_APPS}) break;
    }

    const typeCounts = {};
    for (const app of store.allApps) {
      if (!app) continue;
      typeCounts[app.app_type] = (typeCounts[app.app_type] ?? 0) + 1;
    }

    return {
      tag: "ok",
      total: store.allApps.length,
      typeCounts,
      allKeys: [...new Set(store.allApps.slice(0, 200).flatMap((a) => a ? Object.keys(a) : []))].sort(),
      samples: [...byType.entries()].map(([appType, app]) => ({
        appType,
        displayName: app.display_name,
        fields: describe(app),
      })),
    };
  })()`;

  try {
    const result = await evaluateInSteam<
      | { tag: "no-store" }
      | {
          tag: "ok";
          total: number;
          typeCounts: Record<string, number>;
          allKeys: string[];
          samples: Array<{
            appType: number;
            displayName: string;
            fields: Record<string, string>;
          }>;
        }
    >(expr);

    if (result.tag === "no-store") {
      note("`window.appStore.allApps` was not available. Open Steam's library once and re-run.");
      return;
    }

    console.log(`\`allApps.length\` = **${result.total}**\n`);
    console.log(`App-type histogram (\`app_type\` → count):\n`);
    fence(JSON.stringify(result.typeCounts, null, 2), "json");

    console.log(
      `\nUnion of keys across the first 200 apps (**${result.allKeys.length}** total):\n`,
    );
    fence(result.allKeys.join("\n"));

    for (const sample of result.samples) {
      console.log(`\n### \`app_type: ${sample.appType}\` — ${sample.displayName}\n`);
      fence(
        Object.entries(sample.fields)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n"),
      );
    }

    console.log("\n### Fields Phase 2 expects\n");
    const expected = [
      "appid", "display_name", "app_type", "sort_as", "size_on_disk",
      "rt_original_release_date", "rt_steam_release_date", "rt_purchased_time",
      "rt_last_time_played", "minutes_playtime_forever",
      "steam_deck_compat_category", "steam_hw_compat_category_packed",
      "review_percentage", "metacritic_score", "display_status",
      "store_tag", "store_category", "per_client_data", "installed",
    ];
    const present = new Set(result.allKeys);
    fence(
      expected
        .map((key) => `${present.has(key) ? "PRESENT " : "MISSING "} ${key}`)
        .join("\n"),
    );
    note(
      "Every MISSING row is a Phase-2 field that needs a different source or a " +
        "corrected name. `providers/appstore.ts` reads all of these through a " +
        "`pick()` helper, so a missing key degrades one field with a warning " +
        "rather than breaking the provider.",
    );
  } catch (err) {
    note(`Could not reach Steam over CDP: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── collectionStore ────────────────────────────────────────────────────

async function probeCollectionStore(): Promise<void> {
  heading("`collectionStore` surface");

  const expr = `(() => {
    const cs = window.collectionStore;
    if (!cs) return { tag: "no-store" };

    const methodsOf = (obj) => {
      const out = new Set();
      let cur = obj;
      while (cur && cur !== Object.prototype) {
        for (const key of Object.getOwnPropertyNames(cur)) {
          try { if (typeof obj[key] === "function") out.add(key); } catch {}
        }
        cur = Object.getPrototypeOf(cur);
      }
      return [...out].sort();
    };

    const userCollections = cs.userCollections ?? [];
    const sample = userCollections[0] ?? null;

    return {
      tag: "ok",
      storeMethods: methodsOf(cs),
      storeKeys: Object.keys(cs).sort(),
      userCollectionCount: userCollections.length,
      collectionMethods: sample ? methodsOf(sample) : [],
      collectionKeys: sample ? Object.keys(sample).sort() : [],
      collections: userCollections.slice(0, 10).map((c) => ({
        id: c.id,
        displayName: c.displayName,
        isDynamic: c.bIsDynamic ?? null,
        isEditable: typeof c.AsEditableCollection === "function"
          ? c.AsEditableCollection() !== null
          : null,
        appCount: c.allApps?.length ?? null,
      })),
    };
  })()`;

  try {
    const result = await evaluateInSteam<
      | { tag: "no-store" }
      | {
          tag: "ok";
          storeMethods: string[];
          storeKeys: string[];
          userCollectionCount: number;
          collectionMethods: string[];
          collectionKeys: string[];
          collections: Array<Record<string, unknown>>;
        }
    >(expr);

    if (result.tag === "no-store") {
      note("`window.collectionStore` was not available.");
      return;
    }

    console.log("### `collectionStore` methods\n");
    fence(result.storeMethods.join("\n"));
    console.log("\n### `collectionStore` own keys\n");
    fence(result.storeKeys.join("\n"));

    console.log(`\n### A user collection (of ${result.userCollectionCount})\n`);
    console.log("Methods:\n");
    fence(result.collectionMethods.join("\n"));
    console.log("\nKeys:\n");
    fence(result.collectionKeys.join("\n"));

    console.log("\n### First 10 user collections\n");
    fence(JSON.stringify(result.collections, null, 2), "json");

    console.log("\n### Phase-4 requirements\n");
    const needed = ["AddApps", "RemoveApps", "SaveCollection", "NewUnsavedCollection",
      "GetUserCollectionsByName", "GetCollection", "DeleteCollection"];
    const have = new Set([...result.storeMethods, ...result.collectionMethods]);
    fence(needed.map((m) => `${have.has(m) ? "PRESENT " : "MISSING "} ${m}`).join("\n"));
    note(
      "If `RemoveApps` is MISSING, `CollectionsApi.setApps` cannot do a " +
        "replace-set and has to create-then-delete instead — which loses the " +
        "user's position in Steam's sidebar. Decide that before writing Phase 4.",
    );
  } catch (err) {
    note(`Could not reach Steam over CDP: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── appinfo.vdf ────────────────────────────────────────────────────────

const MAGIC_V28 = 0x07564428;
const MAGIC_V29 = 0x07564429;

/**
 * Walk the per-app section chain, validating that each section's declared
 * size lands exactly on the next section's first byte.
 *
 * This is the measurement that turns a format guess into a fact. We try both
 * candidate header layouts — with and without the trailing 20-byte binary
 * sha1 — and report which one chains cleanly over the *whole* file. Phase 3's
 * `sections.ts` then does the same thing at runtime instead of hardcoding a
 * layout that happens to work on one Steam build.
 */
async function probeAppInfo(): Promise<void> {
  heading("`appcache/appinfo.vdf`");

  const path = join(getSteamDir(), "appcache", "appinfo.vdf");
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    note(`Not found at \`${path}\`.`);
    return;
  }

  const handle = await open(path, "r");
  try {
    const head = Buffer.alloc(64);
    await handle.read(head, 0, 64, 0);

    const magic = head.readUInt32LE(0);
    const universe = head.readUInt32LE(4);

    console.log(`Path: \`${path}\``);
    console.log(`Size: **${(size / 1024 ** 2).toFixed(1)} MiB** (${size} bytes)`);
    console.log(
      `Magic: \`0x${magic.toString(16)}\` ` +
        `(${magic === MAGIC_V29 ? "v29 — string table" : magic === MAGIC_V28 ? "v28 — inline keys" : "UNKNOWN"})`,
    );
    console.log(`Universe: \`${universe}\`\n`);

    console.log("First 64 bytes:\n");
    fence(
      (head.toString("hex").match(/.{1,32}/g) ?? []).join("\n"),
    );

    if (magic !== MAGIC_V28 && magic !== MAGIC_V29) {
      note(
        "Unknown magic. Phase 3's `framing.ts` must return " +
          "`{ supported: false, magic }` for this and the provider must go " +
          "`unavailable` with a sentence naming the value — never crash, never guess.",
      );
      return;
    }

    // v29 stores a string-table offset immediately after the universe.
    let bodyStart = 8;
    if (magic === MAGIC_V29) {
      const tableOffset = head.readBigUInt64LE(8);
      bodyStart = 16;
      console.log(`String-table offset: \`${tableOffset}\` (file is ${size} bytes)\n`);
      if (Number(tableOffset) >= size) {
        note("String-table offset is past the end of the file — treat as corrupt.");
      }
    }

    // Try both candidate header layouts and see which one chains.
    for (const withSha1 of [true, false]) {
      const headerSize = withSha1 ? 4 + 4 + 4 + 4 + 20 + 4 + 20 : 4 + 4 + 4 + 4 + 20 + 4;
      const label = withSha1
        ? "with trailing 20-byte binary sha1"
        : "without trailing binary sha1";

      const report = await chainValidate(handle, bodyStart, size, headerSize);
      console.log(`\n### Header layout: ${label} (${headerSize} bytes)\n`);
      fence(report.lines.join("\n"));
      console.log(
        report.ok
          ? `\n**Chain validated over all ${report.sections} sections.**\n`
          : `\n**Chain BROKE after ${report.sections} sections.**\n`,
      );
    }

    note(
      "Exactly one layout above should validate over the whole file. That is " +
        "the one `sections.ts` must use — and it must chain-validate at runtime " +
        "and retry the alternate layout on mismatch, because this is a " +
        "measurement of one Steam build, not a guarantee about all of them.",
    );
  } finally {
    await handle.close();
  }
}

interface ChainReport {
  ok: boolean;
  sections: number;
  lines: string[];
}

/**
 * Follow `offset + size` from section to section. Each app section is
 * `appid (u32)`, `size (u32)`, then `size` bytes of body — so the next
 * section begins at `offset + 8 + size`. A terminator appid of 0 ends the
 * list.
 */
async function chainValidate(
  handle: Awaited<ReturnType<typeof open>>,
  start: number,
  fileSize: number,
  headerSize: number,
): Promise<ChainReport> {
  const lines: string[] = [];
  const header = Buffer.alloc(headerSize);
  let offset = start;
  let count = 0;

  while (offset + 8 <= fileSize) {
    const { bytesRead } = await handle.read(header, 0, headerSize, offset);
    if (bytesRead < 8) break;

    const appId = header.readUInt32LE(0);
    if (appId === 0) {
      lines.push(`@${offset}: terminator (appid 0) — clean end`);
      return { ok: true, sections: count, lines };
    }

    const sectionSize = header.readUInt32LE(4);
    const next = offset + 8 + sectionSize;

    if (count < SAMPLE_SECTIONS) {
      // Only decode the descriptive fields for the first few, to keep the
      // report readable.
      const infoState = bytesRead >= 12 ? header.readUInt32LE(8) : -1;
      const lastUpdated = bytesRead >= 16 ? header.readUInt32LE(12) : -1;
      const picsToken = bytesRead >= 24 ? header.readBigUInt64LE(16) : -1n;
      lines.push(
        `@${offset}: appid=${appId} size=${sectionSize} infoState=${infoState} ` +
          `lastUpdated=${lastUpdated} picsToken=${picsToken} -> next @${next}`,
      );
    }

    if (sectionSize === 0 || next > fileSize) {
      lines.push(
        `@${offset}: appid=${appId} declares size=${sectionSize}, next would be ` +
          `@${next} but the file is ${fileSize} bytes — CHAIN BROKEN`,
      );
      return { ok: false, sections: count, lines };
    }

    offset = next;
    count++;
  }

  lines.push(`Ran out of file after ${count} sections (no terminator found)`);
  return { ok: false, sections: count, lines };
}

// ── main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("# Steam metadata probe");
  console.log(
    "\nGenerated by `plugins/library-tabs/scripts/probe-steam-metadata.ts`. " +
      "Read-only: this script writes nothing and changes no Steam state.\n",
  );
  console.log(`Steam directory: \`${getSteamDir()}\``);

  await probeAppStore();
  await probeCollectionStore();
  await probeAppInfo();

  console.log("\n---\n");
  console.log(
    "Commit this file as `docs/steam-metadata-probe.md`. Phases 2, 3 and 4 " +
      "are gated on it — until it exists, their field names and byte layouts " +
      "are inferred from TabMaster's source rather than measured.",
  );
}

await main();

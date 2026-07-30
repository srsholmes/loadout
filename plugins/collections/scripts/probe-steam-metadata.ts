#!/usr/bin/env bun
/**
 * Maintainer tool. Dumps the real shape of Steam's metadata sources on a
 * real device, so Phases 2–4 can be written against measurements instead of
 * guesses.
 *
 *   bun plugins/collections/scripts/probe-steam-metadata.ts > docs/steam-metadata-probe.md
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

interface ExpectedField {
  key: string;
  /** Look the key up on `per_client_data[]` entries, not the overview. */
  inPerClient?: boolean;
  /** Value is a Set/Map — "carries data" means non-empty rather than truthy. */
  isSet?: boolean;
  /** Short note carried into the report. */
  note?: string;
}

/**
 * The fields Phase 2 wants, including the names originally *guessed* from
 * TabMaster's source alongside the real ones, so the report shows the guesses
 * failing rather than quietly omitting them.
 */
const EXPECTED_FIELDS: readonly ExpectedField[] = [
  { key: "appid" },
  { key: "display_name" },
  { key: "app_type" },
  { key: "sort_as" },
  { key: "size_on_disk" },
  { key: "rt_original_release_date" },
  { key: "rt_steam_release_date" },
  { key: "rt_purchased_time" },
  { key: "rt_last_time_played" },
  { key: "minutes_playtime_forever" },
  { key: "metacritic_score" },
  { key: "per_client_data" },
  { key: "steam_deck_compat_category", note: "**prefer this** — already unpacked (1|2|3)" },
  { key: "steam_hw_compat_category_packed", note: "packed bitfield; the getter above decodes it" },
  { key: "steam_os_compat_category", note: "for the steamOsCompat rule" },
  { key: "steam_machine_compat_category" },
  { key: "steam_frame_compat_category" },
  { key: "review_percentage", note: "equals review_percentage_without_bombs" },
  { key: "review_percentage_without_bombs" },
  { key: "store_tag", note: "same numeric IDs as m_setStoreTags — **not names**" },
  { key: "m_setStoreTags", isSet: true, note: "numeric tag IDs, not names" },
  { key: "store_category", note: "numeric category IDs" },
  { key: "m_setStoreCategories", isSet: true },
  { key: "display_status", note: "getter; also on per_client_data[]" },
  { key: "display_status", inPerClient: true },
  { key: "installed", note: "getter; also on per_client_data[]" },
  { key: "installed", inPerClient: true },
];

function fieldLabel(f: ExpectedField): string {
  return f.inPerClient ? `per_client_data[].${f.key}` : f.key;
}

/**
 * Dump the full key set of a few overview objects, with each value's type
 * and a truncated sample. Types matter as much as names: several of these
 * fields are documented in TabMaster as numbers but could plausibly be
 * strings, and a silent `Number(undefined)` is how a filter ends up matching
 * nothing.
 *
 * Key *presence* is measured over a 200-app sample but *population* is
 * measured over the whole library, because they are different questions with
 * different answers. `size_on_disk` is a key on every overview object and
 * carries a value on under 3% of apps; a probe that only reported presence
 * said PRESENT and sent Phase 2 off to build a filter on nothing.
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

    // Population over the WHOLE library. "defined" = the key carries a value
    // at all; "usable" additionally excludes 0 and "" (Steam's unset markers)
    // and, for Sets, empties.
    const expected = ${JSON.stringify(EXPECTED_FIELDS)};
    const populated = expected.map((spec) => {
      let defined = 0;
      let usable = 0;
      let own = 0;
      let resolves = 0;
      for (const app of store.allApps) {
        if (!app) continue;
        let value;
        if (spec.inPerClient) {
          const arr = app.per_client_data;
          if (!Array.isArray(arr)) continue;
          let found;
          for (const entry of arr) {
            if (entry && entry[spec.key] !== undefined) { found = entry[spec.key]; break; }
          }
          value = found;
        } else {
          // An own key is enumerable via Object.keys; a getter on the
          // prototype is not, but reads perfectly well. Both are usable, and
          // conflating them is how a real field gets reported MISSING.
          if (Object.prototype.hasOwnProperty.call(app, spec.key)) own++;
          if (spec.key in app) resolves++;
          try { value = app[spec.key]; } catch (e) { continue; }
        }
        if (value === undefined || value === null) continue;
        defined++;
        if (spec.isSet) {
          const n = value.size ?? Object.keys(value).length;
          if (n > 0) usable++;
        } else if (Array.isArray(value)) {
          if (value.length > 0) usable++;
        } else if (value !== 0 && value !== "" && value !== false) {
          usable++;
        }
      }
      return { defined, usable, own, resolves };
    });

    // The overview class's prototype. Its getters are the half of the API
    // Object.keys cannot see, and several are exactly what Phase 2 wants —
    // steam_deck_compat_category returns a decoded enum rather than the packed
    // bitfield the own key carries.
    const first = store.allApps.find((a) => a);
    const proto = first ? Object.getPrototypeOf(first) : null;
    const protoAccessors = [];
    const protoMethods = [];
    for (const name of proto ? Object.getOwnPropertyNames(proto) : []) {
      if (name === "constructor") continue;
      const d = Object.getOwnPropertyDescriptor(proto, name);
      if (!d) continue;
      if (typeof d.get === "function") protoAccessors.push(name);
      else if (typeof d.value === "function") protoMethods.push(name);
    }

    return {
      tag: "ok",
      total: store.allApps.length,
      typeCounts,
      allKeys: [...new Set(store.allApps.slice(0, 200).flatMap((a) => a ? Object.keys(a) : []))].sort(),
      protoAccessors: protoAccessors.sort(),
      protoMethods: protoMethods.sort(),
      populated,
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
          protoAccessors: string[];
          protoMethods: string[];
          populated: Array<{
            defined: number;
            usable: number;
            own: number;
            resolves: number;
          }>;
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

    console.log(
      `\n### Prototype getters (**${result.protoAccessors.length}**) — invisible to \`Object.keys\`\n`,
    );
    note(
      "These are part of the API and read like any other field, but no " +
        "key-enumeration probe will ever list them. Several are strictly " +
        "better than the own key covering the same ground: " +
        "`steam_deck_compat_category` returns a decoded category where " +
        "`steam_hw_compat_category_packed` returns a bitfield.",
    );
    fence(result.protoAccessors.join("\n"));

    console.log(`\nPrototype methods (**${result.protoMethods.length}**):\n`);
    fence(result.protoMethods.join("\n"));

    for (const sample of result.samples) {
      console.log(`\n### \`app_type: ${sample.appType}\` — ${sample.displayName}\n`);
      fence(
        Object.entries(sample.fields)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n"),
      );
    }

    console.log("\n### Fields Phase 2 expects\n");
    console.log(
      `All counts are over the whole library (**${result.total} apps**), not ` +
        `the 200-app key sample above.\n`,
    );
    console.log(
      "`Access` distinguishes an **own key** (enumerable, shows up in " +
        "`Object.keys`) from a **getter** on the prototype (invisible to " +
        "`Object.keys`, reads fine) from **absent** (not resolvable at all). " +
        "Only *absent* means the name is wrong.\n",
    );
    console.log("| Field | Access | Defined | Usable | % | Note |");
    console.log("|---|---|---:|---:|---:|---|");
    for (const [i, spec] of EXPECTED_FIELDS.entries()) {
      const c = result.populated[i] ?? { defined: 0, usable: 0, own: 0, resolves: 0 };
      const pct = result.total > 0 ? Math.round((c.usable / result.total) * 100) : 0;
      const access = spec.inPerClient
        ? "nested"
        : c.own > 0
          ? "own key"
          : c.resolves > 0
            ? "getter"
            : "**absent**";
      console.log(
        `| \`${fieldLabel(spec)}\` | ${access} | ${c.defined} | ` +
          `${c.usable} | ${pct}% | ${spec.note ?? ""} |`,
      );
    }
    console.log("");
    note(
      "Two failure modes, and the row layout separates them. **absent** means " +
        "the name is wrong — fix it. A field that resolves but has a low " +
        "`usable` count is the more dangerous one, because nothing looks " +
        "broken: it reads without error and is simply unset for most of the " +
        "library. `providers/appstore.ts` reads every field through a `pick()` " +
        "helper so a bad name degrades one field rather than the provider — but " +
        "no helper rescues a filter built on a field 3% of games populate. " +
        "Prefer another source for those.",
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

/** Binary-KV type byte opening a nested object — the first byte of a body. */
const KV_NESTED = 0x00;
/** Binary-KV byte closing a nested object. A section ends with two. */
const KV_END = 0x08;

/**
 * Candidate per-section header layouts, in bytes measured from the start of
 * the section (so each figure includes `appid` and `size`):
 *
 *   appid u32 · size u32 · infoState u32 · lastUpdated u32 · picsToken u64
 *   · sha1_text u8[20] · changeNumber u32 · [sha1_binary u8[20]]
 *
 * `sha1_binary` is the field implementations disagree about across v28/v29.
 * The two `no picsToken` candidates are the arithmetic this script used
 * before 2026-07-30 — they dropped `picsToken`'s 8 bytes — kept here so the
 * report shows them losing instead of leaving a reader to wonder.
 */
interface HeaderCandidate {
  /** Total header size from the start of the section, including appid + size. */
  bytes: number;
  label: string;
  picsToken: boolean;
  sha1Binary: boolean;
}

const HEADER_CANDIDATES: readonly HeaderCandidate[] = [
  {
    bytes: 4 + 4 + 4 + 4 + 8 + 20 + 4 + 20,
    label: "picsToken + sha1_binary",
    picsToken: true,
    sha1Binary: true,
  },
  {
    bytes: 4 + 4 + 4 + 4 + 8 + 20 + 4,
    label: "picsToken, no sha1_binary",
    picsToken: true,
    sha1Binary: false,
  },
  {
    bytes: 4 + 4 + 4 + 4 + 20 + 4 + 20,
    label: "no picsToken, sha1_binary",
    picsToken: false,
    sha1Binary: true,
  },
  {
    bytes: 4 + 4 + 4 + 4 + 20 + 4,
    label: "no picsToken, no sha1_binary",
    picsToken: false,
    sha1Binary: false,
  },
];

/**
 * Walk the per-app section chain and measure which header layout is real.
 *
 * Two distinct checks, because they answer different questions and conflating
 * them is what made the pre-2026-07-30 version of this probe useless:
 *
 * - **Chain integrity** — each section's declared `size` must land exactly on
 *   the next section's first byte. This catches a corrupt file. It says
 *   *nothing* about the header layout: the next section is at
 *   `offset + 8 + size` regardless of how many header fields follow `size`,
 *   so every candidate layout "passes" it. The old probe reported exactly
 *   that and claimed it discriminated.
 * - **Body framing** — the byte at `offset + headerSize` must be `0x00`
 *   (a nested object opens every section) and the section's last two bytes
 *   must be `0x08 0x08`. This *does* discriminate: a wrong header size points
 *   into the middle of a sha1 instead of at a type byte.
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

    const report = await walkSections(handle, bodyStart, size);

    console.log("\n### Section chain\n");
    fence(report.lines.join("\n"));
    console.log(
      report.ok
        ? `\n**Chain validated over all ${report.sections} sections.**\n`
        : `\n**Chain BROKE after ${report.sections} sections.**\n`,
    );
    note(
      "Chain integrity only. The next section sits at `offset + 8 + size` no " +
        "matter how many header fields follow `size`, so this result is the " +
        "same for every candidate layout and **cannot** identify the header. " +
        "That is what the next section is for.",
    );

    console.log("\n### Header layout discrimination\n");
    console.log(
      "A section body opens with `0x00` and the section's last two bytes are " +
        "`0x08 0x08`. A wrong header size lands mid-sha1 instead of on a type " +
        "byte, so this measurement discriminates where the chain walk cannot.\n",
    );
    console.log("| Header | Bytes | Sections framed correctly | |");
    console.log("|---|---:|---:|---|");
    const ranked = [...HEADER_CANDIDATES].sort(
      (a, b) => (report.bodyValid.get(b.bytes) ?? 0) - (report.bodyValid.get(a.bytes) ?? 0),
    );
    for (const c of HEADER_CANDIDATES) {
      const ok = report.bodyValid.get(c.bytes) ?? 0;
      const verdict =
        ok === report.sections && report.sections > 0
          ? "**ALL VALID**"
          : ok === 0
            ? "no"
            : "coincidence";
      console.log(`| ${c.label} | ${c.bytes} | ${ok} / ${report.sections} | ${verdict} |`);
    }

    const winner = ranked[0];
    const winnerOk = winner ? (report.bodyValid.get(winner.bytes) ?? 0) : 0;
    console.log("");
    if (winner && report.sections > 0 && winnerOk === report.sections) {
      console.log(
        `**Header is ${winner.bytes} bytes** (${winner.label}) — framed ` +
          `correctly for all ${report.sections} sections. This is what ` +
          "Phase 3's `sections.ts` must use.\n",
      );
      fence(await describeSection(handle, bodyStart, winner), "text");
    } else {
      note(
        "No candidate frames every section. The format has moved — " +
          "`framing.ts` must report `{ supported: false, magic }` and the " +
          "provider must go `unavailable` rather than decode garbage.",
      );
    }

    note(
      "`sections.ts` must validate the **body framing** at runtime, not the " +
        "chain, and retry the alternate layout on mismatch. Chain-validating " +
        "cannot fail on a wrong header size, so it yields false confidence. " +
        "This is a measurement of one Steam build, not a guarantee about all.",
    );
  } finally {
    await handle.close();
  }
}

interface ChainReport {
  ok: boolean;
  sections: number;
  lines: string[];
  /** Candidate header size -> sections whose body framed correctly under it. */
  bodyValid: Map<number, number>;
}

/**
 * Follow `offset + size` from section to section, scoring every candidate
 * header layout along the way. Each app section is `appid (u32)`,
 * `size (u32)`, then `size` bytes of header-plus-body — so the next section
 * begins at `offset + 8 + size`. A terminator appid of 0 ends the list.
 */
async function walkSections(
  handle: Awaited<ReturnType<typeof open>>,
  start: number,
  fileSize: number,
): Promise<ChainReport> {
  const lines: string[] = [];
  const bodyValid = new Map<number, number>();
  for (const c of HEADER_CANDIDATES) bodyValid.set(c.bytes, 0);

  const widest = Math.max(...HEADER_CANDIDATES.map((c) => c.bytes));
  // +1 so the byte *at* the widest candidate's body start is readable.
  const header = Buffer.alloc(widest + 1);
  const tail = Buffer.alloc(2);
  let offset = start;
  let count = 0;

  while (offset + 8 <= fileSize) {
    const { bytesRead } = await handle.read(header, 0, header.length, offset);
    if (bytesRead < 8) break;

    const appId = header.readUInt32LE(0);
    if (appId === 0) {
      lines.push(`@${offset}: terminator (appid 0) — clean end`);
      return { ok: true, sections: count, lines, bodyValid };
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
      return { ok: false, sections: count, lines, bodyValid };
    }

    // A section closes with `0x08 0x08` (end nested, end root) regardless of
    // header layout, so read it once and reuse it for every candidate.
    await handle.read(tail, 0, 2, next - 2);
    const closes = tail[0] === KV_END && tail[1] === KV_END;

    for (const c of HEADER_CANDIDATES) {
      // The body must start inside this section, and `header` must actually
      // hold the byte we are about to test.
      if (c.bytes >= 8 + sectionSize || c.bytes >= bytesRead) continue;
      if (closes && header[c.bytes] === KV_NESTED) {
        bodyValid.set(c.bytes, (bodyValid.get(c.bytes) ?? 0) + 1);
      }
    }

    offset = next;
    count++;
  }

  lines.push(`Ran out of file after ${count} sections (no terminator found)`);
  return { ok: false, sections: count, lines, bodyValid };
}

/** Field-by-field decode of one section under a known header layout. */
async function describeSection(
  handle: Awaited<ReturnType<typeof open>>,
  offset: number,
  layout: HeaderCandidate,
): Promise<string> {
  const buf = Buffer.alloc(layout.bytes + 16);
  await handle.read(buf, 0, buf.length, offset);
  const hex = (from: number, to: number) =>
    [...buf.subarray(from, to)].map((b) => b.toString(16).padStart(2, "0")).join(" ");

  const sha1TextAt = layout.picsToken ? 24 : 16;
  const changeAt = sha1TextAt + 20;
  const out = [
    `@${offset} appid=${buf.readUInt32LE(0)} size=${buf.readUInt32LE(4)}`,
    `  infoState    ${buf.readUInt32LE(8)}`,
    `  lastUpdated  ${buf.readUInt32LE(12)}`,
  ];
  if (layout.picsToken) out.push(`  picsToken    ${buf.readBigUInt64LE(16)}`);
  out.push(
    `  sha1_text    ${hex(sha1TextAt, sha1TextAt + 20)}`,
    `  changeNumber ${buf.readUInt32LE(changeAt)}`,
  );
  if (layout.sha1Binary) {
    out.push(`  sha1_binary  ${hex(changeAt + 4, changeAt + 24)}`);
  }
  out.push(`  body @+${layout.bytes}  ${hex(layout.bytes, layout.bytes + 16)} …`);
  return out.join("\n");
}

// ── main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("# Steam metadata probe");
  console.log(
    "\nGenerated by `plugins/collections/scripts/probe-steam-metadata.ts`. " +
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

#!/usr/bin/env bun
/**
 * Maintainer tool. Measures Steam's real achievement surface on a real
 * device, so Phases 1–3 are written against measurements rather than guesses.
 *
 *   bun plugins/achievement-hunter/scripts/probe-achievements.ts > docs/steam-achievements-probe.md
 *
 * **Why this exists.** Loadout is developed on machines with no Steam install,
 * and the plan's cost model rests on numbers nobody has measured:
 *
 * 1. **The server-side appid cap on `Player.GetAchievementsProgress`.** The
 *    whole "40 requests for a 2000-game library" argument assumes a batch of
 *    ~50 is accepted. If the real cap is 25 the sweep doubles; if it's 400 it
 *    shrinks fivefold. This single number sets `DEFAULT_BATCH_SIZE`, so it is
 *    measured by escalation rather than assumed.
 * 2. **Whether `GetMyAchievementsForApp` already carries global rarity.** If
 *    it does, the whole Tier-3 `GetTopAchievementsForGames` layer is
 *    unnecessary and Phase 3 gets materially smaller.
 * 3. **Which steamid expression actually resolves.** Nothing in the repo
 *    resolves a steamid today; the plan lists four candidate in-page
 *    expressions and none is verified.
 * 4. **The `RegisterForAchievementChanges` payload** — per-unlock or
 *    per-session decides whether the unlock timeline can stay live for free.
 * 5. **Whether the recency fields the dashboard sorts by actually exist** on
 *    `appStore` overviews. `rt_last_time_played` and friends are inferred
 *    from reading TabMaster's source, not verified.
 *
 * Read-only. It evaluates expressions in Steam's context and reads bytes off
 * disk. It writes no config, changes no achievement, and calls no mutator.
 *
 * Rate-limit note: the batch-cap probe deliberately issues a handful of
 * escalating requests with a gap between them. That is a few tens of
 * requests total — far below anything a normal library scan does — but it is
 * the one part of this script that talks to Valve repeatedly, so it is
 * ordered last and can be skipped with `--no-batch-probe`.
 */

import { CDPClient, findSharedJsTab } from "@loadout/steam-cdp";
import { listSteamUiChunks } from "@loadout/steam-paths";
import { findModuleIdInSource } from "@loadout/steam-cdp";

/** Namespaces whose module ids we need to resolve. */
const NAMESPACES = [
  { namespace: "Player", method: "GetAchievementsProgress" },
  { namespace: "Player", method: "GetTopAchievementsForGames" },
  { namespace: "Player", method: "GetOwnedGames" },
] as const;

/** Batch sizes to escalate through when finding the server-side cap. */
const BATCH_LADDER = [25, 50, 100, 200, 400] as const;

/** Gap between batch-cap probes, ms. Deliberately generous. */
const PROBE_GAP_MS = 1_000;

/** The recency and shape fields Phase 1 sorts and filters by. */
const WANTED_OVERVIEW_FIELDS = [
  "appid",
  "app_type",
  "display_name",
  "sort_as",
  "rt_last_time_played",
  "minutes_playtime_forever",
  "minutes_playtime_last_two_weeks",
  "rt_purchased_time",
  "size_on_disk",
  "library_capsule_filename",
] as const;

/** What the "which exports carry this method" expression returns. */
type ExportProbe =
  | { tag: "no-wp" | "no-mod" }
  | { tag: "throw"; detail: string }
  | { tag: "ok"; direct: boolean; via: string[]; allKeys: string[] };

function heading(text: string): void {
  console.log(`\n## ${text}\n`);
}

function subheading(text: string): void {
  console.log(`\n### ${text}\n`);
}

function fence(body: string, lang = "json"): void {
  console.log("```" + lang);
  console.log(body.trimEnd());
  console.log("```");
}

function note(text: string): void {
  console.log(`> ${text}\n`);
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Evaluate in Steam's SharedJSContext via `CDPClient` rather than
 * `SteamClient`: the latter is a typed facade over specific APIs, and this
 * script's whole job is to look at surfaces nobody has typed yet.
 *
 * One client is reused for the whole run — reconnecting per expression would
 * mean dozens of transient CDP connections, which is exactly what Steam's CEF
 * IPC dislikes.
 */
let client: CDPClient | null = null;

/** Read through an annotated accessor: TypeScript otherwise narrows the
 *  closure variable to `null` at the teardown site, since every assignment
 *  happens inside `connect()`. */
function currentClient(): CDPClient | null {
  return client;
}

async function connect(): Promise<CDPClient> {
  const existing = currentClient();
  if (existing) return existing;
  const tab = await findSharedJsTab();
  if (!tab) {
    throw new Error(
      "SharedJSContext tab not found — is Steam running with its CEF debug port open?",
    );
  }
  const created = new CDPClient(tab.webSocketDebuggerUrl);
  await created.connect();
  client = created;
  return created;
}

async function evaluate<T>(expression: string, awaitPromise = true): Promise<T> {
  const c = await connect();
  return (await c.evaluate(expression, { awaitPromise })) as T;
}

// ── 1. Module id resolution ──────────────────────────────────────────────

/**
 * Resolve each namespace by grepping the shipped bundle, and report the
 * module's export key names.
 *
 * The export key is the one thing the production resolver deliberately does
 * NOT grep for (it is minified per build, so it duck-types instead). Dumping
 * the real key names here confirms the duck-typing has something to find.
 */
async function probeModuleResolution(): Promise<Map<string, number>> {
  heading("Service module resolution");

  const chunks = await listSteamUiChunks();
  note(
    `Found ${chunks.length} \`chunk~*.js\` files. Filenames are content-hashed, ` +
      "so the sorted set of basenames is the cache key that invalidates once " +
      "per Steam UI update.",
  );

  const resolved = new Map<string, number>();
  const rows: string[] = [
    "| Namespace.Method | Module id | Chunk | Export keys with this method |",
    "|---|---|---|---|",
  ];

  for (const spec of NAMESPACES) {
    const literal = `${spec.namespace}.${spec.method}#1`;
    let found: { moduleId: number; chunk: string } | null = null;

    for (const path of chunks) {
      let source: string;
      try {
        source = await Bun.file(path).text();
      } catch {
        continue;
      }
      const index =
        source.indexOf(`"${literal}"`) !== -1
          ? source.indexOf(`"${literal}"`)
          : source.indexOf(`'${literal}'`);
      if (index === -1) continue;
      const moduleId = findModuleIdInSource(source, index);
      if (moduleId === null) continue;
      found = { moduleId, chunk: path.slice(path.lastIndexOf("/") + 1) };
      break;
    }

    if (!found) {
      rows.push(`| \`${literal}\` | **NOT FOUND** | — | — |`);
      continue;
    }

    resolved.set(`${spec.namespace}.${spec.method}`, found.moduleId);

    // Ask the page which exports of that module carry the method.
    const keys = await evaluate<ExportProbe>(
      `(() => {
        let wp = globalThis.__STEAM_WP_REQUIRE;
        if (typeof wp !== "function" && Array.isArray(window.webpackChunksteamui)) {
          window.webpackChunksteamui.push([[Symbol()], {}, (r) => { wp = r; }]);
        }
        if (typeof wp !== "function") return { tag: "no-wp" };
        let mod; try { mod = wp(${found.moduleId}); } catch (e) { return { tag: "throw", detail: String(e) }; }
        if (!mod) return { tag: "no-mod" };
        const method = ${JSON.stringify(spec.method)};
        const direct = typeof mod[method] === "function";
        const via = Object.keys(mod).filter((k) => mod[k] && typeof mod[k][method] === "function");
        return { tag: "ok", direct, via, allKeys: Object.keys(mod).slice(0, 30) };
      })()`,
      false,
    );

    const keyDesc =
      keys.tag === "ok"
        ? `\`${JSON.stringify(keys.via)}\` (direct: ${keys.direct})`
        : `\`${json(keys)}\``;

    rows.push(`| \`${literal}\` | \`${found.moduleId}\` | \`${found.chunk}\` | ${keyDesc} |`);
  }

  console.log(rows.join("\n"));
  console.log("");
  note(
    "Module ids change on every Steam build — these are a snapshot for " +
      "cross-checking the resolver, never values to hardcode.",
  );
  return resolved;
}

// ── 2. Steam id ──────────────────────────────────────────────────────────

/**
 * Try every candidate in-page steamid expression and report which resolve.
 *
 * Whichever wins becomes path 1 of `lib/steam-id.ts`'s three-path resolver.
 * A steamid is a 17-digit value, so anything shorter is a different kind of
 * id and must not be accepted.
 */
async function probeSteamId(): Promise<string | null> {
  heading("Steam id resolution");

  const result = await evaluate<{
    candidates: Array<{ expr: string; value: string | null; looksValid: boolean }>;
  }>(
    `(() => {
      const probes = {
        "App.m_CurrentUser.strSteamID": () => window.App?.m_CurrentUser?.strSteamID,
        "App.cm.steamid": () => window.App?.cm?.steamid,
        "App.cm.m_steamid": () => window.App?.cm?.m_steamid,
        "LoginStore.m_strAccountName": () => window.LoginStore?.m_strAccountName,
        "g_steamID": () => globalThis.g_steamID,
        "App.GetCurrentUser().strSteamID": () => window.App?.GetCurrentUser?.()?.strSteamID,
        "SteamClient.User.GetSteamID": () => window.SteamClient?.User?.GetSteamID?.(),
      };
      const candidates = [];
      for (const [expr, fn] of Object.entries(probes)) {
        let value = null;
        try {
          const raw = fn();
          value = raw === undefined || raw === null ? null : String(raw);
        } catch (e) { value = "threw: " + String(e); }
        candidates.push({
          expr,
          value,
          looksValid: typeof value === "string" && /^\\d{17}$/.test(value),
        });
      }
      return { candidates };
    })()`,
    false,
  );

  const rows = ["| Expression | Value | 17-digit? |", "|---|---|---|"];
  let winner: string | null = null;
  for (const c of result.candidates) {
    // Redact all but the last 4 digits: this output gets committed.
    const shown =
      c.looksValid && c.value ? `…${c.value.slice(-4)}` : (c.value ?? "_(absent)_");
    rows.push(`| \`${c.expr}\` | ${shown} | ${c.looksValid ? "**yes**" : "no"} |`);
    if (c.looksValid && !winner) winner = c.value;
  }
  console.log(rows.join("\n"));
  console.log("");
  note(
    winner
      ? "At least one expression resolves — use the first `yes` row as path 1 " +
          "of the resolver. Values are redacted to the last 4 digits."
      : "**No expression resolved a 17-digit id.** The resolver must fall back " +
          "to `loginusers.vdf`. Investigate before building Phase 1.",
  );
  return winner;
}

// ── 3. appStore recency fields ───────────────────────────────────────────

/** PRESENT/MISSING table for the fields the dashboard sorts and filters by. */
async function probeOverviewFields(): Promise<void> {
  heading("`appStore` overview fields the dashboard needs");

  const result = await evaluate<
    | { tag: "no-store" }
    | {
        tag: "ok";
        total: number;
        byType: Record<string, number>;
        fields: Array<{ field: string; present: number; type: string; sample: string }>;
      }
  >(
    `(() => {
      const store = window.appStore;
      if (!store || !Array.isArray(store.allApps)) return { tag: "no-store" };
      const apps = store.allApps.filter(Boolean);
      const wanted = ${JSON.stringify(WANTED_OVERVIEW_FIELDS)};
      const byType = {};
      for (const a of apps) {
        const k = String(a.app_type);
        byType[k] = (byType[k] || 0) + 1;
      }
      const fields = wanted.map((field) => {
        let present = 0, type = "—", sample = "—";
        for (const a of apps) {
          const v = a[field];
          if (v !== undefined && v !== null) {
            present++;
            if (type === "—") {
              type = Array.isArray(v) ? "array" : typeof v;
              sample = String(v).slice(0, 40);
            }
          }
        }
        return { field, present, type, sample };
      });
      return { tag: "ok", total: apps.length, byType, fields };
    })()`,
    false,
  );

  if (result.tag === "no-store") {
    note(
      "**`window.appStore.allApps` is unavailable.** Steam's library UI has " +
        "not booted this session — open the library once and re-run.",
    );
    return;
  }

  note(
    `${result.total} entries in \`allApps\`. Counts by \`app_type\`: ` +
      `\`${json(result.byType)}\`. Note the plan deliberately does NOT filter to ` +
      "`app_type === 1` the way `getAllApps()` does — demos and some " +
      "applications carry achievements.",
  );

  const rows = ["| Field | Present | Type | Sample |", "|---|---|---|---|"];
  for (const f of result.fields) {
    const status =
      f.present === 0 ? "**MISSING**" : `${f.present}/${result.total}`;
    rows.push(`| \`${f.field}\` | ${status} | ${f.type} | \`${f.sample}\` |`);
  }
  console.log(rows.join("\n"));
}

// ── 4. GetMyAchievementsForApp ───────────────────────────────────────────

/**
 * Dump the full key set of the per-game detail call for a game that has
 * partial-progress achievements.
 *
 * The question that matters: **is global rarity in here?** If yes, Tier 3 is
 * unnecessary and "rarest unlocked" becomes free.
 */
async function probeAchievementDetail(appIds: string[]): Promise<void> {
  heading("`SteamClient.Apps.GetMyAchievementsForApp` shape");

  if (appIds.length === 0) {
    note("No candidate appids with achievements were found — skipping.");
    return;
  }

  for (const appId of appIds.slice(0, 2)) {
    subheading(`appid ${appId}`);
    const result = await evaluate<unknown>(
      `(async () => {
        const api = window.SteamClient?.Apps?.GetMyAchievementsForApp;
        if (!api) return { tag: "no-api" };
        try {
          // Race in-page: several SteamClient getters hang forever rather
          // than rejecting, and a hang blocks the whole evaluate chain.
          const res = await Promise.race([
            api(${JSON.stringify(appId)}),
            new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000)),
          ]);
          const list = res?.data?.rgAchievements ?? res?.rgAchievements ?? res;
          const arr = Array.isArray(list) ? list : null;
          if (!arr) return { tag: "unexpected", raw: JSON.stringify(res).slice(0, 800) };
          const keyUnion = [...new Set(arr.flatMap((a) => Object.keys(a || {})))];
          const partial = arr.find(
            (a) => a && a.flMaxProgress && a.flCurrentProgress > 0 && a.flCurrentProgress < a.flMaxProgress
          );
          return {
            tag: "ok",
            count: arr.length,
            achieved: arr.filter((a) => a && a.bAchieved).length,
            keyUnion,
            firstAchieved: arr.find((a) => a && a.bAchieved) ?? null,
            firstLocked: arr.find((a) => a && !a.bAchieved) ?? null,
            partialProgressExample: partial ?? null,
          };
        } catch (e) { return { tag: "throw", detail: String(e) }; }
      })()`,
    );
    fence(json(result));
  }

  note(
    "**Decision this drives:** if the key union contains a global-rarity " +
      "field (something like `flAchieved` / `flAchievedPercent`), drop Tier 3 " +
      "(`GetTopAchievementsForGames`) entirely and cut Phase 3's scope.",
  );
}

// ── 5. RegisterForAchievementChanges ────────────────────────────────────

/**
 * Register the live-unlock callback and report its payload shape.
 *
 * Cannot force an unlock from here, so this reports whether registration
 * succeeds and installs a recorder the operator can inspect after playing.
 */
async function probeAchievementEvents(): Promise<void> {
  heading("`Apps.RegisterForAchievementChanges`");

  const result = await evaluate<unknown>(
    `(() => {
      const api = window.SteamClient?.Apps?.RegisterForAchievementChanges;
      if (!api) return { tag: "no-api" };
      try {
        globalThis.__ah_probe_events = globalThis.__ah_probe_events || [];
        if (!globalThis.__ah_probe_reg) {
          globalThis.__ah_probe_reg = api((...args) => {
            globalThis.__ah_probe_events.push({
              at: Date.now(),
              argCount: args.length,
              args: args.map((a) => {
                try { return JSON.parse(JSON.stringify(a)); } catch (e) { return String(a); }
              }),
            });
          });
        }
        return {
          tag: "ok",
          registrationType: typeof globalThis.__ah_probe_reg,
          hasUnregister: typeof globalThis.__ah_probe_reg?.unregister === "function",
          eventsSoFar: globalThis.__ah_probe_events.length,
        };
      } catch (e) { return { tag: "throw", detail: String(e) }; }
    })()`,
    false,
  );

  fence(json(result));
  note(
    "A recorder is now installed in the page. Play a game, unlock something, " +
      "then read `globalThis.__ah_probe_events` over CDP (DevTools on " +
      "`localhost:9222`). **The question:** does it fire once per unlock " +
      "(the timeline stays live for free) or once per session?",
  );
}

// ── 6. Batch cap ────────────────────────────────────────────────────────

/**
 * Escalate batch sizes against `Player.GetAchievementsProgress` and record
 * where it errors, truncates, or slows non-linearly.
 *
 * This is the number the whole cost model turns on, so it is measured rather
 * than assumed. Ordered last, and skippable, because it is the only part of
 * this script that talks to Valve repeatedly.
 */
async function probeBatchCap(
  moduleId: number,
  steamId: string,
  appIds: string[],
): Promise<void> {
  heading("`Player.GetAchievementsProgress` batch cap");

  if (appIds.length < BATCH_LADDER[0]) {
    note(
      `Only ${appIds.length} candidate appids available — need at least ` +
        `${BATCH_LADDER[0]} to probe the ladder. Skipping.`,
    );
    return;
  }

  const rows = [
    "| Requested | Returned | Truncated? | ms | EResult | Outcome |",
    "|---|---|---|---|---|---|",
  ];

  for (const size of BATCH_LADDER) {
    if (appIds.length < size) {
      rows.push(`| ${size} | — | — | — | — | _skipped: library too small_ |`);
      continue;
    }

    const batch = appIds.slice(0, size).map((id) => Number(id));
    const started = Date.now();
    const result = await evaluate<{
      tag: string;
      eresult?: number;
      count?: number;
      detail?: string;
    }>(
      `(async () => {
        let wp = globalThis.__STEAM_WP_REQUIRE;
        if (typeof wp !== "function" && Array.isArray(window.webpackChunksteamui)) {
          window.webpackChunksteamui.push([[Symbol()], {}, (r) => { wp = r; }]);
        }
        if (typeof wp !== "function") return { tag: "no-wp" };
        const mod = wp(${moduleId});
        const method = "GetAchievementsProgress";
        let ns = typeof mod?.[method] === "function" ? mod : null;
        if (!ns) for (const v of Object.values(mod || {})) {
          if (v && typeof v[method] === "function") { ns = v; break; }
        }
        if (!ns) return { tag: "no-namespace" };
        const tp = window.App?.cm?.GetServiceTransport?.();
        if (!tp) return { tag: "no-transport" };
        try {
          const res = await Promise.race([
            ns[method](tp, {
              steamid: ${JSON.stringify(steamId)},
              language: "english",
              appids: ${JSON.stringify(batch)},
            }),
            new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 20000)),
          ]);
          const eresult = typeof res?.GetEResult === "function" ? res.GetEResult() : res?.eresult;
          const body = typeof res?.Body === "function" ? res.Body() : null;
          const obj = body?.constructor?.toObject ? body.constructor.toObject(false, body) : body;
          const list = obj?.achievement_progress;
          return { tag: "ok", eresult, count: Array.isArray(list) ? list.length : -1 };
        } catch (e) { return { tag: "throw", detail: String(e && e.message ? e.message : e) }; }
      })()`,
    );
    const ms = Date.now() - started;

    if (result.tag !== "ok") {
      rows.push(
        `| ${size} | — | — | ${ms} | — | **${result.tag}**${
          result.detail ? ` — ${result.detail}` : ""
        } |`,
      );
      // A failure at this size is the cap; escalating further tells us nothing.
      break;
    }

    const returned = result.count ?? -1;
    const truncated = returned >= 0 && returned < size;
    rows.push(
      `| ${size} | ${returned} | ${truncated ? "**yes**" : "no"} | ${ms} | ` +
        `${result.eresult ?? "—"} | ${
          result.eresult === 1 ? "ok" : `**EResult ${result.eresult}**`
        } |`,
    );

    if (truncated || result.eresult !== 1) break;
    await sleep(PROBE_GAP_MS);
  }

  console.log(rows.join("\n"));
  console.log("");
  note(
    "**Decision this drives:** `DEFAULT_BATCH_SIZE` is the largest row that " +
      "returned all requested appids with EResult 1 and no non-linear slowdown. " +
      "Note that `returned < requested` is expected for games with no " +
      "achievements — cross-check against the detail probe before reading it " +
      "as truncation.",
  );
}

/** Candidate appids, most-recently-played first — the sweep's real order. */
async function recentAppIds(limit: number): Promise<string[]> {
  const result = await evaluate<{ tag: string; appIds?: string[] }>(
    `(() => {
      const store = window.appStore;
      if (!store || !Array.isArray(store.allApps)) return { tag: "no-store" };
      const appIds = store.allApps
        .filter((a) => a && a.appid)
        .slice()
        .sort((a, b) => (b.rt_last_time_played || 0) - (a.rt_last_time_played || 0))
        .map((a) => String(a.appid))
        .slice(0, ${limit});
      return { tag: "ok", appIds };
    })()`,
    false,
  );
  return result.appIds ?? [];
}

async function main(): Promise<void> {
  const skipBatch = process.argv.includes("--no-batch-probe");

  console.log("# Steam achievements probe");
  console.log("");
  console.log(
    "Generated by `plugins/achievement-hunter/scripts/probe-achievements.ts` " +
      "on a real device. Read-only. Steam ids are redacted to their last 4 digits.",
  );

  const modules = await probeModuleResolution();
  const steamId = await probeSteamId();
  await probeOverviewFields();

  const appIds = await recentAppIds(Math.max(...BATCH_LADDER));
  await probeAchievementDetail(appIds);
  await probeAchievementEvents();

  const progressModule = modules.get("Player.GetAchievementsProgress");
  if (skipBatch) {
    heading("`Player.GetAchievementsProgress` batch cap");
    note("Skipped via `--no-batch-probe`.");
  } else if (progressModule === undefined) {
    heading("`Player.GetAchievementsProgress` batch cap");
    note("Skipped: the module id did not resolve, so there is nothing to call.");
  } else if (!steamId) {
    heading("`Player.GetAchievementsProgress` batch cap");
    note("Skipped: no steamid resolved, and the call requires one.");
  } else {
    await probeBatchCap(progressModule, steamId, appIds);
  }

  console.log("");
  console.log("---");
  console.log("");
  console.log(
    "Open questions this run should have closed: batch cap → " +
      "`DEFAULT_BATCH_SIZE`; global rarity present → drop Tier 3; steamid path " +
      "→ `lib/steam-id.ts` path 1; event granularity → live timeline or not.",
  );
}

try {
  await main();
} finally {
  currentClient()?.close();
}

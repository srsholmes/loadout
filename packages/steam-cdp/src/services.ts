/**
 * Calling Valve's own authenticated service RPCs from inside Steam's page.
 *
 * ## What this unlocks
 *
 * Steam's client UI can call Valve's protobuf services **as the logged-in
 * user**, over the CM connection Steam already holds. No API key, no HTTP
 * endpoint, no third party, no scraping — `window.App.cm.GetServiceTransport()`
 * hands out a transport that is already authenticated, and the shipped bundle
 * contains ~949 service methods across ~110 namespaces. That is how a feature
 * can answer questions about a user's *whole library* (including games that
 * aren't installed) rather than just what's on disk.
 *
 * The one that motivated this module is `Player.GetAchievementsProgress`,
 * which takes an **array** of appids and returns `{appid, unlocked, total,
 * percentage}` for each. Batched, that turns "scan a 2000-game library" from
 * 2000 requests into ~40.
 *
 * ## Why module ids are resolved by grepping the bundle
 *
 * The obvious call is `__STEAM_WP_REQUIRE(64295)["xtC"]` — and it works,
 * until the next Steam update, because **webpack module ids change on every
 * build**. Method *names* don't: `Player.GetAchievementsProgress#1` is
 * versioned by Valve and stable across builds.
 *
 * So the id is discovered rather than hardcoded: text-search
 * `~/.local/share/Steam/steamui/chunk~*.js` for the literal method name and
 * walk backwards to the enclosing module header. The result is cached under a
 * key derived from the chunk filenames, which webpack content-hashes — so the
 * cache invalidates itself exactly once per Steam UI update, and never
 * needlessly.
 *
 * Note we deliberately do **not** grep for the export key (`"xtC"` above):
 * that *is* minified per build, and searching for it would be the fragile
 * thing we just avoided. Instead the in-page expression duck-types the right
 * export out of the already-resolved module. One module, a handful of
 * exports — cheap, and self-healing across renames.
 *
 * ## Why every call is raced against a timeout, twice
 *
 * `CDPClient` serialises evaluates per target (see the `evaluateChains`
 * comment in `./cdp-client.ts`), because Steam's CEF IPC crashes
 * `steamwebhelper` if two clients drive one target concurrently. That makes a
 * hung in-page promise a *shared* problem: it doesn't just fail this call, it
 * head-of-line blocks every other plugin's access to Steam for as long as it
 * hangs. Several `SteamClient` methods are known to hang forever rather than
 * reject.
 *
 * So: the generated expression races the service call against an in-page
 * `setTimeout`, guaranteeing the awaited promise always settles and the
 * evaluate returns normally. A second race on the JS side is the backstop for
 * the page itself being wedged, where no in-page timer can fire.
 */

import { basename } from "node:path";

import { createExternalCache } from "@loadout/external-cache";
import { listSteamUiChunks } from "@loadout/steam-paths";

import { withSteamClient } from "./steam-client";

/** Identifies one service method, e.g. `Player.GetAchievementsProgress#1`. */
export interface SteamServiceSpec {
  /** Service namespace, e.g. `"Player"`. */
  namespace: string;
  /** Method name, e.g. `"GetAchievementsProgress"`. */
  method: string;
  /** Valve's method version suffix. Effectively always 1. */
  version?: number;
}

/**
 * Why a service call failed. The codes exist so callers can react
 * differently — in particular, `eresult` must never be cached and
 * `unresolved` means a Steam update probably renamed something.
 */
export type SteamServiceErrorCode =
  /** No chunk contained the method literal. Steam updated, or bad spec. */
  | "unresolved"
  /** Couldn't get webpack's require from the page. */
  | "no-wp"
  /** `App.cm.GetServiceTransport()` unavailable — Steam not signed in yet. */
  | "no-transport"
  /** The resolved module didn't export anything with this method. */
  | "no-namespace"
  /** The call didn't settle in time. */
  | "timeout"
  /** Steam answered with a non-OK EResult. */
  | "eresult"
  /** The response didn't look like a protobuf response object. */
  | "malformed";

export class SteamServiceError extends Error {
  readonly code: SteamServiceErrorCode;
  /** Valve's numeric EResult, when `code === "eresult"`. */
  readonly eresult?: number;

  constructor(
    code: SteamServiceErrorCode,
    message: string,
    opts: { eresult?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "SteamServiceError";
    this.code = code;
    if (opts.eresult !== undefined) this.eresult = opts.eresult;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

/** `EResult.OK`. Everything else is a failure worth surfacing. */
const ERESULT_OK = 1;

const DEFAULT_TIMEOUT_MS = 8_000;
/** Slack between the in-page deadline and the JS-side backstop. */
const JS_RACE_SLACK_MS = 1_500;
/** The key already guarantees correctness; the TTL is just a janitor. */
const MODULE_CACHE_TTL_SEC = 30 * 24 * 60 * 60;

/** Full method literal as it appears in the bundle. */
function methodLiteral(spec: SteamServiceSpec): string {
  return `${spec.namespace}.${spec.method}#${spec.version ?? 1}`;
}

/**
 * Find the webpack module id that encloses `index` in `source`.
 *
 * Walks **backwards** to the *nearest preceding* module header, which is the
 * whole point — the first header in the file would be some unrelated module
 * hundreds of kilobytes earlier. Handles both shapes webpack emits:
 *
 *   modern:  `64295:(e,t,r)=>{`
 *   legacy:  `64295:function(e,t,r){`
 *
 * Returns `null` when no header precedes the match, which in practice means
 * the literal appeared outside any module (e.g. in a source-map comment).
 */
export function findModuleIdInSource(source: string, index: number): number | null {
  const head = source.slice(0, index);

  // Scan for all headers and keep the last. A single global regex pass is
  // simpler and faster than repeated backwards `lastIndexOf` probing, and
  // avoids the classic bug of matching a digit run that isn't a header.
  const header = /(\d+)\s*:\s*(?:\(\s*\w+\s*,\s*\w+\s*,\s*\w+\s*\)\s*=>|function\s*\(\s*\w+\s*,\s*\w+\s*,\s*\w+\s*\))\s*\{/g;

  let lastId: number | null = null;
  let match: RegExpExecArray | null;
  while ((match = header.exec(head)) !== null) {
    lastId = Number(match[1]);
  }
  return lastId;
}

/**
 * A cache key that changes exactly when Steam's UI bundle changes.
 *
 * Webpack content-hashes chunk filenames, so the *set* of basenames is a
 * fingerprint of the build. Sorted first so readdir order can't affect it.
 *
 * Preferred over `SteamClient.System.GetSystemInfo().nSteamVersion` for two
 * reasons: that call is on the known-to-hang list, and this works with Steam
 * closed.
 */
export function chunkCacheKey(chunkPaths: readonly string[]): string {
  const names = chunkPaths.map((p) => basename(p)).sort().join(",");
  // Bun ships a global `Bun.hash`, but this module is also imported by tests
  // under plain node resolution, so use a tiny stable hash rather than a
  // runtime-specific API. FNV-1a is plenty — this is a cache key, not a
  // security boundary.
  let h = 0x811c9dc5;
  for (let i = 0; i < names.length; i++) {
    h ^= names.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Recursively convert protobuf.js `Long` objects to decimal strings.
 *
 * Runs **inside the page** (this is source text, not a live function) for two
 * reasons: a `{low, high, unsigned}` wrapper survives the structured clone as
 * a meaningless object, and a 64-bit id coerced to a JS number is silently
 * corrupted past 2^53. Steam ids are 17 digits, so that matters.
 */
const NORMALISE_LONGS_SRC = `function normaliseLongs(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(normaliseLongs);
  if (typeof value.low === "number" && typeof value.high === "number") {
    // Two's-complement 64-bit reassembly. Read both halves as unsigned, then
    // subtract 2^64 when the signed interpretation of the high word is
    // negative. Returned as a decimal string: a 17-digit Steam id loses
    // precision the moment it touches a JS number.
    let big = (BigInt(value.high >>> 0) << 32n) | BigInt(value.low >>> 0);
    if (value.unsigned !== true && (value.high | 0) < 0) big -= 1n << 64n;
    return big.toString();
  }
  const out = {};
  for (const key of Object.keys(value)) out[key] = normaliseLongs(value[key]);
  return out;
}`;

/**
 * Build the in-page expression for one service call.
 *
 * Returns a tagged union, matching the house style in `./steam-client.ts`, so
 * every failure mode is distinguishable from a legitimate `null` in the
 * response body.
 */
export function buildCallExpression(
  moduleId: number,
  method: string,
  request: object,
  timeoutMs: number,
): string {
  return `(async () => {
    ${NORMALISE_LONGS_SRC}

    // Self-bootstrap webpack's require rather than depending on the
    // injector having run: apps/loadout/src/injector/steam-react.ts sets
    // __STEAM_WP_REQUIRE, but it early-outs if __STEAM_REACT is already
    // set, so the global is not guaranteed to exist even in an injected page.
    let wp = globalThis.__STEAM_WP_REQUIRE;
    if (typeof wp !== "function") {
      try {
        if (Array.isArray(window.webpackChunksteamui)) {
          window.webpackChunksteamui.push([[Symbol()], {}, (r) => { wp = r; }]);
          if (typeof wp === "function") globalThis.__STEAM_WP_REQUIRE = wp;
        }
      } catch (e) { /* fall through to the no-wp tag */ }
    }
    if (typeof wp !== "function") return { tag: "no-wp" };

    let mod;
    try { mod = wp(${JSON.stringify(moduleId)}); }
    catch (e) { return { tag: "no-namespace", detail: String(e) }; }
    if (!mod || typeof mod !== "object") return { tag: "no-namespace" };

    // Duck-type the namespace out of the module. The export key is minified
    // per build, so grepping for it would reintroduce the fragility that
    // resolving the module id by method name exists to avoid.
    const method = ${JSON.stringify(method)};
    let ns = typeof mod[method] === "function" ? mod : null;
    if (!ns) {
      for (const value of Object.values(mod)) {
        if (value && typeof value[method] === "function") { ns = value; break; }
      }
    }
    if (!ns) return { tag: "no-namespace" };

    const transport = window.App?.cm?.GetServiceTransport?.();
    if (!transport) return { tag: "no-transport" };

    let response;
    try {
      // Race in-page so the awaited promise ALWAYS settles. Without this a
      // never-resolving CM call holds the per-target evaluate chain for the
      // full CDP timeout and blocks every other consumer of Steam.
      response = await Promise.race([
        ns[method](transport, ${JSON.stringify(request)}),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("in-page timeout")), ${JSON.stringify(timeoutMs)})
        ),
      ]);
    } catch (e) {
      const message = String(e && e.message ? e.message : e);
      if (message.indexOf("in-page timeout") !== -1) return { tag: "timeout" };
      return { tag: "malformed", detail: message };
    }

    if (!response) return { tag: "malformed", detail: "empty response" };

    const eresult =
      typeof response.GetEResult === "function"
        ? response.GetEResult()
        : typeof response.eresult === "number"
          ? response.eresult
          : undefined;

    let data = null;
    try {
      const body = typeof response.Body === "function" ? response.Body() : null;
      if (body && body.constructor && typeof body.constructor.toObject === "function") {
        data = body.constructor.toObject(false, body);
      } else if (body) {
        data = body;
      }
      // Round-trip through JSON so a protobuf wrapper can never reach the
      // structured clone, after flattening any Long to a decimal string.
      data = JSON.parse(JSON.stringify(normaliseLongs(data)));
    } catch (e) {
      return { tag: "malformed", detail: String(e), eresult };
    }

    return { tag: "ok", eresult, data };
  })()`;
}

/** Shape the in-page expression returns. */
interface CallResult {
  tag: "ok" | "no-wp" | "no-transport" | "no-namespace" | "timeout" | "malformed";
  eresult?: number;
  data?: unknown;
  detail?: string;
}

/** Process-lifetime memo, so a 40-batch sweep pays no repeat disk reads. */
const moduleIdMemo = new Map<string, number>();

export interface ResolveOptions {
  /** Override the chunk list. Test seam. */
  listChunks?: () => Promise<string[]>;
  /** Override chunk reading. Test seam. */
  readChunk?: (path: string) => Promise<string>;
}

async function defaultReadChunk(path: string): Promise<string> {
  return await Bun.file(path).text();
}

/**
 * Resolve the current webpack module id exporting a service namespace.
 *
 * Cached in-memory for the process and on disk under a key derived from the
 * chunk filenames, so this greps the bundle at most once per Steam update.
 */
export async function resolveServiceModuleId(
  spec: SteamServiceSpec,
  opts: ResolveOptions = {},
): Promise<number> {
  const listChunks = opts.listChunks ?? listSteamUiChunks;
  const readChunk = opts.readChunk ?? defaultReadChunk;
  const literal = methodLiteral(spec);

  const chunks = await listChunks();
  if (chunks.length === 0) {
    throw new SteamServiceError(
      "unresolved",
      `No Steam UI chunks found — looked for ${literal} in Steam's steamui directory. Is Steam installed?`,
    );
  }

  const cacheKey = `modules:${chunkCacheKey(chunks)}`;
  const memoKey = `${cacheKey}:${literal}`;

  const memoised = moduleIdMemo.get(memoKey);
  if (memoised !== undefined) return memoised;

  const cache = createExternalCache("steam-cdp");
  let table: Record<string, number> | undefined;
  try {
    table = await cache.get<Record<string, number>>(cacheKey);
  } catch {
    table = undefined;
  }
  const cached = table?.[literal];
  if (typeof cached === "number") {
    moduleIdMemo.set(memoKey, cached);
    return cached;
  }

  // Both quote flavours, because the bundle's minifier picks either.
  const needles = [`"${literal}"`, `'${literal}'`];

  for (const path of chunks) {
    let source: string;
    try {
      source = await readChunk(path);
    } catch {
      continue; // Chunk vanished mid-read (Steam updating). Try the next.
    }

    for (const needle of needles) {
      const index = source.indexOf(needle);
      if (index === -1) continue;
      const moduleId = findModuleIdInSource(source, index);
      if (moduleId === null) continue;

      moduleIdMemo.set(memoKey, moduleId);
      try {
        await cache.set(
          cacheKey,
          { ...(table ?? {}), [literal]: moduleId },
          { ttlSec: MODULE_CACHE_TTL_SEC },
        );
      } catch {
        // A cache write failure costs a re-grep next launch, nothing more.
      }
      return moduleId;
    }
  }

  throw new SteamServiceError(
    "unresolved",
    `Could not find ${literal} in any of ${chunks.length} Steam UI chunks — Valve may have renamed or removed it.`,
  );
}

export interface CallServiceOptions extends ResolveOptions {
  /** In-page deadline, ms. Default 8000. */
  timeoutMs?: number;
  /**
   * Evaluate an expression in Steam's page. Defaults to a one-shot
   * `withSteamClient` session, which inherits the global session
   * serialisation. Injected by tests, and by callers that already hold a
   * session and want their batches to share it.
   */
  evaluate?: (expression: string) => Promise<unknown>;
}

async function defaultEvaluate(expression: string): Promise<unknown> {
  return await withSteamClient((sc) => sc._evaluateAsync(expression));
}

/**
 * Call a Steam protobuf service and return its response body as a plain
 * object.
 *
 * Throws {@link SteamServiceError} for every failure mode. Callers must not
 * cache on a throw — in particular a `timeout` or `eresult` says nothing
 * about the data, and caching it would turn a transient hiccup into a
 * long-lived wrong answer.
 */
export async function callSteamService<T = unknown>(
  spec: SteamServiceSpec,
  request: object,
  opts: CallServiceOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const evaluate = opts.evaluate ?? defaultEvaluate;

  const moduleId = await resolveServiceModuleId(spec, opts);
  const expression = buildCallExpression(moduleId, spec.method, request, timeoutMs);

  // Backstop race: the in-page timer cannot fire if the page itself is
  // wedged, and a stuck evaluate blocks every other consumer of this target.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: unknown;
  try {
    result = await Promise.race([
      evaluate(expression),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new SteamServiceError(
                "timeout",
                `${methodLiteral(spec)} did not settle within ${timeoutMs + JS_RACE_SLACK_MS}ms`,
              ),
            ),
          timeoutMs + JS_RACE_SLACK_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  const payload = result as CallResult | null | undefined;
  const literal = methodLiteral(spec);

  switch (payload?.tag) {
    case "ok":
      break;
    case "no-wp":
      throw new SteamServiceError(
        "no-wp",
        `Could not obtain webpack require from Steam's page while calling ${literal}.`,
      );
    case "no-transport":
      throw new SteamServiceError(
        "no-transport",
        `App.cm.GetServiceTransport() is unavailable while calling ${literal} — is Steam signed in?`,
      );
    case "no-namespace":
      throw new SteamServiceError(
        "no-namespace",
        `Module ${moduleId} does not export ${spec.namespace}.${spec.method}${
          payload.detail ? ` (${payload.detail})` : ""
        }.`,
      );
    case "timeout":
      throw new SteamServiceError(
        "timeout",
        `${literal} did not respond within ${timeoutMs}ms.`,
      );
    case "malformed":
      throw new SteamServiceError(
        "malformed",
        `${literal} returned an unusable response${
          payload.detail ? `: ${payload.detail}` : ""
        }.`,
      );
    default:
      throw new SteamServiceError(
        "malformed",
        `${literal} returned an unexpected value: ${JSON.stringify(result)}`,
      );
  }

  // An EResult we can read and which isn't OK is a real failure. An absent
  // EResult is not: not every response object exposes one, and treating
  // "couldn't read it" as failure would reject perfectly good data.
  if (typeof payload.eresult === "number" && payload.eresult !== ERESULT_OK) {
    throw new SteamServiceError(
      "eresult",
      `${literal} failed with EResult ${payload.eresult}.`,
      { eresult: payload.eresult },
    );
  }

  return payload.data as T;
}

/**
 * Forget every resolved module id, in memory and on disk.
 *
 * Only needed if a resolution is somehow wrong while the chunk filenames are
 * unchanged — the content-hashed cache key means an ordinary Steam update
 * invalidates itself.
 */
export async function clearServiceModuleCache(): Promise<void> {
  moduleIdMemo.clear();
  try {
    await createExternalCache("steam-cdp").clear();
  } catch {
    // Nothing to clear, or the dir is already gone.
  }
}

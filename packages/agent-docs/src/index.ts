/**
 * @loadout/agent-docs — merge and render the agent-facing API docs.
 *
 * **Server-only.** Consumed by the loader's `/api/agent` routes and by
 * `scripts/generate-agent-docs.ts`. Plugins have no reason to import it
 * — they are the thing being documented — and the eslint `serverOnly`
 * rule enforces that.
 *
 * Two halves, both pure:
 *
 * - `merge` — combines the generated baseline (`plugins/<id>/agent.json`)
 *   with hand-written curation (`package.json → plugin.agent`) and fills
 *   in a safety class for anything uncurated.
 * - `render` — turns the result into Markdown for a model to read. The
 *   same data is served as JSON on `Accept: application/json`.
 *
 * Neither half touches the filesystem, the network or the clock, so the
 * routes stay a thin adapter and output is byte-stable.
 */

export {
  AGENT_DOC_VERSION,
  inferSafety,
  baselineFromMethodNames,
  mergePluginDoc,
  countBySafety,
  toIndexEntry,
  requiresWriteOptIn,
} from "./merge";
export type { ResolvedPluginDoc, MergeArgs } from "./merge";

export {
  formatSchema,
  renderCallingConvention,
  renderIndexMarkdown,
  renderPluginMarkdown,
} from "./render";
export type { RenderContext } from "./render";

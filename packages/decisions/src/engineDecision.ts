/**
 * The engine's three decisions, resolved (EB-9a). Pure: no I/O, no clock.
 *
 * `engine_spawn` and `engine_merge` follow the repo's dial for that decision. `engine_spec_ready` also looks at the Discussion's tag,
 * which the engine reads from the Discussion title:
 *  - a Feature or Critical Spec is the start of a parent item, so it is resolved through `start_parent_item` (class 3, which asks at
 *    every preset), the same routing `resolveStart` in packages/core gives a feature or critical start;
 *  - a Small, Bug, Doc or Process Spec follows the `engine_spec_ready` dial;
 *  - any other tag, or none, asks. An unknown or missing tag never loosens anything.
 */
import { getCatalogueEntry } from "./catalogue.js";
import type { Disposition } from "./types.js";

export const ENGINE_DECISION_TYPES = ["engine_spawn", "engine_merge", "engine_spec_ready"] as const;
export type EngineDecisionType = (typeof ENGINE_DECISION_TYPES)[number];

export const ENGINE_SPEC_TAGS = ["feature", "critical", "small", "bug", "doc", "process", "other"] as const;
export type EngineSpecTag = (typeof ENGINE_SPEC_TAGS)[number];

const DIAL_TAGS: readonly string[] = ["small", "bug", "doc", "process"];
const PARENT_TAGS: readonly string[] = ["feature", "critical"];

export const isEngineDecisionType = (value: unknown): value is EngineDecisionType => typeof value === "string" && (ENGINE_DECISION_TYPES as readonly string[]).includes(value);

export interface EngineResolution {
  readonly disposition: Disposition;
  /** The catalogue entry that decided instead of the decision's own, or null. */
  readonly resolvedVia: "start_parent_item" | null;
}

/**
 * `stored` is the repo's current dial for `decisionType` (null: no row, so the catalogue's default). A stored value the entry does not
 * allow fails closed to `ask`.
 */
export function resolveEngineDecision(input: { decisionType: EngineDecisionType; tag?: string | undefined; stored: Disposition | null }): EngineResolution {
  const entry = getCatalogueEntry(input.decisionType);
  if (entry === undefined) return { disposition: "ask", resolvedVia: null };
  const own: Disposition = input.stored === null ? entry.defaultDisposition : entry.allowedDispositions.includes(input.stored) ? input.stored : "ask";
  if (input.decisionType !== "engine_spec_ready") return { disposition: own, resolvedVia: null };
  const tag = input.tag;
  if (tag !== undefined && PARENT_TAGS.includes(tag)) {
    const parent = getCatalogueEntry("start_parent_item");
    if (parent === undefined) return { disposition: "ask", resolvedVia: null };
    return { disposition: parent.allowedDispositions.includes(own) ? own : parent.defaultDisposition, resolvedVia: "start_parent_item" };
  }
  if (tag !== undefined && DIAL_TAGS.includes(tag)) return { disposition: own, resolvedVia: null };
  return { disposition: "ask", resolvedVia: null };
}

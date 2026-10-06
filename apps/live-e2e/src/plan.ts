/**
 * Turns a selection into a plan: for each selected pack, the first guard that objects decides its outcome.
 * Order: layer 1 (target guard), trigger rule, needs. Pure; `cli.ts` writes the result as plan.json.
 */
import type { Pack, Tier } from "./manifest.js";
import { firstUnmetNeed, type NeedsContext } from "./needs.js";
import { select, triggerRule, type SelectInput, type Trigger } from "./select.js";
import type { RouteRecord, RoutingResult } from "./routing.js";
import { targetGuard, type Target } from "./targets.js";

export type PackOutcome =
  | { id: string; outcome: "RUN"; named: boolean }
  | { id: string; outcome: "SKIPPED-NEED"; need: string; named: boolean }
  | { id: string; outcome: "REFUSED"; reason: string; named: boolean };

export interface Plan {
  version: 1;
  target: string;
  tier: Tier | null;
  trigger: Trigger | null;
  tag: string | null;
  named: string[];
  /** Every selected pack with its outcome, in pack-id order. */
  packs: PackOutcome[];
  /** Packs that will run, with what the runner needs to schedule them. */
  selected: { id: string; tier: Tier; projects: string[]; est_usd: number; est_sandbox_min: number }[];
  skipped: { id: string; need: string }[];
  refused: { id: string; reason: string; named: boolean }[];
  /** The validated `--changed-from` range, or null when routing was not asked for. */
  changed_from: string | null;
  /** Per-file routing records (every (file, pack, glob) match); empty without `--changed-from` or on a fallback. */
  routing: RouteRecord[];
  /** Why routing fell back to every pack at or below standard; null when it judged every file. */
  routing_fallback: string | null;
  estimated_cost_usd: number;
}

export interface PlanInput extends Omit<SelectInput, "routed"> {
  target: Target;
  /** The outcome of changed-files routing, when `--changed-from` was given. */
  routing?: RoutingResult;
  trigger?: Trigger;
  needs: NeedsContext;
}

function decide(pack: Pack, named: boolean, input: PlanInput): PackOutcome {
  const layer1 = targetGuard(pack, input.target);
  if (layer1 !== null) return { id: pack.id, outcome: "REFUSED", reason: layer1, named };
  const trig = triggerRule(pack, input.trigger);
  if (trig !== null) return { id: pack.id, outcome: "REFUSED", reason: trig, named };
  const need = firstUnmetNeed(pack, input.target, input.needs);
  if (need !== null) return { id: pack.id, outcome: "SKIPPED-NEED", need, named };
  return { id: pack.id, outcome: "RUN", named };
}

export function buildPlan(input: PlanInput): Plan {
  const selection = select({ ...input, ...(input.routing !== undefined ? { routed: input.routing.packs } : {}) });
  const outcomes = selection.packs.map((p) => decide(p, selection.named.has(p.id), input));
  const byId = new Map(selection.packs.map((p) => [p.id, p]));
  const selected: Plan["selected"] = [];
  const skipped: Plan["skipped"] = [];
  const refused: Plan["refused"] = [];
  for (const o of outcomes) {
    const pack = byId.get(o.id) as Pack;
    if (o.outcome === "RUN") {
      selected.push({
        id: o.id,
        tier: pack.tier,
        projects: [...pack.projects],
        est_usd: pack.cost.est_usd,
        est_sandbox_min: pack.cost.est_sandbox_min,
      });
    } else if (o.outcome === "SKIPPED-NEED") {
      skipped.push({ id: o.id, need: o.need });
    } else {
      refused.push({ id: o.id, reason: o.reason, named: o.named });
    }
  }
  return {
    version: 1,
    target: input.target.name,
    tier: input.tier ?? null,
    trigger: input.trigger ?? null,
    tag: input.tag ?? null,
    named: [...(input.named ?? [])],
    packs: outcomes,
    selected,
    skipped,
    refused,
    changed_from: input.routing?.changed_from ?? null,
    routing: input.routing?.files ?? [],
    routing_fallback: input.routing?.fallback ?? null,
    estimated_cost_usd: selected.reduce((sum, s) => sum + s.est_usd, 0),
  };
}

/** One line per pack, the form the CLI prints. */
export function describeOutcome(o: PackOutcome): string {
  if (o.outcome === "RUN") return `${o.id}: RUN`;
  if (o.outcome === "SKIPPED-NEED") return `${o.id}: SKIPPED-NEED ${o.need}`;
  return `${o.id}: REFUSED ${o.reason}`;
}

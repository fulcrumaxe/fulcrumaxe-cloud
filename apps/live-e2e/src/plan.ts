/**
 * Turns a selection into a plan: for each selected pack, the first guard that objects decides its outcome.
 * Order: layer 1 (target guard), trigger rule, needs, layer 2 (deployment identity, T5). Pure; `cli.ts` writes the result as plan.json.
 */
import type { Pack, Tier } from "./manifest.js";
import { firstNeedProblem, type NeedsContext } from "./needs.js";
import { isNetworkNeed } from "./needs-network.js";
import { select, triggerRule, type SelectInput, type Trigger } from "./select.js";
import type { RouteRecord, RoutingResult } from "./routing.js";
import type { StagingOnlyTest } from "./staging-only.js";
import { isProdSafe, targetGuard, type Target } from "./targets.js";
import { accountBaseline, type AccountBaseline } from "./janitor/baseline.js";

export type PackOutcome =
  | { id: string; outcome: "RUN"; named: boolean }
  | { id: string; outcome: "SKIPPED-NEED"; need: string; named: boolean }
  | { id: string; outcome: "REFUSED"; reason: string; named: boolean; detail?: string };

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
  selected: { id: string; tier: Tier; projects: string[]; est_usd: number; est_sandbox_min: number; prod_safe: boolean; probes: number }[];
  skipped: { id: string; need: string }[];
  refused: { id: string; reason: string; named: boolean }[];
  /** Tests of packs that run, left out because the target is production and they are tagged `@staging-only`. */
  tests_skipped: { pack: string; test: string; reason: "staging-only" }[];
  /** The validated `--changed-from` range, or null when routing was not asked for. */
  changed_from: string | null;
  /** Per-file routing records (every (file, pack, glob) match); empty without `--changed-from` or on a fallback. */
  routing: RouteRecord[];
  /** Why routing fell back to every pack at or below standard; null when it judged every file. */
  routing_fallback: string | null;
  estimated_cost_usd: number;
  /**
   * What the janitors would do for this selection (T6a; offline, nothing is read from the account here). The account
   * janitor runs only when a selected pack is destructive; the dry-run that shows its changes is
   * `live-e2e janitor account --target <name>`.
   */
  janitors: { account: { needed: boolean; packs: string[]; pending: string[]; baseline: AccountBaseline } };
}

export interface PlanInput extends Omit<SelectInput, "routed"> {
  target: Target;
  /** The outcome of changed-files routing, when `--changed-from` was given. */
  routing?: RoutingResult;
  trigger?: Trigger;
  needs: NeedsContext;
  /** Every `@staging-only` test under the packs (src/staging-only.ts); only consulted for the production target. */
  stagingOnly?: StagingOnlyTest[];
  /**
   * The layer-2 refusal reason (`identityGuard`), when the origin was asked who it is; null when it answered as
   * staging; absent when nothing was asked (`plan` is offline). Applied to every pack that is not prod-safe.
   */
  layer2?: string | null;
}

function decide(pack: Pack, named: boolean, input: PlanInput): PackOutcome {
  const layer1 = targetGuard(pack, input.target);
  if (layer1 !== null) return { id: pack.id, outcome: "REFUSED", reason: layer1, named };
  const trig = triggerRule(pack, input.trigger);
  if (trig !== null) return { id: pack.id, outcome: "REFUSED", reason: trig, named };
  const problem = firstNeedProblem(pack, input.target, input.needs);
  if (problem?.refuse !== undefined) return { id: pack.id, outcome: "REFUSED", reason: problem.refuse, named, ...(problem.detail !== undefined ? { detail: problem.detail } : {}) };
  if (problem !== null) return { id: pack.id, outcome: "SKIPPED-NEED", need: problem.need, named };
  if (input.layer2 != null && !isProdSafe(pack)) return { id: pack.id, outcome: "REFUSED", reason: input.layer2, named };
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
        prod_safe: isProdSafe(pack),
        probes: pack.probes.length,
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
    tests_skipped:
      input.target.name === "production"
        ? (input.stagingOnly ?? []).filter((t) => selected.some((s) => s.id === t.pack)).map((t) => ({ ...t, reason: "staging-only" as const }))
        : [],
    changed_from: input.routing?.changed_from ?? null,
    routing: input.routing?.files ?? [],
    routing_fallback: input.routing?.fallback ?? null,
    estimated_cost_usd: selected.reduce((sum, s) => sum + s.est_usd, 0),
    janitors: { account: janitorForPlan(outcomes, byId) },
  };
}

/**
 * The account janitor runs only when a destructive pack is going to run (`needed`, `packs`). A destructive pack that
 * `plan` skipped for a need only `run` can check (the owner session) is `pending`: the janitor would run for it once
 * the need is met.
 */
function janitorForPlan(outcomes: PackOutcome[], byId: Map<string, Pack>): Plan["janitors"]["account"] {
  const destructive = (o: PackOutcome): boolean => byId.get(o.id)?.destructive === true;
  const packs = outcomes.filter((o) => o.outcome === "RUN" && destructive(o)).map((o) => o.id);
  const pending = outcomes.filter((o) => o.outcome === "SKIPPED-NEED" && destructive(o)).map((o) => o.id);
  return { needed: packs.length > 0, packs, pending, baseline: accountBaseline() };
}

/** The line(s) `plan` prints for the janitors. */
export function describeJanitors(plan: Plan): string[] {
  const a = plan.janitors.account;
  const b = a.baseline;
  const baseline = `janitor account: baseline ${Object.entries(b.limits).map(([k, v]) => `${k} ${v}`).join(", ")}; model_usd_month ${b.model_usd_month}; role model ${b.role_model} (${b.floored_roles.join(", ")} ${b.floor_model}); lowers only`;
  const dry = `dry-run: live-e2e janitor account --target ${plan.target}`;
  if (a.needed) return [`janitor account: runs before ${a.packs.join(", ")} (${dry})`, baseline];
  if (a.pending.length > 0) return [`janitor account: would run before ${a.pending.join(", ")} once their needs are met (${dry})`, baseline];
  return ["janitor account: not needed (no destructive pack selected)"];
}

/** One line per pack, the form the CLI prints. */
export function describeOutcome(o: PackOutcome): string {
  if (o.outcome === "RUN") return `${o.id}: RUN`;
  if (o.outcome === "SKIPPED-NEED") return `${o.id}: SKIPPED-NEED ${o.need}`;
  return `${o.id}: REFUSED ${o.reason}${o.detail === undefined ? "" : ` (${o.detail})`}`;
}

/** The network needs of the packs a `run` is about to start: selected, and not already refused by layer 1 or the trigger rule. */
export function wantedNetworkNeeds(input: PlanInput): string[] {
  const selection = select({ ...input, ...(input.routing !== undefined ? { routed: input.routing.packs } : {}) });
  const live = selection.packs.filter((p) => targetGuard(p, input.target) === null && triggerRule(p, input.trigger) === null);
  return [...new Set(live.flatMap((p) => p.needs).filter(isNetworkNeed))];
}

import type { ExecutionRun } from "./executionTarget.js";

/**
 * D#2 RLR-5: what a later invocation needs to read a run's log in slices, beyond the run's row: the figures the reader's decisions are made against (the model,
 * the caps and the monthly budget, the limits, the extension allowance, who pays). Plain data, so the follower workflow can carry it. It holds NO prompt, role
 * card, clone target or token: a slice reads the file and never launches anything, and a workflow's arguments are kept by the workflow service.
 */
export type SliceRunFacts = Pick<ExecutionRun, "role" | "product" | "repoId" | "pr" | "workItemId" | "model" | "backend" | "workdir" | "capUsd" | "timeoutMs" | "limits" | "maxExtensions" | "funding"> & {
  /** The run's spend inputs without the test clock. */
  spend: Omit<ExecutionRun["spend"], "now">;
};

/** The facts, with absent fields left out (a value of `undefined` does not survive the workflow's JSON). */
export function sliceFactsOf(run: ExecutionRun): SliceRunFacts {
  const { now: _now, ...spend } = run.spend;
  const picked = {
    role: run.role, product: run.product, repoId: run.repoId, pr: run.pr, workItemId: run.workItemId, model: run.model, backend: run.backend, workdir: run.workdir,
    capUsd: run.capUsd, timeoutMs: run.timeoutMs, limits: run.limits, maxExtensions: run.maxExtensions, funding: run.funding, spend,
  };
  return Object.fromEntries(Object.entries(picked).filter(([, v]) => v !== undefined)) as unknown as SliceRunFacts;
}

/** The run a slice acts on, from its ids and the facts the follower carried. */
export function runOfSliceFacts(accountId: string, runId: string, f: SliceRunFacts): ExecutionRun {
  return { ...f, id: runId, accountId, roleCard: "", prompt: "" };
}

const KEYS = ["role", "product", "repoId", "pr", "workItemId", "model", "backend", "workdir", "capUsd", "timeoutMs", "limits", "maxExtensions", "funding", "spend"];
const SPEND_KEYS = ["workItemId", "plan", "estimateComputeUsd", "trigger", "estimateModelUsd", "monthlyModelBudgetUsd", "perSpawnCapUsd", "workItemKind", "purpose", "repoCount", "featureCapUsd", "smallCapUsd", "modelBrokeredBy", "envelopeFloorUsd"];
const SHORT = /^[A-Za-z0-9._:\/-]{1,200}$/;
const amount = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100_000;

/**
 * Strict parse of slice facts that came from outside this module (the reader row, or the follower's arguments): unknown keys are refused, every number is bounded,
 * every string is short and plain. Returns undefined for anything else, and the caller fails closed. It checks the shape; whether the facts are the dispatching
 * invocation's own is `sameSliceFacts` against the copy stored on the reader row at hand-over.
 */
export function parseSliceFacts(raw: unknown): SliceRunFacts | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).some((k) => !KEYS.includes(k))) return undefined;
  for (const k of ["role", "product", "model"]) if (typeof o[k] !== "string" || !SHORT.test(o[k] as string)) return undefined;
  for (const k of ["repoId", "workItemId", "backend", "workdir"]) if (o[k] !== undefined && o[k] !== null && (typeof o[k] !== "string" || !SHORT.test(o[k] as string))) return undefined;
  if (o.pr !== undefined && !(Number.isSafeInteger(o.pr) && (o.pr as number) >= 0)) return undefined;
  if (!amount(o.capUsd)) return undefined;
  if (o.timeoutMs !== undefined && !(Number.isSafeInteger(o.timeoutMs) && (o.timeoutMs as number) > 0 && (o.timeoutMs as number) <= 86_400_000)) return undefined;
  if (o.maxExtensions !== undefined && !(Number.isSafeInteger(o.maxExtensions) && (o.maxExtensions as number) >= 0 && (o.maxExtensions as number) <= 100)) return undefined;
  const lim = o.limits;
  if (lim !== undefined) {
    if (typeof lim !== "object" || lim === null || Array.isArray(lim)) return undefined;
    for (const [k, v] of Object.entries(lim)) if (!["maxTurns", "maxModelCalls", "maxRunMs", "meteringSilenceMs"].includes(k) || !(Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= 86_400_000)) return undefined;
  }
  const f = o.funding as Record<string, unknown> | null | undefined;
  if (f !== undefined) {
    if (typeof f !== "object" || f === null) return undefined;
    if (f.kind === "self") {
      if (Object.keys(f).length !== 1) return undefined;
    } else if (f.kind === "claim") {
      if (Object.keys(f).length !== 3 || typeof f.payerAccountId !== "string" || !SHORT.test(f.payerAccountId) || typeof f.fundingId !== "string" || !SHORT.test(f.fundingId)) return undefined;
    } else return undefined;
  }
  const sp = o.spend as Record<string, unknown> | null;
  if (typeof sp !== "object" || sp === null || Array.isArray(sp)) return undefined;
  for (const [k, v] of Object.entries(sp)) {
    if (!SPEND_KEYS.includes(k)) return undefined;
    if (v === null) continue;
    if (typeof v === "number" ? !amount(v) : typeof v !== "string" || !SHORT.test(v)) return undefined;
  }
  if (typeof sp.plan !== "string") return undefined;
  return o as unknown as SliceRunFacts;
}

const canon = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

/** Whether two sets of facts are the same, key for key. */
export function sameSliceFacts(a: SliceRunFacts, b: SliceRunFacts): boolean {
  return canon(a) === canon(b);
}

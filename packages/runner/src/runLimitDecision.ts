import type { RunLimit } from "./executionTarget.js";

/**
 * D#2 H14c-5c-2a (C48 X-1..X-5, C58 "the extension rules"): whether a run that
 * reached `run_time` or `model_calls` may go on for one more slice.
 *
 * X-2: every fact below is held by the runner (its clock, its meter, its
 * distinct-message-id count, the gh-proxy write counter it is injected with).
 * NOTHING here comes from a file in the VM, stderr or the agent's envelope,
 * and this module imports no file API. A checkpoint envelope never reaches it.
 */
export interface ExtensionFacts {
  kind: RunLimit["kind"];
  nowMs: number;
  startedMs: number;
  /** When the metered total last rose (the runner's clock); undefined if it never has. */
  lastUsageRiseMs: number | undefined;
  silenceMs: number;
  extensionsUsed: number;
  maxExtensions: number;
  ghWrites: number;
  ghWritesAtLastExtension: number;
  /** True for a role that writes to GitHub (from the role manifest, not the VM). */
  roleWrites: boolean;
  messageIds: number;
  messageIdsAtLastExtension: number;
  /** The kind's resolved limit before any extension (the slice is a share of it), and the one in force. */
  resolvedLimit: number;
  currentLimit: number;
  meteredUsd: number;
  /** Platform per-run ceilings, extensions included (run_time in ms, already below the sandbox timeout). */
  ceilings: { runMs: number; modelCalls: number; usd: number };
}

export interface ExtensionProgress {
  usage_rose: true;
  gh_writes: number;
  new_message_ids: number;
}

export type ExtensionDecision =
  | { extend: true; kind: "run_time" | "model_calls"; slice: number; newLimit: number; estimateUsd: number; progress: ExtensionProgress }
  | { extend: false; reason: string };

/** X-3: the slice is half of the resolved limit. */
export const EXTENSION_SLICE_FRACTION = 0.5;
/** X-3 E3: a later extension needs a GitHub write, or this many new distinct ids (roles that never write). */
export const MIN_NEW_MESSAGE_IDS = 5;
const MAX_PROGRESS_WINDOW_MS = 5 * 60_000;

/** E1, E2, E3 and E5. E4 (the reservation) is `tryExtend`'s, because it is asynchronous and has a side effect. */
export function decideExtension(f: ExtensionFacts): ExtensionDecision {
  // E1 (C68): per_run_usd never extends in-run (it ends resumably as killed_spend); nor do turns or silence; a safety kill never gets here.
  if (f.kind !== "run_time" && f.kind !== "model_calls") return { extend: false, reason: "not_extendable" };
  if (f.extensionsUsed >= f.maxExtensions) return { extend: false, reason: "max_extensions" };
  const ghWrites = f.ghWrites - f.ghWritesAtLastExtension;
  const newIds = f.messageIds - f.messageIdsAtLastExtension;
  const window = Math.min(f.silenceMs, MAX_PROGRESS_WINDOW_MS);
  if (f.lastUsageRiseMs === undefined || f.nowMs - f.lastUsageRiseMs > window) return { extend: false, reason: "no_progress" };
  if (f.extensionsUsed >= 1 && ghWrites < 1 && (f.roleWrites || newIds < MIN_NEW_MESSAGE_IDS)) return { extend: false, reason: "no_progress" };
  const slice = Math.floor(f.resolvedLimit * EXTENSION_SLICE_FRACTION);
  const newLimit = f.currentLimit + slice;
  const elapsedMs = Math.max(f.nowMs - f.startedMs, 1);
  // The metered spend rate so far, times the slice.
  const estimateUsd = f.kind === "run_time" ? (f.meteredUsd / elapsedMs) * slice : (f.meteredUsd / Math.max(f.messageIds, 1)) * slice;
  const ceiling = f.kind === "run_time" ? f.ceilings.runMs : f.ceilings.modelCalls;
  if (newLimit > ceiling || f.meteredUsd + estimateUsd > f.ceilings.usd) return { extend: false, reason: "ceiling" };
  return { extend: true, kind: f.kind, slice, newLimit, estimateUsd, progress: { usage_rose: true, gh_writes: ghWrites, new_message_ids: newIds } };
}

/**
 * The per-run policy the composition root injects (H14c-3; CARRY-19). Its
 * `reserveExtension` is the same `reserve()` path `admit` uses, bound to the
 * run's work item and account: it does not exist on main yet, so the port
 * builds against this interface. The reservation settles with the run.
 */
export interface ExtensionPolicy {
  maxExtensions: number;
  /** From the role manifest via the composition root. Left out means a WRITING role (fail closed). */
  roleWrites?: boolean;
  /** Bound on one decision (the reservation included) before the run ends at its limit; default 30 s. */
  decisionTimeoutMs?: number;
  ceilings: ExtensionFacts["ceilings"];
  /** The run's metered model spend so far (the runner's own meter). */
  meteredUsd(): number;
  /** GitHub write requests gh-proxy recorded for this run. */
  ghWrites(): number;
  /** E4: true when `reserve()` admitted a reservation for the estimate. Nothing is left open on a denial. */
  reserveExtension(estimateUsd: number): Promise<boolean>;
  /** X-4: called once per extension, after E4 admitted it. */
  onExtended(e: { kind: "run_time" | "model_calls"; extensionsUsed: number; newLimit: number; progress: ExtensionProgress }): void | Promise<void>;
}

/** What the composition root supplies (H14c-3, CARRY-16/19); the target adds the meter and the event write. */
export type ExtensionPolicyInput = Omit<ExtensionPolicy, "meteredUsd" | "onExtended">;

/** All of E1-E5: `decideExtension`, then E4. A throwing reservation is a denial (fail closed). */
export async function tryExtend(facts: ExtensionFacts, reserveExtension: ExtensionPolicy["reserveExtension"]): Promise<ExtensionDecision> {
  const decision = decideExtension(facts);
  if (!decision.extend) return decision;
  const admitted = await Promise.resolve()
    .then(() => reserveExtension(decision.estimateUsd))
    .catch(() => false);
  return admitted === true ? decision : { extend: false, reason: "spend_denied" };
}

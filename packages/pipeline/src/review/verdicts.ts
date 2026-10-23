import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { recordDriverEvent, toCode } from "@fx/core/src/work-items/driverEvents.js";
import type { ExecutionTargetRegistry } from "@fx/runner";
import { recordReviewVerdict } from "../build/fixLoop.js";
import type { ReviewVerdict, ReviewerAgentRole } from "../build/types.js";
import { MAX_FINDINGS, MAX_FINDING_CHARS } from "./findingCaps.js";

/**
 * D#483 P3: what the reviewers said, read and recorded.
 *
 * Reading. A reviewer's verdict is the exact JSON string `pass`, `needs-fix` or `fail` in the envelope of a run that
 * SUCCEEDED. Anything else is `fail`: another word, another case, a number, a missing envelope, a run that failed or was
 * cancelled. The code reviewer's `security_review_needed` counts only as the JSON boolean `true`. Findings and summary are
 * model text: bounded here, shown only as text, and sanitized again when they go into a prompt.
 *
 * Recording. The item's stage is the LAST verdict recorded, so the order matters (live, a pass recorded after a needs-fix
 * showed "ready to merge" with a needs-fix pending). `recordVerdictsInOrder` therefore takes every verdict of the head
 * first and records the passes first and the non-passes last, so a needs-fix is never overwritten by a later pass. The
 * fix round itself is not dispatched here (`fixDispatch: "deferred"`): the driver starts it, counts it and escalates it.
 */

export type VerdictRole = ReviewerAgentRole | "debater";

export { MAX_FINDINGS, MAX_FINDING_CHARS };
export const MAX_SUMMARY_CHARS = 4000;

export interface ReadVerdict {
  verdict: ReviewVerdict;
  findings: string[];
  /** D#600 CX-4a: the same findings before the 600-character cut (at most MAX_FINDINGS). A fix prompt spills them and marks the cut. */
  fullFindings: string[];
  summary: string;
  /** The code reviewer asked for a security review. Only the JSON boolean `true` counts. */
  securityNeeded: boolean;
  /**
   * D#598 P7d: the reviewer says it could not run the tests (the test command would not start, or a tool it needs was refused).
   * That is a fact about the environment, not a judgment of the code. Only the JSON boolean `true` counts.
   */
  environmentFailure: boolean;
  /**
   * The run produced a verdict at all: it SUCCEEDED and its envelope carries a `verdict` key. A run that failed (an agent killed at its memory limit, a lost
   * runner), timed out or was cancelled, and a succeeded run with no envelope or no `verdict` in it, said nothing about the code. Its `verdict` still reads
   * `fail` (never a pass), but it must never be recorded or reused as one: the driver runs that reviewer again. A `verdict` key with a wrong word is a verdict (`fail`).
   */
  hasVerdict: boolean;
}

/** The exact words only. `Pass`, ` pass`, `PASS`, `passed`, `ok`, 1 and true are all `fail`. */
export function normalizeVerdict(raw: unknown): ReviewVerdict {
  return raw === "pass" || raw === "needs-fix" || raw === "fail" ? raw : "fail";
}

/** A run's verdict from its status and envelope. A run that did not succeed has no verdict: it is `fail`. */
export function readVerdict(status: string, envelope: Record<string, unknown> | null): ReadVerdict {
  const env = status === "succeeded" && envelope !== null && typeof envelope === "object" && !Array.isArray(envelope) ? envelope : null;
  const raw = env && Object.hasOwn(env, "verdict") ? env.verdict : undefined;
  const findingsRaw = env && Object.hasOwn(env, "findings") ? env.findings : undefined;
  const summaryRaw = env && Object.hasOwn(env, "summary") ? env.summary : undefined;
  const flag = env && Object.hasOwn(env, "security_review_needed") ? env.security_review_needed : undefined;
  const envFlag = env && Object.hasOwn(env, "environment_failure") ? env.environment_failure : undefined;
  const fullFindings = Array.isArray(findingsRaw) ? findingsRaw.filter((f): f is string => typeof f === "string").slice(0, MAX_FINDINGS) : [];
  return {
    verdict: normalizeVerdict(raw),
    findings: fullFindings.map((f) => f.slice(0, MAX_FINDING_CHARS)),
    fullFindings,
    summary: typeof summaryRaw === "string" ? summaryRaw.slice(0, MAX_SUMMARY_CHARS) : "",
    securityNeeded: flag === true,
    environmentFailure: envFlag === true,
    hasVerdict: env !== null && Object.hasOwn(env, "verdict"),
  };
}

/** Passes first, non-passes last; the order inside each group is kept. */
export function recordingOrder<T extends { verdict: ReviewVerdict }>(verdicts: readonly T[]): T[] {
  return [...verdicts.filter((v) => v.verdict === "pass"), ...verdicts.filter((v) => v.verdict !== "pass")];
}

export interface GatheredVerdict {
  role: VerdictRole;
  runId: string;
  verdict: ReviewVerdict;
  /** D#598 P7d: the reviewer could not run the tests. Absent is false. */
  environmentFailure?: boolean;
  /**
   * The reviewer's run ended without a verdict (see `ReadVerdict.hasVerdict`), and the driver's bounded re-runs of it on this head are used up. Such an entry is
   * never recorded as a verdict; the round goes to a person (`reviewer_no_verdict`). Absent is false.
   */
  noVerdict?: boolean;
  /** With `noVerdict`: how the last run ended, as a fixed code (`resource_limit`, `agent_failed`, `cancelled`, `wait_timeout`...). */
  endCode?: string;
  /** The debater only: which reviewer it debated (its needs-fix is recorded as that reviewer's). */
  debatedRole?: "code-reviewer" | "security-reviewer";
}

export interface RecordedVerdict {
  role: VerdictRole;
  runId: string;
  verdict: ReviewVerdict;
  outcome: string;
}

export interface RecordVerdictsInput {
  accountId: string;
  workItemId: string;
  headSha: string;
  prNumber: number;
  round: number;
  verdicts: readonly GatheredVerdict[];
  /**
   * Record only the non-passes. Set when the round is incomplete (a required reviewer has no verdict): a pass recorded
   * then would leave the card at "review passed" with a reviewer still missing. Every verdict still goes in the event.
   */
  skipPasses?: boolean;
}

/** Records every gathered verdict, passes first. Writes one `review_verdicts` driver event (a replay of the same head writes nothing more). */
export async function recordVerdictsInOrder(pool: Pool, registry: ExecutionTargetRegistry, input: RecordVerdictsInput): Promise<{ recorded: RecordedVerdict[] }> {
  const recorded: RecordedVerdict[] = [];
  for (const v of recordingOrder(input.verdicts)) {
    if (input.skipPasses === true && v.verdict === "pass") continue;
    // A run that said nothing is never a verdict: recording its `fail` would move the item to Changes requested with nothing to fix.
    if (v.noVerdict === true) continue;
    const out = await recordReviewVerdict(pool, registry, {
      accountId: input.accountId,
      workItemId: input.workItemId,
      role: v.role,
      runId: v.runId,
      verdict: v.verdict,
      ...(v.role === "debater" ? { debatedRole: v.debatedRole ?? "code-reviewer" } : {}),
      fixDispatch: "deferred",
    });
    recorded.push({ role: v.role, runId: v.runId, verdict: v.verdict, outcome: out.outcome });
  }
  await withTenant(pool, input.accountId, (client) =>
    recordDriverEvent(client, input.accountId, {
      workItemId: input.workItemId,
      kind: "review_verdicts",
      dedupeKey: `verdicts:${input.headSha}:${input.verdicts.map((v) => toCode(v.role)).sort().join('+')}`.slice(0, 200),
      reasons: input.verdicts.map((v) => `${toCode(v.role)}_${v.noVerdict === true ? "no_verdict" : toCode(v.verdict)}`).slice(0, 20),
      headSha: input.headSha,
      prNumber: input.prNumber,
      round: Math.min(Math.max(input.round, 0), 20),
    }),
  );
  return { recorded };
}

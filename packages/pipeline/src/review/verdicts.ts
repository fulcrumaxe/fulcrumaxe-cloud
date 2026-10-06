import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { recordDriverEvent, toCode } from "@fx/core/src/work-items/driverEvents.js";
import type { ExecutionTargetRegistry } from "@fx/runner";
import { recordReviewVerdict } from "../build/fixLoop.js";
import type { ReviewVerdict, ReviewerAgentRole } from "../build/types.js";

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

export const MAX_FINDINGS = 20;
export const MAX_FINDING_CHARS = 600;
export const MAX_SUMMARY_CHARS = 4000;

export interface ReadVerdict {
  verdict: ReviewVerdict;
  findings: string[];
  summary: string;
  /** The code reviewer asked for a security review. Only the JSON boolean `true` counts. */
  securityNeeded: boolean;
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
  return {
    verdict: normalizeVerdict(raw),
    findings: Array.isArray(findingsRaw) ? findingsRaw.filter((f): f is string => typeof f === "string").slice(0, MAX_FINDINGS).map((f) => f.slice(0, MAX_FINDING_CHARS)) : [],
    summary: typeof summaryRaw === "string" ? summaryRaw.slice(0, MAX_SUMMARY_CHARS) : "",
    securityNeeded: flag === true,
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
      reasons: input.verdicts.map((v) => `${toCode(v.role)}_${toCode(v.verdict)}`).slice(0, 20),
      headSha: input.headSha,
      prNumber: input.prNumber,
      round: Math.min(Math.max(input.round, 0), 20),
    }),
  );
  return { recorded };
}

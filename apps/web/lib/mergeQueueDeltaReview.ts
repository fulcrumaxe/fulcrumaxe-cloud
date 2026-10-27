import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { isReservationPause, mergeQueue, reviewPlanFor } from "@fx/pipeline";
import { findPrBody, reviewLoadBody, startReviewerBody, type OpenHttp, type PrFound, type ReviewCtx, type ReviewWorker } from "./advanceReviewSteps";
import type { StepWho } from "./advanceStageSteps";

/**
 * D#519 MQ3-b-2: binds `mergeQueue.createStartDeltaReview` to the real reviewer start. Everything about the item (who approved it, its halt
 * epoch, its review context, the pull request and the roles the gate requires) is read from the stored rows and from GitHub here; the
 * queue's caller passes none of it. The delta prompt itself is `assembleReviewPrompt` with `delta` (reviewPrompts.ts), reached through the
 * same `startReviewerBody` every review uses, so spend metering, the envelope and the halt guard apply unchanged.
 */
export interface DeltaReviewBinding {
  pool: Pool;
  worker: ReviewWorker | null;
  open: OpenHttp;
  github: mergeQueue.DeltaReviewPorts["github"];
}

interface Loaded {
  who: StepWho;
  ctx: ReviewCtx;
  pr: PrFound;
}

export function bindStartDeltaReview(deps: DeltaReviewBinding): mergeQueue.StartDeltaReview {
  // One lookup per entry and head; the port is built per tick, so nothing outlives it.
  const loaded = new Map<string, Loaded | { reason: string }>();

  async function load(entry: mergeQueue.MergeQueueEntry): Promise<Loaded | { reason: string }> {
    const key = `${entry.id}:${entry.headSha}`;
    const known = loaded.get(key);
    if (known) return known;
    const out = await read(entry);
    loaded.set(key, out);
    return out;
  }

  async function read(entry: mergeQueue.MergeQueueEntry): Promise<Loaded | { reason: string }> {
    if (!deps.worker || entry.workItemId === null) return { reason: "worker_unavailable" };
    // The person whose approval started the item's advance, and the item's halt epoch: the same two facts the parked-stage sweep restarts a stage with.
    const facts = await withTenant(deps.pool, entry.accountId, async (c) => ({
      epoch: (await c.query<{ halt_epoch: number }>("SELECT halt_epoch FROM work_items WHERE id = $1 AND account_id = $2", [entry.workItemId, entry.accountId])).rows[0]?.halt_epoch,
      user: (
        await c.query<{ u: string }>(
          `SELECT substring(requested_by from 9) AS u FROM run_action_requests
            WHERE account_id = $1 AND kind = 'advance_work_item' AND target_id = $2 AND state = 'done' AND principal_kind = 'session'
            ORDER BY finished_at DESC LIMIT 1`,
          [entry.accountId, entry.workItemId],
        )
      ).rows[0]?.u,
    }));
    if (facts.epoch === undefined || facts.user === undefined) return { reason: "invalid_input" };
    const who: StepWho = { accountId: entry.accountId, userId: facts.user, workItemId: entry.workItemId, haltEpoch: facts.epoch };
    const ctx = await reviewLoadBody(deps.worker, who, null);
    if (!ctx.ok) return { reason: ctx.reason };
    const pr = await findPrBody(deps.open, ctx);
    return pr.ok ? { who, ctx, pr } : { reason: "invalid_input" };
  }

  return mergeQueue.createStartDeltaReview({
    github: deps.github,
    async plan({ entry }) {
      const l = await load(entry);
      if (!("who" in l)) return { ok: false, reason: l.reason };
      // The roles the merge gate will demand for this item's whole pull request, by the one rule it uses (not only for the merge commit's files).
      const plan = reviewPlanFor({ tier: l.ctx.tier as Parameters<typeof reviewPlanFor>[0]["tier"], securityDiffTriggerFired: l.pr.securityCodes.length > 0, reviewerFlaggedSecurity: false, debaterEnabled: l.ctx.debaterEnabled });
      return { ok: true, roles: plan.roles };
    },
    async startRole({ entry, role, delta }) {
      const l = await load(entry);
      if (!("who" in l)) return { ok: false, reason: l.reason };
      const started = await startReviewerBody(deps.worker, l.who, l.ctx, { number: l.pr.number, headSha: delta.mergeCommitSha, baseRef: l.pr.baseRef, branch: l.pr.branch }, role, [], 0, 0, delta);
      if (started.runId !== null) return { ok: true, runId: started.runId };
      // A spending limit (named pause) or an envelope denial is a refused spend; every other refusal keeps its own code.
      return { ok: false, reason: isReservationPause(started.reason) || started.reason === "refused_spend" ? "refused_spend" : (started.reason ?? "invalid_input") };
    },
    async cancelRun(entry, runId) {
      const l = await load(entry);
      if ("who" in l) await deps.worker?.advanceCancel(l.who, runId);
    },
    async recordSkip({ entry, toSha }) {
      const l = await load(entry);
      if ("who" in l) await deps.worker?.advanceRecordEvent(l.who, { kind: "head_refresh", dedupeKey: `refresh:${toSha}`, code: "main_side_only", headSha: toSha, prNumber: entry.prNumber });
    },
  });
}

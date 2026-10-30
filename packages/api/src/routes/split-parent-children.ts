import { reportError } from "@fx/telemetry";
import { SubItemApprovalError } from "@fx/core/src/decisions/approveSubItem.js";
import { announceNewRunAction, type RunActionSignal } from "@fx/core/src/runActions/index.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import type { RouteContext } from "../registry.js";

/**
 * A person's "Approve the Spec and build" on a split parent (a Spec that plans two or more pull requests) starts the planned PRs that can start now, in that
 * person's own name. The parent itself never builds: its workflow answers `children_launched` and ends.
 *
 * Without this the only thing that ever started a child was the auto-start pass's dial launch, and that pass lists a child only while the account's weekly
 * auto-start limit is confirmed (`planned_pr_child_list_due`, migration 0920). An account with automatic starts off got its parent approved and its children
 * left at Triaged with no start, no ask and no reason on any card.
 *
 * Each child goes through the same approval a person's Approve on its card makes (`approveSubItem`: the launch checks, a `launch_sub_item` receipt in the
 * person's name, the child's own advance request), so this adds no second way to start a child. Only children with no blocker on the dial's own reading are
 * offered: a child that waits on a sibling keeps waiting (the person's card Approve may still start it out of order, as before), and so does one held for any
 * other reason. A refused or failed launch never fails the parent's approval; the auto-start pass and the child's card are still there. A repeat click is a
 * replay at every step (a started child is `work_started` and is not offered again).
 *
 * Runs after the approval's transaction has committed (the children and the approval row must be visible to the receipt login).
 */

/** What starting one planned PR needs from the worker (the receipt login): `subItemApprovals.ts`'s approver. */
export type ChildApprover = (input: { principal: { accountId: string; userId: string; tokenId?: string }; workItemId: string; key: string; viaParentApproval?: boolean }) => Promise<{ advanceActionId: string | null; childLaunchedId?: string | null }>;

export interface SplitChildLaunchCounts {
  offered: number;
  started: number;
  refused: number;
}

export async function startSplitParentChildren(ctx: RouteContext, workItemId: string, deps: { getApprover: () => Promise<ChildApprover | null>; signal: RunActionSignal; log?: (line: string) => void }): Promise<SplitChildLaunchCounts> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const { accountId, userId, tokenId } = ctx.principal;
  const counts: SplitChildLaunchCounts = { offered: 0, started: 0, refused: 0 };
  if (tokenId) return counts;
  const keys = await withTenant(ctx.pool, accountId, userId, tokenId, async (client) =>
    (
      await client.query<{ planned_pr_key: string }>(
        `SELECT c.planned_pr_key FROM work_items c
          WHERE c.parent_id = $1::uuid AND c.planned_pr_key IS NOT NULL AND c.stage = 'triaged'
            AND planned_pr_child_blocker(c.id, false, true) IS NULL
          ORDER BY c.created_at, c.id`,
        [workItemId],
      )
    ).rows.map((r) => r.planned_pr_key),
  );
  if (keys.length === 0) return counts;
  // Resolved only now: an approval with no ready planned PR never touches the worker.
  const approver = await deps.getApprover();
  if (approver === null) {
    log(JSON.stringify({ event: "approve.children_unavailable", work_item_id: workItemId, children: keys.length }));
    return counts;
  }
  for (const key of keys) {
    counts.offered += 1;
    try {
      const done = await approver({ principal: { accountId, userId }, workItemId, key, viaParentApproval: true });
      if (done.childLaunchedId && done.advanceActionId) {
        counts.started += 1;
        await announceNewRunAction({ signal: deps.signal }, { actionId: done.advanceActionId, accountId, kind: "advance_work_item" });
      }
    } catch (err) {
      // A refusal (its fixed code) or a fault: the child stays where it is, its card says why, and the approval stands. A fault is also reported.
      counts.refused += 1;
      if (!(err instanceof SubItemApprovalError)) reportError(err, { stage: "approve.split_children" });
      const code = (err as { code?: unknown } | null)?.code;
      log(JSON.stringify({ event: "approve.child_not_started", work_item_id: workItemId, code: typeof code === "string" ? code.slice(0, 64) : "error" }));
    }
  }
  log(JSON.stringify({ event: "approve.children_started", work_item_id: workItemId, ...counts }));
  return counts;
}

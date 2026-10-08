import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { recordStage } from "@fx/core/src/work-items/recordStage.js";
import { WorkItemHaltedError } from "@fx/core/src/work-items/stages.js";
import { runTriageStep } from "../plan/step.js";

/**
 * D#483 P1: triage for one GitHub issue the stage driver was asked to advance.
 *
 * The webhook made a work item for the issue (internal, at `triaged`, with the repo and the issue's number, and no
 * title or body). The classify run answered a category. This runs the pipeline's own triage in `new` mode with that
 * category, which creates the discussion and its root work item, and then makes the pipeline's root THE card for the
 * issue:
 *
 *  - the root gets the issue's `repo_id` and `gh_number` (`createDiscussion` leaves the repo null, and every seat
 *    refuses `no_repo` without it; the number is how a later PR that closes the issue finds the root), and
 *  - the webhook's own row moves `triaged -> closed` with sourceRef `superseded:<root>`, so there is one card per issue.
 *
 * Both are idempotent, so a replay after a crash between triage and the link finishes the job.
 *
 * The category is not trusted: the pipeline's parser validates it against the fixed set, and junk comes back as
 * `unclassified` with nothing written. The trust decision (H07) was made when the webhook created the item as
 * internal, and the worker re-reads that before it calls this; the event below carries the author's login as an
 * allowlisted one so `canCreateWork` agrees with what that item already is. An empty login is untrusted.
 */
export interface IssueTriageInput {
  /** The webhook's work item for the issue. */
  workItemId: string;
  title: string;
  body: string;
  /** What the classify run answered; parsed again by triage. */
  category: string;
  sourceEventId: string;
  repoId: string;
  login: string;
  /** The issue's number on GitHub. */
  number: number;
}

/** Plain data for the worker: the pipeline's own status word and the ids a later step needs. */
export interface IssueTriageResult {
  status: string;
  reason?: string;
  category?: string;
  stage?: string;
  workItemId?: string;
  discussionId?: string;
}

export const SUPERSEDED_REF_PREFIX = "superseded:";

export async function triageIssueItem(pool: Pool, accountId: string, input: IssueTriageInput): Promise<IssueTriageResult> {
  const out = await runTriageStep(
    { pool, accountId, classifier: { complete: async () => input.category } },
    {
      mode: "new",
      event: { login: input.login, repoPermission: "none", allowlist: [input.login], body: input.body },
      title: input.title,
      repoId: input.repoId,
      sourceEventId: input.sourceEventId,
    },
  );
  if (out.status === "triaged" || out.status === "created_not_staged") {
    const root = out.workItemId;
    await withTenant(pool, accountId, async (client) => {
      await client.query("UPDATE work_items SET repo_id = COALESCE(repo_id, $2), gh_number = COALESCE(gh_number, $3) WHERE id = $1 AND account_id = $4", [root, input.repoId, input.number, accountId]);
      if (root !== input.workItemId) {
        const cur = await client.query<{ stage: string }>("SELECT stage FROM work_items WHERE id = $1 AND account_id = $2", [input.workItemId, accountId]);
        if (cur.rows[0]?.stage === "triaged") {
          try {
            await recordStage(client, { workItemId: input.workItemId, toStage: "closed", at: new Date(), source: "control_plane", sourceRef: `${SUPERSEDED_REF_PREFIX}${root}` });
          } catch (err) {
            // A halted duplicate is left as it is: nothing is closed behind a customer's halt.
            if (!(err instanceof WorkItemHaltedError)) throw err;
          }
        }
      }
    });
    return {
      status: out.status,
      category: out.category,
      stage: out.status === "triaged" ? out.stage : undefined,
      workItemId: root,
      discussionId: out.discussionId,
      ...(out.status === "created_not_staged" ? { reason: out.reason } : {}),
    };
  }
  // unclassified (the category was outside the fixed set), refused or parked: nothing was written.
  return { status: out.status, reason: out.reason };
}

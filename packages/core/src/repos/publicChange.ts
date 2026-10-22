import type { PoolClient } from 'pg';
import { operatorVerdict, type OperatorFacts } from '../work-items/operatorActions.js';
import { readPlanePush } from './planePushRecord.js';
import { isPublicChangeState, publicChangeSentence, type PublicChangeState } from './publicChangeCopy.js';

/** What the caller may do to a public change. `build_again` is reserved for the runner-run refusal: the item's top-level `actions` already lists it. */
export type PublicChangeAction = 'retry_push' | 'open_pr' | 'build_again';

/** D#598 P1f-6a: the item's change to its paired public repo, as the activity read returns it. */
export interface PublicChange {
  state: PublicChangeState;
  code: string | null;
  sentence: string;
  /** The public repository's full name, owner/name. */
  repo: string;
  branch: string;
  pr_number: number | null;
  pr_url: string | null;
  head_sha: string | null;
  actions: PublicChangeAction[];
}

/** The buttons the page may draw under the public change: each one the action table (operatorActions.ts) says the caller may press now. */
export function publicChangeActions(facts: OperatorFacts | null): PublicChangeAction[] {
  if (facts === null) return [];
  return (['retry_push', 'open_pr'] as const).filter((a) => operatorVerdict(a, facts).ok);
}

/**
 * Reads `plane_pushes` and the latest attempt (only to word a refusal on a run on the person's machine). Null for an item with no push record,
 * so a single-repository item is unchanged. The record is a stamp: it is shown as recorded. `actions` come from the same table the action routes ask.
 */
export async function readPublicChange(client: Pick<PoolClient, 'query'>, accountId: string, workItemId: string, facts: OperatorFacts | null = null): Promise<PublicChange | null> {
  const push = await readPlanePush(client, accountId, workItemId);
  if (push === null || !isPublicChangeState(push.state)) return null;
  const attempt = await client.query<{ runtime: string }>(
    'SELECT runtime FROM plane_push_attempts WHERE account_id = $1 AND plane_push_id = $2 ORDER BY created_at DESC, attempt_no DESC LIMIT 1',
    [accountId, push.id],
  );
  return {
    state: push.state,
    code: push.state === 'refused' ? push.code : null,
    sentence: publicChangeSentence(push.state, push.code, attempt.rows[0]?.runtime ?? null),
    repo: push.codeRepo,
    branch: push.branch,
    pr_number: push.prNumber,
    pr_url: push.prUrl,
    head_sha: push.headSha,
    actions: publicChangeActions(facts),
  };
}

import type { Pool, PoolClient } from 'pg';
import { withPlatformOps } from '@fx/core/src/tenancy/withPlatformOps.js';
import { emitDomainEvent } from '@fx/core/src/domain-events/emit.js';
import { markWorkPending } from '@fx/core/src/pendingWork.js';

/**
 * D#483 S5-k2: the out-of-credit signal.
 *
 * Three providers answer "your credits ran out" in three different ways, and none of them is a bad key:
 *   - Vercel AI Gateway: HTTP 402 (payment required);
 *   - Anthropic: an `invalid_request_error` whose message says the credit balance is too low;
 *   - OpenAI: HTTP 429 with the error code `insufficient_quota` (a plain 429 is a rate limit and is NOT this).
 * A run that ends on one of them records the customer's connection as `status = 'broken'`, `last_error_code = 'credits_exhausted'`, through the
 * platform_ops pool (the only login allowed to write the connection's status). Items that would draw on that connection then pause as
 * `model_credits_exhausted`, and the reconcile job re-validates the connection until it reads `ok`. This is the customer's own model credit; it is
 * never our platform spend.
 *
 * The code is stored as a word, never a provider message: nothing a provider (or a model) wrote reaches the row.
 */
export const CREDITS_EXHAUSTED_CODE = 'credits_exhausted';

/** What a provider answered on a generation call: the HTTP status when the caller has one, and the body text or the error text. */
export interface ProviderAnswer {
  status?: number | undefined;
  text?: string | undefined;
}

const ANTHROPIC_CREDITS = /credit balance is too low/i;
const OPENAI_QUOTA = /insufficient_quota/i;

/**
 * True for exactly the three out-of-credit answers above. A 402 is credit exhaustion whatever the body says (the gateway sends no more than that); the
 * other two need their own wording, so a 429 rate limit or a 400 for a bad request is not misread as an empty balance. 401 and 403 are never this:
 * they stay with markBroken.
 */
export function isCreditsExhaustedAnswer(answer: ProviderAnswer): boolean {
  const text = answer.text ?? '';
  if (answer.status === 402) return true;
  if (answer.status === 401 || answer.status === 403) return false;
  if (ANTHROPIC_CREDITS.test(text)) return answer.status === undefined || answer.status === 400;
  if (OPENAI_QUOTA.test(text)) return answer.status === undefined || answer.status === 429;
  return false;
}

/**
 * Records the account's connection as broken for out-of-credit, inside the caller's platform_ops transaction. Does nothing to a connection that is
 * already broken (for a rejected key, which outranks a balance and keeps its own code, or already for credits, which is not announced twice), and never touches `accounts.key_broken_at`: an empty
 * balance does not stop the account, it pauses the items that would spend (reserve() reads the connection). Returns whether a row changed.
 */
export async function markCreditsExhaustedWithClient(client: PoolClient, accountId: string): Promise<boolean> {
  const { rows } = await client.query<{ id: string }>(
    `UPDATE model_connections
        SET status = 'broken', last_error_code = $2
      WHERE account_id = $1 AND status <> 'broken'
      RETURNING id`,
    [accountId, CREDITS_EXHAUSTED_CODE],
  );
  const id = rows[0]?.id;
  if (!id) return false;
  await emitDomainEvent(client, { type: 'model_connection.changed', accountId, subjectId: id, payload: { state: 'broken' } });
  // The re-validation job runs inside the reconciler, which is otherwise on a slow slot cadence: wake it (a hint; the row is the truth).
  void markWorkPending('reconcile');
  return true;
}

/** Opens its own platform_ops transaction around markCreditsExhaustedWithClient. */
export async function markCreditsExhausted(platformOpsPool: Pool, accountId: string): Promise<boolean> {
  return withPlatformOps(platformOpsPool, (client) => markCreditsExhaustedWithClient(client, accountId));
}

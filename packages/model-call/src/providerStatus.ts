import type { Pool } from 'pg';
import { isCreditsExhaustedAnswer, markBroken, markCreditsExhausted, type Principal } from '@fx/model-connection';
import { ModelCallError } from './keyUse.js';

/** The non-2xx handling shared by completeJson and streamTurn. Returns for a 2xx; throws a ModelCallError otherwise. */
export async function failOnStatus(ctx: { platformOpsPool: Pool; principal: Principal }, role: string, res: { status: number; text: string }): Promise<void> {
  if (res.status === 401 || res.status === 403) {
    await markBroken(ctx.platformOpsPool, ctx.principal.accountId, res.status); // S2i
    throw new ModelCallError('key_rejected', `model-call (${role}): provider rejected the key (HTTP ${res.status})`, res.status);
  }
  // D#483 S5-k2: the provider says the customer's credits ran out: its own code, and the connection is recorded broken for credits.
  if (isCreditsExhaustedAnswer({ status: res.status, text: res.text })) {
    await markCreditsExhausted(ctx.platformOpsPool, ctx.principal.accountId);
    throw new ModelCallError('credits_exhausted', `model-call (${role}): the account's model credits ran out (HTTP ${res.status})`, res.status);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new ModelCallError('http_error', `model-call (${role}): provider returned HTTP ${res.status}: ${res.text}`, res.status);
  }
}

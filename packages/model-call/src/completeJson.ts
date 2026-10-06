import type { Pool } from 'pg';
import type { z } from 'zod';
import { markBroken, type KekSource, type Principal } from '@fx/model-connection';
import { replyFrom, type RequestParams } from './hosts.js';
import { callWithKey, ModelCallError } from './keyUse.js';

/** S2a: the account is `principal.accountId` and nothing else -- there is no accountId parameter anywhere. */
export interface ModelCallCtx {
  pool: Pool;
  platformOpsPool: Pool;
  principal: Principal;
  kek: KekSource;
  /** Tests inject a fake provider transport; production leaves it unset (global fetch). */
  fetchImpl?: typeof fetch;
}

export interface CompleteJsonParams<T> extends RequestParams {
  /** The caller's role (e.g. 'project-interviewer'); appears in error text only. */
  role: string;
  schema: z.ZodType<T>;
  timeoutMs: number;
}

export interface CompleteJsonResult<T> {
  /** null when the reply was not JSON or failed the schema: the caller treats that as "no follow-up". No retry. */
  value: T | null;
  usage: { inputTokens: number; outputTokens: number };
}

const HARD_TIMEOUT_MS = 30_000;
const NO_USAGE = { inputTokens: 0, outputTokens: 0 };

/**
 * One no-tools, no-streaming model call over the account's own key. Metering is the caller's job.
 * The key is read inside withTenant, whose transaction has ended before the provider call starts
 * (S2f), so no lock is held during it.
 */
export async function completeJson<T>(ctx: ModelCallCtx, p: CompleteJsonParams<T>): Promise<CompleteJsonResult<T>> {
  // S2h: under FX_FORBID_MODEL_CALLS only an injected (fake) transport may run; refuse before touching the DB.
  if (process.env.FX_FORBID_MODEL_CALLS === '1' && !ctx.fetchImpl) {
    throw new ModelCallError('forbidden', 'model-call: FX_FORBID_MODEL_CALLS is set');
  }
  const res = await callWithKey(ctx, ctx.fetchImpl ?? globalThis.fetch, Math.min(p.timeoutMs, HARD_TIMEOUT_MS), p);
  if (res.status === 401 || res.status === 403) {
    await markBroken(ctx.platformOpsPool, ctx.principal.accountId, res.status); // S2i
    throw new ModelCallError('key_rejected', `model-call (${p.role}): provider rejected the key (HTTP ${res.status})`, res.status);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new ModelCallError('http_error', `model-call (${p.role}): provider returned HTTP ${res.status}: ${res.text}`, res.status);
  }
  let reply: ReturnType<typeof replyFrom> = null;
  try {
    reply = replyFrom(res.provider, JSON.parse(res.text));
  } catch {
    // an unreadable envelope is "no follow-up" too
  }
  let value: T | null = null;
  try {
    const parsed = p.schema.safeParse(JSON.parse((reply?.text ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '')));
    if (parsed.success) value = parsed.data;
  } catch {
    // not JSON: "no follow-up"
  }
  return { value, usage: reply?.usage ?? NO_USAGE };
}

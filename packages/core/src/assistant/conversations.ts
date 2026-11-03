import type { Pool } from 'pg';
import { assistantSettings, loadPlanData } from '@fx/plan-data';
import { NotFoundError } from '../tenancy/errors.js';
import { assertActiveMembership } from '../tenancy/scopedAccess.js';
import { withTenant } from '../tenancy/withTenant.js';

/**
 * D#597 CC-5c: the assistant's per-conversation cost store (migration 0973). The money and the ids only: no message text is kept, so none
 * can reach this table or a log line. The cap comes from the plan data when the conversation starts and is fixed on its row.
 * Nothing here calls a model, and nothing imports it yet (the route is a later row).
 */
export interface AssistantCtx {
  pool: Pool;
  principal: { accountId: string; userId: string };
}

export interface AssistantConversation {
  id: string;
  accountId: string;
  repoId: string;
  workItemId: string | null;
  createdBy: string | null;
  capMicroUsd: number;
  spentMicroUsd: number;
  /** Held back for turns admitted and not yet settled. */
  reservedMicroUsd: number;
  turns: number;
  createdAt: Date;
}

/** The assistant cannot run: the plan data carries no cap (or cannot be read). There is no default and no other source for the figure. */
export class AssistantUnavailableError extends Error {
  readonly code = 'assistant_unconfigured';
  constructor() {
    super('the assistant is not available: the conversation cap is not configured');
    this.name = 'AssistantUnavailableError';
  }
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}

/** A settle for a hold that is unknown, another conversation's, already settled or released. Nothing was changed. */
export class AssistantHoldRefusedError extends Error {
  readonly code = 'assistant_hold_refused';
  constructor() {
    super('assistant_hold_refused');
    this.name = 'AssistantHoldRefusedError';
  }
}

export type AdmitResult =
  | { admitted: true; holdId: string; heldMicroUsd: number }
  | { admitted: false; code: 'budget_reached' | 'assistant_unpriced' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS =
  'id, account_id, repo_id, work_item_id, created_by, cap_micro_usd, spent_micro_usd, reserved_micro_usd, turns, created_at';

interface Row {
  id: string;
  account_id: string;
  repo_id: string;
  work_item_id: string | null;
  created_by: string | null;
  cap_micro_usd: string;
  spent_micro_usd: string;
  reserved_micro_usd: string;
  turns: number;
  created_at: Date;
}

function toConversation(r: Row): AssistantConversation {
  return {
    id: r.id,
    accountId: r.account_id,
    repoId: r.repo_id,
    workItemId: r.work_item_id,
    createdBy: r.created_by,
    capMicroUsd: Number(r.cap_micro_usd),
    spentMicroUsd: Number(r.spent_micro_usd),
    reservedMicroUsd: Number(r.reserved_micro_usd),
    turns: r.turns,
    createdAt: r.created_at,
  };
}

interface Rates {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  cacheWriteUsdPerMTok: number;
  cacheReadUsdPerMTok: number;
}

/** The rates (USD per million tokens, which is micro-USD per token) of a price-table model, or undefined when it has no price. Plan data, never code. */
function rateOf(model: string): Rates | undefined {
  const table = loadPlanData().pricing.claude as Readonly<Record<string, Rates>>;
  return Object.hasOwn(table, model) ? table[model] : undefined;
}

const wholeCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/** Micro-USD for a usage, rounded UP so a cost is never understated. Undefined for a model with no price. */
export function priceUsageMicroUsd(model: string, usage: TurnUsage): number | undefined {
  const rate = rateOf(model);
  if (rate === undefined) return undefined;
  const cw = usage.cacheWriteTokens ?? 0;
  const cr = usage.cacheReadTokens ?? 0;
  if (![usage.inputTokens, usage.outputTokens, cw, cr].every(wholeCount)) throw new RangeError('token counts must be whole numbers');
  return Math.ceil(
    usage.inputTokens * rate.inputUsdPerMTok + usage.outputTokens * rate.outputUsdPerMTok + cw * rate.cacheWriteUsdPerMTok + cr * rate.cacheReadUsdPerMTok,
  );
}

/** The worst case of a turn: the input estimate at the dearer of the input and cache-write rates, plus max output at the output rate. Rounded up. */
export function worstCaseMicroUsd(model: string, inputTokensEstimate: number, maxOutputTokens: number): number | undefined {
  const rate = rateOf(model);
  if (rate === undefined) return undefined;
  if (![inputTokensEstimate, maxOutputTokens].every(wholeCount)) throw new RangeError('token counts must be whole numbers');
  return Math.ceil(inputTokensEstimate * Math.max(rate.inputUsdPerMTok, rate.cacheWriteUsdPerMTok) + maxOutputTokens * rate.outputUsdPerMTok);
}

function mapDbError(err: unknown): unknown {
  if ((err as { message?: string } | null)?.message === 'assistant_hold_refused') return new AssistantHoldRefusedError();
  const code = (err as { code?: string } | null)?.code;
  // 23503: repo or item not in this account. 42501: not the creator, not a member, or an unknown conversation: all read as "not found".
  if (code === '23503' || code === '42501' || code === 'P0002') return new NotFoundError('conversation not found');
  return err;
}

/** Begin a conversation for the caller on one of the account's repos. Throws AssistantUnavailableError when the plan data has no cap. */
export async function startConversation(ctx: AssistantCtx, input: { repoId: string; workItemId?: string | null }): Promise<AssistantConversation> {
  const settings = assistantSettings();
  if (!settings.on) throw new AssistantUnavailableError();
  const workItemId = input.workItemId ?? null;
  if (!UUID_RE.test(input.repoId) || (workItemId !== null && !UUID_RE.test(workItemId))) throw new NotFoundError('repo or work item not found');
  const capMicro = Math.round(settings.conversationCapUsd * 1_000_000);
  const { accountId, userId } = ctx.principal;
  try {
    return await withTenant(ctx.pool, accountId, userId, async (client) => {
      await assertActiveMembership(client, accountId, userId);
      const { rows } = await client.query<Row>(
        `INSERT INTO assistant_conversations (account_id, repo_id, work_item_id, created_by, cap_micro_usd)
         VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
        [accountId, input.repoId, workItemId, userId, capMicro],
      );
      return toConversation(rows[0]!);
    });
  } catch (err) {
    throw mapDbError(err);
  }
}

/** One conversation the caller may see (the creator, or an owner or admin), or NotFoundError. */
export async function getConversation(ctx: AssistantCtx, id: string): Promise<AssistantConversation> {
  if (!UUID_RE.test(id)) throw new NotFoundError('conversation not found');
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    await assertActiveMembership(client, accountId, userId);
    const { rows } = await client.query<Row>(`SELECT ${COLUMNS} FROM assistant_conversations WHERE id = $1`, [id]);
    if (rows[0] === undefined) throw new NotFoundError('conversation not found');
    return toConversation(rows[0]);
  });
}

/**
 * Admit a turn only if its worst case fits under the cap (R-597-C2-5, fail closed). Worst case = the priced input estimate plus
 * `maxOutputTokens` priced as output, both from the plan-data price table. A model with no price answers `assistant_unpriced` and records
 * nothing. The check and the hold are ONE conditional UPDATE in the database, so two turns at once cannot both pass.
 * Pass the held amount back to settleTurn.
 */
export async function admitTurn(
  ctx: AssistantCtx,
  input: { conversationId: string; model: string; inputTokensEstimate: number; maxOutputTokens: number },
): Promise<AdmitResult> {
  if (!UUID_RE.test(input.conversationId)) throw new NotFoundError('conversation not found');
  const worst = worstCaseMicroUsd(input.model, input.inputTokensEstimate, input.maxOutputTokens);
  if (worst === undefined) return { admitted: false, code: 'assistant_unpriced' };
  const { accountId, userId } = ctx.principal;
  try {
    return await withTenant(ctx.pool, accountId, userId, async (client) => {
      const { rows } = await client.query<{ hold: string | null }>('SELECT assistant_conversation_charge($1, $2) AS hold', [input.conversationId, worst]);
      return rows[0]?.hold == null ? { admitted: false, code: 'budget_reached' } : { admitted: true, holdId: rows[0].hold, heldMicroUsd: worst };
    });
  } catch (err) {
    throw mapDbError(err);
  }
}

/**
 * Settle ONE admitted turn (by its hold id), once, at its real usage priced from the same table. `usage: null` (the provider gave none)
 * settles at the held worst case. The full real cost is recorded even if it is above the hold, so spend can pass the cap; admission then
 * refuses further turns. A second settle, another conversation's hold or a released hold throws AssistantHoldRefusedError and changes
 * nothing. Returns the conversation's new spent total.
 */
export async function settleTurn(
  ctx: AssistantCtx,
  input: { conversationId: string; holdId: string; model: string; usage: TurnUsage | null },
): Promise<number> {
  if (!UUID_RE.test(input.conversationId)) throw new NotFoundError('conversation not found');
  if (!UUID_RE.test(input.holdId)) throw new AssistantHoldRefusedError();
  const actual = input.usage === null ? null : priceUsageMicroUsd(input.model, input.usage);
  if (actual === undefined) throw new RangeError('settleTurn: the model has no price');
  const { accountId, userId } = ctx.principal;
  try {
    return await withTenant(ctx.pool, accountId, userId, async (client) => {
      const { rows } = await client.query<{ spent: string }>('SELECT assistant_conversation_settle($1, $2, $3) AS spent', [
        input.conversationId,
        input.holdId,
        actual,
      ]);
      return Number(rows[0]!.spent);
    });
  } catch (err) {
    throw mapDbError(err);
  }
}

/**
 * What the assistant has spent, and has held for turns in flight, in the account over a window: the sum of the conversations the caller can see (an owner or admin sees the
 * account's, a member their own), by creation time. For the cost view; it is not a budget and nothing draws on it.
 */
export async function accountAssistantSpend(
  ctx: AssistantCtx,
  window: { since?: Date; until?: Date } = {},
): Promise<{ spentMicroUsd: number; reservedMicroUsd: number; conversations: number }> {
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    await assertActiveMembership(client, accountId, userId);
    const { rows } = await client.query<{ spent: string; held: string; n: number }>(
      `SELECT COALESCE(sum(spent_micro_usd), 0)::text AS spent, COALESCE(sum(reserved_micro_usd), 0)::text AS held, count(*)::int AS n FROM assistant_conversations
        WHERE account_id = $1 AND ($2::timestamptz IS NULL OR created_at >= $2) AND ($3::timestamptz IS NULL OR created_at < $3)`,
      [accountId, window.since ?? null, window.until ?? null],
    );
    return { spentMicroUsd: Number(rows[0]!.spent), reservedMicroUsd: Number(rows[0]!.held), conversations: rows[0]!.n };
  });
}

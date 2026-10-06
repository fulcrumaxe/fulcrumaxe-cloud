import { withPlatformOps } from './pg.js';
import { authorizeAccountWriteInTx } from './authorize.js';
import { recordAccountAction } from './audit.js';
import type { BillingCtx } from './types.js';

export type AccountSettingResult<T> = { ok: true; before: T; after: T } | { ok: false; reason: 'account_not_found' };

export interface SetAccountBudgetsInput {
  accountId: string;
  /** The monthly model budget in USD. The caller validates range and cents; 0 means "not set". */
  modelUsdMonth: number;
}

/**
 * D#31 API-7d: sets the account's monthly model budget. Only this one budget
 * is settable -- the compute budgets come from the plan and have no writer.
 *
 * One platform_ops transaction: authorize (FOR SHARE on the caller's
 * membership) -> read the current value FOR UPDATE -> UPDATE -> audit. The
 * audit call throws on any failure and takes the write with it. A PATCH that
 * sets the value it already has still writes one audit row (the explicit
 * exception to "rows only on a real change").
 */
export async function setAccountBudgets(
  ctx: BillingCtx,
  input: SetAccountBudgetsInput,
): Promise<AccountSettingResult<{ model_usd_month: number }>> {
  return withPlatformOps(ctx.pool, async (client) => {
    const authFailure = await authorizeAccountWriteInTx(client, input.accountId, ctx.principal.userId);
    if (authFailure) return authFailure;

    const { rows } = await client.query<{ model: string }>(
      'SELECT model_budget_usd_month::text AS model FROM accounts WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [input.accountId],
    );
    if (!rows[0]) return { ok: false, reason: 'account_not_found' } as const;
    const before = { model_usd_month: Number(rows[0].model) };

    const { rows: updated } = await client.query<{ model: string }>(
      'UPDATE accounts SET model_budget_usd_month = $1, updated_at = now() WHERE id = $2 RETURNING model_budget_usd_month::text AS model',
      [input.modelUsdMonth, input.accountId],
    );
    const after = { model_usd_month: Number(updated[0]!.model) };

    await recordAccountAction(client, {
      accountId: input.accountId,
      userId: ctx.principal.userId,
      action: 'account.budgets_changed',
      payload: { before, after },
    });
    return { ok: true, before, after } as const;
  });
}

export interface SetSharePublicFiguresInput {
  accountId: string;
  value: boolean;
}

/** D#31 API-7d: the share_public_figures opt-in. Same transaction shape, and the same one-row-per-PATCH rule, as `setAccountBudgets`. */
export async function setSharePublicFigures(
  ctx: BillingCtx,
  input: SetSharePublicFiguresInput,
): Promise<AccountSettingResult<boolean>> {
  return withPlatformOps(ctx.pool, async (client) => {
    const authFailure = await authorizeAccountWriteInTx(client, input.accountId, ctx.principal.userId);
    if (authFailure) return authFailure;

    const { rows } = await client.query<{ share_public_figures: boolean }>(
      'SELECT share_public_figures FROM accounts WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [input.accountId],
    );
    if (!rows[0]) return { ok: false, reason: 'account_not_found' } as const;
    const before = rows[0].share_public_figures;

    await client.query('UPDATE accounts SET share_public_figures = $1, updated_at = now() WHERE id = $2', [
      input.value,
      input.accountId,
    ]);

    await recordAccountAction(client, {
      accountId: input.accountId,
      userId: ctx.principal.userId,
      action: 'account.share_public_figures_changed',
      payload: { before, after: input.value },
    });
    return { ok: true, before, after: input.value } as const;
  });
}

import { getRoleEntry } from '@fx/roles';
import { withTenant } from '../tenancy/withTenant.js';
import { assertActiveMembership } from '../tenancy/scopedAccess.js';
import { requireOwnerOrAdmin, type MembershipRole } from '../tenancy/authorize.js';
import { NotFoundError } from '../tenancy/errors.js';
import { writeRoleSettingsAuditLog } from '../role-settings/auditLog.js';
import { RUN_LIMIT_BOUNDS, RUN_LIMIT_INTEGER_KEYS, RUN_LIMIT_KEYS } from './limits.js';
import { toStored } from './resolve.js';
import { ACCOUNT_DEFAULT_ROLE, type RunLimitsCtx, type StoredRunLimits } from './types.js';

/** A value outside its floor/ceiling, or an unknown key: the API maps it to 422 with `path`. */
export class InvalidRunLimitsError extends Error {
  constructor(
    message: string,
    public readonly path: string,
  ) {
    super(message);
    this.name = 'InvalidRunLimitsError';
  }
}

/** Keys present are written (null = inherit); keys absent stay as they are. */
export type RunLimitsPatch = Partial<StoredRunLimits>;

function validate(values: RunLimitsPatch): void {
  for (const [key, v] of Object.entries(values)) {
    const path = `values.${key}`;
    if (key === 'auto_resume') {
      if (v !== null && typeof v !== 'boolean') throw new InvalidRunLimitsError('auto_resume must be a boolean or null', path);
      continue;
    }
    if (!(RUN_LIMIT_KEYS as string[]).includes(key)) throw new InvalidRunLimitsError(`unknown limit: ${key}`, path);
    if (v === null) continue;
    const { floor, ceiling } = RUN_LIMIT_BOUNDS[key as keyof typeof RUN_LIMIT_BOUNDS];
    const whole = (RUN_LIMIT_INTEGER_KEYS as string[]).includes(key);
    if (typeof v !== 'number' || !Number.isFinite(v) || (whole && !Number.isInteger(v)) || v < floor || v > ceiling) {
      throw new InvalidRunLimitsError(`${key} must be null or ${whole ? 'an integer ' : ''}from ${floor} to ${ceiling}`, path);
    }
  }
}

/**
 * D#2 C48 H12c: sets one role's (or the account default's, role '*') run
 * limits and writes one `run_limits.changed` audit row `{ role, before,
 * after }`, in one transaction. Owner or admin only. The floors/ceilings
 * are checked here and again by migration 0651's CHECKs.
 */
export async function setRunLimits(
  ctx: RunLimitsCtx,
  input: { role: string; values: RunLimitsPatch },
): Promise<void> {
  const { accountId, userId } = ctx.principal;
  await withTenant(ctx.pool, accountId, userId, async (client) => {
    await assertActiveMembership(client, accountId, userId);
    const { rows: memberRows } = await client.query<{ role: MembershipRole }>(
      'SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2',
      [accountId, userId],
    );
    requireOwnerOrAdmin(memberRows[0]?.role ?? null);

    if (input.role !== ACCOUNT_DEFAULT_ROLE && getRoleEntry(input.role) === undefined) {
      throw new NotFoundError(`unknown role: ${input.role}`);
    }
    validate(input.values);

    await client.query(
      'INSERT INTO run_limits (account_id, role) VALUES ($1, $2) ON CONFLICT (account_id, role) DO NOTHING',
      [accountId, input.role],
    );
    const { rows } = await client.query<Record<string, unknown>>(
      'SELECT * FROM run_limits WHERE account_id = $1 AND role = $2 FOR UPDATE',
      [accountId, input.role],
    );
    const before = toStored(rows[0]);
    const after = { ...before, ...input.values };

    const cols = [...RUN_LIMIT_KEYS, 'auto_resume'] as const;
    await client.query(
      `UPDATE run_limits SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')}, updated_at = now()
       WHERE account_id = $1 AND role = $2`,
      [accountId, input.role, ...cols.map((c) => after[c])],
    );

    await writeRoleSettingsAuditLog(client, accountId, userId, 'run_limits.changed', {
      role: input.role,
      before,
      after,
    });
  });
}

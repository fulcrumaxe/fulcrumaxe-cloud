import type { PoolClient } from 'pg';
import { AUTO_RESUME_DEFAULT, RUN_LIMIT_BOUNDS, RUN_LIMIT_KEYS } from './limits.js';
import { ACCOUNT_DEFAULT_ROLE, type RunLimits, type StoredRunLimits } from './types.js';

const COLUMNS = [...RUN_LIMIT_KEYS, 'auto_resume'].join(', ');

/** Turns pg's raw row (numeric arrives as a string) into a StoredRunLimits. */
export function toStored(row: Record<string, unknown> | undefined): StoredRunLimits {
  const out: Record<string, unknown> = { auto_resume: (row?.auto_resume as boolean | null | undefined) ?? null };
  for (const k of RUN_LIMIT_KEYS) out[k] = row?.[k] == null ? null : Number(row[k]);
  return out as StoredRunLimits;
}

/** Pure: the role row, then the account row, then the default, clamped to the ceiling. */
export function mergeRunLimits(roleRow: StoredRunLimits | undefined, accountRow: StoredRunLimits | undefined): RunLimits {
  const out: Record<string, unknown> = {
    auto_resume: roleRow?.auto_resume ?? accountRow?.auto_resume ?? AUTO_RESUME_DEFAULT,
  };
  for (const k of RUN_LIMIT_KEYS) {
    const b = RUN_LIMIT_BOUNDS[k];
    out[k] = Math.min(roleRow?.[k] ?? accountRow?.[k] ?? b.default, b.ceiling);
  }
  return out as RunLimits;
}

/**
 * Must run inside a `withTenant` transaction for `accountId` (RLS scopes the
 * read; the WHERE names the account too).
 */
export async function resolveRunLimits(
  client: PoolClient,
  input: { accountId: string; role: string },
): Promise<RunLimits> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT role, ${COLUMNS} FROM run_limits WHERE account_id = $1 AND role IN ($2, $3)`,
    [input.accountId, input.role, ACCOUNT_DEFAULT_ROLE],
  );
  const byRole = (r: string) => {
    const row = rows.find((x) => x.role === r);
    return row === undefined ? undefined : toStored(row);
  };
  return mergeRunLimits(byRole(input.role), byRole(ACCOUNT_DEFAULT_ROLE));
}

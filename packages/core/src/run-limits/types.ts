import type { Pool } from 'pg';
import type { RunLimitKey } from './limits.js';

/** Same shape as the other core service modules' ctx. */
export interface RunLimitsCtx {
  /** app_user pool -- every read/write goes through withTenant on this. */
  pool: Pool;
  principal: { accountId: string; userId: string };
}

/** A fully resolved set: every field has a value. */
export type RunLimits = Record<RunLimitKey, number> & { auto_resume: boolean };

/** One stored row's settings; null means "inherit". */
export type StoredRunLimits = Record<RunLimitKey, number | null> & { auto_resume: boolean | null };

/** The account default is stored under this role. */
export const ACCOUNT_DEFAULT_ROLE = '*';

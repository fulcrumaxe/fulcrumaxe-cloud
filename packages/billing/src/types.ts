import type { Pool } from 'pg';

/**
 * D#2 comment 18494573 (C7, the H10 note): "plan/status reads, pause/resume
 * and the portal/checkout-session services take (ctx, input). D#31 API-7
 * wraps them." Mirrors H21's `ModelConnectionCtx` shape
 * (packages/model-connection/src/types.ts) -- `pool` + `principal` is the
 * one identity/tenancy carrier every ctx-taking function below accepts,
 * matching D#31 API-7's own wrapping convention.
 *
 * Unlike H21, billing's writes already run entirely under `platform_ops`
 * (sec-criteria A3 -- app_user has no INSERT/UPDATE on accounts at all), so
 * `pool` here IS the platform_ops-connected pool; there is no separate
 * app_user pool to carry. `platform_ops` also holds the GRANT +
 * unconditional `USING (true)` policy on `account_members`
 * (migrations/0004_account_members_platform_ops_grant.sql), so
 * `@fx/core`'s `getMemberRole` resolves correctly against this same pool.
 */
export interface BillingPrincipal {
  accountId: string;
  userId: string;
}

export interface BillingCtx {
  /** platform_ops-connected pool -- every H10 write and the role check both go through this one pool. */
  pool: Pool;
  principal: BillingPrincipal;
}

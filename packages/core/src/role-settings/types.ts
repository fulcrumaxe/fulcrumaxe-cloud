import type { Pool } from 'pg';
import type { RoleMode } from '@fx/roles';

/**
 * D#31 comment 18494573 (C7, H12 line): the caller's tenant + identity,
 * matching the same shape @fx/model-connection's `Principal` already uses
 * for its own ctx-taking functions. Each domain module in this codebase
 * defines its own local copy rather than sharing one exported type (see
 * packages/model-connection/src/types.ts's own doc comment) -- this is
 * this module's copy.
 */
export interface Principal {
  accountId: string;
  userId: string;
}

/**
 * D#31 comment 18494573 (C7): "the service module in
 * packages/core/src/role-settings/** takes (ctx:{pool, principal},
 * input). D#31 API-8 wraps it, and there are no page-local server
 * actions." Every mutation and every tenant-scoped read in this module
 * takes exactly this ctx shape.
 */
export interface RoleSettingsCtx {
  /** app_user pool -- every read/write here goes through withTenant on this. */
  pool: Pool;
  principal: Principal;
}

/**
 * H16 (the scheduler) and its cron tick have no end-user session to carry
 * as a `principal.userId` -- there is no "acting member" for a scheduled
 * tick, but the tick DOES already know which account it's running for
 * (it iterates accounts/repos itself). `isRoleRunnable`/
 * `listSkippedForBudget` are the read-only contract H16 calls, and they
 * still go through `withTenant` on the app_user pool -- using its 2-arg
 * `withTenant(pool, accountId, fn)` overload (no `userId`) rather than
 * `withPlatformOps`, because `role_settings`/`agent_runs`/`run_events`
 * have no `platform_ops` grant at all (migrations/0001_core.sql only
 * grants platform_ops on `accounts`/`partners`/`users`/`account_members`/
 * `invitations`(SELECT)/`ledger`(SELECT)/`audit_log`(SELECT)) --
 * `withPlatformOps` is for lookups that have no `account_id` to scope by
 * yet, which is not this case.
 */
export interface RoleSchedulerCtx {
  /** app_user pool. */
  pool: Pool;
}

/** Mirrors migrations/0001_core.sql's role_settings.mode CHECK, which is @fx/roles' own RoleMode. */
export type { RoleMode };

/** H12 criterion 2's cost line, plus the raw numbers a UI would need to render it without recomputing them. */
export interface RoleCostLine {
  /** The exact string: "expected spend on your model bill: $X/month". */
  text: string;
  monthlyUsd: number;
  runsPerMonth: number;
  medianCostPerRunUsd: number;
  /** 'seed' until the tenant has 10 of this role's own runs; 'ledger' after. */
  medianSource: 'seed' | 'ledger';
  /** The token-coverage caveat, as data (H12 re-brief: "as data", not baked into `text`). */
  caveat: string;
}

/** H12 criterion 1: one entry per role, for `listRoleSettings`. */
export interface RoleSettingsEntry {
  role: string;
  allowedModes: RoleMode[];
  mode: RoleMode;
  /** The stored `role_settings.model` override, or null ("follows the routing table"). Returned as stored, not validated on read. */
  model: string | null;
  costLine: RoleCostLine;
}

/** H12 criterion 5: the two per-repo auto-merge guard toggles, stored in `repos.settings` jsonb. */
export interface RepoGuardSettings {
  autoMerge: boolean;
  blockExternalAutoMerge: boolean;
}

/**
 * The model ids `role_settings.model` may hold (D#31 API-8b). Mirrors
 * `@fx/spend`'s `ModelId`; it is declared here only because `@fx/core`
 * cannot import `@fx/model-router` or `@fx/spend` (model-router -> spend ->
 * core would be a cycle). `packages/model-router/test/role-model-parity.test.ts`
 * fails if this list, the router's tier order or the database CHECK drift.
 */
export const ROLE_MODEL_IDS = ['haiku-4.5', 'sonnet-5', 'opus-5'] as const;
export type RoleModelId = (typeof ROLE_MODEL_IDS)[number];

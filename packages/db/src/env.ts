import type { PoolClient } from 'pg';

/** Accessors for the environment tables (D#5 E5a; migrations/0674). Each takes a `withTenant` client; the tenant is the session's, never an input. */

export type EnvSource = 'repo' | 'proposal' | 'preset';
/** The compute budgets a build can draw on (OD-7, C12; `emergency` per the D#8 amendment). */
export type EnvBuildBudget = 'foreground_compute' | 'background_compute' | 'emergency';

/**
 * The states of a build (migration 0738). `running` is the only open state; the other three close the row:
 * `succeeded` (image built), `failed` (a step failed; `failingStep` names it) and `killed` (the dollar or time cap, C12).
 */
export type EnvBuildStatus = 'running' | 'succeeded' | 'failed' | 'killed';
export const ENV_BUILD_STATUSES: readonly EnvBuildStatus[] = ['running', 'succeeded', 'failed', 'killed'];
export const ENV_BUILD_FINAL_STATUSES: readonly EnvBuildStatus[] = ['succeeded', 'failed', 'killed'];

export const ENV_SOURCES: readonly EnvSource[] = ['repo', 'proposal', 'preset'];
export const ENV_BUILD_BUDGETS: readonly EnvBuildBudget[] = ['foreground_compute', 'background_compute', 'emergency'];

const ENV_VERSION_ID = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

export interface EnvVersionRow {
  id: string;
  account_id: string;
  repo_id: string;
  env_version_id: string;
  canonical_spec: string;
  base_image_digest: string;
  built_image_digest: string;
  source: EnvSource;
  created_at: Date;
}

export interface EnvBuildRow {
  id: string;
  account_id: string;
  env_version_id: string;
  status: EnvBuildStatus;
  failing_step: string | null;
  log_ref: string | null;
  started_at: Date;
  finished_at: Date | null;
  cost_usd: string;
  budget: EnvBuildBudget;
}

export type EnvErrorCode =
  'env_bad_version_id' | 'env_bad_digest' | 'env_bad_source' | 'env_bad_budget' | 'env_missing_spec' | 'env_bad_status';

/** Thrown before any query is sent; branch on `code`. */
export class EnvInputError extends Error {
  constructor(readonly code: EnvErrorCode) {
    super(code);
    this.name = 'EnvInputError';
  }
}

export interface NewEnvVersion {
  repoId: string;
  envVersionId: string;
  canonicalSpec: string;
  baseImageDigest: string;
  builtImageDigest: string;
  source: EnvSource;
}

/** Records a built version. Insert-only: a re-pin is a NEW row; a repeat hits the unique constraint. */
export async function insertEnvVersion(client: PoolClient, input: NewEnvVersion): Promise<EnvVersionRow> {
  if (!ENV_VERSION_ID.test(input.envVersionId)) throw new EnvInputError('env_bad_version_id');
  if (!IMAGE_DIGEST.test(input.baseImageDigest) || !IMAGE_DIGEST.test(input.builtImageDigest)) throw new EnvInputError('env_bad_digest');
  if (!ENV_SOURCES.includes(input.source)) throw new EnvInputError('env_bad_source');
  if (input.canonicalSpec === '') throw new EnvInputError('env_missing_spec');
  const { rows } = await client.query<EnvVersionRow>(
    `INSERT INTO env_versions
       (account_id, repo_id, env_version_id, canonical_spec, base_image_digest, built_image_digest, source)
     VALUES (NULLIF(current_setting('app.account_id', true), '')::uuid, $1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [input.repoId, input.envVersionId, input.canonicalSpec, input.baseImageDigest, input.builtImageDigest, input.source],
  );
  return rows[0]!;
}

/** The cache lookup: the recorded version for this repo, or null on a miss. */
export async function getEnvVersion(client: PoolClient, repoId: string, envVersionId: string): Promise<EnvVersionRow | null> {
  if (!ENV_VERSION_ID.test(envVersionId)) throw new EnvInputError('env_bad_version_id');
  const { rows } = await client.query<EnvVersionRow>(
    `SELECT * FROM env_versions WHERE repo_id = $1 AND env_version_id = $2`,
    [repoId, envVersionId],
  );
  return rows[0] ?? null;
}

export interface NewEnvBuild {
  envVersionId: string;
  /** Only `running` opens a build; a finished one is written by `finishEnvBuild`. */
  status: 'running';
  budget: EnvBuildBudget;
}

/** Opens a build row. The budget is required and fixed for the row's life. */
export async function startEnvBuild(client: PoolClient, input: NewEnvBuild): Promise<EnvBuildRow> {
  if (!ENV_VERSION_ID.test(input.envVersionId)) throw new EnvInputError('env_bad_version_id');
  if (!ENV_BUILD_BUDGETS.includes(input.budget)) throw new EnvInputError('env_bad_budget');
  if (input.status !== 'running') throw new EnvInputError('env_bad_status');
  const { rows } = await client.query<EnvBuildRow>(
    `INSERT INTO env_builds (account_id, env_version_id, status, budget)
     VALUES (NULLIF(current_setting('app.account_id', true), '')::uuid, $1, $2, $3)
     RETURNING *`,
    [input.envVersionId, input.status, input.budget],
  );
  return rows[0]!;
}

/**
 * Closes a build row with its outcome. A build closes once: the update is limited to rows with no `finished_at`, so a
 * second finish changes nothing and returns null, exactly as a row outside this account does. The caller treats null
 * as "nothing to do" (a no-op, not an error): the first finish already recorded the outcome.
 */
export async function finishEnvBuild(client: PoolClient, buildId: string,
  outcome: { status: Exclude<EnvBuildStatus, 'running'>; failingStep?: string | null; logRef?: string | null; costUsd: number },
): Promise<EnvBuildRow | null> {
  if (!ENV_BUILD_FINAL_STATUSES.includes(outcome.status)) throw new EnvInputError('env_bad_status');
  const { rows } = await client.query<EnvBuildRow>(
    `UPDATE env_builds
        SET status = $2, failing_step = $3, log_ref = $4, cost_usd = $5, finished_at = now()
      WHERE id = $1 AND finished_at IS NULL
      RETURNING *`,
    [buildId, outcome.status, outcome.failingStep ?? null, outcome.logRef ?? null, outcome.costUsd],
  );
  return rows[0] ?? null;
}

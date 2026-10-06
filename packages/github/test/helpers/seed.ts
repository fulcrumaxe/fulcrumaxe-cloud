import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

export interface SeedRefs {
  accountId: string;
  installationId: string;
  ghInstallationId: number;
  repoId: string;
  ghRepoId: number;
  repoFullName: string;
  defaultBranch: string;
}

/**
 * Local copy of the db/core/billing pattern (each package keeps its own,
 * see packages/billing/test/helpers/seed.ts's header) -- inserts an
 * account, an installation and a repo through the superuser/admin
 * connection (RLS does not apply), returning the ids H13a's own tests
 * seed work_items against.
 */
export async function seedAccountWithRepo(
  admin: PoolClient,
  ghInstallationId: number,
  appKind: 'team' | 'team_readonly' | 'sitekit' = 'team',
): Promise<SeedRefs> {
  const accountId = randomUUID();
  const installationId = randomUUID();
  const repoId = randomUUID();
  const ghRepoId = 9001;
  const repoFullName = 'acme-corp/widgets';
  const defaultBranch = 'main';

  await admin.query(
    `INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`,
    [accountId, `cus_test_${accountId}`],
  );
  await admin.query(
    `INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, $4)`,
    [installationId, accountId, ghInstallationId, appKind],
  );
  await admin.query(
    `INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, $4, 'team')`,
    [repoId, accountId, installationId, ghRepoId],
  );

  return { accountId, installationId, ghInstallationId, repoId, ghRepoId, repoFullName, defaultBranch };
}

/** D#2 H13c: sets a repo's GitHub owner/name directly (bypassing the
 * installation-webhook writer path), for tests that need a resolvable
 * repo without exercising eventMapper.ts's own writer. */
export async function setRepoGithubNames(
  admin: PoolClient,
  repoId: string,
  owner: string | null,
  name: string | null,
): Promise<void> {
  await admin.query(`UPDATE repos SET gh_owner = $1, gh_name = $2 WHERE id = $3`, [owner, name, repoId]);
}

/** D#2 H13c: seeds an agent_runs row directly, for runResolver.pg.test.ts's
 * own allow/deny fixtures. `dispatchRepoId` has no FK (0605) -- passing a
 * random uuid that names no repos row is exactly the "deleted repo" deny
 * fixture. */
export async function seedAgentRun(
  admin: PoolClient,
  accountId: string,
  opts: { sandboxName: string; role?: string; status?: string; dispatchRepoId?: string | null },
): Promise<string> {
  const runId = randomUUID();
  await admin.query(
    `INSERT INTO agent_runs (id, account_id, role, runtime, status, sandbox_name, dispatch_repo_id)
     VALUES ($1, $2, $3, 'production', $4, $5, $6)`,
    [runId, accountId, opts.role ?? 'executor', opts.status ?? 'running', opts.sandboxName, opts.dispatchRepoId ?? null],
  );
  return runId;
}

/** Seeds a work_items row directly (bypassing H13a's own INSERT path) at a
 * given stage, for tests that need a PRE-EXISTING item for a
 * pull_request event to transition -- mirrors D#45's own
 * record-stage.test.ts pattern. */
export async function seedWorkItem(
  admin: PoolClient,
  accountId: string,
  repoId: string,
  opts: { ghNumber: number; kind?: string; provenance?: 'internal' | 'external'; stage?: string },
): Promise<string> {
  const workItemId = randomUUID();
  await admin.query(
    `INSERT INTO work_items (id, account_id, repo_id, kind, gh_number, provenance, stage)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      workItemId,
      accountId,
      repoId,
      opts.kind ?? 'issue',
      opts.ghNumber,
      opts.provenance ?? 'internal',
      opts.stage ?? 'in_progress',
    ],
  );
  return workItemId;
}

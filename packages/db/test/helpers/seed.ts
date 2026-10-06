import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

/**
 * Every table that carries `account_id` and is scoped by the standard
 * `tenant_isolation` policy -- i.e. every tenant table except `accounts`
 * (keyed on `id`), `users` (global, membership-scoped -- see
 * migrations/0001_core.sql) and `partners` (platform-wide).
 */
export const TENANT_TABLES = [
  'model_connections',
  'account_members',
  'invitations',
  'installations',
  'repos',
  'role_settings',
  'work_items',
  'agent_runs',
  'run_events',
  'spend_reservations',
  'ledger',
  'audit_log',
] as const;

export type TenantTable = (typeof TENANT_TABLES)[number];

export interface SeedRefs {
  accountId: string;
  userId: string;
  installationId: string;
  repoId: string;
  workItemId: string;
  runId: string;
}

function freshRefs(accountId: string): SeedRefs {
  return {
    accountId,
    userId: randomUUID(),
    installationId: randomUUID(),
    repoId: randomUUID(),
    workItemId: randomUUID(),
    runId: randomUUID(),
  };
}

type RowBuilder = (
  accountId: string,
  refs: SeedRefs,
  ownIdentity?: string | number,
) => { sql: string; params: unknown[] };

/**
 * One INSERT builder per tenant table, each producing a row that is valid
 * (satisfies every FK/NOT NULL/CHECK constraint) for the given `accountId`,
 * chaining through `refs` for foreign keys. Shared by `seedAccount` (which
 * inserts a full, committed baseline row per tenant, using the DEFAULT
 * `ownIdentity`) and the cross-tenant/soft-delete write-rejection tests
 * (which reuse the SAME builders, via `freshOwnIdentityFor()` below, to
 * attempt inserting a row that's valid EXCEPT for the one thing under
 * test).
 *
 * `ownIdentity` exists because several tables have a second uniqueness
 * constraint (a PK reused from `refs`, or a UNIQUE pair) besides the
 * account_id/RLS check the write-rejection tests actually want to isolate.
 * Security fix round 5 suggestion 4 caught this concretely: without a
 * fresh identity, re-attempting `refs`'s OWN already-seeded row collides
 * on that constraint FIRST, so a test asserting "rejected" could pass for
 * a UNIQUE-violation reason having nothing to do with the RLS/account_id
 * check it claims to prove. Each builder defaults `ownIdentity` to the
 * refs-derived value it always used (so `seedAccount` is unaffected) and
 * substitutes it in for exactly the column that's actually reused from
 * `refs` for identity purposes, not for a foreign-key reference to another
 * table (FK columns always stay refs-derived -- they need to point at a
 * REAL existing row, which is exactly what `refs` gives them).
 *
 * `users` is not here: it's global, seeded separately by `seedAccount`
 * before this table's inserts run, and is never itself account-scoped.
 */
const ROW_BUILDERS: Record<TenantTable, RowBuilder> = {
  model_connections: (accountId) => ({
    sql: `INSERT INTO model_connections
            (account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint)
          VALUES ($1, 'ai_gateway', $2, $3, $4, 1, $5)`,
    params: [
      accountId,
      Buffer.from('ciphertext'),
      Buffer.from('nonce'),
      Buffer.from('wrapped'),
      `fp-${randomUUID()}`,
    ],
  }),
  // ownIdentity here is a REAL, different user id (never a fresh random
  // uuid -- that would just trade a UNIQUE violation for a FOREIGN KEY
  // one, equally the wrong reason to reject). See freshOwnIdentityFor().
  account_members: (accountId, refs, ownIdentity = refs.userId) => ({
    sql: `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`,
    params: [accountId, ownIdentity],
  }),
  invitations: (accountId, refs) => ({
    sql: `INSERT INTO invitations (account_id, email, role, token_hash, invited_by, expires_at)
          VALUES ($1, $2, 'member', $3, $4, now() + interval '7 days')`,
    params: [accountId, `invite-${randomUUID()}@example.test`, `hash-${randomUUID()}`, refs.userId],
  }),
  installations: (accountId, refs, ownIdentity = refs.installationId) => ({
    sql: `INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, floor(random() * 2000000000)::bigint + 1, 'team')`,
    params: [ownIdentity, accountId],
  }),
  repos: (accountId, refs, ownIdentity = refs.repoId) => ({
    sql: `INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product)
          VALUES ($1, $2, $3, 1, 'team')`,
    params: [ownIdentity, accountId, refs.installationId],
  }),
  role_settings: (accountId, refs, ownIdentity = 'executor') => ({
    sql: `INSERT INTO role_settings (account_id, repo_id, role, mode) VALUES ($1, $2, $3, 'always')`,
    params: [accountId, refs.repoId, ownIdentity],
  }),
  work_items: (accountId, refs, ownIdentity = refs.workItemId) => ({
    sql: `INSERT INTO work_items (id, account_id, repo_id, kind, provenance)
          VALUES ($1, $2, $3, 'feature', 'internal')`,
    params: [ownIdentity, accountId, refs.repoId],
  }),
  agent_runs: (accountId, refs, ownIdentity = refs.runId) => ({
    sql: `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status)
          VALUES ($1, $2, $3, 'executor', 'local', 'running')`,
    params: [ownIdentity, accountId, refs.workItemId],
  }),
  run_events: (accountId, refs, ownIdentity = 1) => ({
    sql: `INSERT INTO run_events (account_id, run_id, seq, kind) VALUES ($1, $2, $3, 'start')`,
    params: [accountId, refs.runId, ownIdentity],
  }),
  spend_reservations: (accountId, refs) => ({
    sql: `INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state)
          VALUES ($1, $2, 1.00, 'open')`,
    params: [accountId, refs.runId],
  }),
  ledger: (accountId, refs) => ({
    sql: `INSERT INTO ledger (account_id, kind, source, usd, run_id)
          VALUES ($1, 'compute', 'sandbox', 0.10, $2)`,
    params: [accountId, refs.runId],
  }),
  audit_log: (accountId) => ({
    sql: `INSERT INTO audit_log (account_id, action) VALUES ($1, 'seed')`,
    params: [accountId],
  }),
};

/** Attempts one INSERT into `table` shaped for `accountId`/`refs`, using the shared builder above. */
export async function insertRowForAccount(
  client: PoolClient,
  table: TenantTable,
  accountId: string,
  refs: SeedRefs,
  ownIdentity?: string | number,
): Promise<void> {
  const { sql, params } = ROW_BUILDERS[table](accountId, refs, ownIdentity);
  await client.query(sql, params);
}

/**
 * A write-rejection test wants a row that's valid in every way EXCEPT the
 * one thing it's actually testing (a wrong account_id, or a soft-deleted
 * one) -- reusing `refs`'s own already-seeded identity for `table`
 * otherwise collides on a UNIQUE/PK constraint before RLS is ever
 * evaluated (security fix round 5 suggestion 4). This returns a fresh,
 * non-colliding value for exactly the column each builder above treats as
 * `ownIdentity`, given a `spareUserId` -- a REAL user id, different from
 * `refs.userId`, for the one table (`account_members`) where a random
 * uuid won't do because the column is foreign-keyed to `users(id)`.
 */
export function freshOwnIdentityFor(
  table: TenantTable,
  spareUserId: string,
): string | number | undefined {
  switch (table) {
    case 'account_members':
      return spareUserId;
    case 'role_settings':
      return `role-${randomUUID()}`;
    case 'run_events':
      return Math.floor(Math.random() * 1_000_000_000) + 1;
    case 'installations':
    case 'repos':
    case 'work_items':
    case 'agent_runs':
      return randomUUID();
    default:
      // model_connections, invitations, spend_reservations, ledger,
      // audit_log: no second uniqueness constraint reused from refs, so
      // the default (refs-derived, or none) is already collision-free.
      return undefined;
  }
}

/** Dependency order: a row must exist before anything that references it by id. */
const SEED_ORDER: TenantTable[] = [
  'account_members',
  'invitations',
  'installations',
  'repos',
  'role_settings',
  'work_items',
  'agent_runs',
  'run_events',
  'spend_reservations',
  'ledger',
  'audit_log',
  'model_connections',
];

/**
 * Inserts `accounts`, a global `users` row, plus one full, FK-consistent
 * row per tenant table for a fresh account, using an admin/superuser
 * client. RLS does not apply to a superuser regardless of FORCE ROW LEVEL
 * SECURITY, so no `app.account_id` needs to be set here -- this is the
 * seeding path, not the isolation check itself.
 */
export async function seedAccount(admin: PoolClient, accountId: string): Promise<SeedRefs> {
  // D#69 (migration 0606): `status` is derived from stripe_customer_id
  // (plus marker columns none of this package's tests set), not written
  // directly -- a `cus_test_<accountId>` value (unique per seeded
  // account, since migration 0606 also adds a live UNIQUE index on this
  // column) keeps every existing caller's implicit "this account is
  // active" assumption true without changing this function's signature.
  // The explicit `status = 'active'` literal (security review MUST-fix
  // 4, Spec A5): 0606's INSERT trigger check now rejects a row whose
  // status -- explicit or the column DEFAULT 'unsubscribed' -- disagrees
  // with what stripe_customer_id/the marker columns derive to; since this
  // INSERT sets a customer id and no markers, that derived value is
  // 'active', so the literal has to say so too.
  await admin.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [
    accountId,
    `cus_test_${accountId}`,
  ]);
  const refs = freshRefs(accountId);
  await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [
    refs.userId,
    `${refs.userId}@example.test`,
  ]);
  for (const table of SEED_ORDER) {
    await insertRowForAccount(admin, table, accountId, refs);
  }
  return refs;
}

/**
 * The confirmed CWE-639 cross-tenant-FK relations (D#2605 H02 security fix
 * round 2), each as one INSERT builder that takes the OWNING tenant's own
 * account id/refs plus a `foreignId` belonging to a DIFFERENT tenant, and
 * points exactly the FK column under test at that foreign id while every
 * other column stays valid for the owning tenant. Used by
 * test/cross-tenant-fk.test.ts to prove each composite FK rejects a
 * cross-tenant parent id.
 *
 * `account_members.user_id -> users(id)` and `invitations.invited_by ->
 * users(id)` are deliberately NOT here: users is global now, so naming
 * another tenant's real user id is not a cross-tenant FK bug on its own --
 * see the file header of migrations/0001_core.sql. (account_members'
 * INSERT is still gated, just not via a composite FK -- see
 * test/users-global.test.ts for the invitation-based fix.)
 */
export const CROSS_TENANT_FK_CASES = [
  {
    label: 'run_events.run_id -> agent_runs',
    foreignRef: (refs: SeedRefs) => refs.runId,
    insert: (accountId: string, _refs: SeedRefs, foreignId: string) => ({
      sql: `INSERT INTO run_events (account_id, run_id, seq, kind) VALUES ($1, $2, 999, 'probe')`,
      params: [accountId, foreignId],
    }),
  },
  {
    label: 'spend_reservations.run_id -> agent_runs',
    foreignRef: (refs: SeedRefs) => refs.runId,
    insert: (accountId: string, _refs: SeedRefs, foreignId: string) => ({
      sql: `INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state)
            VALUES ($1, $2, 1.00, 'open')`,
      params: [accountId, foreignId],
    }),
  },
  {
    label: 'ledger.run_id -> agent_runs',
    foreignRef: (refs: SeedRefs) => refs.runId,
    insert: (accountId: string, _refs: SeedRefs, foreignId: string) => ({
      sql: `INSERT INTO ledger (account_id, kind, source, usd, run_id)
            VALUES ($1, 'compute', 'sandbox', 0.10, $2)`,
      params: [accountId, foreignId],
    }),
  },
  {
    label: 'agent_runs.parent_run_id -> agent_runs (self)',
    foreignRef: (refs: SeedRefs) => refs.runId,
    insert: (accountId: string, refs: SeedRefs, foreignId: string) => ({
      sql: `INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, parent_run_id)
            VALUES ($1, $2, 'executor', 'local', 'running', $3)`,
      params: [accountId, refs.workItemId, foreignId],
    }),
  },
  {
    label: 'agent_runs.work_item_id -> work_items',
    foreignRef: (refs: SeedRefs) => refs.workItemId,
    insert: (accountId: string, _refs: SeedRefs, foreignId: string) => ({
      sql: `INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status)
            VALUES ($1, $2, 'executor', 'local', 'running')`,
      params: [accountId, foreignId],
    }),
  },
  {
    label: 'role_settings.repo_id -> repos',
    foreignRef: (refs: SeedRefs) => refs.repoId,
    insert: (accountId: string, _refs: SeedRefs, foreignId: string) => ({
      sql: `INSERT INTO role_settings (account_id, repo_id, role, mode) VALUES ($1, $2, 'code-reviewer', 'always')`,
      params: [accountId, foreignId],
    }),
  },
  {
    label: 'repos.installation_id -> installations',
    foreignRef: (refs: SeedRefs) => refs.installationId,
    insert: (accountId: string, _refs: SeedRefs, foreignId: string) => ({
      sql: `INSERT INTO repos (account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, 2, 'team')`,
      params: [accountId, foreignId],
    }),
  },
  {
    label: 'work_items.repo_id -> repos',
    foreignRef: (refs: SeedRefs) => refs.repoId,
    insert: (accountId: string, _refs: SeedRefs, foreignId: string) => ({
      sql: `INSERT INTO work_items (account_id, repo_id, kind, provenance) VALUES ($1, $2, 'bug', 'internal')`,
      params: [accountId, foreignId],
    }),
  },
] as const;

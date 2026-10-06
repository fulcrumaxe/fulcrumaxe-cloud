import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { withPartner } from '../src/withPartner.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/**
 * Migration 0693: the stored run prompt (run_events kind 'run.input') is
 * hidden at the database. partner_user (under a support grant) and
 * platform_ops-owned definers lose it; app_user keeps it (the retry path).
 */
describe('migration 0693: run.input is hidden at the database', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let partnerUserPool: Pool;
  let runWriterPool: Pool;

  let partnerId: string;
  let refs: SeedRefs;
  let seq = 1000;

  const PROMPT = 'the retained start prompt';
  const META = { model: 'haiku-4.5', escalated_from_model: null };

  const addEvent = (accountId: string, runId: string, kind: string, payload: unknown) =>
    admin.query(
      `INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, $3, $4, $5)`,
      [accountId, runId, seq++, kind, JSON.stringify(payload)],
    );

  const addRun = async (accountId: string, workItemId: string, status: string): Promise<string> => {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status)
       VALUES ($1, $2, $3, 'executor', 'local', $4)`,
      [id, accountId, workItemId, status],
    );
    return id;
  };

  /** Reads `sql` as platform_ops with app.account_id set; the session user stays the admin, so the policy applies. */
  const asPlatformOps = async <T extends Record<string, unknown>>(accountId: string, sql: string): Promise<T[]> => {
    await admin.query('BEGIN');
    try {
      await admin.query('SET LOCAL ROLE platform_ops');
      await admin.query(`SELECT set_config('app.account_id', $1, true)`, [accountId]);
      return (await admin.query<T>(sql)).rows;
    } finally {
      await admin.query('ROLLBACK');
    }
  };

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    partnerUserPool = createPool(process.env.DATABASE_URL_PARTNER_USER!);
    runWriterPool = createPool(process.env.DATABASE_URL_RUN_WRITER!);

    partnerId = randomUUID();
    await admin.query(`INSERT INTO partners (id, kind, status, name) VALUES ($1, 'reseller', 'active', 'Support')`, [partnerId]);
    refs = await seedAccount(admin, randomUUID());
    await admin.query('UPDATE accounts SET partner_id = $1 WHERE id = $2', [partnerId, refs.accountId]);
    await addEvent(refs.accountId, refs.runId, 'run.input', { prompt: PROMPT, meta: META });
    await addEvent(refs.accountId, refs.runId, 'run.status_changed', { to: 'running' });
    await addEvent(refs.accountId, refs.runId, 'agent.output', { text: 'hello' });
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await partnerUserPool.end();
    await runWriterPool.end();
  });

  const partnerKinds = (accountId: string): Promise<string[]> =>
    withPartner(partnerUserPool, partnerId, async (client) =>
      (await client.query<{ kind: string }>('SELECT kind FROM run_events WHERE account_id = $1 ORDER BY kind', [accountId])).rows.map((r) => r.kind),
    );

  describe('1 and 2: partner_user under a support grant', () => {
    it('with no grant, an expired grant and a revoked grant, the partner reads nothing of any kind', async () => {
      expect(await partnerKinds(refs.accountId)).toEqual([]);
      await admin.query(
        `INSERT INTO support_grants (id, account_id, grantee_kind, grantee_partner_id, granted_by_user_id, created_at, expires_at)
         VALUES ($1, $2, 'partner', $3, $4, now() - interval '2 hours', now() - interval '1 hour')`,
        [randomUUID(), refs.accountId, partnerId, refs.userId],
      );
      expect(await partnerKinds(refs.accountId)).toEqual([]);
      await admin.query(
        `INSERT INTO support_grants (id, account_id, grantee_kind, grantee_partner_id, granted_by_user_id, expires_at, revoked_at)
         VALUES ($1, $2, 'partner', $3, $4, now() + interval '60 minutes', now())`,
        [randomUUID(), refs.accountId, partnerId, refs.userId],
      );
      expect(await partnerKinds(refs.accountId)).toEqual([]);
    });

    it('with an active grant, the partner reads every kind except run.input, and a count of run.input is 0', async () => {
      await admin.query(
        `INSERT INTO support_grants (id, account_id, grantee_kind, grantee_partner_id, granted_by_user_id, expires_at)
         VALUES ($1, $2, 'partner', $3, $4, now() + interval '60 minutes')`,
        [randomUUID(), refs.accountId, partnerId, refs.userId],
      );
      const kinds = await partnerKinds(refs.accountId);
      expect(kinds).toContain('run.status_changed');
      expect(kinds).toContain('agent.output');
      expect(kinds).not.toContain('run.input');
      const count = await withPartner(partnerUserPool, partnerId, async (client) =>
        (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM run_events WHERE account_id = $1 AND kind = 'run.input'`, [refs.accountId])).rows[0]!.n,
      );
      expect(count).toBe(0);
    });
  });

  describe('3: a platform_ops-owned definer reads one kind only', () => {
    it('reads run.status_changed, and no run.input and no agent.output', async () => {
      const rows = await asPlatformOps<{ kind: string }>(refs.accountId, `SELECT kind FROM run_events WHERE account_id = '${refs.accountId}'`);
      const kinds = new Set(rows.map((r) => r.kind));
      expect(kinds.has('run.status_changed')).toBe(true);
      expect(kinds.has('run.input')).toBe(false);
      expect(kinds.has('agent.output')).toBe(false);
      expect([...kinds]).toEqual(['run.status_changed']);
    });
  });

  describe('4: agent_run_release_idempotency_key still sees run.status_changed', () => {
    const release = (accountId: string, key: string): Promise<boolean> =>
      withTenant(runWriterPool, accountId, async (client) =>
        (await client.query<{ released: boolean }>(`SELECT agent_run_release_idempotency_key($1::uuid, $2::text) AS released`, [accountId, key])).rows[0]!.released,
      );
    const claim = (accountId: string, runId: string, key: string) =>
      admin.query(
        `INSERT INTO agent_run_idempotency_keys (account_id, idempotency_key, run_id, request_hash) VALUES ($1, $2, $3, $4)`,
        [accountId, key, runId, '0'.repeat(64)],
      );

    it('a terminal run that once held running is not released; one that never ran is', async () => {
      const ran = await addRun(refs.accountId, refs.workItemId, 'failed');
      await addEvent(refs.accountId, ran, 'run.status_changed', { to: 'running' });
      await addEvent(refs.accountId, ran, 'run.input', { prompt: PROMPT, meta: META });
      await claim(refs.accountId, ran, 'ran-key');
      const never = await addRun(refs.accountId, refs.workItemId, 'refused_spend');
      await addEvent(refs.accountId, never, 'run.status_changed', { to: 'refused_spend' });
      await claim(refs.accountId, never, 'never-key');

      expect(await release(refs.accountId, 'ran-key')).toBe(false);
      expect(await release(refs.accountId, 'never-key')).toBe(true);
    });
  });

  describe('5: app_user (the retry path) still reads run.input under its own tenant', () => {
    it('reads the prompt and the meta', async () => {
      const row = await withTenant(appUserPool, refs.accountId, async (client) =>
        (
          await client.query<{ prompt: string; meta: unknown }>(
            `SELECT payload->>'prompt' AS prompt, payload->'meta' AS meta FROM run_events WHERE run_id = $1 AND kind = 'run.input' ORDER BY seq LIMIT 1`,
            [refs.runId],
          )
        ).rows[0],
      );
      expect(row).toEqual({ prompt: PROMPT, meta: META });
    });
  });

  describe('6: the catalogue carries the kind predicate', () => {
    it('both policies mention their kind, so a later re-creation without it goes red', async () => {
      const { rows } = await admin.query<{ policyname: string; qual: string }>(
        `SELECT policyname, qual FROM pg_policies WHERE tablename = 'run_events' AND policyname IN ('partner_support_grant_read', 'platform_ops_claim_release_probe')`,
      );
      const qual = Object.fromEntries(rows.map((r) => [r.policyname, r.qual]));
      expect(qual['partner_support_grant_read']).toMatch(/kind <> 'run\.input'/);
      expect(qual['platform_ops_claim_release_probe']).toMatch(/kind = 'run\.status_changed'/);
    });
  });
});

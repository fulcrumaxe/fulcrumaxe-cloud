import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { claimTwinWork, listTwinParityDue, listTwinWork, recordTwinParity, type TwinParityRecord } from '../../src/repos/twinWork.js';
import { withTenant } from '../../src/tenancy/withTenant.js';

/**
 * [pg] D#845 ON-27d4a: the TypeScript calls of the twin sweep, as the real roles: the two lists on the run-writer login, the claim and the result under the twin's own tenant. The rules themselves (who may call, which state, the lease,
 * the anchor) are pinned in packages/db/test/twin-work.pg.test.ts; this pins that the calls carry them through.
 */
const SWEEP_LOGIN = 'fx_twin_sweep_test';
const SHA = (c: string): string => c.repeat(40);
const RESULT: TwinParityRecord = { result: 'in_parity', privateSha: SHA('a'), publicSha: SHA('b'), paths: [], pathCount: 0, publishCount: 0, syncCount: 0, conflictCount: 0, advanceSyncedTo: null };

describe('twin sweep calls [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let writer: Pool;
  let A: SeedRefs;

  const twinFor = async (state: string, result: string | null, due: string | null) => {
    const tag = randomUUID().slice(0, 8);
    const repo = async (name: string): Promise<string> => {
      const id = randomUUID();
      await admin.query('INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, $4, $5, $6, $7)', [id, A.accountId, A.installationId, Math.floor(Math.random() * 1e9) + 10, 'team', 'acme', name]);
      return id;
    };
    const pub = await repo(`pub-${tag}`);
    const priv = await repo(`priv-${tag}`);
    const r = await withTenant(appPool, A.accountId, A.userId, async (c) => (await c.query<{ o_id: string }>('SELECT o_id FROM twin_record($1, $2, 777, $3)', [pub, priv, `priv-${tag}`])).rows[0]!);
    await admin.query('UPDATE repo_twins SET state = $2, published_private_sha = $3, synced_public_sha = $4 WHERE id = $1', [r.o_id, state, state === 'seeding' ? null : SHA('c'), state === 'seeding' ? null : SHA('d')]);
    if (result !== null || due !== null) await admin.query(`INSERT INTO twin_parity_checks (twin_id, account_id, last_result, due_at) VALUES ($1, $2, $3, ${due ?? 'NULL'})`, [r.o_id, A.accountId, result]);
    return r.o_id;
  };
  const tenant = <T>(fn: (c: PoolClient) => Promise<T>) => withTenant(appPool, A.accountId, fn);

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    await admin.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${SWEEP_LOGIN}') THEN
          CREATE ROLE ${SWEEP_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
      END $$`);
    await admin.query(`GRANT app_user, agent_run_writer TO ${SWEEP_LOGIN}`);
    const u = new URL(process.env.DATABASE_URL_APP_USER!);
    u.username = SWEEP_LOGIN;
    u.password = '';
    writer = createPool(u.toString());
    A = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appPool.end();
    await writer.end();
  });

  it('lists a seeding twin and a twin with something to publish as work, and a twin with a due time as a parity check', async () => {
    const seeding = await twinFor('seeding', null, null);
    const publish = await twinFor('ready', 'publish_pending', null);
    const due = await twinFor('ready', 'in_parity', "now() - interval '1 second'");
    const work = await listTwinWork(writer, 200);
    expect(work.find((w) => w.twinId === seeding)).toEqual({ accountId: A.accountId, twinId: seeding, kind: 'seed' });
    expect(work.find((w) => w.twinId === publish)).toMatchObject({ kind: 'publish' });
    expect(work.some((w) => w.twinId === due)).toBe(false);
    const parity = await listTwinParityDue(writer, 200);
    expect(parity.find((p) => p.twinId === due)).toMatchObject({ accountId: A.accountId, dueNow: true });
    expect(parity.some((p) => p.twinId === seeding || p.twinId === publish)).toBe(false);
  });

  it('claims the work once under its lease, and a parity check once with its mark and anchor', async () => {
    const publish = await twinFor('ready', 'publish_pending', null);
    expect(await tenant((c) => claimTwinWork(c, publish, 'publish'))).toMatchObject({ result: 'ok' });
    expect(await tenant((c) => claimTwinWork(c, publish, 'publish'))).toEqual({ result: 'leased' });
    expect((await listTwinWork(writer, 200)).some((w) => w.twinId === publish)).toBe(false);
    const due = await twinFor('ready', 'in_parity', "now() - interval '1 second'");
    expect(await tenant((c) => claimTwinWork(c, due, 'parity'))).toEqual({ result: 'ok', markSeq: 0, anchor: SHA('d') });
    expect(await tenant((c) => claimTwinWork(c, due, 'parity'))).toEqual({ result: 'not_due' });
  });

  it('stores a result computed from the current anchor, and drops and logs one whose anchor has moved', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const id = await twinFor('ready', 'in_parity', "now() - interval '1 second'");
      const claim = await tenant((c) => claimTwinWork(c, id, 'parity'));
      if (claim.result !== 'ok' || claim.anchor === null) throw new Error('claim');
      await admin.query('UPDATE repo_twins SET synced_public_sha = $2 WHERE id = $1', [id, SHA('e')]);
      expect(await tenant((c) => recordTwinParity(c, id, { markSeq: claim.markSeq, anchor: claim.anchor! }, { ...RESULT, result: 'publish_pending', paths: ['src/a.ts'], pathCount: 1, publishCount: 1 }))).toBe('stale');
      expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'twin.parity_result_dropped', code: 'anchor_moved', twin_id: id }));
      expect((await admin.query('SELECT last_result FROM twin_parity_checks WHERE twin_id = $1', [id])).rows[0].last_result).toBe('in_parity');
      expect(await tenant((c) => recordTwinParity(c, id, { markSeq: claim.markSeq, anchor: SHA('e') }, { ...RESULT, result: 'publish_pending', paths: ['src/a.ts'], pathCount: 1, publishCount: 1 }))).toBe('ok');
      expect((await admin.query('SELECT last_result, paths FROM twin_parity_checks WHERE twin_id = $1', [id])).rows[0]).toMatchObject({ last_result: 'publish_pending', paths: ['src/a.ts'] });
    } finally {
      warn.mockRestore();
    }
  });
});

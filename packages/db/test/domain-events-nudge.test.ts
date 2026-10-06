import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client, type Pool, type PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { NUDGE_CHANNEL, NUDGE_EVENT_TYPES } from '../../api/src/sse/nudge.js';

/**
 * D#31 API-5d criterion 1: the migration-0652 trigger on domain_events. It notifies on commit, with the
 * account id as the whole payload, and only for the three auth-related event types.
 */
describe('domain_events nudge trigger (migration 0652)', () => {
  let admin: Pool;
  let ops: Pool;
  let app: Pool;
  let listener: Client;
  let received: string[] = [];

  beforeAll(async () => {
    admin = createPool(process.env.DATABASE_URL!);
    ops = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    app = createPool(process.env.DATABASE_URL_APP_USER!);
    listener = new Client({ connectionString: process.env.DATABASE_URL! });
    await listener.connect();
    listener.on('notification', (m) => {
      if (m.channel === NUDGE_CHANNEL && m.payload !== undefined) received.push(m.payload);
    });
    await listener.query(`LISTEN ${NUDGE_CHANNEL}`);
  });
  afterEach(() => {
    received = [];
  });
  afterAll(async () => {
    await listener.end();
    await admin.end();
    await ops.end();
    await app.end();
  });

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150));

  async function account(): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [id, `cus_${id}`]);
    return id;
  }

  const insertEvent = (c: Pool | PoolClient, accountId: string, type: string) =>
    c.query(`INSERT INTO domain_events (account_id, type, payload) VALUES ($1, $2, '{}'::jsonb)`, [accountId, type]);

  it.each(NUDGE_EVENT_TYPES)('%s notifies a listening connection once, with the account id only, after commit', async (type) => {
    const accountId = await account();
    const c = await ops.connect();
    try {
      await c.query('BEGIN');
      await insertEvent(c, accountId, type);
      await settle();
      expect(received).toEqual([]); // nothing before COMMIT
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    await settle();
    expect(received).toEqual([accountId]);
  });

  it('other event types notify nothing', async () => {
    const accountId = await account();
    await insertEvent(admin, accountId, 'pr.opened');
    await insertEvent(admin, accountId, 'run.status_changed');
    await settle();
    expect(received).toEqual([]);
  });

  it('a rolled-back INSERT notifies nothing', async () => {
    const accountId = await account();
    const c = await ops.connect();
    try {
      await c.query('BEGIN');
      await insertEvent(c, accountId, 'session.revoked');
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    await settle();
    expect(received).toEqual([]);
  });

  it('revoking 5 tokens in one transaction delivers at most one notification for the account', async () => {
    const accountId = await account();
    const c = await ops.connect();
    try {
      await c.query('BEGIN');
      for (let i = 0; i < 5; i++) await insertEvent(c, accountId, 'api_token.revoked');
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    await settle();
    expect(received).toEqual([accountId]);
  });

  it('a sign-out-everywhere by a user in 2 accounts delivers one notification per account', async () => {
    const [a, b] = [await account(), await account()];
    const userId = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
    for (const acc of [a, b]) await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [acc, userId]);
    // The same statement bumpSessionEpoch runs, as platform_ops, in one transaction.
    const c = await ops.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO domain_events (account_id, type, subject_id, payload)
         SELECT account_id, 'session.revoked', user_id::text, '{}'::jsonb FROM account_members WHERE user_id = $1`,
        [userId],
      );
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    await settle();
    expect([...received].sort()).toEqual([a, b].sort());
  });

  it('works for app_user inside its own tenant scope too (the trigger needs no extra privilege)', async () => {
    const accountId = await account();
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.account_id', $1, true)`, [accountId]);
      await insertEvent(c, accountId, 'api_token.created');
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    await settle();
    expect(received).toEqual([accountId]);
  });

  it('parity: NUDGE_EVENT_TYPES equals the trigger WHEN list, and the function is invoker-rights with a pinned search_path', async () => {
    const { rows } = await admin.query<{ def: string }>(`SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgname = 'domain_events_nudge' AND NOT tgisinternal`);
    expect(rows).toHaveLength(1);
    const when = rows[0]!.def.slice(rows[0]!.def.indexOf('WHEN'));
    const listed = [...when.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    expect([...listed].sort()).toEqual([...NUDGE_EVENT_TYPES].sort());
    expect(rows[0]!.def).toMatch(/AFTER INSERT ON (public\.)?domain_events FOR EACH ROW/);

    const fn = await admin.query<{ prosecdef: boolean; proconfig: string[] }>(`SELECT prosecdef, proconfig FROM pg_proc WHERE proname = 'domain_events_nudge'`);
    expect(fn.rows).toHaveLength(1);
    expect(fn.rows[0]!.prosecdef).toBe(false);
    expect(fn.rows[0]!.proconfig).toEqual(['search_path=pg_catalog, pg_temp']);
  });

  it('domain_events keeps its columns', async () => {
    const { rows } = await admin.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'domain_events' ORDER BY ordinal_position`);
    expect(rows.map((r) => r.column_name)).toEqual(expect.arrayContaining(['seq', 'id', 'account_id', 'type', 'subject_id', 'payload', 'created_at', 'inserted_at']));
  });
});

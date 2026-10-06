import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#2605 H02 security fix round 8 (Team Lead decisions 1-3, following the
 * round-7 grants audit). Same class of bug as round 7's ledger/audit_log
 * fix: app_user held full CRUD on three more tables that either record
 * what an agent did (agent_runs, same reasoning as ledger/audit_log --
 * billing disputes and audit) or describe their own lifecycle as
 * UPDATE-driven state transitions with no legitimate removal
 * (spend_reservations: settled or released, never deleted -- a deletable
 * reservation is a way to escape a spend cap; run_events: an append-only
 * event stream H11 streams live, nothing rewrites or removes an event
 * after the fact).
 *
 * Each describe block seeds its OWN account rather than sharing one:
 * agent_runs' composite FK cascades to run_events AND spend_reservations
 * (ON DELETE CASCADE), so a DELETE that succeeds against agent_runs (as
 * it would with the grant this round removes) would silently destroy the
 * other two describe blocks' fixture rows for the SAME account, breaking
 * their tests for a reason that has nothing to do with their own grants.
 * Caught this directly while red-testing this file, not from the
 * reviewer.
 */
describe('agent_runs / run_events / spend_reservations privileges', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  // D#2 H09c (correction C37) REPLACES the old contract here. This block
  // used to assert "app_user can INSERT a new agent_runs row" and "app_user
  // can UPDATE its own agent_runs row (status/tokens/envelope as a run
  // progresses)" -- D#2605 H02 round 8's "keep UPDATE" decision. Those two
  // assertions are removed on purpose: the merge gate trusts these rows, so
  // app_user may no longer INSERT at all and may UPDATE pure metering
  // columns only. Every gate-relevant write now goes through the
  // agent_run_writer-only SECURITY DEFINER functions (0642).
  describe('agent_runs (H09c: no INSERT, metering-only UPDATE, no DELETE)', () => {
    let refs: SeedRefs;

    /** Pure metering columns app_user may still UPDATE (0642 documents
     * each one). Explicit, so widening it is a reviewed change to this
     * file. */
    const METERING_ALLOWLIST = ['tokens_in', 'tokens_out', 'usd'];

    /** Every column the merge gate (mergeGate.ts) reads or filters on, plus
     * the dispatch-identity columns C37 names. */
    const GATE_RELEVANT = [
      'id', 'account_id', 'work_item_id', 'role', 'runtime', 'head_sha', 'status', 'envelope',
      'created_at', 'spec_version_id', 'execution_mode', 'dispatch_repo_id', 'dispatch_pr_number',
    ];

    beforeAll(async () => {
      refs = await seedAccount(admin, randomUUID());
    });

    it('app_user can SELECT its own agent_runs rows', async () => {
      await withTenant(appUserPool, refs.accountId, async (client) => {
        const { rows } = await client.query('SELECT 1 FROM agent_runs WHERE account_id = $1', [
          refs.accountId,
        ]);
        expect(rows.length).toBeGreaterThan(0);
      });
    });

    it('the metering allowlist and the gate-relevant set do not overlap', () => {
      expect(METERING_ALLOWLIST.filter((c) => GATE_RELEVANT.includes(c))).toEqual([]);
    });

    it('app_user INSERT into agent_runs fails 42501', async () => {
      await expect(
        withTenant(appUserPool, refs.accountId, async (client) => {
          await client.query(
            `INSERT INTO agent_runs (account_id, role, runtime, status) VALUES ($1, 'code-reviewer', 'local', 'running')`,
            [refs.accountId],
          );
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('app_user UPDATE of EVERY agent_runs column outside the metering allowlist fails 42501 (column list read from information_schema)', async () => {
      const { rows } = await admin.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'agent_runs'`,
      );
      const columns = rows.map((r) => r.column_name);
      // Sanity: the query really sees the table, and every gate-relevant
      // column is one of them (a renamed column fails here rather than
      // passing vacuously).
      for (const c of GATE_RELEVANT) expect(columns).toContain(c);

      const denied = columns.filter((c) => !METERING_ALLOWLIST.includes(c));
      expect(denied.length).toBeGreaterThanOrEqual(GATE_RELEVANT.length);
      for (const column of denied) {
        // `SET col = col` writes the column without needing a legal value
        // for its type; the privilege check happens before any value is
        // looked at.
        await expect(
          withTenant(appUserPool, refs.accountId, async (client) => {
            await client.query(`UPDATE agent_runs SET "${column}" = "${column}" WHERE account_id = $1`, [
              refs.accountId,
            ]);
          }),
          `UPDATE of ${column}`,
        ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
    });

    it('app_user can still UPDATE each metering column (mid-run token/cost counters)', async () => {
      for (const column of METERING_ALLOWLIST) {
        await withTenant(appUserPool, refs.accountId, async (client) => {
          await expect(
            client.query(`UPDATE agent_runs SET "${column}" = 1 WHERE account_id = $1 AND id = $2`, [
              refs.accountId,
              refs.runId,
            ]),
            `UPDATE of ${column}`,
          ).resolves.toBeDefined();
        });
      }
    });

    it('app_user cannot DELETE its own agent_runs row', async () => {
      await expect(
        withTenant(appUserPool, refs.accountId, async (client) => {
          await client.query(`DELETE FROM agent_runs WHERE account_id = $1`, [refs.accountId]);
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });

      // Confirms the DELETE genuinely never happened.
      const { rows } = await admin.query('SELECT 1 FROM agent_runs WHERE account_id = $1', [
        refs.accountId,
      ]);
      expect(rows.length).toBeGreaterThan(0);
    });
  });

  describe('run_events (decision 2: SELECT and INSERT only)', () => {
    let refs: SeedRefs;

    beforeAll(async () => {
      refs = await seedAccount(admin, randomUUID());
    });

    it('app_user can SELECT its own run_events rows', async () => {
      await withTenant(appUserPool, refs.accountId, async (client) => {
        const { rows } = await client.query('SELECT 1 FROM run_events WHERE account_id = $1', [
          refs.accountId,
        ]);
        expect(rows.length).toBeGreaterThan(0);
      });
    });

    it('app_user can INSERT a new run_events row', async () => {
      await withTenant(appUserPool, refs.accountId, async (client) => {
        await expect(
          client.query(
            `INSERT INTO run_events (account_id, run_id, seq, kind) VALUES ($1, $2, 2, 'tick')`,
            [refs.accountId, refs.runId],
          ),
        ).resolves.toBeDefined();
      });
    });

    it('app_user cannot UPDATE its own run_events row', async () => {
      await expect(
        withTenant(appUserPool, refs.accountId, async (client) => {
          await client.query(`UPDATE run_events SET kind = 'rewritten' WHERE account_id = $1`, [
            refs.accountId,
          ]);
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('app_user cannot DELETE its own run_events row', async () => {
      await expect(
        withTenant(appUserPool, refs.accountId, async (client) => {
          await client.query(`DELETE FROM run_events WHERE account_id = $1`, [refs.accountId]);
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });

      // Confirms the DELETE genuinely never happened.
      const { rows } = await admin.query('SELECT 1 FROM run_events WHERE account_id = $1', [
        refs.accountId,
      ]);
      expect(rows.length).toBeGreaterThan(0);
    });
  });

  describe('spend_reservations (decision 3: keep UPDATE, drop DELETE)', () => {
    let refs: SeedRefs;

    beforeAll(async () => {
      refs = await seedAccount(admin, randomUUID());
    });

    it('app_user can SELECT its own spend_reservations rows', async () => {
      await withTenant(appUserPool, refs.accountId, async (client) => {
        const { rows } = await client.query(
          'SELECT 1 FROM spend_reservations WHERE account_id = $1',
          [refs.accountId],
        );
        expect(rows.length).toBeGreaterThan(0);
      });
    });

    it('app_user can INSERT a new spend_reservations row', async () => {
      await withTenant(appUserPool, refs.accountId, async (client) => {
        await expect(
          client.query(
            `INSERT INTO spend_reservations (account_id, usd_reserved, state) VALUES ($1, 5.00, 'open')`,
            [refs.accountId],
          ),
        ).resolves.toBeDefined();
      });
    });

    it('app_user can UPDATE its own spend_reservations row (settle/release is a state transition)', async () => {
      await withTenant(appUserPool, refs.accountId, async (client) => {
        await expect(
          client.query(
            `UPDATE spend_reservations SET state = 'settled' WHERE account_id = $1 AND state = 'open'`,
            [refs.accountId],
          ),
        ).resolves.toBeDefined();
      });
    });

    it('app_user cannot DELETE its own spend_reservations row (a deletable reservation would be a spend-cap escape)', async () => {
      await expect(
        withTenant(appUserPool, refs.accountId, async (client) => {
          await client.query(`DELETE FROM spend_reservations WHERE account_id = $1`, [
            refs.accountId,
          ]);
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });

      // Confirms the DELETE genuinely never happened.
      const { rows } = await admin.query(
        'SELECT 1 FROM spend_reservations WHERE account_id = $1',
        [refs.accountId],
      );
      expect(rows.length).toBeGreaterThan(0);
    });
  });
});

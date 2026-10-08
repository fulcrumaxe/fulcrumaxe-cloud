import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../src/pool.js';

/**
 * Outside-meter clock trigger (0752): the trigger function stays SECURITY INVOKER (a definer must be owned by platform_ops or a
 * NOLOGIN role, and definer work never lives in a trigger function), it has no PUBLIC execute, and it calls no helper function. EXECUTE is only checked at
 * CREATE TRIGGER, so removing it does not stop the trigger firing for the roles that write agent_runs.status.
 */
const TRIGGER_FN = 'public.agent_runs_outside_meter_start_clock()';

describe('outside-meter start-clock trigger: security mode and grants (0752)', () => {
  let admin: Pool;
  beforeAll(() => {
    admin = createPool(process.env.DATABASE_URL!);
  });
  afterAll(async () => {
    await admin.end();
  });

  const canExecute = async (role: string, fn: string): Promise<boolean> =>
    (await admin.query(`SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok`, [role, fn])).rows[0].ok;

  it('the trigger function is SECURITY INVOKER', async () => {
    const { rows } = await admin.query(`SELECT p.prosecdef FROM pg_proc p WHERE p.oid = $1::regprocedure`, [TRIGGER_FN]);
    expect(rows).toEqual([{ prosecdef: false }]);
  });

  it('no role can call the trigger function directly: PUBLIC and the writer roles have no EXECUTE', async () => {
    for (const role of ['public', 'app_user', 'agent_run_writer', 'platform_ops']) {
      expect(await canExecute(role, TRIGGER_FN), role).toBe(false);
    }
  });

  it('the start rule is written into the trigger and the finalize definer: no helper function is left that every role would need to execute', async () => {
    // The trigger runs as whichever role writes agent_runs, so a shared helper would have to be executable by PUBLIC, and the narrow
    // GitHub-proxy login pins exactly which functions it gets from PUBLIC (ghProxyNarrowLogin.pg.test.ts).
    const { rows } = await admin.query(`SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'outside_meter_clock%'`);
    expect(rows).toEqual([]);
  });

  it('the role that writes agent_runs.status still fires the trigger: it is attached and enabled, and that role has no EXECUTE on the function', async () => {
    // Status is written by the platform_ops-owned definer agent_run_set_status (its body runs as platform_ops); app_user has no
    // status grant. A BEFORE ROW trigger fires for the writer whether or not it can EXECUTE the trigger function.
    const priv = await admin.query(`SELECT has_column_privilege('platform_ops', 'public.agent_runs', 'status', 'UPDATE') AS ok`);
    expect(priv.rows[0].ok).toBe(true);
    expect(await canExecute('platform_ops', TRIGGER_FN)).toBe(false);
    const trg = await admin.query(
      `SELECT t.tgenabled FROM pg_trigger t WHERE t.tgrelid = 'public.agent_runs'::regclass AND t.tgname = 'agent_runs_zz_outside_meter_start_clock' AND t.tgfoid = $1::regprocedure`,
      [TRIGGER_FN],
    );
    expect(trg.rows).toHaveLength(1);
    expect(trg.rows[0].tgenabled).toBe('O');
  });
});

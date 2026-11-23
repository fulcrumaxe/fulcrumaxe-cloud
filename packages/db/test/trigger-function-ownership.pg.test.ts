import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../src/pool.js';

/**
 * Repo-wide guard (D#2 hardening, security review of #522/#523, CWE-284/693).
 *
 * A trigger whose job is to refuse direct writes by the platform_ops login is
 * useless if platform_ops OWNS the trigger function: the owner can
 * `DROP FUNCTION ... CASCADE` (which removes the triggers) and then write
 * directly. So after every migration, no function that a trigger calls may be
 * owned by platform_ops, or by any other role the table's own checks are
 * written to refuse. Every trigger function must be owned by the role that
 * owns the migrations (the owner of the schema's tables).
 *
 * ALLOWLIST: a function that genuinely has to be owned by another role goes
 * here with a reason. It is empty on purpose; an entry is a security decision
 * and needs the reviewer's sign-off. (SECURITY DEFINER work belongs in a platform_ops-owned helper that an
 * invoker trigger function calls, never in the trigger function itself.)
 */
const ALLOWLIST: ReadonlyArray<{ fn: string; owner: string; reason: string }> = [
  {
    fn: 'runner_provisioning_token_revoke_for_member()',
    owner: 'runner_provisioning_definer',
    reason:
      "0786 (D#605 FL-6): stamps a demoted or removed minter's unused provisioning tokens revoked. SECURITY DEFINER, owned by a NOLOGIN role nothing can become. 0720's invoker-plus-helper shape needs EXECUTE for platform_ops, which migration 0765's platform_ops diff test refuses for any later migration.",
  },
  {
    fn: 'runner_link_facts_drop_trigger()',
    owner: 'onboarding_ops',
    reason:
      "1062 (D#845 ON-2b): deletes a revoked runner's stored link address. SECURITY DEFINER, owned by the NOLOGIN role that holds the table's DELETE grant. It deletes only the row of the runner the trigger fired for. 0720's invoker-plus-helper shape needs EXECUTE for platform_ops and guard_definer, which the neon-shape exception check refuses.",
  },
  {
    fn: 'engine_operate_off_supersede()',
    owner: 'machine_jobs_owner',
    reason:
      "1066 (D#845 ON-13a0): the AFTER trigger on a switch of operate to off marks the account's issued, undelivered engine_session_start jobs superseded in the same transaction. It must write machine_jobs, which no writer of engine_bridge_settings can, so it is SECURITY DEFINER, owned by the NOLOGIN machine_jobs_owner (1053's owner of the machine job definers, which holds nothing but those functions' reads and writes). EXECUTE is app_user's alone and a call outside a trigger only raises. 0720's invoker-plus-helper shape would make a directly callable helper that supersedes jobs with no switch.",
  },
];

describe('trigger function ownership (all migrations applied)', () => {
  let admin: Pool;
  beforeAll(() => {
    admin = createPool(process.env.DATABASE_URL!);
  });
  afterAll(async () => {
    await admin.end();
  });

  async function triggerFunctionOwners(): Promise<Array<{ fn: string; owner: string; triggers: string }>> {
    const { rows } = await admin.query(
      `SELECT p.oid::regprocedure::text AS fn, pg_get_userbyid(p.proowner) AS owner,
              string_agg(t.tgrelid::regclass::text || '.' || t.tgname, ', ' ORDER BY t.tgname) AS triggers
         FROM pg_trigger t
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE NOT t.tgisinternal
        GROUP BY p.oid, p.proowner
        ORDER BY 1`,
    );
    return rows;
  }

  it('finds trigger functions at all (the query is not vacuous)', async () => {
    expect((await triggerFunctionOwners()).length).toBeGreaterThan(20);
  });

  it('no trigger function is owned by platform_ops', async () => {
    const bad = (await triggerFunctionOwners()).filter(
      (r) => r.owner === 'platform_ops' && !ALLOWLIST.some((a) => a.fn === r.fn && a.owner === r.owner),
    );
    expect(bad).toEqual([]);
  });

  it('every trigger function is owned by the migration owner (the owner of the tables)', async () => {
    const { rows } = await admin.query(
      `SELECT pg_get_userbyid(c.relowner) AS owner FROM pg_class c WHERE c.oid = 'public.agent_runs'::regclass`,
    );
    const migrationOwner: string = rows[0].owner;
    expect(migrationOwner).not.toBe('platform_ops');
    const bad = (await triggerFunctionOwners()).filter(
      (r) => r.owner !== migrationOwner && !ALLOWLIST.some((a) => a.fn === r.fn && a.owner === r.owner),
    );
    expect(bad).toEqual([]);
  });

  it('every allowlist entry is still needed (no stale exemptions)', async () => {
    const all = await triggerFunctionOwners();
    for (const a of ALLOWLIST) {
      expect(all.some((r) => r.fn === a.fn && r.owner === a.owner), `${a.fn} (${a.reason})`).toBe(true);
    }
  });
});

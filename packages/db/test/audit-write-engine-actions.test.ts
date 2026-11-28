import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENGINE_AUDIT_ACTIONS, EngineAuditRefused, writeEngineAudit, type EngineAuditAction, type EngineAuditPayload } from '../src/engineAudit.js';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

function allowlistOf(file: string): string[] {
  const sql = readFileSync(path.join(MIGRATIONS, file), 'utf8');
  const start = sql.indexOf('p_action = ANY (ARRAY[');
  const end = sql.indexOf('])', start);
  return [...sql.slice(start, end).matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]!);
}

/** Engine bridge EB-14 (migration 1026): audit_write accepts the nine engine actions and every action 1008 accepted; the helper holds the payload to ids and enums. */
describe('audit_write allowlist carries the engine bridge actions', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let a: SeedRefs;

  const call = (action: string | null, payload: string = '{"n":1}') =>
    withTenant(appUserPool, a.accountId, a.userId, (c) => c.query(`SELECT audit_write($1::text, $2::jsonb) AS id`, [action, payload]));
  const count = async (action: string) =>
    Number((await admin.query(`SELECT count(*) AS n FROM audit_log WHERE account_id = $1 AND action = $2`, [a.accountId, action])).rows[0].n);

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  it("1026 lists exactly 1008's actions plus the nine engine actions", () => {
    const before = allowlistOf('1008_verify_settings_audit.sql');
    expect(before.length).toBeGreaterThan(20);
    expect(allowlistOf('1026_engine_audit_actions.sql')).toEqual([...before, ...ENGINE_AUDIT_ACTIONS.slice(0, 9)]);
  });

  it("1098 lists exactly 1095's actions (1068's list plus machine_server.credential_rebound) plus project.public_survey_consented, and every engine action is on it", () => {
    const one098 = allowlistOf('1098_survey_public_consent.sql');
    expect(one098.slice(-2)).toEqual(['machine_server.credential_rebound', 'project.public_survey_consented']);
    for (const action of ENGINE_AUDIT_ACTIONS.filter((a) => a !== 'project.github_identity_changed')) expect(one098).toContain(action);
    expect(new Set(one098).size).toBe(one098.length);
    expect(one098.length).toBe(allowlistOf('1068_engine_session_sandboxes.sql').length + 2);
    for (const action of allowlistOf('1068_engine_session_sandboxes.sql')) expect(one098).toContain(action);
  });

  it("1121 lists exactly 1098's actions plus project.github_identity_changed, and every engine action is on it", () => {
    const one098 = allowlistOf('1098_survey_public_consent.sql');
    const one121 = allowlistOf('1121_repo_github_identity.sql');
    expect(one121).toEqual([...one098, 'project.github_identity_changed']);
    for (const action of ENGINE_AUDIT_ACTIONS) expect(one121).toContain(action);
  });

  it('the action names are exactly the ones later rows depend on', () => {
    expect([...ENGINE_AUDIT_ACTIONS].sort()).toEqual([
      'engine_bridge.data_deleted',
      'engine_bridge.settings_changed',
      'engine_command.acked',
      'engine_command.cancelled',
      'engine_command.issued',
      'engine_decision.answered',
      'engine_decision.recorded',
      'engine_halt.cleared',
      'engine_halt.set',
      'project.github_identity_changed',
      'project.public_survey_consented',
    ]);
  });

  it('accepts every engine action and every earlier one, each leaving one row', async () => {
    for (const action of [...ENGINE_AUDIT_ACTIONS, ...allowlistOf('1008_verify_settings_audit.sql')]) {
      await call(action);
      expect(await count(action), action).toBe(1);
    }
  });

  it('still refuses an unknown action, NULL and a non-object payload', async () => {
    for (const action of ['engine_halt.toggled', 'engine_command', 'engine_command.', '', null]) await expect(call(action)).rejects.toMatchObject({ code: '22023' });
    await expect(call('engine_halt.set', '[1]')).rejects.toMatchObject({ code: '22023' });
  });

  it('stays closed to a caller that is not a member of the account', async () => {
    await expect(withTenant(appUserPool, a.accountId, randomUUID(), (c) => c.query(`SELECT audit_write('engine_halt.set', '{}'::jsonb)`))).rejects.toMatchObject({ code: '42501' });
  });

  describe('writeEngineAudit', () => {
    const write = (action: EngineAuditAction, payload: EngineAuditPayload) => withTenant(appUserPool, a.accountId, a.userId, (c) => writeEngineAudit(c, action, payload));

    it('writes the payload as sent and returns the row id', async () => {
      const payload = { repo_id: randomUUID(), command_id: randomUUID(), kind: 'set_dial', outcome: 'applied', refusal: null, decision_type: 'merge', disposition: 'approve', halt_epoch: 3 };
      const id = await write('engine_command.acked', payload);
      const { rows } = await admin.query(`SELECT action, payload FROM audit_log WHERE id = $1`, [id]);
      expect(rows[0]).toEqual({ action: 'engine_command.acked', payload });
    });

    it('refuses a key outside the list before any query, naming the key and never the value', async () => {
      const queries: unknown[] = [];
      const fake = {
        query: async (...args: unknown[]) => {
          queries.push(args);
          return { rows: [{ id: 'x' }] };
        },
      } as unknown as PoolClient;
      for (const bad of [{ note: 'secret-value' }, { repo_id: randomUUID(), title: 'x' }, { actor: 'x' }, { account_id: 'x' }, { created_at: 'x' }]) {
        const err = await writeEngineAudit(fake, 'engine_halt.set', bad as EngineAuditPayload).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(EngineAuditRefused);
        expect((err as Error).message).not.toContain('secret-value');
      }
      await expect(writeEngineAudit(fake, 'engine_halt.set', { kind: { nested: 1 } } as unknown as EngineAuditPayload)).rejects.toBeInstanceOf(EngineAuditRefused);
      await expect(writeEngineAudit(fake, 'engine_halt.set', { halt_epoch: Number.NaN })).rejects.toBeInstanceOf(EngineAuditRefused);
      await expect(writeEngineAudit(fake, 'engine_halt.set', ['repo_id'] as unknown as EngineAuditPayload)).rejects.toBeInstanceOf(EngineAuditRefused);
      await expect(writeEngineAudit(fake, 'verify_settings.changed' as EngineAuditAction, {})).rejects.toBeInstanceOf(EngineAuditRefused);
      expect(queries).toEqual([]);
    });
  });
});

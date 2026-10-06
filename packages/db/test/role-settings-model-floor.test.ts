import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedF1 } from './helpers/members.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#31 API-8b, migration 0645: audit_write accepts 'role_settings.model_changed'
 * (and still refuses an unlisted action), and role_settings.model carries two
 * CHECKs -- a known model id, and the H22 floor for security-reviewer and
 * security-expert -- that hold even for a writer that skips the route.
 */
describe('migration 0645: role_settings model CHECKs and the model_changed audit action', () => {
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

  async function seedRepo(): Promise<{ accountId: string; userId: string; repoId: string }> {
    const f1 = await seedF1(admin);
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO repos (account_id, gh_repo_id, product) VALUES ($1, $2, 'web') RETURNING id`,
      [f1.accountId, Math.floor(Math.random() * 1e9)],
    );
    return { accountId: f1.accountId, userId: f1.o1, repoId: rows[0]!.id };
  }

  async function insertRow(s: { accountId: string; repoId: string }, role: string, model: string | null): Promise<void> {
    await admin.query(
      `INSERT INTO role_settings (account_id, repo_id, role, mode, model) VALUES ($1, $2, $3, 'off', $4)`,
      [s.accountId, s.repoId, role, model],
    );
  }

  it("audit_write('role_settings.model_changed') is accepted, and an unlisted action still raises", async () => {
    const s = await seedRepo();
    const payload = JSON.stringify({ repoId: s.repoId, role: 'debater', before: null, after: 'opus-5' });
    const { rows } = await withTenant(appUserPool, s.accountId, s.userId, (client) =>
      client.query<{ audit_write: string }>(`SELECT audit_write('role_settings.model_changed', $1::jsonb)`, [payload]),
    );
    const { rows: logged } = await admin.query<{ action: string; actor: string; payload: unknown }>(
      `SELECT action, actor, payload FROM audit_log WHERE id = $1`,
      [rows[0]!.audit_write],
    );
    expect(logged[0]).toMatchObject({ action: 'role_settings.model_changed', actor: s.userId });
    expect(logged[0]!.payload).toEqual({ repoId: s.repoId, role: 'debater', before: null, after: 'opus-5' });

    await expect(
      withTenant(appUserPool, s.accountId, s.userId, (client) =>
        client.query(`SELECT audit_write('role_settings.not_a_real_action', '{}'::jsonb)`),
      ),
    ).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
  });

  it('keeps every earlier allowlist entry accepted', async () => {
    const s = await seedRepo();
    for (const action of [
      'decision_dial_changed',
      'model_connection.connect',
      'model_connection.replace',
      'model_connection.remove',
      'role_settings.mode_changed',
      'role_settings.guard_changed',
    ]) {
      const { rows } = await withTenant(appUserPool, s.accountId, s.userId, (client) =>
        client.query<{ audit_write: string }>(`SELECT audit_write($1, '{}'::jsonb)`, [action]),
      );
      expect(rows[0]!.audit_write, action).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('a direct INSERT of an unknown model is refused by the CHECK', async () => {
    const s = await seedRepo();
    await expect(insertRow(s, 'debater', 'gpt-5')).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
  });

  it('a direct INSERT of security-reviewer or security-expert on haiku-4.5 is refused, and an UPDATE to it too', async () => {
    const s = await seedRepo();
    await expect(insertRow(s, 'security-reviewer', 'haiku-4.5')).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    await expect(insertRow(s, 'security-expert', 'haiku-4.5')).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    await insertRow(s, 'security-reviewer', 'sonnet-5');
    await expect(
      admin.query(`UPDATE role_settings SET model = 'haiku-4.5' WHERE repo_id = $1 AND role = 'security-reviewer'`, [s.repoId]),
    ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
  });

  it('NULL, an at-floor model and a non-floored role on haiku-4.5 are accepted', async () => {
    const s = await seedRepo();
    await insertRow(s, 'security-reviewer', null);
    await insertRow(s, 'security-expert', 'sonnet-5');
    await insertRow(s, 'debater', 'haiku-4.5');
    await insertRow(s, 'executor', 'opus-5');
    const { rows } = await admin.query(`SELECT 1 FROM role_settings WHERE repo_id = $1`, [s.repoId]);
    expect(rows).toHaveLength(4);
  });
});

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { getCurrentDialSetting, getDialSettingAt } from '../src/decisions.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/**
 * D#7 DP4b-1: getDialSettingAt() returns the row at exactly that version, and null for version 0 (no row: the catalogue default applies), a
 * version that was never written, and anything that is not a version. A read only: the table is append-only history.
 */
describe('getDialSettingAt', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let refs: SeedRefs;
  let other: SeedRefs;
  const TYPE = 'test_strategy_choice';

  async function write(r: SeedRefs, type: string, version: number, disposition: string, preset: string | null): Promise<void> {
    await admin.query(
      `INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, preset, version, changed_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [r.accountId, r.repoId, type, disposition, preset, version, r.userId],
    );
  }

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    refs = await seedAccount(admin, randomUUID());
    other = await seedAccount(admin, randomUUID());
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`, [refs.accountId, refs.userId]);
    await write(refs, TYPE, 1, 'ask', 'cautious');
    await write(refs, TYPE, 2, 'announce', null);
    await write(refs, TYPE, 3, 'act', 'autonomous');
    await write(refs, 'nonbreaking_refactor_approach', 1, 'ask', 'cautious');
    await write(other, TYPE, 1, 'act', 'autonomous');
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appUserPool.end()]);
  });

  it('returns the row at exactly each of three versions, whatever the current one is', async () => {
    await withTenant(appUserPool, refs.accountId, async (c) => {
      expect(await getDialSettingAt(c, refs.repoId, TYPE, 1)).toMatchObject({ version: 1, disposition: 'ask', preset: 'cautious' });
      expect(await getDialSettingAt(c, refs.repoId, TYPE, 2)).toMatchObject({ version: 2, disposition: 'announce', preset: null });
      expect(await getDialSettingAt(c, refs.repoId, TYPE, 3)).toMatchObject({ version: 3, disposition: 'act', preset: 'autonomous' });
      expect((await getCurrentDialSetting(c, refs.repoId, TYPE))?.version).toBe(3);
    });
  });

  it('is null for version 0 (the catalogue default), a version never written, and a non-version', async () => {
    await withTenant(appUserPool, refs.accountId, async (c) => {
      for (const version of [0, 4, 99, -1, 1.5, Number.NaN]) {
        expect(await getDialSettingAt(c, refs.repoId, TYPE, version), String(version)).toBeNull();
      }
    });
  });

  it('is scoped to the repo and the decision type, and to the session tenant', async () => {
    await withTenant(appUserPool, refs.accountId, async (c) => {
      expect(await getDialSettingAt(c, refs.repoId, 'nonbreaking_refactor_approach', 2)).toBeNull();
      expect(await getDialSettingAt(c, refs.repoId, 'nonbreaking_refactor_approach', 1)).toMatchObject({ decisionType: 'nonbreaking_refactor_approach' });
      // Another tenant's repo is invisible to this session, even at a version that exists there.
      expect(await getDialSettingAt(c, other.repoId, TYPE, 1)).toBeNull();
    });
  });
});

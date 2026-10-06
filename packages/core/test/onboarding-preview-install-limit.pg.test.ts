import { randomInt, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { createRecordingRunActionSignal } from '../src/runActions/index.js';
import {
  PREVIEW_INSTALL_LIMIT,
  PREVIEW_INSTALL_WINDOW_DAYS,
  PreviewInstallLimitError,
  requestPreview,
} from '../src/onboarding/index.js';
import { NotFoundError } from '../src/tenancy/errors.js';

/** D#2 PREVIEW-PER-INSTALL-LIMIT: one free preview per GitHub installation and per owner per window, across accounts (0695). */
describe('onboarding preview install limit (pg)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appPool.end();
  });

  const deps = () => ({ signal: createRecordingRunActionSignal(), available: () => true });
  const ask = (r: SeedRefs, repoId: string, idempotencyKey?: string) =>
    requestPreview({ pool: appPool, principal: { accountId: r.accountId, userId: r.userId } }, { repoId, confirmModelCapUsd: 20, idempotencyKey }, deps());
  const newOwner = () => `own${randomInt(1, 2_000_000_000)}x${randomInt(1, 2_000_000_000)}`;
  async function account(): Promise<SeedRefs> {
    const r = await seedAccount(admin, randomUUID());
    await admin.query(`UPDATE model_connections SET status = 'ok' WHERE account_id = $1`, [r.accountId]);
    return r;
  }
  /** A repo of `ghOwner` (as stored; null leaves it unset) on its own read-only installation with an installer record. */
  async function repo(r: SeedRefs, ghOwner: string | null, ghInstallationId = randomInt(1, 2_000_000_000)) {
    const installationId = randomUUID();
    const repoId = randomUUID();
    await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, 'team_readonly')`, [installationId, r.accountId, ghInstallationId]);
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner) VALUES ($1, $2, $3, 1, 'team', $4)`, [repoId, r.accountId, installationId, ghOwner]);
    await admin.query(`INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id) VALUES ($1, 'team_readonly', $2)`, [ghInstallationId, randomInt(1, 2_000_000_000)]);
    return { repoId, installationId, ghInstallationId };
  }
  /** A committed preview row of `r` that records GitHub installation `x` (a copy, not a foreign key), one day old, with an unrelated owner. */
  async function plant(r: SeedRefs, x: number, state: 'requested' | 'void') {
    const t = await repo(r, newOwner());
    await admin.query(
      `INSERT INTO onboarding_previews (account_id, installation_id, repo_id, gh_user_id, gh_installation_id, gh_owner, run_action_id, state, void_reason, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, gen_random_uuid(), $7, $8, now() - interval '1 day')`,
      [r.accountId, t.installationId, t.repoId, randomInt(1, 2_000_000_000), x, newOwner(), state, state === 'void' ? 'preview_unavailable' : null],
    );
  }
  const rows = async (where: string, param: unknown) =>
    (await admin.query(`SELECT count(*)::int n FROM onboarding_previews WHERE ${where} AND state <> 'void'`, [param])).rows[0].n as number;
  const backdate = (previewId: string, days: number) =>
    admin.query(`UPDATE onboarding_previews SET created_at = now() - make_interval(days => $2) WHERE id = $1`, [previewId, days]);

  it('the TS constants equal the definer\'s constants', () => {
    const sql = readFileSync(new URL('../../db/migrations/0695_onboarding_preview_install_limit.sql', import.meta.url), 'utf8');
    expect(Number(/c_limit\s+CONSTANT int := (\d+)/.exec(sql)?.[1])).toBe(PREVIEW_INSTALL_LIMIT);
    expect(Number(/c_window\s+CONSTANT interval := interval '(\d+) days'/.exec(sql)?.[1])).toBe(PREVIEW_INSTALL_WINDOW_DAYS);
  });

  it('two accounts on one owner asking at the same moment: exactly one preview, the other is PreviewInstallLimitError (20 runs)', async () => {
    for (let i = 0; i < 20; i++) {
      const login = newOwner();
      const [a, b] = [await account(), await account()];
      const [ra, rb] = [await repo(a, login), await repo(b, login)];
      const out = await Promise.allSettled([ask(a, ra.repoId), ask(b, rb.repoId)]);
      expect(out.filter((o) => o.status === 'fulfilled'), `run ${i}`).toHaveLength(1);
      const lost = out.find((o) => o.status === 'rejected') as PromiseRejectedResult;
      expect(lost.reason, `run ${i}`).toBeInstanceOf(PreviewInstallLimitError);
      expect(await rows('gh_owner = $1', login), `run ${i}`).toBe(1);
    }
  });

  it('a request that arrives while another for the same owner is still uncommitted waits for it, then is refused', async () => {
    const login = newOwner();
    const [a, b] = [await account(), await account()];
    const [ra, rb] = [await repo(a, login), await repo(b, login)];
    const call = (r: SeedRefs, repoId: string, then?: () => Promise<void>) =>
      withTenant(appPool, r.accountId, r.userId, undefined, async (c) => {
        const res = await c.query('SELECT * FROM onboarding_preview_request($1, NULL, $2)', [repoId, 'h'.repeat(64)]);
        await then?.();
        return res.rows[0];
      });
    const first = call(a, ra.repoId, async () => {
      for (let i = 0; i < 40; i++) {
        const waiting = await admin.query(`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`);
        if (waiting.rowCount) return;
        await new Promise((r) => setTimeout(r, 50));
      }
    });
    await new Promise((r) => setTimeout(r, 200));
    const second = call(b, rb.repoId).then(() => 'accepted', (e: { code?: string }) => e.code);
    await first;
    expect(await second).toBe('PX409');
    expect(await rows('gh_owner = $1', login)).toBe(1);
  });

  it('per installation, across accounts: a preview of GitHub installation X (stored on another account\'s row) refuses a request on X', async () => {
    const [a, b] = [await account(), await account()];
    const x = randomInt(1, 2_000_000_000);
    // 0655 keeps a GitHub installation in one account at a time; the row's gh_installation_id is a copy, so A's row
    // is written with X while A's own installation has another id. This models "the installation moved accounts".
    await plant(a, x, 'requested');
    const rb = await repo(b, newOwner(), x);
    await expect(ask(b, rb.repoId)).rejects.toBeInstanceOf(PreviewInstallLimitError);
    expect(await rows('account_id = $1', b.accountId)).toBe(0);
  });

  it('per owner: a preview 29 days old refuses, one 31 days old does not', async () => {
    for (const [days, refused] of [[29, true], [31, false]] as const) {
      const login = newOwner();
      const [a, b] = [await account(), await account()];
      const first = await ask(a, (await repo(a, login)).repoId);
      await backdate(first.previewId, days);
      const second = ask(b, (await repo(b, login)).repoId);
      if (refused) await expect(second, `${days} days`).rejects.toBeInstanceOf(PreviewInstallLimitError);
      else await expect(second, `${days} days`).resolves.toMatchObject({ replayed: false });
    }
  });

  it('an owner login that differs only in case is the same owner, stored lower-cased', async () => {
    const login = newOwner();
    const [a, b] = [await account(), await account()];
    const first = await ask(a, (await repo(a, login.toUpperCase())).repoId);
    expect((await admin.query('SELECT gh_owner FROM onboarding_previews WHERE id = $1', [first.previewId])).rows[0].gh_owner).toBe(login);
    await expect(ask(b, (await repo(b, login)).repoId)).rejects.toBeInstanceOf(PreviewInstallLimitError);
  });

  it('a void preview of the same owner or installation does not count', async () => {
    const login = newOwner();
    const [a, b, c] = [await account(), await account(), await account()];
    const first = await ask(a, (await repo(a, login)).repoId);
    await admin.query(`UPDATE onboarding_previews SET state = 'void', void_reason = 'preview_unavailable' WHERE id = $1`, [first.previewId]);
    const second = await ask(b, (await repo(b, login)).repoId);
    expect(second.replayed).toBe(false);
    // The live one counts again as soon as it is live: a third account is refused.
    await expect(ask(c, (await repo(c, login)).repoId)).rejects.toBeInstanceOf(PreviewInstallLimitError);
    // The same for an installation: a void row recording X does not refuse a request on X.
    const [d, e] = [await account(), await account()];
    const x = randomInt(1, 2_000_000_000);
    await plant(d, x, 'void');
    await expect(ask(e, (await repo(e, newOwner(), x)).repoId)).resolves.toMatchObject({ replayed: false });
  });

  it('an idempotent replay of the accepted request still answers the first 202 and is not refused by the limit', async () => {
    const a = await account();
    const { repoId } = await repo(a, newOwner());
    const first = await ask(a, repoId, 'limit-replay');
    expect(await ask(a, repoId, 'limit-replay')).toEqual({ ...first, replayed: true });
    expect(await rows('account_id = $1', a.accountId)).toBe(1);
  });

  it('different owners on different installations do not affect each other', async () => {
    const [a, b] = [await account(), await account()];
    await ask(a, (await repo(a, newOwner())).repoId);
    await expect(ask(b, (await repo(b, newOwner())).repoId)).resolves.toMatchObject({ replayed: false });
  });

  it('a repo with no recorded owner is not found, and nothing is written', async () => {
    const a = await account();
    const { repoId } = await repo(a, null);
    await expect(ask(a, repoId)).rejects.toBeInstanceOf(NotFoundError);
    expect(await rows('account_id = $1', a.accountId)).toBe(0);
    expect((await admin.query(`SELECT count(*)::int n FROM run_action_requests WHERE account_id = $1`, [a.accountId])).rows[0].n).toBe(0);
  });
});

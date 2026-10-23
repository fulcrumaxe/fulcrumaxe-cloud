import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { resetPlanDataCache } from '@fx/plan-data';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { proposalVerifyKey } from '@fx/core/src/plan/proposalVerifyLimits.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { seedAccountWithMember } from './helpers/seed.js';

interface Identity {
  accountId: string;
  userId: string;
}
interface DetailBody {
  proposal: { id: string; verification: string; verify_wait: string | null };
}

/**
 * D#483 S4-b2b (S4b-12): `verify_wait` on GET /api/v1/proposals/{id}, through the real dispatcher against real Postgres as app_user. A verifier run
 * started for a proposal is what the sweep leaves behind: an `agent_runs` row and its idempotency key, keyed by `proposalVerifyKey` (the key the sweep
 * uses; packages/worker/test/proposalVerify.pg.test.ts holds the sweep to it and to the same limit function).
 */
describe('verify_wait on the proposal detail route (D#483 S4b-12)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  const savedPlanData = process.env.FX_PLAN_DATA;
  const fixture = (): Record<string, unknown> => JSON.parse(readFileSync(new URL('../../plan-data/fixtures/plan-data.fixture.json', import.meta.url), 'utf8'));
  /** Test figures only; the real ones live in each environment's plan data. */
  const usePlan = (discovery: Record<string, number> | null): void => {
    process.env.FX_PLAN_DATA = JSON.stringify(discovery === null ? fixture() : { ...fixture(), discovery });
    resetPlanDataCache();
  };
  const limitOf = (externalVerifiesPerRepoPerDay: number) => ({ perRepoDailyUsd: 2, verifyPerProposalUsd: 0.25, externalVerifiesPerRepoPerDay });

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await Promise.all([adminPool.end(), platformOpsPool.end(), appUserPool.end()]);
  });
  afterEach(() => {
    if (savedPlanData === undefined) delete process.env.FX_PLAN_DATA;
    else process.env.FX_PLAN_DATA = savedPlanData;
    resetPlanDataCache();
  });

  async function call(who: Identity | string, urlPath: string): Promise<Response> {
    const h = new Headers();
    if (typeof who === 'string') h.set('authorization', `Bearer ${who}`);
    else h.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(who)}`);
    return handleApiRequest(new Request(`http://localhost/api/v1${urlPath}`, { method: 'GET', headers: h }), appUserPool, platformOpsPool, ROUTES);
  }
  const waitOf = async (who: Identity | string, id: string): Promise<string | null> => {
    const res = await call(who, `/proposals/${id}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as DetailBody).proposal.verify_wait;
  };
  async function repoFor(who: Identity): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, 'team', 'acme', 'widgets')`, [id, who.accountId, Math.floor(Math.random() * 1e9) + 5]);
    return id;
  }
  let issueNo = 5000;
  async function proposalFor(who: Identity, repo: string, provenance: 'external' | 'internal' = 'external'): Promise<string> {
    const n = issueNo++;
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO proposals (account_id, repo_id, dedupe_key, sources, gh_number, title, summary, provenance, owner_process) VALUES ($1, $2, $3, '{github_issue}', $4, $5, 'body', $6, 'product') RETURNING id`,
      [who.accountId, repo, `gh:issue:${n}`, n, `Issue ${n}`, provenance],
    );
    return rows[0]!.id;
  }
  /** What a sweep start leaves: a verifier run and its key for the proposal's current attempt. */
  async function started(who: Identity, id: string): Promise<string> {
    const p = (await admin.query('SELECT id, title, summary, gh_number, discussion_number, verify_attempts FROM proposals WHERE id = $1', [id])).rows[0];
    const runId = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'proposal-verifier', 'local', 'running')`, [runId, who.accountId]);
    await admin.query('INSERT INTO agent_run_idempotency_keys (account_id, idempotency_key, run_id, request_hash) VALUES ($1, $2, $3, $4)', [who.accountId, proposalVerifyKey(p), runId, 'c'.repeat(64)]);
    return runId;
  }
  /** The repository's verifier spend today: a started run of an internal proposal with `usd` in the ledger. */
  async function spentToday(who: Identity, repo: string, usd: number): Promise<void> {
    const runId = await started(who, await proposalFor(who, repo, 'internal'));
    await admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'model', 'customer_gateway', $2, $3, 'model')`, [who.accountId, usd, runId]);
  }

  it('S4b-12: with the limit at 2, the two external proposals started today read queued and the third reads daily_limit; an internal one is never held', async () => {
    usePlan(limitOf(2));
    const who = await seedAccountWithMember(admin, { role: 'member' });
    const repo = await repoFor(who);
    const [one, two, three] = [await proposalFor(who, repo), await proposalFor(who, repo), await proposalFor(who, repo)];
    const inside = await proposalFor(who, repo, 'internal');
    // Before any start nothing is held.
    expect(await waitOf(who, three!)).toBe('queued');
    await started(who, one!);
    await started(who, two!);
    expect(await waitOf(who, one!)).toBe('queued');
    expect(await waitOf(who, two!)).toBe('queued');
    expect(await waitOf(who, three!)).toBe('daily_limit');
    expect(await waitOf(who, inside)).toBe('queued');
    // A read token sees the same as the session.
    const plaintext = generateToken();
    await insertApiToken(appUserPool, { accountId: who.accountId, createdBy: who.userId, tokenHash: hashToken(plaintext), displayHint: 'fxat_...test', scopes: ['read'], expiresAt: new Date(Date.now() + 86_400_000) });
    expect(await waitOf(plaintext, three!)).toBe('daily_limit');
  });

  it('the limit is the counter: at 3 the third reads queued; another repository and another account do not count; verification off reads queued', async () => {
    const who = await seedAccountWithMember(admin, { role: 'member' });
    const repo = await repoFor(who);
    const ids = [await proposalFor(who, repo), await proposalFor(who, repo), await proposalFor(who, repo)];
    await started(who, ids[0]!);
    await started(who, ids[1]!);
    usePlan(limitOf(3));
    expect(await waitOf(who, ids[2]!)).toBe('queued');

    usePlan(limitOf(2));
    const otherRepo = await repoFor(who);
    const elsewhere = await proposalFor(who, otherRepo);
    expect(await waitOf(who, elsewhere)).toBe('queued');
    const stranger = await seedAccountWithMember(admin, { role: 'member' });
    const theirs = await proposalFor(stranger, await repoFor(stranger));
    expect(await waitOf(stranger, theirs)).toBe('queued');

    // No discovery block: verification is off (fail closed) and nothing is held by a limit that is not set.
    usePlan(null);
    expect(await waitOf(who, ids[2]!)).toBe('queued');
  });

  it('is null for anything but pending, and absent from nothing: every detail body carries the field', async () => {
    usePlan(limitOf(0));
    const who = await seedAccountWithMember(admin, { role: 'member' });
    const repo = await repoFor(who);
    const id = await proposalFor(who, repo);
    expect(await waitOf(who, id)).toBe('daily_limit');
    for (const verification of ['verified', 'partly_verified', 'refuted', 'not_checked', 'check_failed']) {
      await admin.query('UPDATE proposals SET verification = $2, verified_at = now() WHERE id = $1', [id, verification]);
      expect(await waitOf(who, id), verification).toBeNull();
    }
  });

  it('daily_spend: a proposal held only by the repository cap reads daily_spend; both limits hold reads daily_limit; a raised cap reads queued', async () => {
    const who = await seedAccountWithMember(admin, { role: 'member' });
    const repo = await repoFor(who);
    const waiting = await proposalFor(who, repo);
    const inside = await proposalFor(who, repo, 'internal');
    // 1.9 spent today plus the 0.25 the next check reserves is over the 2.0 cap; the outside-author limit (10) is far off.
    await spentToday(who, repo, 1.9);
    usePlan(limitOf(10));
    expect(await waitOf(who, waiting)).toBe('daily_spend');
    // The spend cap is the repository's, so it holds an internal proposal too (which the outside limit never does).
    expect(await waitOf(who, inside)).toBe('daily_spend');
    // Both hold: one outside check has started today and the limit is 1, so the outside-author limit wins.
    await started(who, await proposalFor(who, repo));
    usePlan(limitOf(1));
    expect(await waitOf(who, waiting)).toBe('daily_limit');
    expect(await waitOf(who, inside)).toBe('daily_spend');
    // Raising the cap releases the hold.
    usePlan({ ...limitOf(10), perRepoDailyUsd: 3 });
    expect(await waitOf(who, waiting)).toBe('queued');
    expect(await waitOf(who, inside)).toBe('queued');
    // Another repository of the same account has spent nothing.
    usePlan(limitOf(10));
    const elsewhere = await proposalFor(who, await repoFor(who));
    expect(await waitOf(who, elsewhere)).toBe('queued');
  });

  it('daily_spend is not read for a proposal whose check already started', async () => {
    usePlan(limitOf(10));
    const who = await seedAccountWithMember(admin, { role: 'member' });
    const repo = await repoFor(who);
    const mine = await proposalFor(who, repo);
    await started(who, mine);
    await spentToday(who, repo, 5);
    expect(await waitOf(who, mine)).toBe('queued');
  });

  it('plan data that is present but invalid does not fail the detail read: pending reads queued', async () => {
    const who = await seedAccountWithMember(admin, { role: 'member' });
    const id = await proposalFor(who, await repoFor(who));
    for (const bad of ['{', '{"plans":1}', JSON.stringify({ ...fixture(), discovery: { perRepoDailyUsd: -1, verifyPerProposalUsd: 0.25, externalVerifiesPerRepoPerDay: 1 } })]) {
      process.env.FX_PLAN_DATA = bad;
      resetPlanDataCache();
      expect(await waitOf(who, id), bad.slice(0, 20)).toBe('queued');
    }
  });
});

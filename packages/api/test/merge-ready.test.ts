import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { COPY } from '@fulcrumaxe/runner-protocol';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { MERGE_READY_LIST_LIMIT, pullRequestUrl } from '../src/routes/mergeReady.js';

/**
 * D#598 P8c-2b: GET /api/v1/merge-ready through the real `handleApiRequest` against real Postgres (RLS, membership). Every id is random and every
 * account is its own, so this file shares nothing with another test file. The list is derived: events and stages are written the way the stage driver
 * and the pull request webhook write them, and nothing here stores "this item is on the list".
 */
interface Identity {
  accountId: string;
  userId: string;
}
interface Item {
  work_item_id: string;
  title: string | null;
  pr_number: number;
  pr_url: string | null;
  why: string;
  since: string;
}
interface Body {
  items: Item[];
  not_shown: number;
}
const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/v1/listMergeReady/200-ok.json', import.meta.url), 'utf8')) as Body;

describe('D#598 P8c-2b: merge-ready list', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;

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

  async function call(identity: Identity, bearer?: string): Promise<Response> {
    const headers = new Headers();
    if (bearer) headers.set('authorization', `Bearer ${bearer}`);
    else headers.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(identity)}`);
    return handleApiRequest(new Request('http://localhost/api/v1/merge-ready', { method: 'GET', headers }), appUserPool, platformOpsPool, ROUTES);
  }
  const read = async (who: Identity): Promise<Body> => (await (await call(who)).json()) as Body;
  async function fixture(repo: { owner: string; name: string } | null = { owner: 'example-org', name: 'example-repo' }) {
    const refs: SeedRefs = await seedAccount(admin, randomUUID());
    const userId = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [refs.accountId, userId]);
    if (repo) await admin.query(`UPDATE repos SET gh_owner = $2, gh_name = $3 WHERE id = $1`, [refs.repoId, repo.owner, repo.name]);
    return { refs, member: { accountId: refs.accountId, userId } };
  }
  async function item(refs: SeedRefs, title: string): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, title) VALUES ($1, $2, $3, 'feature', 'internal', $4)`, [id, refs.accountId, refs.repoId, title]);
    return id;
  }
  const gate = (refs: SeedRefs, workItemId: string, over: { code?: string; pr?: number; reasons?: string[] } = {}) =>
    admin.query(
      `INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, reasons, pr_number, dedupe_key) VALUES ($1, $2, 'merge_gate', $3, $4::text[], $5, $6)`,
      [refs.accountId, workItemId, over.code ?? 'ready_human_merges', over.reasons ?? ['local_review_not_enabled'], over.pr ?? 7, randomUUID()],
    );
  const setStage = (id: string, stage: string) => admin.query(`UPDATE work_items SET stage = $2 WHERE id = $1`, [id, stage]);

  it('is empty when no item is waiting for a person to merge', async () => {
    const f = await fixture();
    await gate(f.refs, f.refs.workItemId, { code: 'merged' });
    expect(await read(f.member)).toEqual({ items: [], not_shown: 0 });
  });

  it('lists one item with a link built from the repository and the number, in the shape of the contract fixture', async () => {
    const f = await fixture();
    const id = await item(f.refs, 'Add a retry to the export job');
    await gate(f.refs, id, { pr: 42 });
    const res = await call(f.member);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.not_shown).toBe(0);
    expect(body.items).toHaveLength(1);
    const row = body.items[0]!;
    expect(row).toMatchObject({ work_item_id: id, title: 'Add a retry to the export job', pr_number: 42, pr_url: 'https://github.com/example-org/example-repo/pull/42' });
    expect(Object.keys(row).sort()).toEqual(Object.keys(FIXTURE.items[0]!).sort());
    expect(Object.keys(body).sort()).toEqual(Object.keys(FIXTURE).sort());
    expect(row.why).toBe(FIXTURE.items[0]!.why);
    expect(Number.isNaN(Date.parse(row.since))).toBe(false);
  });

  it('D#694 B6-3: an item waiting in the merge queue of GitHub is not "ready for you to merge", even with an older ready answer; it is listed again after a removal', async () => {
    const f = await fixture();
    const id = await item(f.refs, 'Queued by hand');
    await gate(f.refs, id, { pr: 9 });
    const fact = (kind: string, code: string | null, dedupe: string) =>
      admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, pr_number, head_sha, dedupe_key) VALUES ($1, $2, $3, $4, 9, $5, $6)`, [f.refs.accountId, id, kind, code, 'a'.repeat(40), dedupe]);
    await fact('merge_enqueued', 'queue', 'enq');
    expect((await read(f.member)).items).toEqual([]);
    await fact('merge_dequeued', 'merge', 'deq-success');
    expect((await read(f.member)).items).toEqual([]);
    await fact('merge_dequeued', 'manual', 'deq');
    expect((await read(f.member)).items.map((i) => i.work_item_id)).toEqual([id]);
  });

  it('D#694 B6-4: a body-linked other pull request that was enqueued does not make the item queued: it stays listed for its own pull request', async () => {
    const f = await fixture();
    const id = await item(f.refs, 'Linked to someone else');
    await gate(f.refs, id, { pr: 9 });
    await admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, pr_number, head_sha, dedupe_key) VALUES ($1, $2, 'merge_enqueued', 'queue', 99, $3, 'enq-foreign')`, [f.refs.accountId, id, 'b'.repeat(40)]);
    expect((await read(f.member)).items.map((i) => i.work_item_id)).toEqual([id]);
  });

  it('still lists an item whose repository is not on record, with a null link and every other field present', async () => {
    const f = await fixture(null);
    const id = await item(f.refs, 'No repository yet');
    await gate(f.refs, id, { pr: 7 });
    const res = await call(f.member);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.not_shown).toBe(0);
    expect(body.items).toHaveLength(1);
    const row = body.items[0]!;
    expect(row.pr_url).toBeNull();
    expect(Object.keys(row).sort()).toEqual(Object.keys(FIXTURE.items[0]!).sort());
    expect(row).toMatchObject({ work_item_id: id, title: 'No repository yet', pr_number: 7 });
    expect(row.why).toBe(FIXTURE.items[0]!.why);
    expect(Number.isNaN(Date.parse(row.since))).toBe(false);
  });

  it('lists many, newest first, with the cap sentences for the review caps and no link when the repository is unknown', async () => {
    const f = await fixture(null);
    const a = await item(f.refs, 'First');
    await gate(f.refs, a, { pr: 1, reasons: ['review_round_cap'] });
    const b = await item(f.refs, 'Second');
    await gate(f.refs, b, { pr: 2, reasons: ['review_compute_cap'] });
    const body = await read(f.member);
    expect(body.items.map((i) => i.work_item_id)).toEqual([b, a]);
    expect(body.items[1]!.why).toBe(COPY.reviewRoundCap);
    expect(body.items[0]!.why).toBe(COPY.reviewComputeCap);
    expect(body.items.every((i) => i.pr_url === null)).toBe(true);
  });

  it('drops an item when its pull request is merged or closed, and when a later gate outcome replaces the ready one', async () => {
    const f = await fixture();
    const merged = await item(f.refs, 'Merged');
    const closed = await item(f.refs, 'Closed');
    const replaced = await item(f.refs, 'Replaced');
    const stays = await item(f.refs, 'Stays');
    for (const [id, pr] of [[merged, 11], [closed, 12], [replaced, 13], [stays, 14]] as const) await gate(f.refs, id, { pr });
    expect((await read(f.member)).items).toHaveLength(4);
    await setStage(merged, 'merged');
    await setStage(closed, 'closed_unmerged');
    await gate(f.refs, replaced, { code: 'blocked', pr: 13 });
    expect((await read(f.member)).items.map((i) => i.work_item_id)).toEqual([stays]);
  });

  it('shows each account only its own items, and refuses a token (session only)', async () => {
    const f = await fixture();
    const other = await fixture();
    await gate(other.refs, other.refs.workItemId, { pr: 99 });
    expect((await read(f.member)).items).toEqual([]);
    const plaintext = generateToken();
    await insertApiToken(appUserPool, { accountId: f.member.accountId, createdBy: f.member.userId, tokenHash: hashToken(plaintext), displayHint: 'fxat_...test', scopes: ['read'] as never, expiresAt: new Date(Date.now() + 86_400_000) });
    const viaToken = await call(f.member, plaintext);
    expect(viaToken.status).toBe(403);
    expect(((await viaToken.json()) as { error: { code: string } }).error.code).toBe('session_required');
  });

  it('is capped and says how many are not shown', async () => {
    const f = await fixture();
    for (let n = 0; n < MERGE_READY_LIST_LIMIT + 2; n += 1) await gate(f.refs, await item(f.refs, `Item ${n}`), { pr: n + 1 });
    const body = await read(f.member);
    expect(body.items).toHaveLength(MERGE_READY_LIST_LIMIT);
    expect(body.not_shown).toBe(2);
  });

  // Live 2026-10-25 (cloud#673): the gate answered "ready, a person merges" while the pull request was still a draft with no public copy open and its checks
  // not green. That is not a pull request for a person to merge; it is an answer the gate gave too early (the stalled list shows it, with the button that asks again).
  it('does not list a gate answer that holds any reason other than a person pressing merge (draft, checks not green, public copy not open, a review that did not pass, an unknown code): it is not ready yet', async () => {
    const f = await fixture();
    for (const reason of ['pr_draft', 'ci_not_green', 'public_pr_not_open', 'public_head_unrecorded', 'verdict_not_pass_code_reviewer', 'merge_conflict', 'a_code_nobody_has_heard_of']) {
      const id = await item(f.refs, `Not ready: ${reason}`);
      await gate(f.refs, id, { reasons: ['local_review_not_enabled', reason] });
    }
    const ready = await item(f.refs, 'Really ready');
    await gate(f.refs, ready, { reasons: ['local_review_not_enabled'] });
    const body = await read(f.member);
    expect(body.items.map((i) => i.work_item_id)).toEqual([ready]);
    expect(body.not_shown).toBe(0);
  });

  it('builds the link only from a well-formed repository and number', () => {
    expect(pullRequestUrl({ owner: 'a-b', name: 'c.d_e' }, 5)).toBe('https://github.com/a-b/c.d_e/pull/5');
    expect(pullRequestUrl(null, 5)).toBeNull();
    expect(pullRequestUrl({ owner: 'a/b', name: 'c' }, 5)).toBeNull();
    expect(pullRequestUrl({ owner: 'a', name: '..' }, 5)).toBeNull();
    expect(pullRequestUrl({ owner: 'a', name: 'c' }, 0)).toBeNull();
  });
});

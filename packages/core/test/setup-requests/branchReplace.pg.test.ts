import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { setPendingHooks } from '../../src/pendingWork.js';
import { withTenant } from '../../src/tenancy/withTenant.js';
import { clearBranchPushedByPerson, keepBranchPushedByPerson, raiseBranchPushedByPerson, replaceBranchPushedByPerson } from '../../src/setup-requests/branchPushed.js';
import { keepBranch, releaseBranch, replaceBranch } from '../../src/setup-requests/branchPushedAnswer.js';
import { SetupRequestError, listSetupRequests, setupHoldFor } from '../../src/setup-requests/store.js';
import { readPlanePush, recordUpdatedHead } from '../../src/repos/planePushRecord.js';

/**
 * [pg] D#598 P1g-3a: a confirmed Replace records the authorization at the head the person was shown, restarts the item, and is single-use. The confirmation
 * carries the head on screen; if the request has moved on, nothing is written (the scenario the Opus review of the raise named).
 */
const STAMP = 'd'.repeat(40);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('replace the person-pushed branch: authorization at the shown head [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUser: Pool;
  let T: SeedRefs;
  let other: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUser = createPool(process.env.DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appUser.end()]);
  });
  beforeEach(async () => {
    T = await seedAccount(admin, randomUUID());
    other = await seedAccount(admin, randomUUID());
    const markers = new Map<string, number>();
    setPendingHooks({ store: { get: async (k) => markers.get(k) ?? null, set: async (k, v) => void markers.set(k, v), delete: async (k) => void markers.delete(k) } });
    await admin.query('INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, $3, $4)', [T.repoId, T.accountId, 'acme/widgets-public', ['private/**']]);
    await admin.query(
      `INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest, head_sha, tip_sha, pr_number, pr_url, state)
       VALUES ($1, $2, $3, 'acme/widgets-public', $4, $5, $6, 7, 'https://github.com/acme/widgets-public/pull/7', 'pr_opened')`,
      [T.accountId, T.workItemId, T.repoId, 'f'.repeat(64), STAMP, 'e'.repeat(40)],
    );
  });
  afterEach(() => setPendingHooks(null));

  const asWorker = <R>(fn: (c: PoolClient) => Promise<R>): Promise<R> => withTenant(appUser, T.accountId, fn);
  const asPerson = <R>(fn: (c: PoolClient) => Promise<R>, userId = T.userId): Promise<R> => withTenant(appUser, T.accountId, userId, undefined, fn);
  const raise = async (head: string) => {
    const out = await asWorker((c) => raiseBranchPushedByPerson(c, { workItemId: T.workItemId, seenHead: head }));
    if (out.kind === 'not_applicable') throw new Error('expected a request');
    return out.request;
  };
  const push = () => asWorker((c) => readPlanePush(c, T.accountId, T.workItemId));
  const restarts = async () => (await admin.query("SELECT id FROM run_action_requests WHERE account_id = $1 AND kind = 'advance_work_item' AND target_id = $2", [T.accountId, T.workItemId])).rowCount;

  it('authorizes the lease at the head the person was shown, closes the request as their answer, restarts the item once and lifts the hold', async () => {
    const req = await raise(A);
    const done = await asPerson((c) => replaceBranchPushedByPerson(c, { id: req.id, userId: T.userId, shownHead: A }));
    expect(done.changed).toBe(true);
    expect(done.request.state).toBe('done');
    const row = await push();
    expect(row?.state).toBe('pr_opened');
    expect(row?.replaceAuthorizedHead).toBe(A);
    expect(row?.headSha).toBe(STAMP);
    expect(await restarts()).toBe(1);
    expect(await asWorker((c) => setupHoldFor(c, T.workItemId))).toBeNull();
    // A repeat of the click changes nothing and files nothing.
    const again = await asPerson((c) => replaceBranchPushedByPerson(c, { id: req.id, userId: T.userId, shownHead: A }));
    expect(again.changed).toBe(false);
    expect(await restarts()).toBe(1);
  });

  it('refuses when the request moved to a newer head after the page was shown, writes nothing, and shows the new head (page on A, branch moved to B)', async () => {
    const req = await raise(A);
    await raise(B); // a step on the held item refreshed the request to the newer push
    const err = await asPerson((c) => replaceBranchPushedByPerson(c, { id: req.id, userId: T.userId, shownHead: A })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SetupRequestError);
    expect((err as SetupRequestError).code).toBe('head_changed');
    const row = await push();
    expect(row?.replaceAuthorizedHead).toBeNull();
    expect(row?.state).toBe('waiting_person_pushed');
    expect(await restarts()).toBe(0);
    const open = await asPerson((c) => listSetupRequests(c, { state: 'open' }));
    expect(open.requests).toHaveLength(1);
    expect(open.requests[0]!.seenHead).toBe(B);
    // The same click carrying the new head goes through, on the new head.
    await asPerson((c) => replaceBranchPushedByPerson(c, { id: req.id, userId: T.userId, shownHead: B }));
    expect((await push())?.replaceAuthorizedHead).toBe(B);
  });

  it('is refused whole, with the request left open, when the pull request is no longer waiting on this branch', async () => {
    const req = await raise(A);
    await admin.query("UPDATE plane_pushes SET state = 'pr_closed' WHERE work_item_id = $1", [T.workItemId]);
    const err = await asPerson((c) => replaceBranchPushedByPerson(c, { id: req.id, userId: T.userId, shownHead: A })).catch((e: unknown) => e);
    expect((err as SetupRequestError).code).toBe('not_open');
    const open = await asPerson((c) => listSetupRequests(c, { state: 'open' }));
    expect(open.requests).toHaveLength(1);
    expect(await restarts()).toBe(0);
  });

  it('is not open to another account, or to a value that is not a commit id', async () => {
    const req = await raise(A);
    await expect(asPerson((c) => replaceBranchPushedByPerson(c, { id: req.id, userId: T.userId, shownHead: 'not-a-sha' }))).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(withTenant(appUser, other.accountId, other.userId, undefined, (c) => replaceBranchPushedByPerson(c, { id: req.id, userId: other.userId, shownHead: A }))).rejects.toThrow();
    expect((await push())?.replaceAuthorizedHead).toBeNull();
  });

  it('is single-use: the update that lands, a branch put back, and Keep each spend it', async () => {
    const req = await raise(A);
    await asPerson((c) => replaceBranchPushedByPerson(c, { id: req.id, userId: T.userId, shownHead: A }));
    const id = (await push())!.id;
    await asWorker((c) => recordUpdatedHead(c, { accountId: T.accountId, id, headSha: 'c'.repeat(40), tipSha: 'e'.repeat(40), sourceHead: null }));
    expect((await push())?.replaceAuthorizedHead).toBeNull();

    await admin.query("UPDATE plane_pushes SET replace_authorized_head = $2 WHERE work_item_id = $1", [T.workItemId, A]);
    expect(await asWorker((c) => clearBranchPushedByPerson(c, { workItemId: T.workItemId }))).toBe(true);
    expect((await push())?.replaceAuthorizedHead).toBeNull();
  });

  it('the answer functions run for the person, announce the restart, and Keep with its undo works through them', async () => {
    const req = await raise(A);
    const kept = await keepBranch({ pool: appUser }, { accountId: T.accountId, userId: T.userId, id: req.id });
    expect(kept.changed).toBe(true);
    expect((await push())?.state).toBe('managed_by_person');
    expect(await releaseBranch({ pool: appUser }, { accountId: T.accountId, userId: T.userId, workItemId: T.workItemId })).toBe(true);
    expect(await releaseBranch({ pool: appUser }, { accountId: T.accountId, userId: T.userId, workItemId: T.workItemId })).toBe(false);
    expect((await push())?.state).toBe('pr_opened');
    const req2 = await raise(B);
    await expect(replaceBranch({ pool: appUser }, { accountId: T.accountId, userId: T.userId, id: req2.id, shownHead: A })).rejects.toMatchObject({ code: 'head_changed' });
    await replaceBranch({ pool: appUser }, { accountId: T.accountId, userId: T.userId, id: req2.id, shownHead: B });
    expect((await push())?.replaceAuthorizedHead).toBe(B);
  });

  it('the list for Needs you keeps a Keep-answered request with its mark, and drops it when the mark is undone', async () => {
    const req = await raise(A);
    await keepBranch({ pool: appUser }, { accountId: T.accountId, userId: T.userId, id: req.id });
    let list = await asPerson((c) => listSetupRequests(c, { state: 'needs_you' }));
    expect(list.requests.map((r) => [r.id, r.branchManaged])).toEqual([[req.id, true]]);
    await releaseBranch({ pool: appUser }, { accountId: T.accountId, userId: T.userId, workItemId: T.workItemId });
    list = await asPerson((c) => listSetupRequests(c, { state: 'needs_you' }));
    expect(list.requests).toHaveLength(0);
  });

  describe('the answers meet each other (review rulings 1, 2, 4, 5)', () => {
    const keep = (id: string) => asPerson((c) => keepBranchPushedByPerson(c, { id, userId: T.userId }));
    const replace = (id: string, shownHead: string) => asPerson((c) => replaceBranchPushedByPerson(c, { id, userId: T.userId, shownHead }));
    const needsYou = async () => (await asPerson((c) => listSetupRequests(c, { state: 'needs_you' }))).requests.map((r) => [r.id, r.branchManaged]);
    const spend = async () => {
      const id = (await push())!.id;
      await asWorker((c) => recordUpdatedHead(c, { accountId: T.accountId, id, headSha: 'c'.repeat(40), tipSha: 'e'.repeat(40), sourceHead: null }));
    };

    it('Keep wins while the authorization is unspent: it is cleared, the branch is managed, the person sees the Keep result, and a repeat changes nothing', async () => {
      const req = await raise(A);
      await replace(req.id, A);
      expect((await push())?.replaceAuthorizedHead).toBe(A);
      const kept = await keep(req.id);
      expect(kept.changed).toBe(true);
      expect(kept.restart).toBeNull();
      const row = await push();
      expect(row).toMatchObject({ state: 'managed_by_person', replaceAuthorizedHead: null });
      expect(row?.managedByPersonAt).not.toBeNull();
      expect(await needsYou()).toEqual([[req.id, true]]);
      const again = await keep(req.id);
      expect(again.changed).toBe(false);
      expect(await restarts()).toBe(1);
      expect(await releaseBranch({ pool: appUser }, { accountId: T.accountId, userId: T.userId, workItemId: T.workItemId })).toBe(true);
      expect(await needsYou()).toEqual([]);
    });

    it('Keep after the Replace was spent (the update landed) is refused as closed, and nothing becomes managed', async () => {
      const req = await raise(A);
      await replace(req.id, A);
      await spend();
      await expect(keep(req.id)).rejects.toMatchObject({ code: 'not_open' });
      expect(await push()).toMatchObject({ state: 'pr_opened', replaceAuthorizedHead: null, managedByPersonAt: null });
      // The Replace answer itself, repeated, is still the same answer.
      expect((await replace(req.id, A)).changed).toBe(false);
    });

    it('Replace after Keep is refused, not reported as a success', async () => {
      const req = await raise(A);
      await keep(req.id);
      await expect(replace(req.id, A)).rejects.toMatchObject({ code: 'not_open' });
      expect(await push()).toMatchObject({ state: 'managed_by_person', replaceAuthorizedHead: null });
      await releaseBranch({ pool: appUser }, { accountId: T.accountId, userId: T.userId, workItemId: T.workItemId });
      // After the undo the old request is just closed: neither answer applies to it any more.
      await expect(replace(req.id, A)).rejects.toMatchObject({ code: 'not_open' });
      await expect(keep(req.id)).rejects.toMatchObject({ code: 'not_open' });
    });

    it('Keep, undo, a new push, Keep again: only the newest Kept request is listed as managed (no phantom row)', async () => {
      const r1 = await raise(A);
      await keep(r1.id);
      await releaseBranch({ pool: appUser }, { accountId: T.accountId, userId: T.userId, workItemId: T.workItemId });
      const r2 = await raise(B);
      expect(r2.id).not.toBe(r1.id);
      await keep(r2.id);
      expect(await needsYou()).toEqual([[r2.id, true]]);
    });

    it('a Replace-closed request is never shown as managed when a later request is Kept', async () => {
      const r1 = await raise(A);
      await replace(r1.id, A);
      await spend();
      const r2 = await raise(B);
      await keep(r2.id);
      expect(await needsYou()).toEqual([[r2.id, true]]);
      const all = await asPerson((c) => listSetupRequests(c, { state: 'all' }));
      expect(all.requests.filter((r) => r.branchManaged).map((r) => r.id)).toEqual([r2.id]);
    });

    it('each answer and the undo leave an audit row naming the answer, the request and the person; a repeat leaves none', async () => {
      const audit = async () =>
        (await admin.query<{ actor: string; payload: { work_item_id: string; action: string; request_id?: string } }>("SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'work_item.sent_back' ORDER BY created_at, id", [T.accountId])).rows.map((r) => [r.actor, r.payload.action, r.payload.request_id ?? null, r.payload.work_item_id]);
      const r1 = await raise(A);
      await replace(r1.id, A);
      await replace(r1.id, A);
      await keep(r1.id);
      await keep(r1.id);
      await releaseBranch({ pool: appUser }, { accountId: T.accountId, userId: T.userId, workItemId: T.workItemId });
      await releaseBranch({ pool: appUser }, { accountId: T.accountId, userId: T.userId, workItemId: T.workItemId });
      expect(await audit()).toEqual([
        [T.userId, 'public_branch_replace', r1.id, T.workItemId],
        [T.userId, 'public_branch_keep', r1.id, T.workItemId],
        [T.userId, 'public_branch_release', null, T.workItemId],
      ]);
    });

    describe('an item with two push rows (re-paired)', () => {
      const second = async () => {
        await admin.query(
          `INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest, head_sha, tip_sha, pr_number, pr_url, state)
           VALUES ($1, $2, $3, 'acme/other-public', $4, $5, $6, 8, 'https://github.com/acme/other-public/pull/8', 'waiting_person_pushed')`,
          [T.accountId, T.workItemId, T.repoId, 'f'.repeat(64), 'c'.repeat(40), 'e'.repeat(40)],
        );
      };
      const rows = async () =>
        (await admin.query<{ code_repo: string; state: string; replace_authorized_head: string | null; managed_by_person_at: Date | null }>(
          'SELECT code_repo, state, replace_authorized_head, managed_by_person_at FROM plane_pushes WHERE work_item_id = $1 ORDER BY code_repo', [T.workItemId])).rows;

      it('Replace authorizes the push row the request names, and no other', async () => {
        const req = await raise(A);
        await second();
        await replace(req.id, A);
        expect(await rows()).toEqual([
          { code_repo: 'acme/other-public', state: 'waiting_person_pushed', replace_authorized_head: null, managed_by_person_at: null },
          { code_repo: 'acme/widgets-public', state: 'pr_opened', replace_authorized_head: A, managed_by_person_at: null },
        ]);
      });

      it('Keep marks the push row the request names, and no other', async () => {
        const req = await raise(A);
        await second();
        await keep(req.id);
        const got = await rows();
        expect(got.map((r) => [r.code_repo, r.state, r.managed_by_person_at !== null])).toEqual([
          ['acme/other-public', 'waiting_person_pushed', false],
          ['acme/widgets-public', 'managed_by_person', true],
        ]);
      });
    });
  });

  it('a confirm of an older head waits for a refresh that has not committed yet, then refuses (the row lock is what makes the head check true)', async () => {
    const req = await raise(A);
    const other = await adminPool.connect();
    try {
      await other.query('BEGIN');
      await other.query('UPDATE setup_requests SET seen_head = $2 WHERE id = $1', [req.id, B]);
      const pending = asPerson((c) => replaceBranchPushedByPerson(c, { id: req.id, userId: T.userId, shownHead: A })).catch((e: unknown) => e);
      // Not a clock assertion: wait until the server itself reports the confirm blocked on a lock (bounded; a confirm that never blocks simply stops waiting).
      for (let i = 0; i < 400; i += 1) {
        const blocked = await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
        if ((blocked.rowCount ?? 0) > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await other.query('COMMIT');
      const err = await pending;
      expect(err).toBeInstanceOf(SetupRequestError);
      expect((err as SetupRequestError).code).toBe('head_changed');
      expect((await push())?.replaceAuthorizedHead).toBeNull();
    } finally {
      other.release();
    }
  });
});

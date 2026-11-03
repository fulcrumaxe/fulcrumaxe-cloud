import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { setPendingHooks } from '../../src/pendingWork.js';
import { withTenant } from '../../src/tenancy/withTenant.js';
import {
  PUBLIC_BRANCH_MANAGED_SENTENCE,
  clearBranchPushedByPerson,
  keepBranchPushedByPerson,
  raiseBranchPushedByPerson,
  releaseManagedBranch,
} from '../../src/setup-requests/branchPushed.js';
import { SetupRequestError, getSetupRequest, listSetupRequests, proposeSetupRequest, resolveSetupRequest, setupHoldFor, type SetupRequest } from '../../src/setup-requests/store.js';
import { setupRequestTitle } from '../../src/setup-requests/kinds.js';
import { markSetupRequestDone } from '../../src/setup-requests/markDone.js';
import { unavailableVercelEnvSource } from '../../src/setup-requests/checks.js';
import { COPY_BRANCH_PUSHED, statusSentence } from '../../src/setup-requests/copy.js';
import { createRecordingRunActionSignal } from '../../src/runActions/signal.js';

/**
 * [pg] D#598 P1g-2: the platform raises "someone pushed to the public branch" (migration 0977), stores the head the person was shown, and a person's own
 * click answers it (Keep, Withdraw), with the undo of Keep. Real Postgres as the real roles: the worker's raise carries no person (app_user with an account
 * and no user), the answers carry an owner. Row security is forced, and the policies that admit a no-person write are tested from both sides.
 */
const STAMP = 'd'.repeat(40);
const THEIRS = 'a'.repeat(40);
const THEIRS_LATER = 'b'.repeat(40);

describe('branch pushed by a person: raise, keep, withdraw, undo [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUser: Pool;
  let A: SeedRefs;
  let B: SeedRefs;

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
    A = await seedAccount(admin, randomUUID());
    B = await seedAccount(admin, randomUUID());
    const markers = new Map<string, number>();
    setPendingHooks({ store: { get: async (k) => markers.get(k) ?? null, set: async (k, v) => void markers.set(k, v), delete: async (k) => void markers.delete(k) } });
    await paired(A);
  });
  afterEach(() => setPendingHooks(null));

  /** The item's pairing and the record of the pull request the platform opened and last pushed at STAMP. */
  async function paired(t: SeedRefs, over: { state?: string; managed?: boolean } = {}): Promise<void> {
    await admin.query('INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, $3, $4)', [t.repoId, t.accountId, 'acme/widgets-public', ['private/**']]);
    await admin.query(
      `INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest, head_sha, tip_sha, pr_number, pr_url, state, managed_by_person_at)
       VALUES ($1, $2, $3, 'acme/widgets-public', $4, $5, $6, 7, 'https://github.com/acme/widgets-public/pull/7', $7, $8)`,
      [t.accountId, t.workItemId, t.repoId, 'f'.repeat(64), STAMP, 'e'.repeat(40), over.state ?? 'pr_opened', over.managed ? new Date() : null],
    );
  }
  const asWorker = <T>(t: SeedRefs, fn: (c: PoolClient) => Promise<T>): Promise<T> => withTenant(appUser, t.accountId, fn);
  const asPerson = <T>(t: SeedRefs, fn: (c: PoolClient) => Promise<T>, userId = t.userId): Promise<T> => withTenant(appUser, t.accountId, userId, undefined, fn);
  const raise = (t: SeedRefs, seenHead = THEIRS) => asWorker(t, (c) => raiseBranchPushedByPerson(c, { workItemId: t.workItemId, seenHead }));
  const push = async (t: SeedRefs) => (await admin.query<{ state: string; managed_by_person_at: Date | null; branch: string }>('SELECT state, managed_by_person_at, branch FROM plane_pushes WHERE work_item_id = $1', [t.workItemId])).rows[0]!;
  const rowsOf = async (t: SeedRefs) => (await admin.query<{ id: string; state: string; origin: string; seen_head: string; created_by: string | null }>("SELECT id, state, origin, seen_head, created_by FROM setup_requests WHERE work_item_id = $1 AND kind = 'branch_pushed_by_person' ORDER BY created_at, id", [t.workItemId])).rows;
  const hold = (t: SeedRefs) => asWorker(t, (c) => setupHoldFor(c, t.workItemId));
  const restarts = async (t: SeedRefs) => (await admin.query("SELECT id FROM run_action_requests WHERE account_id = $1 AND kind = 'advance_work_item' AND target_id = $2", [t.accountId, t.workItemId])).rows;
  const raised = async (t: SeedRefs, seenHead = THEIRS): Promise<SetupRequest> => {
    const out = await raise(t, seenHead);
    if (out.kind === 'not_applicable') throw new Error('expected a request');
    return out.request;
  };
  const show = (r: SetupRequest) => `${setupRequestTitle(r.kind, r.target, r.envName)}\n${r.reason}`;

  it('raises one request from what it saw: derived, no creator, the seen head stored, the item held, the push record waiting', async () => {
    const out = await raise(A);
    expect(out.kind).toBe('raised');
    const r = (out as { request: SetupRequest }).request;
    const { branch } = await push(A);
    expect(r).toMatchObject({ kind: 'branch_pushed_by_person', origin: 'derived', createdBy: null, state: 'open', seenHead: THEIRS, workItemId: A.workItemId, repoId: A.repoId, target: `${branch} on acme/widgets-public` });
    expect(await hold(A)).toBe('setup_request_open');
    expect(await push(A)).toMatchObject({ state: 'waiting_person_pushed', managed_by_person_at: null });
    // Words a person reads: the full branch and repository, short ids only, nothing raw.
    const words = show(r);
    expect(words).toContain(`Someone pushed to ${branch} on acme/widgets-public`);
    expect(words).toContain(`It is now at ${THEIRS.slice(0, 7)}; the cloud last pushed ${STAMP.slice(0, 7)}.`);
    expect(words).toContain('Nothing was overwritten, and the item is paused.');
    expect(words).not.toMatch(/choose|mark done/i);
    expect(words).not.toMatch(/null|undefined|\[object|public_branch_moved|branch_pushed_by_person/);
    expect(words).not.toContain(THEIRS);
  });

  it('is idempotent: the same head again changes nothing, and a newer push moves what the person sees in the same request', async () => {
    const first = await raised(A);
    const again = await raise(A);
    expect(again).toMatchObject({ kind: 'unchanged', request: { id: first.id, seenHead: THEIRS } });
    expect(await rowsOf(A)).toHaveLength(1);
    const later = await raise(A, THEIRS_LATER);
    expect(later.kind).toBe('refreshed');
    const r = (later as { request: SetupRequest }).request;
    expect(r).toMatchObject({ id: first.id, state: 'open', seenHead: THEIRS_LATER });
    expect(r.reason).toContain(`It is now at ${THEIRS_LATER.slice(0, 7)}`);
    expect(r.reason).not.toContain(THEIRS.slice(0, 7));
    expect(await rowsOf(A)).toEqual([expect.objectContaining({ id: first.id, state: 'open', seen_head: THEIRS_LATER })]);
  });

  it('two raises at once make one request', async () => {
    const outs = await Promise.all([raise(A), raise(A, THEIRS_LATER)]);
    expect(outs.every((o) => o.kind !== 'not_applicable')).toBe(true);
    expect(await rowsOf(A)).toHaveLength(1);
  });

  it('raises nothing when the facts do not hold: no push record, the branch at the pushed head, a person already manages it, or the pull request is not open', async () => {
    expect(await raise(B)).toEqual({ kind: 'not_applicable' });
    expect(await raise(A, STAMP)).toEqual({ kind: 'not_applicable' });
    expect(await rowsOf(A)).toEqual([]);
    for (const [name, over] of [['managed', { managed: true }], ['closed', { state: 'pr_closed' }]] as const) {
      const C = await seedAccount(admin, randomUUID());
      await paired(C, over);
      expect(await raise(C), name).toEqual({ kind: 'not_applicable' });
      expect(await rowsOf(C), name).toEqual([]);
    }
  });

  it('a model cannot raise or propose it, and a malformed head or item is refused in words', async () => {
    await expect(asPerson(A, (c) => proposeSetupRequest(c, { userId: A.userId, repoId: A.repoId, workItemId: A.workItemId, kind: 'branch_pushed_by_person' as never, target: 'fx/p-1', reason: 'x' }))).rejects.toMatchObject({ code: 'invalid_input', field: 'kind' });
    await expect(raise(A, 'not-a-sha')).rejects.toMatchObject({ code: 'invalid_input', field: 'seen_head' });
    await expect(asWorker(A, (c) => raiseBranchPushedByPerson(c, { workItemId: 'nope', seenHead: THEIRS }))).rejects.toBeInstanceOf(SetupRequestError);
  });

  describe('Mark done does not answer it', () => {
    it('is refused before anything is written, and the request, the push record and the item are exactly as they were', async () => {
      const r = await raised(A);
      const signal = createRecordingRunActionSignal();
      const before = await admin.query('SELECT * FROM setup_requests WHERE id = $1', [r.id]);
      const pushBefore = await push(A);
      await expect(markSetupRequestDone({ pool: appUser, envSource: unavailableVercelEnvSource, signal }, { accountId: A.accountId, userId: A.userId, id: r.id })).rejects.toMatchObject({ code: 'not_markable' });
      expect((await admin.query('SELECT * FROM setup_requests WHERE id = $1', [r.id])).rows).toEqual(before.rows);
      expect(await push(A)).toEqual(pushBefore);
      expect(await restarts(A)).toEqual([]);
      expect(signal.sent).toEqual([]);
      expect(await hold(A)).toBe('setup_request_open');
    });

    it('has its own sentence, which says what works today and never says Mark done; a closed one has none', async () => {
      const r = await raised(A);
      const sentence = statusSentence(r, { checksAvailable: true });
      expect(sentence).toBe(COPY_BRANCH_PUSHED);
      expect(statusSentence(r, { checksAvailable: false })).toBe(COPY_BRANCH_PUSHED);
      expect(sentence).toMatch(/withdraw/i);
      expect(sentence).toMatch(/move the branch back/i);
      expect(sentence).not.toMatch(/mark done|null|undefined/i);
      const withdrawn = await asPerson(A, (c) => resolveSetupRequest(c, { id: r.id, userId: A.userId, to: 'withdrawn' }));
      expect(statusSentence(withdrawn, { checksAvailable: true })).toBeNull();
    });
  });

  describe('Keep', () => {
    it('closes the request as the person\'s answer, restarts the item once, and records that a person manages the branch; a second click changes nothing', async () => {
      const r = await raised(A);
      const out = await asPerson(A, (c) => keepBranchPushedByPerson(c, { id: r.id, userId: A.userId }));
      expect(out).toMatchObject({ changed: true, request: { id: r.id, state: 'done', resolution: 'marked_done', resolvedBy: A.userId, seenHead: THEIRS } });
      expect(out.restart).not.toBeNull();
      expect(await hold(A)).toBeNull();
      const p = await push(A);
      expect(p.state).toBe('managed_by_person');
      expect(p.managed_by_person_at).toBeInstanceOf(Date);
      expect(await restarts(A)).toHaveLength(1);
      expect(PUBLIC_BRANCH_MANAGED_SENTENCE).toBe('Public branch managed by a person');
      const again = await asPerson(A, (c) => keepBranchPushedByPerson(c, { id: r.id, userId: A.userId }));
      expect(again).toMatchObject({ changed: false, restart: null });
      expect(await restarts(A)).toHaveLength(1);
    });

    it('is a person\'s click only: a member who is not an owner or admin, or a request that is another kind, changes nothing', async () => {
      const r = await raised(A);
      const member = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [member, `${member}@example.test`]);
      await admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')", [A.accountId, member]);
      await expect(asPerson(A, (c) => keepBranchPushedByPerson(c, { id: r.id, userId: member }), member)).rejects.toBeDefined();
      expect((await getRequest(A, r.id)).state).toBe('open');
      expect((await push(A)).state).toBe('waiting_person_pushed');
      const other = await asPerson(A, (c) => proposeSetupRequest(c, { userId: A.userId, repoId: A.repoId, workItemId: A.workItemId, kind: 'overlay_path_missing', target: 'docs/ops', reason: 'add it' }));
      await expect(asPerson(A, (c) => keepBranchPushedByPerson(c, { id: other.id, userId: A.userId }))).rejects.toMatchObject({ code: 'invalid_input', field: 'id' });
    });

    it('undo: an owner clears "managed by a person", the platform may update again, and a branch that moved since is asked about again', async () => {
      const r = await raised(A);
      await asPerson(A, (c) => keepBranchPushedByPerson(c, { id: r.id, userId: A.userId }));
      // A raise while a person manages the branch is not applicable: the platform does not ask again.
      expect(await raise(A, THEIRS_LATER)).toEqual({ kind: 'not_applicable' });
      const member = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [member, `${member}@example.test`]);
      await admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')", [A.accountId, member]);
      expect(await asPerson(A, (c) => releaseManagedBranch(c, { workItemId: A.workItemId, userId: member }), member)).toBe(false);
      expect((await push(A)).state).toBe('managed_by_person');
      expect(await asPerson(A, (c) => releaseManagedBranch(c, { workItemId: A.workItemId, userId: A.userId }))).toBe(true);
      expect(await push(A)).toMatchObject({ state: 'pr_opened', managed_by_person_at: null });
      expect(await asPerson(A, (c) => releaseManagedBranch(c, { workItemId: A.workItemId, userId: A.userId }))).toBe(false);
      const second = await raised(A, THEIRS_LATER);
      expect(second.id).not.toBe(r.id);
      expect(await rowsOf(A)).toHaveLength(2);
      expect(await hold(A)).toBe('setup_request_open');
    });
  });

  describe('Withdraw and the branch coming back', () => {
    it('Withdraw is the person\'s answer: the item stays paused, the branch is untouched, and the push record still waits', async () => {
      const r = await raised(A);
      const out = await asPerson(A, (c) => resolveSetupRequest(c, { id: r.id, userId: A.userId, to: 'withdrawn' }));
      expect(out).toMatchObject({ state: 'withdrawn', resolution: 'withdrawn', resolvedBy: A.userId });
      expect(await hold(A)).toBe('setup_request_withdrawn');
      expect(await push(A)).toMatchObject({ state: 'waiting_person_pushed', managed_by_person_at: null });
      // The next fix round that still finds the branch moved asks again (a new open request); it never reopens the withdrawn one.
      const next = await raised(A, THEIRS_LATER);
      expect(next.id).not.toBe(r.id);
      expect((await getRequest(A, r.id)).state).toBe('withdrawn');
    });

    it('a branch reset to the pushed head closes the request as cleared and the push record goes back to an open pull request', async () => {
      const r = await raised(A);
      expect(await asWorker(A, (c) => clearBranchPushedByPerson(c, { workItemId: A.workItemId }))).toBe(true);
      expect(await getRequest(A, r.id)).toMatchObject({ state: 'done', resolution: 'condition_cleared', resolvedBy: null });
      expect(await hold(A)).toBeNull();
      expect((await push(A)).state).toBe('pr_opened');
      expect(await asWorker(A, (c) => clearBranchPushedByPerson(c, { workItemId: A.workItemId }))).toBe(false);
    });
  });

  describe('row security and the guard', () => {
    it('another account sees nothing and raises nothing for this item', async () => {
      const mine = await raised(A);
      expect((await asWorker(B, (c) => listSetupRequests(c, { state: 'all' }))).requests).toEqual([]);
      expect(await asWorker(B, (c) => raiseBranchPushedByPerson(c, { workItemId: A.workItemId, seenHead: THEIRS_LATER }))).toEqual({ kind: 'not_applicable' });
      await expect(asWorker(B, (c) => getSetupRequest(c, mine.id))).rejects.toMatchObject({ name: 'NotFoundError' });
      expect(await rowsOf(A)).toHaveLength(1);
    });

    it('a write with no person is admitted only for this kind with a public push record in the same account', async () => {
      const insert = (t: SeedRefs, over: { origin?: string; kind?: string; work?: string | null; repo?: string; seen?: string | null } = {}) =>
        asWorker(t, (c) =>
          c.query(
            `INSERT INTO setup_requests (account_id, repo_id, work_item_id, origin, kind, target, reason, seen_head)
             VALUES ($1, $2, $3, $4, $5, 'x on y/z', 'because', $6)`,
            [t.accountId, over.repo ?? t.repoId, over.work === undefined ? t.workItemId : over.work, over.origin ?? 'derived', over.kind ?? 'branch_pushed_by_person', over.seen === undefined ? THEIRS : over.seen],
          ),
        );
      // Admitted (control): what the raise itself writes.
      await insert(A);
      // The same row in an account whose item has no push record, or another account's item and repo.
      await expect(insert(B)).rejects.toThrow(/row-level security/);
      await expect(insert(B, { work: A.workItemId, repo: A.repoId })).rejects.toThrow(/row-level security/);
      // Another kind without a person, an agent row without a person, and a parity row without a person.
      await expect(insert(A, { kind: 'overlay_path_missing', seen: null })).rejects.toThrow(/row-level security/);
      await expect(insert(A, { origin: 'agent' })).rejects.toThrow();
      await expect(insert(A, { kind: 'parity_drift', work: null, seen: null })).rejects.toThrow(/row-level security/);
      // The shape: a head that is not a commit id, or none at all, is refused by the table.
      await expect(insert(A, { seen: 'zz' })).rejects.toThrow();
      await expect(insert(A, { seen: null })).rejects.toThrow();
    });

    it('a no-person update may refresh or clear this kind only, and never answer for a person; an agent row cannot take a seen head', async () => {
      const r = await raised(A);
      // Answering as someone: a resolver with no person is refused by the table.
      await expect(asWorker(A, (c) => c.query("UPDATE setup_requests SET state = 'withdrawn', resolution = 'withdrawn' WHERE id = $1", [r.id]))).rejects.toThrow();
      await expect(asWorker(A, (c) => c.query("UPDATE setup_requests SET state = 'done', resolution = 'marked_done' WHERE id = $1", [r.id]))).rejects.toThrow();
      // The identity of the request never moves.
      await expect(admin.query("UPDATE setup_requests SET kind = 'env_var' WHERE id = $1", [r.id])).rejects.toThrow();
      // A seen head only moves while the request is open.
      await asWorker(A, (c) => clearBranchPushedByPerson(c, { workItemId: A.workItemId }));
      await expect(admin.query('UPDATE setup_requests SET seen_head = $2 WHERE id = $1', [r.id, THEIRS_LATER])).rejects.toThrow(/setup_requests_frozen/);
      // An agent request has no seen head, so it cannot carry one.
      const agent = await asPerson(A, (c) => proposeSetupRequest(c, { userId: A.userId, repoId: A.repoId, workItemId: A.workItemId, kind: 'overlay_path_missing', target: 'docs/ops', reason: 'add it' }));
      await expect(admin.query('UPDATE setup_requests SET seen_head = $2 WHERE id = $1', [agent.id, THEIRS])).rejects.toThrow();
    });

    it('row security stays forced on the table', async () => {
      const { rows } = await admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'setup_requests'");
      expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    });
  });

  const getRequest = (t: SeedRefs, id: string) => asWorker(t, (c) => getSetupRequest(c, id));
});

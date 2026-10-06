import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import type { RepoPermission } from '@fx/trust';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { AUTHOR_CHECK_DEADLINE_MS, MAX_AUTHOR_CHECK_ITEMS, checkRetryAuthor, type IssueAuthorLookup, type IssueAuthorRequest, type IssueAuthorResult } from '../../src/runActions/authorCheck.js';

/** D#31 API-6b-3 criterion X1: the retry author check against real Postgres and a fake GitHub lookup. */
describe('checkRetryAuthor (pg)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let a: SeedRefs;
  let repoId: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    repoId = randomUUID();
    await admin.query(
      `INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, 9001, 'team', 'acme', 'widgets')`,
      [repoId, a.accountId],
    );
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appPool.end();
  });

  let nextNumber = 100;
  interface ItemOpts {
    provenance?: 'internal' | 'external';
    parent?: string | null;
    kind?: string | null;
    ghNumber?: number | null;
    repo?: string | null;
  }
  async function item(o: ItemOpts = {}): Promise<{ id: string; ghNumber: number | null }> {
    const id = randomUUID();
    const ghNumber = o.ghNumber === undefined ? nextNumber++ : o.ghNumber;
    await admin.query(
      `INSERT INTO work_items (id, account_id, kind, provenance, parent_id, repo_id, gh_number) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, a.accountId, o.kind === undefined ? 'issue' : o.kind, o.provenance ?? 'external', o.parent ?? null, o.repo === undefined ? repoId : o.repo, ghNumber],
    );
    return { id, ghNumber };
  }

  /** A fake GitHub: `authors` maps issue number to a result (or an Error to throw). Records every call. */
  function fake(authors: Map<number, IssueAuthorResult | Error>) {
    const calls: IssueAuthorRequest[] = [];
    const poolStates: Array<{ total: number; idle: number }> = [];
    const lookup: IssueAuthorLookup = async (req) => {
      calls.push(req);
      poolStates.push({ total: appPool.totalCount, idle: appPool.idleCount });
      const r = authors.get(req.number);
      if (!r) return { status: 'missing' };
      if (r instanceof Error) throw r;
      return r;
    };
    return { lookup, calls, poolStates };
  }
  const by = (login: string, permission: RepoPermission): IssueAuthorResult => ({ status: 'found', login, permission });
  const check = (workItemId: string, lookup: IssueAuthorLookup | null, allowlist: readonly string[] = []) =>
    checkRetryAuthor({ pool: appPool, accountId: a.accountId, userId: a.userId, workItemId, lookup, allowlist });

  it('(a) an internal chain is trusted with zero lookup calls, even with no lookup registered', async () => {
    const root = await item({ provenance: 'internal' });
    const child = await item({ provenance: 'internal', parent: root.id });
    const f = fake(new Map());
    expect(await check(child.id, f.lookup)).toBe('trusted');
    expect(f.calls).toEqual([]);
    expect(await check(child.id, null)).toBe('trusted');
  });

  it.each(['admin', 'maintain', 'write'] as const)('(b) an external item whose author holds %s is trusted', async (permission) => {
    const w = await item();
    const f = fake(new Map([[w.ghNumber!, by('octo', permission)]]));
    expect(await check(w.id, f.lookup)).toBe('trusted');
    expect(f.calls).toEqual([{ repoId, owner: 'acme', name: 'widgets', number: w.ghNumber, signal: expect.any(AbortSignal) }]);
  });

  it.each(['triage', 'read', 'none'] as const)('(c) an external item whose author holds %s is untrusted', async (permission) => {
    const w = await item();
    const f = fake(new Map([[w.ghNumber!, by('octo', permission)]]));
    expect(await check(w.id, f.lookup)).toBe('untrusted');
  });

  it('(d) an allowlisted author is trusted whatever their permission and however the login is cased', async () => {
    const w = await item();
    const f = fake(new Map([[w.ghNumber!, by('OctoCat', 'none')]]));
    expect(await check(w.id, f.lookup, ['octocat'])).toBe('trusted');
    expect(await check(w.id, f.lookup, ['someone-else'])).toBe('untrusted');
  });

  it('(e) an internal child of an external parent is checked and uses the parent\'s author', async () => {
    const parent = await item();
    const child = await item({ provenance: 'internal', parent: parent.id });
    const f = fake(new Map([[parent.ghNumber!, by('octo', 'read')]]));
    expect(await check(child.id, f.lookup)).toBe('untrusted');
    expect(f.calls.map((c) => c.number)).toEqual([parent.ghNumber]);
    const g = fake(new Map([[parent.ghNumber!, by('octo', 'write')]]));
    expect(await check(child.id, g.lookup)).toBe('trusted');
  });

  it('(f) two external items in the chain, one failing, is untrusted; both passing is trusted', async () => {
    const top = await item();
    const mid = await item({ parent: top.id });
    const leaf = await item({ provenance: 'internal', parent: mid.id });
    const f = fake(new Map([[top.ghNumber!, by('a', 'write')], [mid.ghNumber!, by('b', 'read')]]));
    expect(await check(leaf.id, f.lookup)).toBe('untrusted');
    const g = fake(new Map([[top.ghNumber!, by('a', 'write')], [mid.ghNumber!, by('b', 'admin')]]));
    expect(await check(leaf.id, g.lookup)).toBe('trusted');
    expect(g.calls).toHaveLength(2);
  });

  it('(g) an external item missing its number, its repo, or its repo\'s owner/name is untrusted with no lookup call', async () => {
    const noRepoName = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product) VALUES ($1, $2, 9002, 'team')`, [noRepoName, a.accountId]);
    for (const w of [await item({ ghNumber: null }), await item({ repo: null }), await item({ repo: noRepoName })]) {
      const f = fake(new Map());
      expect(await check(w.id, f.lookup)).toBe('untrusted');
      expect(f.calls).toEqual([]);
    }
  });

  it('(h) an external item of kind discussion is untrusted with no lookup call', async () => {
    const w = await item({ kind: 'discussion' });
    const f = fake(new Map([[w.ghNumber!, by('octo', 'admin')]]));
    expect(await check(w.id, f.lookup)).toBe('untrusted');
    expect(f.calls).toEqual([]);
  });

  it('(i) a broken chain with no external item (a cycle, or a parent that cannot be seen) is untrusted with no lookup call', async () => {
    const x = await item({ provenance: 'internal' });
    const y = await item({ provenance: 'internal', parent: x.id });
    await admin.query(`UPDATE work_items SET parent_id = $2 WHERE id = $1`, [x.id, y.id]);
    // A parent row that does not exist (bypassing the FK triggers): the walk stops short of a root.
    const orphan = await item({ provenance: 'internal' });
    await admin.query('BEGIN');
    try {
      await admin.query(`SET LOCAL session_replication_role = replica`);
      await admin.query(`UPDATE work_items SET parent_id = $2 WHERE id = $1`, [orphan.id, randomUUID()]);
      await admin.query('COMMIT');
    } catch (err) {
      await admin.query('ROLLBACK');
      throw err;
    }
    for (const start of [x.id, y.id, orphan.id]) {
      const f = fake(new Map());
      expect(await check(start, f.lookup)).toBe('untrusted');
      expect(f.calls).toEqual([]);
    }
  });

  it('(j) a lookup that throws, rejects with a timeout, or is null is unavailable, never trusted', async () => {
    const w = await item();
    for (const failure of [new Error('boom'), Object.assign(new Error('timed out'), { name: 'TimeoutError' })]) {
      const f = fake(new Map([[w.ghNumber!, failure]]));
      expect(await check(w.id, f.lookup)).toBe('unavailable');
    }
    expect(await check(w.id, null)).toBe('unavailable');
  });

  it('(k) an issue the lookup reports as missing (404) is untrusted, not unavailable', async () => {
    const w = await item();
    const f = fake(new Map([[w.ghNumber!, { status: 'missing' }]]));
    expect(await check(w.id, f.lookup)).toBe('untrusted');
  });

  it('(l) no pool client is checked out while the lookup runs', async () => {
    const w = await item();
    const f = fake(new Map([[w.ghNumber!, by('octo', 'write')]]));
    expect(await check(w.id, f.lookup)).toBe('trusted');
    expect(f.poolStates).toHaveLength(1);
    for (const s of f.poolStates) expect(s.total).toBe(s.idle);
  });
  /** A chain of n external issue items, the leaf last; returns the leaf id and every item's number. */
  async function externalChain(n: number, kinds: string[] = []): Promise<{ leaf: string; numbers: number[] }> {
    let parent: string | null = null;
    const numbers: number[] = [];
    let leaf = '';
    for (let i = 0; i < n; i++) {
      const w = await item({ parent, kind: kinds[i] ?? 'issue' });
      numbers.push(w.ghNumber!);
      parent = w.id;
      leaf = w.id;
    }
    return { leaf, numbers };
  }

  it('(m) the cap: more than 3 external items is unavailable with zero lookup calls; exactly 3 is checked', async () => {
    expect(MAX_AUTHOR_CHECK_ITEMS).toBe(3);
    const four = await externalChain(4);
    const f = fake(new Map(four.numbers.map((n) => [n, by('octo', 'write')] as const)));
    expect(await check(four.leaf, f.lookup)).toBe('unavailable');
    expect(f.calls).toEqual([]);
    const three = await externalChain(3);
    const g = fake(new Map(three.numbers.map((n) => [n, by('octo', 'write')] as const)));
    expect(await check(three.leaf, g.lookup)).toBe('trusted');
    expect(g.calls).toHaveLength(3);
  });

  it('(n) a definite untrusted answer wins over the cap: 4 external items with a discussion among them', async () => {
    const chain = await externalChain(4, ['issue', 'discussion', 'issue', 'issue']);
    const f = fake(new Map(chain.numbers.map((n) => [n, by('octo', 'write')] as const)));
    expect(await check(chain.leaf, f.lookup)).toBe('untrusted');
    expect(f.calls).toEqual([]);
  });

  describe('the deadline', () => {
    // A pool with no idle timer, warmed before the fake clock starts, so getTimerCount() sees only the check's own timers.
    let timerPool: Pool;
    beforeAll(async () => {
      timerPool = createPool(process.env.DATABASE_URL_APP_USER!, { idleTimeoutMillis: 0 });
      (await timerPool.connect()).release();
    });
    afterAll(async () => {
      await timerPool.end();
    });
    afterEach(() => {
      vi.useRealTimers();
    });
    const timedCheck = (workItemId: string, lookup: IssueAuthorLookup) =>
      checkRetryAuthor({ pool: timerPool, accountId: a.accountId, userId: a.userId, workItemId, lookup, allowlist: [] });
    const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

    it('(o) a lookup that never settles is unavailable at exactly 20 s, its signal is aborted, the next item is never looked up, no timer is left', async () => {
      expect(AUTHOR_CHECK_DEADLINE_MS).toBe(20_000);
      const chain = await externalChain(2);
      const signals: Array<AbortSignal | undefined> = [];
      const lookup: IssueAuthorLookup = (req) => {
        signals.push(req.signal);
        return new Promise<IssueAuthorResult>(() => {});
      };
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      let verdict: string | undefined;
      const pending = timedCheck(chain.leaf, lookup).then((v) => (verdict = v));
      for (const t0 = performance.now(); signals.length === 0 && performance.now() - t0 < 5_000; ) await flush();
      expect(signals).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(19_999);
      expect(verdict).toBeUndefined();
      expect(signals[0]!.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(verdict).toBe('unavailable');
      expect(signals[0]!.aborted).toBe(true);
      expect(signals).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('(p) no timer is left after a trusted check', async () => {
      const w = await item();
      const f = fake(new Map([[w.ghNumber!, by('octo', 'write')]]));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const verdict = await timedCheck(w.id, f.lookup);
      expect(verdict).toBe('trusted');
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

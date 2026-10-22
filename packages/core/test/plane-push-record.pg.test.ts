import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { withTenant } from '../src/tenancy/withTenant.js';
import {
  PlanePushRecordError,
  cleanRefusals,
  derivePlanePush,
  pairingDigest,
  readPlanePush,
  recordVerifiedOutcome,
  stampPlanePush,
} from '../src/repos/planePushRecord.js';

/** D#598 P1f-1 against a real Postgres: the stamp at build start, recorded outcomes, and the derive-from-GitHub read. */
describe('plane push record (D#598 P1f-1)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  const SHA1 = '1'.repeat(40);
  const SHA2 = '2'.repeat(40);

  async function item(account: SeedRefs): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'feature', 'internal')`, [id, account.accountId, account.repoId]);
    return id;
  }
  async function pair(account: SeedRefs, over: Partial<{ code_repo: string; globs: string[] }> = {}): Promise<void> {
    await admin.query(
      `INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, $3, $4)
       ON CONFLICT (repo_id) DO UPDATE SET code_repo = EXCLUDED.code_repo, overlay_globs = EXCLUDED.overlay_globs`,
      [account.repoId, account.accountId, over.code_repo ?? 'acme/pub', over.globs ?? ['docs/ops/']],
    );
  }
  const run = <T>(account: SeedRefs, fn: (c: PoolClient) => Promise<T>) => withTenant(appUserPool, account.accountId, fn);
  const stamp = (account: SeedRefs, workItemId: string, replay = false) =>
    run(account, (c) => stampPlanePush(c, { accountId: account.accountId, workItemId, repoId: account.repoId, ...(replay ? { replay } : {}) }));
  const count = async (workItemId: string) => Number((await admin.query(`SELECT count(*) FROM plane_pushes WHERE work_item_id = $1`, [workItemId])).rows[0].count);

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  it('an unpaired repo writes no row at all (row count 0)', async () => {
    const it1 = await item(b);
    expect(await stamp(b, it1)).toBeNull();
    expect(await count(it1)).toBe(0);
    expect(await run(b, (c) => readPlanePush(c, b.accountId, it1))).toBeNull();
  });

  it('a paired repo gets one row: the repo, the digest and the branch fx/p-<id>; stamping again does not add a second', async () => {
    await pair(a);
    const it1 = await item(a);
    const row = (await stamp(a, it1))!;
    expect(row).toMatchObject({ codeRepo: 'acme/pub', state: 'building', headSha: null, prNumber: null, accountId: a.accountId, workItemId: it1 });
    expect(row.branch).toBe(`fx/p-${row.id}`);
    expect(row.pairingDigest).toBe(pairingDigest({ codeRepo: 'acme/pub', overlayGlobs: ['docs/ops/'], identifierRulesPath: null, planDataRulesPath: null }));
    const again = (await stamp(a, it1))!;
    expect(again.id).toBe(row.id);
    expect(await count(it1)).toBe(1);
  });

  it('the digest moves with the repo, the globs and the rule paths, not with the case of the repo name', () => {
    const base = { codeRepo: 'acme/pub', overlayGlobs: ['a', 'b'], identifierRulesPath: null, planDataRulesPath: null };
    const d = pairingDigest(base);
    expect(pairingDigest({ ...base, codeRepo: 'ACME/Pub' })).toBe(d);
    for (const over of [{ codeRepo: 'acme/other' }, { overlayGlobs: ['b', 'a'] }, { overlayGlobs: ['a'] }, { identifierRulesPath: 'r/i.txt' }, { planDataRulesPath: 'r/p.json' }]) {
      expect(pairingDigest({ ...base, ...over })).not.toBe(d);
    }
  });

  it('a new build re-stamps the digest and clears an earlier refusal; a replay of the same step leaves the row as it is', async () => {
    await pair(a, { globs: ['docs/ops/'] });
    const it1 = await item(a);
    const first = (await stamp(a, it1))!;
    await run(a, (c) => recordVerifiedOutcome(c, { accountId: a.accountId, id: first.id, outcome: { state: 'refused', code: 'scan_refused', refusals: [{ kind: 'overlay_path', place: 'docs/ops/x.md', rule_key: 'overlay' }] } }));
    await pair(a, { globs: ['docs/ops/', 'infra/'] });
    const replayed = (await stamp(a, it1, true))!;
    expect(replayed).toMatchObject({ state: 'refused', code: 'scan_refused', pairingDigest: first.pairingDigest });
    const rebuilt = (await stamp(a, it1))!;
    expect(rebuilt.id).toBe(first.id);
    expect(rebuilt).toMatchObject({ state: 'building', code: null, refusals: [] });
    expect(rebuilt.pairingDigest).not.toBe(first.pairingDigest);
    await pair(a);
  });

  it('records a verified outcome for each state, and a settled row is not moved back by a late one', async () => {
    const row = (await stamp(a, await item(a)))!;
    const rec = (outcome: Parameters<typeof recordVerifiedOutcome>[1]['outcome']) => run(a, (c) => recordVerifiedOutcome(c, { accountId: a.accountId, id: row.id, outcome }));
    expect(await rec({ state: 'scanning' })).toMatchObject({ state: 'scanning' });
    expect(await rec({ state: 'no_public_change' })).toMatchObject({ state: 'no_public_change' });
    expect(await rec({ state: 'pushed', headSha: SHA1, tipSha: SHA2 })).toMatchObject({ state: 'pushed', headSha: SHA1, tipSha: SHA2 });
    expect(await rec({ state: 'pushed_pr_not_opened', headSha: SHA1, tipSha: SHA2 })).toMatchObject({ state: 'pushed_pr_not_opened', prNumber: null });
    expect(await rec({ state: 'pr_opened', headSha: SHA1, tipSha: SHA2, prNumber: 9, prUrl: 'https://github.com/acme/pub/pull/9' })).toMatchObject({ state: 'pr_opened', prNumber: 9 });
    expect(await rec({ state: 'refused', code: 'push_failed' })).toBeNull();
    expect(await run(a, (c) => readPlanePush(c, a.accountId, row.workItemId))).toMatchObject({ state: 'pr_opened', code: null, prNumber: 9, headSha: SHA1 });
  });

  it('a pr_opened outcome is recorded only with the address of that pull request in the paired repository; any other address is refused and nothing is written', async () => {
    const row = (await stamp(a, await item(a)))!;
    const rec = (prNumber: number, prUrl: string) =>
      run(a, (c) => recordVerifiedOutcome(c, { accountId: a.accountId, id: row.id, outcome: { state: 'pr_opened', headSha: SHA1, tipSha: SHA2, prNumber, prUrl } }));
    for (const [n, url] of [
      [9, 'https://github.com/acme/pub/pull/10'],
      [9, 'https://github.com/evil/pub/pull/9'],
      [9, 'https://github.com/acme/pub/pull/9/files'],
      [9, 'https://evil.example/acme/pub/pull/9'],
    ] as const) {
      await expect(rec(n, url), url).rejects.toMatchObject({ name: 'PlanePushRecordError', code: 'bad_outcome' });
    }
    expect((await admin.query(`SELECT state, pr_number, pr_url FROM plane_pushes WHERE id = $1`, [row.id])).rows[0]).toEqual({ state: 'building', pr_number: null, pr_url: null });
    // control: the same row takes the right address, whatever case GitHub spells the repository in.
    expect(await rec(9, 'https://github.com/Acme/Pub/pull/9')).toMatchObject({ state: 'pr_opened', prNumber: 9 });
  });

  it('a row with managed_by_person_at set is settled even when its state is not: a late outcome writes nothing', async () => {
    const row = (await stamp(a, await item(a)))!;
    await admin.query(`UPDATE plane_pushes SET managed_by_person_at = now() WHERE id = $1`, [row.id]);
    const before = (await admin.query(`SELECT state FROM plane_pushes WHERE id = $1`, [row.id])).rows[0].state;
    expect(before).toBe('building');
    const late = await run(a, (c) => recordVerifiedOutcome(c, { accountId: a.accountId, id: row.id, outcome: { state: 'pushed', headSha: SHA1, tipSha: SHA2 } }));
    expect(late).toBeNull();
    expect((await admin.query(`SELECT state, head_sha FROM plane_pushes WHERE id = $1`, [row.id])).rows[0]).toEqual({ state: 'building', head_sha: null });
    // control: the same call on a row without the timestamp does record.
    const open = (await stamp(a, await item(a)))!;
    expect(await run(a, (c) => recordVerifiedOutcome(c, { accountId: a.accountId, id: open.id, outcome: { state: 'pushed', headSha: SHA1, tipSha: SHA2 } }))).toMatchObject({ state: 'pushed' });
  });

  it('one record per item and public repo whatever the case of the repo name: a pairing re-saved in other case adds no second row', async () => {
    const it1 = await item(a);
    const first = (await stamp(a, it1))!;
    await pair(a, { code_repo: 'Acme/PUB' });
    const again = (await stamp(a, it1))!;
    expect(again.id).toBe(first.id);
    expect(again.codeRepo).toBe(first.codeRepo);
    expect(await count(it1)).toBe(1);
    await expect(
      admin.query(`INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest) VALUES ($1, $2, $3, 'ACME/pub', $4)`, [a.accountId, it1, a.repoId, 'a'.repeat(64)]),
    ).rejects.toMatchObject({ code: '23505' });
    await pair(a);
  });

  it('refuses an outcome that is missing what its state needs, with a typed error, and writes nothing', async () => {
    const row = (await stamp(a, await item(a)))!;
    const rec = (outcome: Parameters<typeof recordVerifiedOutcome>[1]['outcome']) => run(a, (c) => recordVerifiedOutcome(c, { accountId: a.accountId, id: row.id, outcome }));
    for (const outcome of [
      { state: 'pushed' as const },
      { state: 'pushed' as const, headSha: 'abc', tipSha: SHA2 },
      { state: 'pr_opened' as const, headSha: SHA1, tipSha: SHA2 },
      { state: 'refused' as const },
      { state: 'refused' as const, code: 'Not A Code' },
      { state: 'scanning' as const, code: 'x_y' },
      { state: 'pushed' as const, headSha: SHA1, tipSha: SHA2, prNumber: 3 },
    ]) {
      await expect(rec(outcome), JSON.stringify(outcome)).rejects.toBeInstanceOf(PlanePushRecordError);
    }
    expect(await run(a, (c) => readPlanePush(c, a.accountId, row.workItemId))).toMatchObject({ state: 'building', headSha: null });
  });

  it('refusals keep only kind, place and rule key, at most 100, with no control characters', async () => {
    const row = (await stamp(a, await item(a)))!;
    const many = Array.from({ length: 150 }, (_, i) => ({ kind: 'identifier_hit', place: `src/f${i}.ts:3`, rule_key: 'identifier-rule#1', value: 'SECRET-MATCH', content: 'x' }) as never);
    const saved = (await run(a, (c) => recordVerifiedOutcome(c, { accountId: a.accountId, id: row.id, outcome: { state: 'refused', code: 'scan_refused', refusals: many } })))!;
    expect(saved.refusals).toHaveLength(100);
    expect(Object.keys(saved.refusals[0]!).sort()).toEqual(['kind', 'place', 'rule_key']);
    expect(JSON.stringify(saved)).not.toContain('SECRET-MATCH');
    expect(cleanRefusals([{ kind: 'Bad Kind!', place: 'a\nb\u0000c', rule_key: 'r'.repeat(500) }])).toEqual([{ kind: 'unknown', place: 'a b c', rule_key: 'r'.repeat(200) }]);
  });

  it('derive returns GitHub\'s head, says the stamp is stale when they differ, and never writes GitHub\'s value over the stamp', async () => {
    const row = (await stamp(a, await item(a)))!;
    await run(a, (c) => recordVerifiedOutcome(c, { accountId: a.accountId, id: row.id, outcome: { state: 'pushed', headSha: SHA1, tipSha: SHA2 } }));
    const seen: Array<{ codeRepo: string; branch: string }> = [];
    const port = (head: string | null) => ({ branchHead: async (i: { codeRepo: string; branch: string }) => (seen.push(i), head) });
    const same = (await run(a, (c) => derivePlanePush(c, { accountId: a.accountId, id: row.id }, port(SHA1))))!;
    expect(same).toMatchObject({ headSha: SHA1, stale: false });
    expect(seen[0]).toEqual({ codeRepo: 'acme/pub', branch: row.branch });
    const moved = (await run(a, (c) => derivePlanePush(c, { accountId: a.accountId, id: row.id }, port(SHA2))))!;
    expect(moved).toMatchObject({ headSha: SHA2, stale: true });
    expect(moved.row.headSha).toBe(SHA1);
    const gone = (await run(a, (c) => derivePlanePush(c, { accountId: a.accountId, id: row.id }, port(null))))!;
    expect(gone).toMatchObject({ headSha: null, stale: true });
    // The stored stamp is unchanged by all three.
    expect(await run(a, (c) => readPlanePush(c, a.accountId, row.workItemId))).toMatchObject({ headSha: SHA1, state: 'pushed' });
    // A failure to read GitHub is the caller's: it does not fall back to the stamp.
    await expect(run(a, (c) => derivePlanePush(c, { accountId: a.accountId, id: row.id }, { branchHead: async () => { throw new Error('down'); } }))).rejects.toThrow('down');
  });

  it('another account cannot read, derive or record a row', async () => {
    const row = (await stamp(a, await item(a)))!;
    expect(await run(b, (c) => derivePlanePush(c, { accountId: b.accountId, id: row.id }, { branchHead: async () => SHA1 }))).toBeNull();
    expect(await run(b, (c) => recordVerifiedOutcome(c, { accountId: b.accountId, id: row.id, outcome: { state: 'scanning' } }))).toBeNull();
    expect(await run(b, (c) => readPlanePush(c, b.accountId, row.workItemId))).toBeNull();
  });
});

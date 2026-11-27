import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { sweepTwins, type TwinParityCompute, type TwinParityJob, type TwinParityOutcome, type TwinWorkPorts } from '../../src/repos/twinSweep.js';
import { markTwinParityDue } from '../../src/repos/twinParityDue.js';
import { withTenant } from '../../src/tenancy/withTenant.js';

/**
 * [pg] D#845 ON-27d4b: the twin sweep as the real roles: the lists on the run-writer login, each twin under its own tenant. The check and the steps are fakes that record what they were handed; what the definers enforce (who may call, the lease,
 * the anchor) is packages/db/test/twin-work.pg.test.ts. Every case below fails if the sweep leaves out the call it names (see the mutants in the PR).
 */
const SWEEP_LOGIN = 'fx_twin_sweep_b_test';
const SHA = (c: string): string => c.repeat(40);
const OUT = (over: Partial<TwinParityOutcome> = {}): TwinParityOutcome => ({ result: 'in_parity', privateSha: SHA('a'), publicSha: SHA('b'), paths: [], pathCount: 0, publishCount: 0, syncCount: 0, conflictCount: 0, advanceSyncedTo: null, ...over });
const NOW = (): number => Date.now();

describe('twin sweep [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let writer: Pool;
  let A: SeedRefs;
  let B: SeedRefs;

  const twinFor = async (refs: SeedRefs, state: string, result: string | null, due: string | null, extra: { paths?: string[]; syncPr?: boolean } = {}) => {
    const tag = randomUUID().slice(0, 8);
    const repo = async (name: string): Promise<string> => {
      const id = randomUUID();
      await admin.query('INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, $4, $5, $6, $7)', [id, refs.accountId, refs.installationId, Math.floor(Math.random() * 1e9) + 10, 'team', 'acme', name]);
      return id;
    };
    const pub = await repo(`pub-${tag}`);
    const priv = await repo(`priv-${tag}`);
    const r = await withTenant(appPool, refs.accountId, refs.userId, async (c) => (await c.query<{ o_id: string }>('SELECT o_id FROM twin_record($1, $2, 777, $3)', [pub, priv, `priv-${tag}`])).rows[0]!);
    await admin.query('UPDATE repo_twins SET state = $2, published_private_sha = $3, synced_public_sha = $4 WHERE id = $1', [r.o_id, state, state === 'seeding' ? null : SHA('c'), state === 'seeding' ? null : SHA('d')]);
    if (extra.syncPr) await admin.query("UPDATE repo_twins SET sync_pr = 5, sync_head = $2 WHERE id = $1", [r.o_id, SHA('9')]).catch(() => undefined);
    if (result !== null || due !== null) {
      await admin.query(`INSERT INTO twin_parity_checks (twin_id, account_id, last_result, due_at, paths, path_count, sync_count) VALUES ($1, $2, $3, ${due ?? 'NULL'}, $4, $5, $6)`, [r.o_id, refs.accountId, result, extra.paths ?? [], (extra.paths ?? []).length, (extra.paths ?? []).length]);
    }
    return r.o_id;
  };
  const row = async (id: string) => (await admin.query('SELECT last_result, due_at, work_lease_until, mark_seq FROM twin_parity_checks WHERE twin_id = $1', [id])).rows[0];

  const ports = () => {
    const calls: string[] = [];
    const principals: Array<{ call: string; id: string; principal: unknown }> = [];
    const note = (call: string, principal: unknown, id: string): void => void principals.push({ call, id, principal });
    const p = {
      guard: vi.fn(async (pr, id: string) => (note('guard', pr, id), calls.push(`guard ${id}`), 'ok' as 'ok' | 'refused' | 'unavailable')),
      seed: { check: vi.fn(async (pr, id: string) => (note('seed.check', pr, id), calls.push(`seed.check ${id}`), 'not_ready')) },
      publish: { check: vi.fn(async (pr, id: string) => (note('publish.check', pr, id), calls.push(`publish.check ${id}`), 'not_ready')), issue: vi.fn(async (pr, id: string) => (note('publish.issue', pr, id), void calls.push(`publish.issue ${id}`))) },
      sync: {
        check: vi.fn(async (pr, id: string) => (note('sync.check', pr, id), calls.push(`sync.check ${id}`), 'not_ready')),
        open: vi.fn(async (pr, id: string) => (note('sync.open', pr, id), calls.push(`sync.open ${id}`), 'recorded')),
        issue: vi.fn(async (pr, id: string, paths: string[]) => (note('sync.issue', pr, id), void calls.push(`sync.issue ${id} ${paths.join(',')}`))),
      },
    } satisfies TwinWorkPorts;
    return { p: p as TwinWorkPorts, calls, principals, raw: p };
  };
  const run = (compute: TwinParityCompute, p: TwinWorkPorts, over: { log?: (l: string) => void; now?: () => number } = {}) => sweepTwins({ pool: writer, compute, ports: p, log: over.log ?? (() => undefined), ...(over.now ? { now: over.now } : {}) });
  const never: TwinParityCompute = async () => {
    throw new Error('no check expected');
  };

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    await admin.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${SWEEP_LOGIN}') THEN
          CREATE ROLE ${SWEEP_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
      END $$`);
    await admin.query(`GRANT app_user, agent_run_writer TO ${SWEEP_LOGIN}`);
    const u = new URL(process.env.DATABASE_URL_APP_USER!);
    u.username = SWEEP_LOGIN;
    u.password = '';
    writer = createPool(u.toString());
    A = await seedAccount(admin, randomUUID());
    B = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appPool.end();
    await writer.end();
  });

  it('hands the check the twin as stored, stores the result with the claim, and advances the anchor only when the check says so', async () => {
    const id = await twinFor(A, 'ready', 'in_parity', "now() - interval '1 second'");
    const seen: TwinParityJob[] = [];
    const { p } = ports();
    const counts = await run(async (job) => (seen.push(job), OUT({ result: 'publish_pending', paths: ['src/a.ts'], pathCount: 1, publishCount: 1, advanceSyncedTo: SHA('b') })), p);
    const mine = seen.find((j) => j.twinId === id)!;
    expect(mine).toMatchObject({ accountId: A.accountId, publishedPrivateSha: SHA('c'), syncedPublicSha: SHA('d'), privateRepo: { owner: 'acme' }, publicRepo: { owner: 'acme' } });
    expect(mine.privateRepo.name).toMatch(/^priv-/);
    expect(mine.publicRepo.name).toMatch(/^pub-/);
    expect(counts.checked).toBeGreaterThanOrEqual(1);
    expect((await row(id))!.last_result).toBe('publish_pending');
    expect((await row(id))!.due_at).toBeNull();
    expect((await admin.query('SELECT synced_public_sha FROM repo_twins WHERE id = $1', [id])).rows[0].synced_public_sha).toBe(SHA('b'));
  });

  it('drops a result whose anchor moved during the check, logs it, and keeps the twin due', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const id = await twinFor(A, 'ready', 'in_parity', "now() - interval '1 second'");
      const { p } = ports();
      const counts = await run(async (job) => {
        if (job.twinId === id) await admin.query('UPDATE repo_twins SET synced_public_sha = $2 WHERE id = $1', [id, SHA('e')]);
        return OUT({ result: job.twinId === id ? 'conflict' : 'in_parity', ...(job.twinId === id ? { paths: ['x'], pathCount: 1, conflictCount: 1 } : {}) });
      }, p);
      expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'twin.parity_result_dropped', code: 'anchor_moved', twin_id: id }));
      expect((await row(id))!.last_result).toBe('in_parity');
      expect((await admin.query('SELECT state FROM repo_twins WHERE id = $1', [id])).rows[0].state).toBe('ready');
      expect(counts.nextDueAt).not.toBeNull();
      expect(counts.nextDueAt!).toBeLessThanOrEqual(NOW() + 5000);
    } finally {
      warn.mockRestore();
    }
  });

  it('a push that arrives during the check keeps the twin due (the claim hands back its mark counter)', async () => {
    const id = await twinFor(A, 'ready', 'in_parity', "now() - interval '1 second'");
    const { p } = ports();
    await run(async (job) => {
      if (job.twinId === id) await admin.query("UPDATE twin_parity_checks SET mark_seq = mark_seq + 1, due_at = now() + interval '60 seconds' WHERE twin_id = $1", [id]);
      return OUT();
    }, p);
    expect((await row(id))!.due_at).not.toBeNull();
  });

  it('clears the due mark when no push arrived during the check, whatever the counter had reached', async () => {
    const id = await twinFor(A, 'ready', 'in_parity', "now() - interval '1 second'");
    await admin.query('UPDATE twin_parity_checks SET mark_seq = 3 WHERE twin_id = $1', [id]);
    const { p } = ports();
    await run(async () => OUT(), p);
    expect((await row(id))!.due_at).toBeNull();
  });

  it('reads the visibility of every twin it touches on every pass, and a twin that is not clearly private is skipped this tick and logged', async () => {
    const parity = await twinFor(A, 'ready', 'in_parity', "now() - interval '1 second'");
    const work = await twinFor(A, 'ready', 'publish_pending', null);
    const { p, calls, raw } = ports();
    raw.guard.mockImplementation(async (_p, id) => (calls.push(`guard ${id}`), id === parity ? 'refused' : 'unavailable'));
    const lines: string[] = [];
    const checked: string[] = [];
    await run(async (job) => (checked.push(job.twinId), OUT()), p, { log: (l) => lines.push(l) });
    expect(calls).toEqual(expect.arrayContaining([`guard ${parity}`, `guard ${work}`]));
    expect(checked).not.toContain(parity);
    expect(calls).not.toContain(`publish.check ${work}`);
    expect(lines).toContain(JSON.stringify({ event: 'twin_sweep.visibility_skip', twin_id: parity, code: 'refused' }));
    expect(lines).toContain(JSON.stringify({ event: 'twin_sweep.visibility_skip', twin_id: work, code: 'unavailable' }));
  });

  it('a stale result is a skipped tick, logged by code, never a failure', async () => {
    const id = await twinFor(A, 'ready', 'in_parity', "now() - interval '1 second'");
    const { p } = ports();
    const lines: string[] = [];
    const counts = await run(async (job) => {
      if (job.twinId === id) await admin.query('UPDATE repo_twins SET synced_public_sha = $2 WHERE id = $1', [id, SHA('f')]);
      return OUT();
    }, p, { log: (l) => lines.push(l) });
    expect(lines).toContain(JSON.stringify({ event: 'twin_sweep.parity_skip', twin_id: id, code: 'stale' }));
    expect(counts.failed).toBe(0);
    expect(counts.failed).toBe(0);
  });

  it('every call a port gets carries exactly the twin\'s own account and no person, for twins of two accounts, on both passes', async () => {
    const mine: string[] = [];
    for (const refs of [A, B]) {
      mine.push(await twinFor(refs, 'ready', 'in_parity', "now() - interval '1 second'"));
      mine.push(await twinFor(refs, 'seeding', null, null));
      mine.push(await twinFor(refs, 'ready', 'publish_pending', null));
      mine.push(await twinFor(refs, 'ready', 'sync_pending', null, { paths: ['docs/a.md'] }));
    }
    const { p, principals } = ports();
    await run(async () => OUT(), p);
    const owner = new Map((await admin.query<{ id: string; account_id: string }>('SELECT id, account_id FROM repo_twins')).rows.map((r) => [r.id, r.account_id]));
    expect([...new Set(principals.map((x) => x.call))]).toEqual(expect.arrayContaining(['guard', 'seed.check', 'publish.check', 'publish.issue', 'sync.check', 'sync.issue']));
    for (const x of principals) expect(x.principal, `${x.call} ${x.id}`).toEqual({ accountId: owner.get(x.id), userId: null });
    for (const id of mine) expect(principals.some((x) => x.id === id)).toBe(true);
    expect(new Set(principals.filter((x) => mine.includes(x.id)).map((x) => (x.principal as { accountId: string }).accountId))).toEqual(new Set([A.accountId, B.accountId]));
  });

  it('a step that throws a 5xx with a status (503 not_configured) is a failure, not a refusal', async () => {
    const id = await twinFor(A, 'ready', 'publish_pending', null);
    const { p, raw } = ports();
    raw.publish.check.mockImplementation(async (_p, tid) => {
      if (tid === id) throw Object.assign(new Error('the cloud cannot issue a twin publish now'), { status: 503, code: 'not_configured' });
      return 'not_ready';
    });
    const lines: string[] = [];
    const counts = await run(never, p, { log: (l) => lines.push(l) });
    expect(lines).toContain(JSON.stringify({ event: 'twin_sweep.work_failed', twin_id: id, code: 'not_configured' }));
    expect(lines.some((l) => l.includes('work_refused') && l.includes(id))).toBe(false);
    expect(counts.failed).toBeGreaterThanOrEqual(1);
  });

  it('a check that could not know stores nothing and the twin is not checked again before its five minutes', async () => {
    const id = await twinFor(A, 'ready', 'in_parity', "now() - interval '1 second'");
    const { p } = ports();
    const counts = await run(async (job) => (job.twinId === id ? OUT({ result: 'unavailable', privateSha: null, publicSha: null }) : OUT()), p);
    expect(counts.failed).toBe(0);
    expect((await row(id))!.last_result).toBe('in_parity');
    const due = new Date((await row(id))!.due_at).getTime();
    expect(due).toBeGreaterThan(NOW() + 200_000);
    expect(counts.nextDueAt).not.toBeNull();
    const again: string[] = [];
    await run(async (job) => (again.push(job.twinId), OUT()), p);
    expect(again).not.toContain(id);
  });

  it('a check that throws is dropped (not a failure of the tick) and a twin not yet due waits for its time', async () => {
    const id = await twinFor(A, 'ready', 'in_parity', "now() - interval '1 second'");
    const later = await twinFor(A, 'ready', 'in_parity', "now() + interval '40 seconds'");
    const { p } = ports();
    const counts = await run(async (job) => {
      if (job.twinId === id) throw new Error('boom https://secret.example');
      return OUT();
    }, p);
    expect((await row(id))!.last_result).toBe('in_parity');
    expect((await row(later))!.last_result).toBe('in_parity');
    expect(counts.failed).toBe(0);
    expect(counts.nextDueAt).toBeLessThanOrEqual(NOW() + 41_000);
  });

  it('works a seeding twin (its check only), a publish (check, then issue when nothing is finished) and a sync (check, then issue with the stored paths) once per lease', async () => {
    const seeding = await twinFor(A, 'seeding', null, null);
    const publish = await twinFor(A, 'ready', 'publish_pending', null);
    const sync = await twinFor(A, 'ready', 'sync_pending', null, { paths: ['docs/a.md', 'docs/b.md'] });
    const { p, calls } = ports();
    const counts = await run(never, p);
    expect(calls).toEqual(expect.arrayContaining([`seed.check ${seeding}`, `publish.check ${publish}`, `publish.issue ${publish}`, `sync.check ${sync}`, `sync.issue ${sync} docs/a.md,docs/b.md`]));
    // issuing a seed is a person's: the tick only checks it, whatever the twin's kind
    expect(calls.filter((c) => c.includes(seeding))).toEqual([`guard ${seeding}`, `seed.check ${seeding}`]);
    expect(counts.worked).toBeGreaterThanOrEqual(3);
    expect((await row(publish))!.work_lease_until).not.toBeNull();
    // under its lease the twin is not listed again
    const second = ports();
    await run(never, second.p);
    expect(second.calls.filter((c) => c.includes(publish) || c.includes(sync) || c.includes(seeding))).toEqual([]);
  });

  it('a finished publish is checked and not issued again; a verified sync gets its pull request and no new job', async () => {
    const publish = await twinFor(A, 'ready', 'publish_pending', null);
    const sync = await twinFor(A, 'ready', 'sync_pending', null, { paths: ['docs/a.md'] });
    const { p, calls, raw } = ports();
    raw.publish.check.mockImplementation(async (_p, id) => (calls.push(`publish.check ${id}`), 'recorded'));
    raw.sync.check.mockImplementation(async (_p, id) => (calls.push(`sync.check ${id}`), 'verified'));
    await run(never, p);
    expect(calls).toContain(`publish.check ${publish}`);
    expect(calls).not.toContain(`publish.issue ${publish}`);
    expect(calls).toContain(`sync.open ${sync}`);
    expect(calls.some((c) => c.startsWith(`sync.issue ${sync}`))).toBe(false);
  });

  it('a refusal the step threw (4xx) is counted as skipped and logged by code; any other error is a failure, logged by id and code only', async () => {
    const refused = await twinFor(A, 'ready', 'publish_pending', null);
    const broken = await twinFor(A, 'ready', 'sync_pending', null, { paths: ['x'] });
    const { p, raw } = ports();
    raw.publish.check.mockImplementation(async (_p, id) => {
      if (id === refused) throw Object.assign(new Error('the private repository is no longer private'), { status: 409, code: 'twin_not_private' });
      return 'not_ready';
    });
    raw.sync.check.mockImplementation(async (_p, id) => {
      if (id === broken) throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.1'), { code: 'ECONNREFUSED' });
      return 'not_ready';
    });
    const lines: string[] = [];
    const counts = await run(never, p, { log: (l) => lines.push(l) });
    expect(lines).toContain(JSON.stringify({ event: 'twin_sweep.work_refused', twin_id: refused, code: 'twin_not_private' }));
    expect(lines).toContain(JSON.stringify({ event: 'twin_sweep.work_failed', twin_id: broken, code: 'ECONNREFUSED' }));
    expect(lines.join('\n')).not.toMatch(/10\.0\.0\.1|no longer private/);
    expect(counts.failed).toBeGreaterThanOrEqual(1);
  });

  it('carries the lease end as the next time for a twin it worked, so the gate asks again for its job', async () => {
    // only this twin's work is worked and listed (the others' leases are taken above), so the earliest time asked for is its lease end
    await twinFor(A, 'ready', 'publish_pending', null);
    const { p } = ports();
    const t0 = NOW();
    // the other cases' twins still wait on their own times, so look at the lease end by taking those out of the list
    await admin.query("UPDATE twin_parity_checks SET due_at = NULL WHERE account_id = $1 AND due_at > now() + interval '1 second'", [A.accountId]);
    await admin.query("UPDATE twin_parity_checks SET due_at = NULL WHERE account_id = $1", [B.accountId]);
    const counts = await run(never, p, { now: () => t0 });
    expect(counts.worked).toBe(1);
    expect(counts.nextDueAt).not.toBeNull();
    expect(counts.nextDueAt!).toBeGreaterThanOrEqual(t0 + 300_000);
  });

  it('the webhook mark marks a twin from either of its repositories, not for another repository, and counts a push that arrives during a check', async () => {
    const id = await twinFor(A, 'ready', 'in_parity', null);
    const repos = (await admin.query('SELECT private_repo_id, public_repo_id FROM repo_twins WHERE id = $1', [id])).rows[0];
    const other = await twinFor(A, 'ready', 'in_parity', null);
    const tenant = <T>(fn: (c: PoolClient) => Promise<T>) => withTenant(appPool, A.accountId, fn);
    expect(await tenant((c) => markTwinParityDue(c, { accountId: A.accountId, twinIds: [id], repoId: repos.public_repo_id, fullName: 'acme/whatever' }))).toBe(1);
    const first = await row(id);
    expect(first!.due_at).not.toBeNull();
    expect(Number(first!.mark_seq)).toBe(1);
    expect(await tenant((c) => markTwinParityDue(c, { accountId: A.accountId, twinIds: [id], repoId: repos.private_repo_id, fullName: 'acme/whatever' }))).toBe(1);
    expect(Number((await row(id))!.mark_seq)).toBe(2);
    // a repository that is neither side of the twin marks nothing, and nothing leaks to the account's other twin
    const stranger = (await admin.query('SELECT id FROM repos WHERE id NOT IN ($1, $2) AND account_id = $3 LIMIT 1', [repos.private_repo_id, repos.public_repo_id, A.accountId])).rows[0].id;
    expect(await tenant((c) => markTwinParityDue(c, { accountId: A.accountId, twinIds: [id], repoId: stranger, fullName: 'nobody/else' }))).toBe(0);
    expect((await row(other))!.due_at).toBeNull();
    // another account's twin id is not found under this tenant
    const foreign = await twinFor(B, 'ready', 'in_parity', null);
    expect(await tenant((c) => markTwinParityDue(c, { accountId: A.accountId, twinIds: [foreign], repoId: repos.public_repo_id, fullName: 'acme/whatever' }))).toBe(0);
    expect((await row(foreign))!.due_at).toBeNull();
  });
});

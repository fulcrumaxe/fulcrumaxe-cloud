import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { withTenant } from '../src/tenancy/withTenant.js';
import { recordDriverEvent } from '../src/work-items/driverEvents.js';
import { UNVERIFIABLE_ESCALATION_CODE } from '../src/work-items/reviewHold.js';
import { readUnverifiableStop, readVerifiedRoles, writeCriteriaVerifications } from '../src/work-items/criteriaVerification.js';

/** [pg] Issue #757 "record": the table, the write and the two reads, against real Postgres (RLS is part of what is tested). */
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);

describe('criteria verification [pg]', { timeout: 120_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let n = 0;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appPool.end();
  });

  async function newItem(refs: SeedRefs): Promise<string> {
    const id = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'feature', 'internal', 'needs_human', $4)", [id, refs.accountId, refs.repoId, 9000 + n++]);
    return id;
  }

  async function run(refs: SeedRefs, workItemId: string, role: string, headSha: string, envelope: unknown, status = 'succeeded'): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, envelope, head_sha) VALUES ($1, $2, $3, $4, 'production', $5, $6::jsonb, $7)`, [id, refs.accountId, workItemId, role, status, envelope === null ? null : JSON.stringify(envelope), headSha]);
    return id;
  }

  function unverifiableEnvelope(items: Array<{ criterion: string; reason?: string }>): unknown {
    return { verdict: 'unverifiable', findings: [], unverifiable: items.map((i) => ({ criterion: i.criterion, reason: i.reason ?? 'skipped here' })) };
  }

  async function escalate(refs: SeedRefs, workItemId: string, headSha: string, roles: string[], runId: string, key = randomUUID()): Promise<void> {
    await withTenant(appPool, refs.accountId, (c) => recordDriverEvent(c, refs.accountId, { workItemId, kind: 'escalated', dedupeKey: key, code: UNVERIFIABLE_ESCALATION_CODE, reasons: roles.map((r) => r.replace(/-/g, '_')), headSha, runId }));
  }

  const stop = (workItemId: string) => withTenant(appPool, a.accountId, (c) => readUnverifiableStop(c, workItemId));

  it('no escalation at all: null', async () => {
    const item = await newItem(a);
    expect(await stop(item)).toBeNull();
  });

  it('an escalation of a different cause (reviewer_fail): null, whatever agent_runs holds', async () => {
    const item = await newItem(a);
    const r = await run(a, item, 'acceptance-tester', HEAD, unverifiableEnvelope([{ criterion: 'AC1' }]));
    await withTenant(appPool, a.accountId, (c) => recordDriverEvent(c, a.accountId, { workItemId: item, kind: 'escalated', dedupeKey: 'k', code: 'reviewer_fail', reasons: ['acceptance_tester'], headSha: HEAD, runId: r }));
    expect(await stop(item)).toBeNull();
  });

  it('one unverifiable role: the head and that role\'s items, in stored order, identified by (runId, index)', async () => {
    const item = await newItem(a);
    const r = await run(a, item, 'acceptance-tester', HEAD, unverifiableEnvelope([{ criterion: 'AC1', reason: 'r1' }, { criterion: 'AC2', reason: 'r2' }]));
    await escalate(a, item, HEAD, ['acceptance-tester'], r);
    expect(await stop(item)).toEqual({
      headSha: HEAD,
      roles: [{ role: 'acceptance-tester', runId: r, items: [{ index: 0, criterion: 'AC1', reason: 'r1' }, { index: 1, criterion: 'AC2', reason: 'r2' }] }],
    });
  });

  it('two unverifiable roles: the confirm list holds both roles\' items, not only the escalation\'s own run_id (criterion 3)', async () => {
    const item = await newItem(a);
    const rAccept = await run(a, item, 'acceptance-tester', HEAD, unverifiableEnvelope([{ criterion: 'AC1' }]));
    const rCode = await run(a, item, 'code-reviewer', HEAD, unverifiableEnvelope([{ criterion: 'AC2' }, { criterion: 'AC3' }]));
    // The escalation's own run_id column names only one of the two roles; the stop must still find both.
    await escalate(a, item, HEAD, ['acceptance-tester', 'code-reviewer'], rAccept);
    const s = await stop(item);
    expect(s?.headSha).toBe(HEAD);
    expect(s?.roles).toHaveLength(2);
    expect(s?.roles.find((x) => x.role === 'acceptance-tester')).toEqual({ role: 'acceptance-tester', runId: rAccept, items: [{ index: 0, criterion: 'AC1', reason: 'skipped here' }] });
    expect(s?.roles.find((x) => x.role === 'code-reviewer')).toEqual({ role: 'code-reviewer', runId: rCode, items: [{ index: 0, criterion: 'AC2', reason: 'skipped here' }, { index: 1, criterion: 'AC3', reason: 'skipped here' }] });
  });

  it('a role whose latest run on the head is a real fail (not unverifiable) is left out, even though an older run of it was unverifiable -- and with nothing left to confirm, the stop is null, not a hollow stop a caller could wrongly act on', async () => {
    const item = await newItem(a);
    const rOld = await run(a, item, 'acceptance-tester', HEAD, unverifiableEnvelope([{ criterion: 'AC1' }]));
    await new Promise((r) => setTimeout(r, 10));
    await run(a, item, 'acceptance-tester', HEAD, { verdict: 'fail', findings: ['x'] });
    await escalate(a, item, HEAD, ['acceptance-tester'], rOld);
    // The escalation itself is stale once a real run superseded it: null, not `{ headSha, roles: [] }` (a caller must
    // never be handed a stop with nothing to confirm -- `matchesUnverifiableStop` matches an empty set trivially).
    expect(await stop(item)).toBeNull();
  });

  it('a role whose latest run is still in flight is left out, and the stop is null', async () => {
    const item = await newItem(a);
    const r = await run(a, item, 'acceptance-tester', HEAD, unverifiableEnvelope([{ criterion: 'AC1' }]));
    await new Promise((res) => setTimeout(res, 10));
    await run(a, item, 'acceptance-tester', HEAD, null, 'running');
    await escalate(a, item, HEAD, ['acceptance-tester'], r);
    expect(await stop(item)).toBeNull();
  });

  it('an envelope with no usable unverifiable item leaves that role out, and the stop is null', async () => {
    const item = await newItem(a);
    const r = await run(a, item, 'acceptance-tester', HEAD, { verdict: 'unverifiable', unverifiable: [] });
    await escalate(a, item, HEAD, ['acceptance-tester'], r);
    expect(await stop(item)).toBeNull();
  });

  describe('writeCriteriaVerifications / readVerifiedRoles', () => {
    async function writtenRow(id: string): Promise<{ head_sha: string; role: string; run_id: string; criteria: unknown; verified_by: string }> {
      const { rows } = await admin.query('SELECT head_sha, role, run_id, criteria, verified_by FROM work_item_criteria_verifications WHERE id = $1', [id]);
      return rows[0];
    }

    it('writes one row per role, with the criteria text copied from the stored envelope -- never from a request (criterion 4)', async () => {
      const item = await newItem(a);
      const rAccept = await run(a, item, 'acceptance-tester', HEAD, unverifiableEnvelope([{ criterion: 'AC1', reason: 'r1' }]));
      const rCode = await run(a, item, 'code-reviewer', HEAD, unverifiableEnvelope([{ criterion: 'AC2' }]));
      await escalate(a, item, HEAD, ['acceptance-tester', 'code-reviewer'], rAccept);
      const s = (await stop(item))!;
      const written = await withTenant(appPool, a.accountId, (c) => writeCriteriaVerifications(c, { workItemId: item, headSha: s.headSha, roles: s.roles, verifiedBy: a.userId }));
      expect(written).toHaveLength(2);
      const rows = await Promise.all(written.map((w) => writtenRow(w.id)));
      const accept = rows.find((r) => r.role === 'acceptance-tester')!;
      expect(accept).toMatchObject({ head_sha: HEAD, run_id: rAccept, verified_by: a.userId, criteria: [{ index: 0, criterion: 'AC1' }] });
      const code = rows.find((r) => r.role === 'code-reviewer')!;
      expect(code).toMatchObject({ head_sha: HEAD, run_id: rCode, verified_by: a.userId, criteria: [{ index: 0, criterion: 'AC2' }] });
      // The stored shape never carries the "reason" text, only index + criterion.
      expect(Object.keys((accept.criteria as [Record<string, unknown>])[0]!).sort()).toEqual(['criterion', 'index']);
      expect(await admin.query('SELECT verified_at FROM work_item_criteria_verifications WHERE id = $1', [written[0]!.id]).then((r) => r.rows[0].verified_at)).not.toBeNull();
    });

    it('readVerifiedRoles answers exactly the roles recorded on that head, and nothing for another head', async () => {
      const item = await newItem(a);
      const r = await run(a, item, 'acceptance-tester', HEAD, unverifiableEnvelope([{ criterion: 'AC1' }]));
      await escalate(a, item, HEAD, ['acceptance-tester'], r);
      const s = (await stop(item))!;
      await withTenant(appPool, a.accountId, (c) => writeCriteriaVerifications(c, { workItemId: item, headSha: s.headSha, roles: s.roles, verifiedBy: a.userId }));
      expect(await withTenant(appPool, a.accountId, (c) => readVerifiedRoles(c, a.accountId, item, HEAD))).toEqual(['acceptance-tester']);
      expect(await withTenant(appPool, a.accountId, (c) => readVerifiedRoles(c, a.accountId, item, OTHER_HEAD))).toEqual([]);
    });

    it('a second write for the same item, head and role writes nothing more: the unique index makes a concurrent double press land one set of rows (criterion 8)', async () => {
      const item = await newItem(a);
      const r = await run(a, item, 'acceptance-tester', HEAD, unverifiableEnvelope([{ criterion: 'AC1' }]));
      await escalate(a, item, HEAD, ['acceptance-tester'], r);
      const s = (await stop(item))!;
      const first = await withTenant(appPool, a.accountId, (c) => writeCriteriaVerifications(c, { workItemId: item, headSha: s.headSha, roles: s.roles, verifiedBy: a.userId }));
      expect(first).toHaveLength(1);
      const second = await withTenant(appPool, a.accountId, (c) => writeCriteriaVerifications(c, { workItemId: item, headSha: s.headSha, roles: s.roles, verifiedBy: a.userId }));
      expect(second).toEqual([]);
      const { rows } = await admin.query('SELECT count(*) AS n FROM work_item_criteria_verifications WHERE account_id = $1 AND work_item_id = $2 AND head_sha = $3 AND role = $4', [a.accountId, item, HEAD, 'acceptance-tester']);
      expect(Number(rows[0].n)).toBe(1);
    });

    it('accepts a 64-hex head, exactly like the other sha columns this schema uses (`work_item_driver_events.head_sha`, the column this value is read from)', async () => {
      const head64 = 'c'.repeat(64);
      const item = await newItem(a);
      const r = await run(a, item, 'acceptance-tester', head64, unverifiableEnvelope([{ criterion: 'AC1' }]));
      await escalate(a, item, head64, ['acceptance-tester'], r);
      const s = (await stop(item))!;
      expect(s.headSha).toBe(head64);
      const written = await withTenant(appPool, a.accountId, (c) => writeCriteriaVerifications(c, { workItemId: item, headSha: s.headSha, roles: s.roles, verifiedBy: a.userId }));
      expect(written).toHaveLength(1);
    });

    it('writes nothing for a role whose claimed run does not actually back the claimed head/role/status/verdict together: the INSERT itself re-checks `agent_runs`, not just caller discipline', async () => {
      const item = await newItem(a);
      // A run that really is unverifiable, but on a DIFFERENT head than the one the caller (wrongly) claims.
      const r = await run(a, item, 'acceptance-tester', OTHER_HEAD, unverifiableEnvelope([{ criterion: 'AC1' }]));
      const written = await withTenant(appPool, a.accountId, (c) =>
        writeCriteriaVerifications(c, {
          workItemId: item,
          headSha: HEAD,
          roles: [{ role: 'acceptance-tester', runId: r, items: [{ index: 0, criterion: 'AC1', reason: 'r1' }] }],
          verifiedBy: a.userId,
        }));
      expect(written).toEqual([]);
      const { rows } = await admin.query('SELECT count(*) AS n FROM work_item_criteria_verifications WHERE work_item_id = $1', [item]);
      expect(Number(rows[0].n)).toBe(0);
    });

    it('another account cannot read the row (RLS confinement): a session on account b, even asked for account a\'s id by name, sees nothing -- only the admin connection (no RLS) does', async () => {
      const item = await newItem(a);
      const r = await run(a, item, 'acceptance-tester', HEAD, unverifiableEnvelope([{ criterion: 'AC1' }]));
      await escalate(a, item, HEAD, ['acceptance-tester'], r);
      const s = (await stop(item))!;
      await withTenant(appPool, a.accountId, (c) => writeCriteriaVerifications(c, { workItemId: item, headSha: s.headSha, roles: s.roles, verifiedBy: a.userId }));
      expect(await withTenant(appPool, b.accountId, (c) => readVerifiedRoles(c, a.accountId, item, HEAD))).toEqual([]);
      expect((await admin.query('SELECT role FROM work_item_criteria_verifications WHERE account_id = $1 AND work_item_id = $2 AND head_sha = $3', [a.accountId, item, HEAD])).rows.map((row) => row.role)).toEqual(['acceptance-tester']);
    });
  });
});

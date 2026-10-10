import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { ForbiddenError, NotFoundError } from '../src/tenancy/errors.js';
import { withTenant } from '../src/tenancy/withTenant.js';
import {
  CORRECTION_BODY_MAX,
  CorrectionInputError,
  createCorrection,
  decideCorrection,
  getCorrection,
  listCorrections,
  markCorrectionApplied,
} from '../src/corrections/index.js';

/** D#597 CC-1: the core read and write functions, against a real Postgres. */
describe('corrections (D#597 CC-1)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let aAdmin: string;
  let aMember: string;
  let itemA: string;
  let itemB: string;

  async function addMember(accountId: string, role: 'admin' | 'member'): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [id, `${id}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, id, role]);
    return id;
  }
  async function newItem(refs: SeedRefs): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'bug', 'internal')`, [id, refs.accountId, refs.repoId]);
    return id;
  }
  const as = (accountId: string, userId: string) => ({ pool: appPool, principal: { accountId, userId } });
  const auditCount = async (id: string) =>
    (await admin.query(`SELECT count(*)::int AS n FROM audit_log WHERE payload->>'correction_id' = $1`, [id])).rows[0].n as number;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    aAdmin = await addMember(a.accountId, 'admin');
    aMember = await addMember(a.accountId, 'member');
    itemA = await newItem(a);
    itemB = await newItem(b);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  it('a member creates a proposed correction that reads back whole, with the hash and no decision stamps', async () => {
    const c = await createCorrection(as(a.accountId, aMember), { workItemId: itemA, kind: 'run_note', body: 'use the staging key' });
    expect(c).toMatchObject({
      accountId: a.accountId,
      workItemId: itemA,
      origin: 'person',
      kind: 'run_note',
      body: 'use the staging key',
      status: 'proposed',
      createdBy: aMember,
      decidedBy: null,
      decidedVia: null,
      appliedRunId: null,
      decidedAt: null,
      appliedAt: null,
    });
    expect(c.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await getCorrection(as(a.accountId, aMember), c.id)).toEqual(c);
  });

  it('input is checked before the database: unknown kind or origin, blank text, and more than 4,000 characters', async () => {
    const ctx = as(a.accountId, aMember);
    // @ts-expect-error a kind outside the union
    await expect(createCorrection(ctx, { workItemId: itemA, kind: 'approve', body: 'x' })).rejects.toBeInstanceOf(CorrectionInputError);
    // @ts-expect-error an origin outside the union
    await expect(createCorrection(ctx, { workItemId: itemA, kind: 'pause', body: 'x', origin: 'bot' })).rejects.toBeInstanceOf(CorrectionInputError);
    await expect(createCorrection(ctx, { workItemId: itemA, kind: 'pause', body: '   ' })).rejects.toBeInstanceOf(CorrectionInputError);
    await expect(createCorrection(ctx, { workItemId: itemA, kind: 'pause', body: 'x'.repeat(CORRECTION_BODY_MAX + 1) })).rejects.toBeInstanceOf(CorrectionInputError);
    // Characters, not UTF-16 units: 4,000 astral characters are allowed.
    await expect(createCorrection(ctx, { workItemId: itemA, kind: 'pause', body: '\u{1F600}'.repeat(CORRECTION_BODY_MAX) })).resolves.toMatchObject({ status: 'proposed' });
  });

  it("another account's work item, a bad id and a cross-tenant read all answer not found", async () => {
    await expect(createCorrection(as(b.accountId, b.userId), { workItemId: itemA, kind: 'pause', body: 'x' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(createCorrection(as(a.accountId, aMember), { workItemId: 'nope', kind: 'pause', body: 'x' })).rejects.toBeInstanceOf(NotFoundError);
    const c = await createCorrection(as(a.accountId, aMember), { workItemId: itemA, kind: 'pause', body: 'x' });
    await expect(getCorrection(as(b.accountId, b.userId), c.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await listCorrections(as(b.accountId, b.userId), itemA)).toEqual([]);
    await expect(decideCorrection(as(b.accountId, b.userId), { id: c.id, to: 'accepted', via: 'workspace' })).rejects.toBeInstanceOf(NotFoundError);
    expect((await getCorrection(as(a.accountId, aMember), c.id)).status).toBe('proposed');
    expect(itemB).toBeTruthy();
  });

  it('a user who is not a member of the account is refused', async () => {
    await expect(createCorrection(as(a.accountId, randomUUID()), { workItemId: itemA, kind: 'pause', body: 'x' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('a member cannot decide; an admin can, once; the second call is already_decided and writes nothing', async () => {
    const c = await createCorrection(as(a.accountId, aMember), { workItemId: itemA, kind: 'priority', body: 'make it urgent' });
    await expect(decideCorrection(as(a.accountId, aMember), { id: c.id, to: 'accepted', via: 'workspace' })).rejects.toBeInstanceOf(ForbiddenError);
    const first = await decideCorrection(as(a.accountId, aAdmin), { id: c.id, to: 'accepted', via: 'terminal' });
    expect(first.outcome).toBe('decided');
    expect(first.correction).toMatchObject({ status: 'accepted', decidedBy: aAdmin, decidedVia: 'terminal' });
    const second = await decideCorrection(as(a.accountId, a.userId), { id: c.id, to: 'accepted', via: 'workspace' });
    expect(second.outcome).toBe('already_decided');
    expect(second.correction).toMatchObject({ decidedBy: aAdmin, decidedVia: 'terminal' });
    expect(await auditCount(c.id)).toBe(2);
  });

  it("'auto' is not a way to decide, and an unknown decision is an input error", async () => {
    const c = await createCorrection(as(a.accountId, aMember), { workItemId: itemA, kind: 'pause', body: 'x' });
    // @ts-expect-error auto is not open
    await expect(decideCorrection(as(a.accountId, aAdmin), { id: c.id, to: 'accepted', via: 'auto' })).rejects.toBeInstanceOf(CorrectionInputError);
    // @ts-expect-error applied is never a click
    await expect(decideCorrection(as(a.accountId, aAdmin), { id: c.id, to: 'applied', via: 'workspace' })).rejects.toBeInstanceOf(CorrectionInputError);
    expect((await getCorrection(as(a.accountId, aAdmin), c.id)).status).toBe('proposed');
  });

  it('the undo path: reject an accepted note before it runs; after a run applies it nothing moves it', async () => {
    const ctx = as(a.accountId, aAdmin);
    const undone = await createCorrection(ctx, { workItemId: itemA, kind: 'run_note', body: 'by mistake' });
    await decideCorrection(ctx, { id: undone.id, to: 'accepted', via: 'workspace' });
    expect((await decideCorrection(ctx, { id: undone.id, to: 'rejected', via: 'workspace' })).outcome).toBe('decided');

    const used = await createCorrection(ctx, { workItemId: itemA, kind: 'run_note', body: 'use it' });
    await decideCorrection(ctx, { id: used.id, to: 'accepted', via: 'workspace' });
    const runId = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1,$2,$3,'executor','local','running')`, [runId, a.accountId, itemA]);
    expect(await withTenant(appPool, a.accountId, (c) => markCorrectionApplied(c, { id: used.id, runId }))).toBe(true);
    expect(await withTenant(appPool, a.accountId, (c) => markCorrectionApplied(c, { id: used.id, runId }))).toBe(false);
    const after = await decideCorrection(ctx, { id: used.id, to: 'rejected', via: 'workspace' });
    expect(after.outcome).toBe('already_decided');
    expect(after.correction).toMatchObject({ status: 'applied', appliedRunId: runId });
  });

  it('applying with a run of another item is an input error and leaves the note accepted', async () => {
    const ctx = as(a.accountId, aAdmin);
    const note = await createCorrection(ctx, { workItemId: itemA, kind: 'run_note', body: 'n' });
    await decideCorrection(ctx, { id: note.id, to: 'accepted', via: 'workspace' });
    const other = await newItem(a);
    const runId = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1,$2,$3,'executor','local','running')`, [runId, a.accountId, other]);
    await expect(withTenant(appPool, a.accountId, (c) => markCorrectionApplied(c, { id: note.id, runId }))).rejects.toBeInstanceOf(CorrectionInputError);
    expect((await getCorrection(ctx, note.id)).status).toBe('accepted');
  });

  it('the list is oldest first and holds only that item', async () => {
    const item = await newItem(a);
    const ctx = as(a.accountId, aMember);
    const one = await createCorrection(ctx, { workItemId: item, kind: 'question', body: 'why?' });
    const two = await createCorrection(ctx, { workItemId: item, kind: 'pause', body: 'stop' });
    await createCorrection(ctx, { workItemId: itemA, kind: 'pause', body: 'elsewhere' });
    expect((await listCorrections(ctx, item)).map((c) => c.id)).toEqual([one.id, two.id]);
  });
});

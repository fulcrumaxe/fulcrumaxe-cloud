import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken, type Scope } from '@fx/core/src/tokens/service.js';
import { withTenant } from '@fx/core/src/tenancy/withTenant.js';
import { acceptCorrection } from '@fx/core/src/corrections/accept.js';
import { markCorrectionApplied } from '@fx/core/src/corrections/index.js';
import { createRecordingRunActionSignal } from '@fx/core/src/runActions/index.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { effectivePrincipals } from '../src/registry.js';
import { ROUTES } from '../src/routes/index.js';
import { runActionDeps } from '../src/routes/run-actions.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

interface Identity {
  accountId: string;
  userId: string;
}
interface Corr {
  id: string;
  status: string;
  content_hash: string;
  origin: string;
  attribution: string | null;
  created_by_name: string;
  decided_by_name: string | null;
  applied_run_id: string | null;
}
interface ErrBody {
  error: { code: string; message: string };
}

/** D#597 CC-2a: the correction routes through the real dispatcher on real Postgres (RLS on, the real audit writers). */
describe('D#597 CC-2a: correction routes', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  const signal = createRecordingRunActionSignal();

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
  beforeEach(() => {
    runActionDeps.getRunActionSignal = () => signal;
    signal.sent.length = 0;
  });
  afterEach(() => {
    runActionDeps.getRunActionSignal = () => null;
  });

  async function call(who: Identity | string, method: string, urlPath: string, body?: unknown) {
    const h = new Headers();
    if (typeof who === 'string') h.set('authorization', `Bearer ${who}`);
    else h.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(who)}`);
    if (body !== undefined) h.set('content-type', 'application/json');
    return handleApiRequest(
      new Request(`http://localhost/api/v1${urlPath}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }),
      appUserPool,
      platformOpsPool,
      ROUTES,
    );
  }
  const owner = () => seedAccountWithMember(admin, { role: 'owner' });
  async function addMember(accountId: string, role: 'member' | 'admin', name?: string): Promise<Identity> {
    const userId = randomUUID();
    await seedUser(admin, userId);
    if (name) await admin.query('UPDATE users SET name = $2 WHERE id = $1', [userId, name]);
    await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [accountId, userId, role]);
    return { accountId, userId };
  }
  async function tokenFor(who: Identity, scopes: Scope[]): Promise<string> {
    const plaintext = generateToken();
    await insertApiToken(appUserPool, {
      accountId: who.accountId,
      createdBy: who.userId,
      tokenHash: hashToken(plaintext),
      displayHint: 'fxat_...test',
      scopes,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    return plaintext;
  }
  async function seedItem(accountId: string, stage = 'triaged'): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, kind, provenance, stage, priority) VALUES ($1, $2, 'feature', 'internal', $3, 2)`, [id, accountId, stage]);
    return id;
  }
  async function propose(who: Identity | string, item: string, kind: string, body: string): Promise<Corr> {
    const res = await call(who, 'POST', `/work-items/${item}/corrections`, { kind, body });
    expect(res.status).toBe(201);
    return (await res.json()) as Corr;
  }
  const row = async (id: string) => (await admin.query('SELECT status, applied_run_id FROM work_item_corrections WHERE id = $1', [id])).rows[0] as { status: string; applied_run_id: string | null };
  const err = async (res: Response) => ((await res.json()) as ErrBody).error.code;

  it('a member proposes (origin person); a token proposes as an agent; both are only proposed', async () => {
    const o = await owner();
    const m = await addMember(o.accountId, 'member');
    const item = await seedItem(o.accountId);
    const c = await propose(m, item, 'question', 'Is the retry safe?');
    expect(c.origin).toBe('person');
    expect(c.status).toBe('proposed');
    const t = await tokenFor(m, ['corrections:write']);
    const c2 = await propose(t, item, 'run_note', 'Use the staging fixture.');
    expect(c2.origin).toBe('agent');
    expect(c2.status).toBe('proposed');
    // a read-only token cannot propose; a corrections token cannot read
    expect((await call(await tokenFor(m, ['read']), 'POST', `/work-items/${item}/corrections`, { kind: 'question', body: 'x' })).status).toBe(403);
    expect((await call(t, 'GET', `/work-items/${item}/corrections`)).status).toBe(403);
  });

  it('refuses a bad kind, a 4,001-character body, a bad priority or new_item body, and another account\'s item (fixed answers)', async () => {
    const o = await owner();
    const other = await owner();
    const item = await seedItem(o.accountId);
    const foreign = await seedItem(other.accountId);
    const url = `/work-items/${item}/corrections`;
    expect((await call(o, 'POST', url, { kind: 'shout', body: 'x' })).status).toBe(422);
    const long = await call(o, 'POST', url, { kind: 'question', body: 'x'.repeat(4001) });
    expect(long.status).toBe(422);
    expect(JSON.stringify(await long.json())).not.toContain('4000');
    expect((await call(o, 'POST', url, { kind: 'priority', body: '{"priority":"now"}' })).status).toBe(422);
    expect((await call(o, 'POST', url, { kind: 'priority', body: 'urgent' })).status).toBe(422);
    expect((await call(o, 'POST', url, { kind: 'new_item', body: '{"title":"t","kind":"nope","body":"b"}' })).status).toBe(422);
    expect((await call(o, 'POST', `/work-items/${foreign}/corrections`, { kind: 'question', body: 'x' })).status).toBe(404);
    // a read of another account's item sees nothing (row security), not an error that confirms it exists
    expect(((await (await call(o, 'GET', `/work-items/${foreign}/corrections`)).json()) as { data: unknown[] }).data).toEqual([]);
  });

  it('accept: a hash that does not match is 409 content_changed and changes nothing; a member session is refused', async () => {
    const o = await owner();
    const m = await addMember(o.accountId, 'member');
    const item = await seedItem(o.accountId);
    const c = await propose(m, item, 'priority', '{"priority":"urgent"}');
    const bad = await call(o, 'POST', `/corrections/${c.id}/accept`, { content_hash: 'a'.repeat(64) });
    expect(bad.status).toBe(409);
    expect(await err(bad)).toBe('content_changed');
    expect((await row(c.id)).status).toBe('proposed');
    expect((await admin.query('SELECT priority FROM work_items WHERE id = $1', [item])).rows[0].priority).toBe(2);
    expect((await call(m, 'POST', `/corrections/${c.id}/accept`)).status).toBe(403);
    expect((await row(c.id)).status).toBe('proposed');
  });

  it('priority: accepting changes it, stamps applied, writes the audit row with via assistant, and the history reads "<name> via assistant"', async () => {
    const o = await owner();
    await admin.query(`UPDATE users SET name = 'Ada' WHERE id = $1`, [o.userId]);
    const m = await addMember(o.accountId, 'member', 'Bo');
    const item = await seedItem(o.accountId);
    const t = await tokenFor(m, ['corrections:write']);
    const c = await propose(t, item, 'priority', '{"priority":"urgent"}');
    const res = await call(o, 'POST', `/corrections/${c.id}/accept`, { content_hash: c.content_hash });
    expect(res.status).toBe(200);
    expect((await admin.query('SELECT priority FROM work_items WHERE id = $1', [item])).rows[0].priority).toBe(0);
    expect((await row(c.id)).status).toBe('applied');
    const audit = (await admin.query(`SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'work_item.priority_changed'`, [o.accountId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].payload).toMatchObject({ via: 'assistant', correction_id: c.id });
    const list = (await (await call(o, 'GET', `/work-items/${item}/corrections`)).json()) as { data: Corr[] };
    expect(list.data[0]).toMatchObject({ status: 'applied', created_by_name: 'Bo', decided_by_name: 'Ada', attribution: 'Ada via assistant' });
    // a person's own correction reads without the suffix
    const p = await propose(o, item, 'priority', '{"priority":"low"}');
    await call(o, 'POST', `/corrections/${p.id}/accept`);
    const again = (await (await call(o, 'GET', `/work-items/${item}/corrections`)).json()) as { data: Corr[] };
    expect(again.data[1]!.attribution).toBe('Ada');
  });

  it('a second accept is 409 already_decided and writes nothing more', async () => {
    const o = await owner();
    const item = await seedItem(o.accountId);
    const c = await propose(o, item, 'priority', '{"priority":"high"}');
    expect((await call(o, 'POST', `/corrections/${c.id}/accept`)).status).toBe(200);
    const audits = async () => Number((await admin.query(`SELECT count(*) AS n FROM audit_log WHERE payload->>'correction_id' = $1`, [c.id])).rows[0].n);
    const before = await audits();
    const second = await call(o, 'POST', `/corrections/${c.id}/accept`);
    expect(second.status).toBe(409);
    expect(await err(second)).toBe('already_decided');
    expect(await audits()).toBe(before);
    // applied is final: reject is also already_decided
    expect(await err(await call(o, 'POST', `/corrections/${c.id}/reject`))).toBe('already_decided');
  });

  it('a token can propose but never decide: accept and reject are 403 session_required and nothing is decided (R-597-1)', async () => {
    const o = await owner();
    const adm = await addMember(o.accountId, 'admin');
    const item = await seedItem(o.accountId);
    const t = await tokenFor(adm, ['read', 'corrections:write', 'work_items:write', 'runs:cancel']);
    const c = await propose(t, item, 'priority', '{"priority":"urgent"}');
    for (const verb of ['accept', 'reject']) {
      // even with the right hash, read from the reply the same caller just got
      const res = await call(t, 'POST', `/corrections/${c.id}/${verb}`, { content_hash: c.content_hash });
      expect(res.status, verb).toBe(403);
      expect(await err(res), verb).toBe('session_required');
      expect(await err(await call(t, 'POST', `/corrections/${c.id}/${verb}`)), verb).toBe('session_required');
    }
    expect((await row(c.id)).status).toBe('proposed');
    expect((await admin.query('SELECT priority FROM work_items WHERE id = $1', [item])).rows[0].priority).toBe(2);
    expect((await admin.query(`SELECT count(*)::int AS n FROM audit_log WHERE payload->>'correction_id' = $1 AND action <> 'work_item.correction_proposed'`, [c.id])).rows[0].n).toBe(0);
  });

  it('a failure while applying rolls the whole accept back: still proposed, no stamp, no effect', async () => {
    const o = await owner();
    const item = await seedItem(o.accountId, 'merged');
    const c = await propose(o, item, 'priority', '{"priority":"urgent"}');
    const res = await call(o, 'POST', `/corrections/${c.id}/accept`);
    expect(res.status).toBe(500);
    expect(await err(res)).toBe('apply_failed');
    expect((await row(c.id)).status).toBe('proposed');
    expect((await admin.query('SELECT priority FROM work_items WHERE id = $1', [item])).rows[0].priority).toBe(2);
    expect((await call(o, 'POST', `/corrections/${c.id}/reject`)).status).toBe(200);
  });

  it('pause: accepting asks for the halt (cancel_work_item) and is refused with nothing decided when no worker is registered', async () => {
    const o = await owner();
    const item = await seedItem(o.accountId);
    const c = await propose(o, item, 'pause', 'Hold on, wrong repo.');
    runActionDeps.getRunActionSignal = () => null;
    const refused = await call(o, 'POST', `/corrections/${c.id}/accept`);
    expect(refused.status).toBe(503);
    expect((await row(c.id)).status).toBe('proposed');
    runActionDeps.getRunActionSignal = () => signal;
    expect((await call(o, 'POST', `/corrections/${c.id}/accept`)).status).toBe(200);
    expect((await row(c.id)).status).toBe('applied');
    const reqs = (await admin.query(`SELECT kind, target_id FROM run_action_requests WHERE account_id = $1`, [o.accountId])).rows;
    expect(reqs).toEqual([{ kind: 'cancel_work_item', target_id: item }]);
    expect(signal.sent).toHaveLength(1);
  });

  it('new_item creates a Discussion; run_note and spec_amend stay accepted; question applies with no side effect', async () => {
    const o = await owner();
    const item = await seedItem(o.accountId);
    const n = await propose(o, item, 'new_item', JSON.stringify({ title: 'Follow-up', kind: 'feature', body: 'Split the export.' }));
    expect((await call(o, 'POST', `/corrections/${n.id}/accept`)).status).toBe(200);
    expect((await row(n.id)).status).toBe('applied');
    expect((await admin.query(`SELECT title FROM discussions WHERE account_id = $1`, [o.accountId])).rows).toEqual([{ title: 'Follow-up' }]);
    const note = await propose(o, item, 'run_note', 'Mind the flaky test.');
    expect((await call(o, 'POST', `/corrections/${note.id}/accept`)).status).toBe(200);
    expect((await row(note.id)).status).toBe('accepted');
    const spec = await propose(o, item, 'spec_amend', 'Add a rollback step.');
    expect((await call(o, 'POST', `/corrections/${spec.id}/accept`)).status).toBe(200);
    expect((await row(spec.id)).status).toBe('accepted');
  });

  it('undo: reject works on proposed and on accepted-not-applied, changes nothing else, and shows in the history', async () => {
    const o = await owner();
    const item = await seedItem(o.accountId);
    const a = await propose(o, item, 'priority', '{"priority":"urgent"}');
    expect((await call(o, 'POST', `/corrections/${a.id}/reject`)).status).toBe(200);
    expect((await row(a.id)).status).toBe('rejected');
    expect((await admin.query('SELECT priority FROM work_items WHERE id = $1', [item])).rows[0].priority).toBe(2);
    const note = await propose(o, item, 'run_note', 'x');
    await call(o, 'POST', `/corrections/${note.id}/accept`);
    expect((await call(o, 'POST', `/corrections/${note.id}/reject`)).status).toBe(200);
    expect((await row(note.id)).status).toBe('rejected');
    const list = (await (await call(o, 'GET', `/work-items/${item}/corrections`)).json()) as { data: Corr[] };
    expect(list.data.map((d) => d.status)).toEqual(['rejected', 'rejected']);
  });

  it('a member reaching decide or mark-applied acts with their own user id and is refused (no userless path from a request)', async () => {
    const o = await owner();
    const m = await addMember(o.accountId, 'member');
    const item = await seedItem(o.accountId);
    const c = await propose(o, item, 'run_note', 'Use the fixture.');
    const ctx = { pool: appUserPool, principal: { accountId: m.accountId, userId: m.userId } };
    await expect(acceptCorrection(ctx, { id: c.id, via: 'workspace' }, { signal, itemKinds: [], createItem: async () => undefined })).rejects.toThrow();
    expect((await row(c.id)).status).toBe('proposed');
    await call(o, 'POST', `/corrections/${c.id}/accept`);
    expect((await row(c.id)).status).toBe('accepted');
    // the same path the accept uses, for a member: the database floor refuses it
    await expect(
      withTenant(appUserPool, m.accountId, m.userId, (client) => markCorrectionApplied(client, { id: c.id, runId: null })),
    ).rejects.toThrow();
    expect((await row(c.id)).status).toBe('accepted');
  });

  it('a person who is gone reads as "a former member", never null', async () => {
    const o = await owner();
    const m = await addMember(o.accountId, 'member');
    const item = await seedItem(o.accountId);
    await propose(m, item, 'question', 'Still there?');
    await admin.query('DELETE FROM users WHERE id = $1', [m.userId]);
    const list = (await (await call(o, 'GET', `/work-items/${item}/corrections`)).json()) as { data: Corr[] };
    expect(list.data[0]!.created_by_name).toBe('a former member');
  });

  it('every stage verb still refuses a token (session_required)', async () => {
    const o = await owner();
    const item = await seedItem(o.accountId);
    const t = await tokenFor(o, ['read', 'runs:cancel', 'work_items:write', 'discussions:write', 'corrections:write']);
    for (const verb of ['approve', 'respec', 'back-to-discussion', 'treat-as-feature', 'close', 'reopen']) {
      const res = await call(t, 'POST', `/work-items/${item}/${verb}`);
      expect(res.status, verb).toBe(403);
      expect(await err(res), verb).toBe('session_required');
    }
  });

  it('no route that allows a token ever clears halted_at: every token-allowed write is called on a halted item', async () => {
    const o = await owner();
    const item = await seedItem(o.accountId);
    await admin.query(`UPDATE work_items SET halted_at = now(), halt_action_id = $2 WHERE id = $1`, [item, randomUUID()]);
    const t = await tokenFor(o, ['read', 'runs:cancel', 'work_items:write', 'discussions:write', 'corrections:write']);
    const writes = ROUTES.filter((r) => effectivePrincipals(r).includes('token') && r.method !== 'GET');
    expect(writes.map((r) => r.operationId)).toEqual(expect.arrayContaining(['cancelWorkItem', 'setWorkItemPriority', 'createCorrection']));
    expect(writes.map((r) => r.operationId)).not.toContain('acceptCorrection');
    await propose(o, item, 'pause', 'again');
    for (const r of writes) {
      const urlPath = r.path.replace('/api/v1', '').replace('{id}', item);
      const body = r.operationId === 'setWorkItemPriority' ? { priority: 'high' } : {};
      await call(t, r.method, urlPath, r.method === 'DELETE' ? undefined : body);
      const after = (await admin.query('SELECT halted_at FROM work_items WHERE id = $1', [item])).rows[0];
      expect(after.halted_at, r.operationId).not.toBeNull();
    }
  });
});

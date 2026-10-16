import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { FIXED_INVARIANTS } from '@fx/db/src/dialInventory.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { invariantLabel } from '../src/routes/decision-labels.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

interface Identity {
  accountId: string;
  userId: string;
}
interface Dial {
  decision_type: string;
  class: string;
  adjustable: boolean;
  disposition: string;
  allowed_dispositions: string[];
  source: string;
  preset: string | null;
  version: number | null;
}
interface Settings {
  repo_id: string;
  can_change: boolean;
  catalogue_version: number;
  active_preset: string | null;
  presets: { name: string; label: string; customer_role: string }[];
  dials: Dial[];
  invariants: { key: string; layer: string }[];
  moved?: { decision_type: string; from: string; to: string }[];
}
interface Preview {
  preset: string;
  active_preset: string | null;
  moves: { decision_type: string; from: string; to: string }[];
}
interface ErrorBody {
  error: { code: string };
  details?: { path: string; code: string }[];
}

const CLASS_2 = ['nonbreaking_refactor_approach', 'test_strategy_choice', 'runner_run_on_member_plan', 'publish_deprecation_notice', 'start_work_small', 'start_work_bug', 'start_work_doc', 'launch_sub_item'];

/**
 * D#7 DP10a: the Autonomy settings API, called through the real `handleApiRequest` against real Postgres (RLS, the owner/admin INSERT
 * policy, the SECURITY DEFINER audit function). The fakes are the real tables; nothing here stubs a database answer.
 */
describe('D#7 DP10a: decision settings routes', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  const sql: string[] = [];

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
    // Record every statement the app_user connections issue, so the append-only claim is checked against what actually ran.
    const connect = appUserPool.connect.bind(appUserPool) as (...args: unknown[]) => Promise<PoolClient>;
    (appUserPool as unknown as { connect: (...args: unknown[]) => unknown }).connect = async (...args: unknown[]) => {
      // pg's own `pool.query` calls `connect(callback)`: leave the callback form alone.
      if (args.length > 0) return connect(...args);
      const client = await connect();
      const query = client.query.bind(client) as (...args: unknown[]) => unknown;
      (client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
        const first = args[0];
        sql.push(typeof first === 'string' ? first : String((first as { text?: string }).text ?? ''));
        return query(...args);
      };
      return client;
    };
  });

  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await adminPool.end();
    await platformOpsPool.end();
    await appUserPool.end();
  });

  async function call(identity: Identity, method: string, urlPath: string, body?: unknown, bearer?: string): Promise<Response> {
    const headers = new Headers();
    if (bearer) headers.set('authorization', `Bearer ${bearer}`);
    else headers.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(identity)}`);
    if (body !== undefined) headers.set('content-type', 'application/json');
    const req = new Request(`http://localhost/api/v1${urlPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return handleApiRequest(req, appUserPool, platformOpsPool, ROUTES);
  }

  async function addMember(accountId: string, role: 'admin' | 'member'): Promise<Identity> {
    const userId = randomUUID();
    await seedUser(admin, userId);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, userId, role]);
    return { accountId, userId };
  }

  async function seedRepo(accountId: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO repos (account_id, installation_id, gh_repo_id, product) VALUES ($1, NULL, $2, 'web') RETURNING id`,
      [accountId, Math.floor(Math.random() * 1e9)],
    );
    return rows[0]!.id;
  }

  async function fixture(): Promise<{ owner: Identity; admin: Identity; member: Identity; repoId: string }> {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    return {
      owner,
      admin: await addMember(owner.accountId, 'admin'),
      member: await addMember(owner.accountId, 'member'),
      repoId: await seedRepo(owner.accountId),
    };
  }

  const get = async (who: Identity, repoId: string): Promise<Settings> => {
    const res = await call(who, 'GET', `/repos/${repoId}/decision-settings`);
    expect(res.status).toBe(200);
    return (await res.json()) as Settings;
  };
  const dialsByType = (s: Settings): Record<string, Dial> => Object.fromEntries(s.dials.map((d) => [d.decision_type, d]));
  const versions = async (repoId: string): Promise<{ decision_type: string; version: number; disposition: string; preset: string | null; changed_by: string }[]> =>
    (await admin.query(`SELECT decision_type, version, disposition, preset, changed_by FROM decision_settings WHERE repo_id = $1 ORDER BY decision_type, version`, [repoId])).rows;
  const auditRows = async (accountId: string): Promise<{ actor: string; payload: { decision_type: string; previous: string | null; new: string } }[]> =>
    (await admin.query(`SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'decision_dial_changed' ORDER BY created_at, id`, [accountId])).rows;

  it('GET on a repo with no versions: the catalogue defaults, class 1 and 3 shown but not adjustable, the invariants from the DP5 source', async () => {
    const f = await fixture();
    const s = await get(f.owner, f.repoId);
    expect(s.can_change).toBe(true);
    expect(s.active_preset).toBeNull();
    expect(s.presets.map((p) => p.name)).toEqual(['cautious', 'balanced', 'autonomous']);
    expect(new Set(s.presets.map((p) => p.customer_role)).size).toBe(3);
    const dials = dialsByType(s);
    expect(s.dials).toHaveLength(15);
    for (const type of CLASS_2) expect(dials[type], type).toMatchObject({ adjustable: true, source: 'default', preset: null, version: null });
    expect(dials.runner_run_on_member_plan!.disposition).toBe('announce');
    expect(dials.nonbreaking_refactor_approach!.disposition).toBe('ask');
    // D#483 S5-a: with no dial row the starting-work dials ask (starting work is a person's approval until they choose); the always-asked ones are locked.
    for (const type of ['start_work_small', 'start_work_bug', 'start_work_doc', 'launch_sub_item']) expect(dials[type]!.disposition, type).toBe('ask');
    for (const type of ['start_parent_item', 'spend_past_envelope', 'start_after_reclassify']) {
      expect(dials[type], type).toMatchObject({ adjustable: false, disposition: 'ask', allowed_dispositions: ['ask'] });
    }
    expect(dials.dependency_patch_bump).toMatchObject({ adjustable: false, disposition: 'act' });
    expect(dials.publish_release_artifact).toMatchObject({ adjustable: false, disposition: 'ask' });
    // The invariants are exactly the list DP5's inventory test reads, and none is a dial.
    expect(s.invariants).toEqual(FIXED_INVARIANTS.map((i) => ({ key: i.key, layer: i.layer, label: invariantLabel(i.key) })));
    for (const i of s.invariants) expect(dials[i.key]).toBeUndefined();
    expect((await versions(f.repoId))).toHaveLength(0);
  });

  it('GET: a plain member reads with can_change false; a missing, malformed or other-tenant repo is one 404', async () => {
    const f = await fixture();
    const other = await fixture();
    expect((await get(f.member, f.repoId)).can_change).toBe(false);
    expect((await get(f.admin, f.repoId)).can_change).toBe(true);
    for (const id of [randomUUID(), 'not-a-uuid', other.repoId]) {
      const res = await call(f.owner, 'GET', `/repos/${id}/decision-settings`);
      expect(res.status, id).toBe(404);
    }
  });

  it('preview returns exactly the class 2 dials a preset moves and writes nothing', async () => {
    const f = await fixture();
    const balanced = await (await call(f.member, 'POST', `/repos/${f.repoId}/decision-settings/preset/preview`, { preset: 'balanced' })).json() as Preview;
    // Defaults are ask, ask, announce, ask, then ask on the four starting-work dials; Balanced is announce on the six it may and ask on the locked one.
    expect(balanced.moves).toEqual([
      { decision_type: 'nonbreaking_refactor_approach', from: 'ask', to: 'announce' },
      { decision_type: 'test_strategy_choice', from: 'ask', to: 'announce' },
      { decision_type: 'start_work_small', from: 'ask', to: 'announce' },
      { decision_type: 'start_work_bug', from: 'ask', to: 'announce' },
      { decision_type: 'start_work_doc', from: 'ask', to: 'announce' },
      { decision_type: 'launch_sub_item', from: 'ask', to: 'announce' },
    ]);
    const autonomous = await (await call(f.owner, 'POST', `/repos/${f.repoId}/decision-settings/preset/preview`, { preset: 'autonomous' })).json() as Preview;
    expect(autonomous.moves.map((m) => [m.decision_type, m.to])).toEqual([
      ['nonbreaking_refactor_approach', 'act'],
      ['test_strategy_choice', 'act'],
      ['runner_run_on_member_plan', 'act'],
      ['start_work_small', 'act'],
      ['start_work_bug', 'act'],
      ['start_work_doc', 'act'],
      ['launch_sub_item', 'act'],
    ]);
    for (const m of [...balanced.moves, ...autonomous.moves]) expect(CLASS_2).toContain(m.decision_type);
    expect(await versions(f.repoId)).toHaveLength(0);
    expect(await auditRows(f.owner.accountId)).toHaveLength(0);
    const bad = await call(f.owner, 'POST', `/repos/${f.repoId}/decision-settings/preset/preview`, { preset: 'reckless' });
    expect(bad.status).toBe(422);
  });

  it('applying a preset appends one version per moved class 2 dial with an audit row naming both values, and never touches class 1 or 3', async () => {
    const f = await fixture();
    const res = await call(f.admin, 'POST', `/repos/${f.repoId}/decision-settings/preset`, { preset: 'autonomous' });
    expect(res.status).toBe(200);
    const s = (await res.json()) as Settings;
    expect(s.active_preset).toBe('autonomous');
    expect(s.moved!.map((m) => m.decision_type).sort()).toEqual([
      'launch_sub_item', 'nonbreaking_refactor_approach', 'runner_run_on_member_plan', 'start_work_bug', 'start_work_doc', 'start_work_small', 'test_strategy_choice',
    ]);
    const dials = dialsByType(s);
    expect(dials.nonbreaking_refactor_approach).toMatchObject({ disposition: 'act', source: 'preset', preset: 'autonomous', version: 1 });
    expect(dials.publish_deprecation_notice).toMatchObject({ disposition: 'ask', source: 'default', version: null });
    const rows = await versions(f.repoId);
    expect(rows).toHaveLength(7);
    for (const r of rows) {
      expect(CLASS_2).toContain(r.decision_type);
      expect(r.changed_by).toBe(f.admin.userId);
      expect(r.preset).toBe('autonomous');
    }
    const audit = await auditRows(f.owner.accountId);
    expect(audit).toHaveLength(7);
    for (const a of audit) expect(a.actor).toBe(f.admin.userId);
    expect(audit.find((a) => a.payload.decision_type === 'runner_run_on_member_plan')!.payload).toMatchObject({ previous: 'announce', new: 'act' });
  });

  it('re-applying the active preset writes nothing; switching away and back is the undo, and the history keeps every step', async () => {
    const f = await fixture();
    const base = `/repos/${f.repoId}/decision-settings/preset`;
    await call(f.owner, 'POST', base, { preset: 'balanced' });
    const again = (await (await call(f.owner, 'POST', base, { preset: 'balanced' })).json()) as Settings;
    expect(again.moved).toEqual([]);
    expect(await versions(f.repoId)).toHaveLength(6);

    await call(f.owner, 'POST', base, { preset: 'cautious' });
    expect((await get(f.owner, f.repoId)).active_preset).toBe('cautious');
    const undone = (await (await call(f.owner, 'POST', base, { preset: 'balanced' })).json()) as Settings;
    expect(undone.active_preset).toBe('balanced');

    const rows = await versions(f.repoId);
    const refactor = rows.filter((r) => r.decision_type === 'nonbreaking_refactor_approach');
    expect(refactor.map((r) => [r.version, r.disposition])).toEqual([[1, 'announce'], [2, 'ask'], [3, 'announce']]);
    // Cautious asks for the runner dial, which was announce by default: moved, and its history starts there.
    const runner = rows.filter((r) => r.decision_type === 'runner_run_on_member_plan');
    expect(runner.map((r) => [r.version, r.disposition])).toEqual([[1, 'ask'], [2, 'announce']]);
    expect((await auditRows(f.owner.accountId)).length).toBe(rows.length);
  });

  it('a single dial change appends one version, leaves the preset derivation at custom, and the same value again is a no-op', async () => {
    const f = await fixture();
    await call(f.owner, 'POST', `/repos/${f.repoId}/decision-settings/preset`, { preset: 'balanced' });
    const url = `/repos/${f.repoId}/decision-settings/dial`;
    const res = await call(f.owner, 'POST', url, { decision_type: 'test_strategy_choice', disposition: 'act' });
    expect(res.status).toBe(200);
    const s = (await res.json()) as Settings;
    expect(s.active_preset).toBeNull();
    expect(dialsByType(s).test_strategy_choice).toMatchObject({ disposition: 'act', source: 'override', preset: null, version: 2 });
    const before = (await versions(f.repoId)).length;
    await call(f.owner, 'POST', url, { decision_type: 'test_strategy_choice', disposition: 'act' });
    expect((await versions(f.repoId)).length).toBe(before);
    // Setting it back to what the preset gave is the undo, and the derivation returns to balanced.
    const back = (await (await call(f.owner, 'POST', url, { decision_type: 'test_strategy_choice', disposition: 'announce' })).json()) as Settings;
    expect(back.active_preset).toBe('balanced');
    const last = (await auditRows(f.owner.accountId)).at(-1)!;
    expect(last.payload).toMatchObject({ decision_type: 'test_strategy_choice', previous: 'act', new: 'announce' });
    expect(last.actor).toBe(f.owner.userId);
  });

  it('naming the catalogue default on a dial with no version is a no-op: no version, no audit row', async () => {
    const f = await fixture();
    const res = await call(f.owner, 'POST', `/repos/${f.repoId}/decision-settings/dial`, { decision_type: 'test_strategy_choice', disposition: 'ask' });
    expect(res.status).toBe(200);
    expect(dialsByType((await res.json()) as Settings).test_strategy_choice).toMatchObject({ disposition: 'ask', source: 'default', version: null });
    expect(await versions(f.repoId)).toHaveLength(0);
    expect(await auditRows(f.owner.accountId)).toHaveLength(0);
  });

  it('a first dial write records the catalogue default as previous in the audit row', async () => {
    const f = await fixture();
    await call(f.owner, 'POST', `/repos/${f.repoId}/decision-settings/dial`, { decision_type: 'test_strategy_choice', disposition: 'act' });
    expect((await auditRows(f.owner.accountId)).at(-1)!.payload).toMatchObject({ decision_type: 'test_strategy_choice', previous: 'ask', new: 'act' });
  });

  it('a writer that loses the race to a concurrent commit gets 409 dial_changed, not 500 (version trigger, 23514)', async () => {
    const f = await fixture();
    // Commit version 1 from another connection after the route has read "no row" but before it inserts: hook the route's own pool.
    let raced = false;
    const connect = appUserPool.connect.bind(appUserPool) as (...args: unknown[]) => Promise<PoolClient>;
    const original = (appUserPool as unknown as { connect: unknown }).connect;
    (appUserPool as unknown as { connect: (...args: unknown[]) => unknown }).connect = async (...args: unknown[]) => {
      if (args.length > 0) return connect(...args);
      const client = await connect();
      const query = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
      (client as unknown as { query: (...a: unknown[]) => unknown }).query = async (...a: unknown[]) => {
        const first = a[0];
        const text = typeof first === 'string' ? first : String((first as { text?: string }).text ?? '');
        if (!raced && /^\s*INSERT INTO decision_settings/.test(text)) {
          raced = true;
          await admin.query(
            `INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, preset, version, changed_by) VALUES ($1, $2, 'test_strategy_choice', 'announce', NULL, 1, $3)`,
            [f.owner.accountId, f.repoId, f.owner.userId],
          );
        }
        return query(...a);
      };
      return client;
    };
    try {
      const res = await call(f.owner, 'POST', `/repos/${f.repoId}/decision-settings/dial`, { decision_type: 'test_strategy_choice', disposition: 'act' });
      expect(raced).toBe(true);
      expect(res.status).toBe(409);
      expect(((await res.json()) as ErrorBody).error.code).toBe('dial_changed');
    } finally {
      (appUserPool as unknown as { connect: unknown }).connect = original;
    }
  });

  it('refuses a dial on class 1, class 3, an unknown type or a fixed invariant, and a disposition the entry does not allow; nothing is written', async () => {
    const f = await fixture();
    const url = `/repos/${f.repoId}/decision-settings/dial`;
    const cases: [unknown, string, string][] = [
      [{ decision_type: 'dependency_patch_bump', disposition: 'ask' }, 'decision_type', 'not_adjustable'],
      [{ decision_type: 'external_paid_api_call', disposition: 'act' }, 'decision_type', 'not_adjustable'],
      [{ decision_type: 'publish_release_artifact', disposition: 'announce' }, 'decision_type', 'not_adjustable'],
      [{ decision_type: 'no_such_type', disposition: 'act' }, 'decision_type', 'unknown_decision_type'],
      ...FIXED_INVARIANTS.map((i): [unknown, string, string] => [{ decision_type: i.key, disposition: 'act' }, 'decision_type', 'unknown_decision_type']),
      [{ decision_type: 'publish_deprecation_notice', disposition: 'act' }, 'disposition', 'not_allowed'],
      [{ decision_type: 'publish_deprecation_notice', disposition: 'announce' }, 'disposition', 'not_allowed'],
    ];
    for (const [body, path, code] of cases) {
      const res = await call(f.owner, 'POST', url, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      const err = (await res.json()) as ErrorBody;
      expect(err.details, JSON.stringify(body)).toEqual([{ path, code }]);
    }
    for (const body of [{ decision_type: 'test_strategy_choice', disposition: 'deny' }, { decision_type: 'test_strategy_choice', disposition: 'act', class: 'human_in_the_loop' }, { disposition: 'act' }]) {
      expect((await call(f.owner, 'POST', url, body)).status, JSON.stringify(body)).toBe(422);
    }
    expect(await versions(f.repoId)).toHaveLength(0);
    expect(await auditRows(f.owner.accountId)).toHaveLength(0);
  });

  it('a plain member cannot write, a token cannot write, and neither leaves a version or an audit row', async () => {
    const f = await fixture();
    const plaintext = generateToken();
    await insertApiToken(appUserPool, {
      accountId: f.owner.accountId,
      createdBy: f.owner.userId,
      tokenHash: hashToken(plaintext),
      displayHint: 'fxat_...test',
      scopes: ['read'],
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const writes: [string, unknown][] = [
      [`/repos/${f.repoId}/decision-settings/preset`, { preset: 'autonomous' }],
      [`/repos/${f.repoId}/decision-settings/dial`, { decision_type: 'test_strategy_choice', disposition: 'act' }],
    ];
    for (const [url, body] of writes) {
      const asMember = await call(f.member, 'POST', url, body);
      expect(asMember.status, url).toBe(403);
      expect(((await asMember.json()) as ErrorBody).error.code).toBe('insufficient_role');
      const asToken = await call(f.owner, 'POST', url, body, plaintext);
      expect(asToken.status, url).toBe(403);
      expect(((await asToken.json()) as ErrorBody).error.code).toBe('session_required');
    }
    expect((await call(f.owner, 'GET', `/repos/${f.repoId}/decision-settings`, undefined, plaintext)).status).toBe(403);
    expect(await versions(f.repoId)).toHaveLength(0);
    expect(await auditRows(f.owner.accountId)).toHaveLength(0);
  });

  it('the database refuses the write even if the route check were bypassed: a member session inserting a version fails on privileges', async () => {
    const f = await fixture();
    const { appendDialVersion } = await import('@fx/db/src/decisions.js');
    const { withTenant } = await import('@fx/db/src/withTenant.js');
    await expect(
      withTenant(appUserPool, f.member.accountId, f.member.userId, (client) =>
        appendDialVersion(client, { accountId: f.member.accountId, repoId: f.repoId, decisionType: 'test_strategy_choice', disposition: 'act', preset: null, changedBy: f.member.userId }),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    expect(await versions(f.repoId)).toHaveLength(0);
  });

  it('never issues an UPDATE or DELETE against decision_settings (C8): every write the routes made is an INSERT', async () => {
    const f = await fixture();
    sql.length = 0;
    await call(f.owner, 'POST', `/repos/${f.repoId}/decision-settings/preset`, { preset: 'autonomous' });
    await call(f.owner, 'POST', `/repos/${f.repoId}/decision-settings/preset`, { preset: 'cautious' });
    await call(f.owner, 'POST', `/repos/${f.repoId}/decision-settings/dial`, { decision_type: 'test_strategy_choice', disposition: 'announce' });
    expect(sql.filter((q) => /INSERT\s+INTO\s+decision_settings/i.test(q)).length).toBeGreaterThanOrEqual(7);
    expect(sql.filter((q) => /\b(UPDATE|DELETE\s+FROM|TRUNCATE)\b[^;]*decision_settings/i.test(q))).toEqual([]);
    expect(sql.filter((q) => /decision_settings/i.test(q) && /FOR\s+(UPDATE|SHARE)/i.test(q))).toEqual([]);
  });

  it('each preset differs from the others only on class 2, as the API reports it', async () => {
    const f = await fixture();
    const table: Record<string, Record<string, string>> = {};
    for (const preset of ['cautious', 'balanced', 'autonomous']) {
      const s = (await (await call(f.owner, 'POST', `/repos/${f.repoId}/decision-settings/preset`, { preset })).json()) as Settings;
      table[preset] = Object.fromEntries(s.dials.map((d) => [d.decision_type, d.disposition]));
    }
    expect(table.cautious).toMatchObject({ nonbreaking_refactor_approach: 'ask', test_strategy_choice: 'ask', runner_run_on_member_plan: 'ask', publish_deprecation_notice: 'ask' });
    expect(table.balanced).toMatchObject({ nonbreaking_refactor_approach: 'announce', test_strategy_choice: 'announce', runner_run_on_member_plan: 'announce', publish_deprecation_notice: 'ask' });
    expect(table.autonomous).toMatchObject({ nonbreaking_refactor_approach: 'act', test_strategy_choice: 'act', runner_run_on_member_plan: 'act', publish_deprecation_notice: 'ask' });
    for (const type of ['dependency_patch_bump', 'retry_transient_step_failure']) for (const p of Object.keys(table)) expect(table[p]![type]).toBe('act');
    for (const type of ['publish_release_artifact', 'external_paid_api_call']) for (const p of Object.keys(table)) expect(table[p]![type]).toBe('ask');
  });
});

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { FIXED_INVARIANTS } from '@fx/db/src/dialInventory.js';
import { setPendingHooks } from '@fx/core/src/pendingWork.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { invariantLabel } from '../src/routes/decision-labels.js';
import { insertRunner } from '@fx/db/test/helpers/runnerFixtures.js';
import { PLAN_HOLDER_ONLY_SENTENCE, PRESET_HELD_SENTENCE } from '@fx/db/src/runnerPlanLoosen.js';
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

const CLASS_2 = ['nonbreaking_refactor_approach', 'test_strategy_choice', 'runner_run_on_member_plan', 'publish_deprecation_notice', 'start_work_small', 'start_work_bug', 'start_work_doc', 'launch_sub_item', 'tool_call', 'run_extension', 'merge_after_reviews'];

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
    // A repo with no versions runs as Balanced (owner ruling 10-25), so that is what it reads.
    expect(s.active_preset).toBe('balanced');
    expect(s.presets.map((p) => p.name)).toEqual(['cautious', 'balanced', 'autonomous']);
    expect(new Set(s.presets.map((p) => p.customer_role)).size).toBe(3);
    const dials = dialsByType(s);
    expect(s.dials).toHaveLength(20);
    for (const type of CLASS_2) expect(dials[type], type).toMatchObject({ adjustable: true, source: 'default', preset: null, version: null });
    expect(dials.runner_run_on_member_plan!.disposition).toBe('announce');
    // The dials the runtime reads as Balanced with no row show announce; a dial no runtime path reads keeps the catalogue default.
    for (const type of ['nonbreaking_refactor_approach', 'test_strategy_choice', 'start_work_small', 'start_work_bug', 'start_work_doc', 'launch_sub_item']) expect(dials[type]!.disposition, type).toBe('announce');
    for (const type of ['tool_call', 'run_extension', 'publish_deprecation_notice']) expect(dials[type]!.disposition, type).toBe('ask');
    for (const type of ['start_parent_item', 'spend_past_envelope', 'start_after_reclassify']) {
      expect(dials[type], type).toMatchObject({ adjustable: false, disposition: 'ask', allowed_dispositions: ['ask'] });
    }
    // D#7 DP7-1: the reversal records are not choices: a class 2 record whose only allowed disposition is `act`, and a class 3 that is always asked.
    expect(dials.reversal_recorded).toMatchObject({ disposition: 'act', allowed_dispositions: ['act'] });
    expect(dials.reversal_over_cap).toMatchObject({ adjustable: false, disposition: 'ask', allowed_dispositions: ['ask'] });
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
    // A repo with no versions already reads as Balanced, so Balanced moves nothing (the two dials no runtime path reads are not written for it).
    // ... but the three start dials are written by a person's choice (the auto-start sweep starts work only on a written row), so the preview says so.
    expect(balanced.active_preset).toBe('balanced');
    // The merge dial has no row and the gate reads that as the catalogue's act, which merges as announce does: it counts as Balanced, but a person's choice of Balanced
    // writes announce for it (what the preview says is what is written).
    expect(balanced.moves.map((m) => [m.decision_type, m.from, m.to]).sort()).toEqual([
      ...['start_work_bug', 'start_work_doc', 'start_work_small'].map((t) => [t, 'announce', 'announce']),
      ['merge_after_reviews', 'act', 'announce'],
    ].sort());
    const cautious = await (await call(f.owner, 'POST', `/repos/${f.repoId}/decision-settings/preset/preview`, { preset: 'cautious' })).json() as Preview;
    expect(cautious.moves.map((m) => [m.decision_type, m.from, m.to]).sort()).toEqual(
      [...['launch_sub_item', 'nonbreaking_refactor_approach', 'runner_run_on_member_plan', 'start_work_bug', 'start_work_doc', 'start_work_small', 'test_strategy_choice'].map((t) => [t, 'announce', 'ask']), ['merge_after_reviews', 'act', 'ask']].sort(),
    );
    expect(cautious.moves).toHaveLength(8);
    const autonomous = await (await call(f.owner, 'POST', `/repos/${f.repoId}/decision-settings/preset/preview`, { preset: 'autonomous' })).json() as Preview;
    expect(autonomous.moves.map((m) => [m.decision_type, m.to])).toEqual([
      ['nonbreaking_refactor_approach', 'act'],
      ['test_strategy_choice', 'act'],
      ['start_work_small', 'act'],
      ['start_work_bug', 'act'],
      ['start_work_doc', 'act'],
      ['launch_sub_item', 'act'],
      ['tool_call', 'act'],
      ['run_extension', 'act'],
    ]);
    for (const m of [...cautious.moves, ...autonomous.moves]) expect(CLASS_2).toContain(m.decision_type);
    expect(await versions(f.repoId)).toHaveLength(0);
    expect(await auditRows(f.owner.accountId)).toHaveLength(0);
    const bad = await call(f.owner, 'POST', `/repos/${f.repoId}/decision-settings/preset/preview`, { preset: 'reckless' });
    expect(bad.status).toBe(422);
  });

  it('S5-b1a-2: a preset that moves a dial, or a dial set looser, wakes the auto-start pass; setting it to ask does not', async () => {
    const sets: string[] = [];
    setPendingHooks({ store: { get: async () => null, set: async (key) => { sets.push(key); }, delete: async () => {} } });
    try {
      const f = await fixture();
      expect((await call(f.admin, 'POST', `/repos/${f.repoId}/decision-settings/dial`, { decision_type: 'start_work_small', disposition: 'ask' })).status).toBe(200);
      expect(sets).toEqual([]);
      expect((await call(f.admin, 'POST', `/repos/${f.repoId}/decision-settings/dial`, { decision_type: 'start_work_small', disposition: 'act' })).status).toBe(200);
      expect(sets).toContain('pending:proposal-verify-sweep');
      sets.length = 0;
      expect((await call(f.admin, 'POST', `/repos/${f.repoId}/decision-settings/preset`, { preset: 'autonomous' })).status).toBe(200);
      expect(sets).toContain('pending:proposal-verify-sweep');
    } finally {
      setPendingHooks(null);
    }
  });

  it('applying a preset appends one version per moved class 2 dial with an audit row naming both values, and never touches class 1 or 3', async () => {
    const f = await fixture();
    const res = await call(f.admin, 'POST', `/repos/${f.repoId}/decision-settings/preset`, { preset: 'autonomous' });
    expect(res.status).toBe(200);
    const s = (await res.json()) as Settings;
    // The member-plan dial is held back (a preset never loosens it, D#7 DW-R7), so no preset matches the repo as a whole.
    expect(s.active_preset).toBeNull();
    expect(s.moved!.map((m) => m.decision_type).sort()).toEqual([
      'launch_sub_item', 'nonbreaking_refactor_approach', 'run_extension', 'start_work_bug', 'start_work_doc', 'start_work_small', 'test_strategy_choice', 'tool_call',
    ]);
    const dials = dialsByType(s);
    expect(dials.nonbreaking_refactor_approach).toMatchObject({ disposition: 'act', source: 'preset', preset: 'autonomous', version: 1 });
    expect(dials.publish_deprecation_notice).toMatchObject({ disposition: 'ask', source: 'default', version: null });
    const rows = await versions(f.repoId);
    expect(rows).toHaveLength(8);
    for (const r of rows) {
      expect(CLASS_2).toContain(r.decision_type);
      expect(r.changed_by).toBe(f.admin.userId);
      expect(r.preset).toBe('autonomous');
    }
    const audit = await auditRows(f.owner.accountId);
    expect(audit).toHaveLength(8);
    for (const a of audit) expect(a.actor).toBe(f.admin.userId);
    expect(audit.find((a) => a.payload.decision_type === 'runner_run_on_member_plan')).toBeUndefined();
  });

  describe('D#7 DW-R7: the dial for running work on a member\'s plan only gets looser by its plan holder', () => {
    const RUN = 'runner_run_on_member_plan';
    const runnerFor = async (f: { owner: Identity; repoId: string }, by: Identity) => {
      const id = await insertRunner(admin, f.owner.accountId, by.userId);
      await admin.query('UPDATE runners SET allowed_repo_ids = $2::uuid[] WHERE id = $1', [id, [f.repoId]]);
      return id;
    };
    const runnerRows = async (repoId: string) => (await versions(repoId)).filter((r) => r.decision_type === RUN);

    it('a preset that would loosen it leaves it as it is, and preview and apply both say so per row; the other dials still move', async () => {
      const f = await fixture();
      const preview = (await (await call(f.owner, 'POST', `/repos/${f.repoId}/decision-settings/preset/preview`, { preset: 'autonomous' })).json()) as Preview & { held?: { decision_type: string; from: string; to: string; note: string }[] };
      expect(preview.moves.map((m) => m.decision_type)).not.toContain(RUN);
      expect(preview.held).toEqual([{ decision_type: RUN, from: 'announce', to: 'act', note: PRESET_HELD_SENTENCE }]);
      const res = await call(f.admin, 'POST', `/repos/${f.repoId}/decision-settings/preset`, { preset: 'autonomous' });
      expect(res.status).toBe(200);
      const applied = (await res.json()) as Settings & { held?: unknown };
      expect(applied.held).toEqual(preview.held);
      expect(applied.moved!.map((m) => m.decision_type)).not.toContain(RUN);
      expect(applied.moved).toHaveLength(8);
      expect(dialsByType(applied)[RUN]).toMatchObject({ disposition: 'announce', source: 'default', version: null });
      expect(applied.active_preset).toBeNull();
      expect(await runnerRows(f.repoId)).toEqual([]);
      expect((await auditRows(f.owner.accountId)).map((a) => a.payload.decision_type)).not.toContain(RUN);
    });

    it('a preset that tightens it still moves it, and a preset with nothing held carries no held list', async () => {
      const f = await fixture();
      const cautious = (await (await call(f.owner, 'POST', `/repos/${f.repoId}/decision-settings/preset`, { preset: 'cautious' })).json()) as Settings & { held?: unknown };
      expect(cautious.moved!.map((m) => m.decision_type)).toContain(RUN);
      expect(cautious.held).toBeUndefined();
      expect(dialsByType(cautious)[RUN]).toMatchObject({ disposition: 'ask', source: 'preset', preset: 'cautious', version: 1 });
      const balanced = (await (await call(f.owner, 'POST', `/repos/${f.repoId}/decision-settings/preset`, { preset: 'balanced' })).json()) as Settings & { held?: { decision_type: string }[] };
      expect(balanced.held!.map((h) => h.decision_type)).toEqual([RUN]);
      expect(dialsByType(balanced)[RUN]).toMatchObject({ disposition: 'ask', version: 1 });
    });

    it('a single dial set looser, or the default taken back off ask, is the holders\' alone when a live subscription runner lists the repo: 403 plan_holder_only, nothing written', async () => {
      const f = await fixture();
      await runnerFor(f, f.member);
      expect((await call(f.owner, 'POST', `/repos/${f.repoId}/decision-settings/dial`, { decision_type: RUN, disposition: 'ask' })).status).toBe(200);
      const refused = await call(f.admin, 'POST', `/repos/${f.repoId}/decision-settings/dial`, { decision_type: RUN, disposition: 'act' });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ error: { code: 'plan_holder_only', message: PLAN_HOLDER_ONLY_SENTENCE } });
      const back = await call(f.owner, 'POST', `/repos/${f.repoId}/decision-settings/reset`, { decision_type: RUN });
      expect(back.status).toBe(403);
      expect(((await back.json()) as ErrorBody).error.code).toBe('plan_holder_only');
      expect(await runnerRows(f.repoId)).toHaveLength(1);
      // Making it stricter, and every other dial, stay open.
      expect((await call(f.admin, 'POST', `/repos/${f.repoId}/decision-settings/dial`, { decision_type: 'start_work_small', disposition: 'act' })).status).toBe(200);
    });

    it('the holder of every live subscription runner on the repo may loosen it, and with no such runner an owner or admin may', async () => {
      const f = await fixture();
      await runnerFor(f, f.admin);
      await call(f.owner, 'POST', `/repos/${f.repoId}/decision-settings/dial`, { decision_type: RUN, disposition: 'ask' });
      expect((await call(f.admin, 'POST', `/repos/${f.repoId}/decision-settings/dial`, { decision_type: RUN, disposition: 'act' })).status).toBe(200);
      const g = await fixture();
      await call(g.owner, 'POST', `/repos/${g.repoId}/decision-settings/dial`, { decision_type: RUN, disposition: 'ask' });
      expect((await call(g.admin, 'POST', `/repos/${g.repoId}/decision-settings/dial`, { decision_type: RUN, disposition: 'act' })).status).toBe(200);
    });
  });

  it('re-applying the active preset writes nothing more; switching away and back is the undo, and the history keeps every step', async () => {
    const f = await fixture();
    const base = `/repos/${f.repoId}/decision-settings/preset`;
    // A repo with no versions already reads as Balanced; choosing it writes the three start dials (and nothing else), and choosing it again writes nothing.
    const chosen = (await (await call(f.owner, 'POST', base, { preset: 'balanced' })).json()) as Settings;
    expect(chosen.active_preset).toBe('balanced');
    expect(chosen.moved!.map((m) => m.decision_type).sort()).toEqual(['merge_after_reviews', 'start_work_bug', 'start_work_doc', 'start_work_small']);
    expect(((await (await call(f.owner, 'POST', base, { preset: 'balanced' })).json()) as Settings).moved).toEqual([]);
    const afterBalanced = (await versions(f.repoId)).length;
    expect(afterBalanced).toBe(chosen.moved!.length);
    // Cautious moves the six dials the runtime reads, the member-plan dial and the merge dial; the two no runtime path reads already say ask.
    const first = (await (await call(f.owner, 'POST', base, { preset: 'cautious' })).json()) as Settings;
    expect(first.moved).toHaveLength(8);
    const again = (await (await call(f.owner, 'POST', base, { preset: 'cautious' })).json()) as Settings;
    expect(again.moved).toEqual([]);
    expect(await versions(f.repoId)).toHaveLength(afterBalanced + first.moved!.length);
    expect((await get(f.owner, f.repoId)).active_preset).toBe('cautious');
    const undone = (await (await call(f.owner, 'POST', base, { preset: 'balanced' })).json()) as Settings;
    // Balanced over Cautious would loosen the member-plan dial, which stays ask: no preset matches, and the answer says which dial was held.
    expect(undone.active_preset).toBeNull();
    expect((undone as Settings & { held?: { decision_type: string }[] }).held!.map((h) => h.decision_type)).toEqual(['runner_run_on_member_plan']);

    const rows = await versions(f.repoId);
    const refactor = rows.filter((r) => r.decision_type === 'nonbreaking_refactor_approach');
    expect(refactor.map((r) => [r.version, r.disposition])).toEqual([[1, 'ask'], [2, 'announce']]);
    // Cautious asks for the runner dial, which was announce by default: moved, and its history starts there.
    const runner = rows.filter((r) => r.decision_type === 'runner_run_on_member_plan');
    expect(runner.map((r) => [r.version, r.disposition])).toEqual([[1, 'ask']]);
    expect((await auditRows(f.owner.accountId)).length).toBe(rows.length);
  });

  it('D#7 DW-R4: the merge dial reads act with no row (the gate\'s default), counts as Balanced, is written as announce by choosing Balanced, and Reset returns it to the act marker the gate reads as default', async () => {
    const f = await fixture();
    const dial = async () => dialsByType(await get(f.owner, f.repoId)).merge_after_reviews!;
    expect(await dial()).toMatchObject({ disposition: 'act', source: 'default', version: null });
    expect((await get(f.owner, f.repoId)).active_preset).toBe('balanced');
    await call(f.owner, 'POST', `/repos/${f.repoId}/decision-settings/preset`, { preset: 'balanced' });
    expect(await dial()).toMatchObject({ disposition: 'announce', source: 'preset', preset: 'balanced', version: 1 });
    // Reset: back to the catalogue's act as a marker row, which reads as the default and which the gate (readMergeDial) reads as act.
    await call(f.owner, 'POST', `/repos/${f.repoId}/decision-settings/reset`, { decision_type: 'merge_after_reviews' });
    expect(await dial()).toMatchObject({ disposition: 'act', source: 'default', preset: null, version: 2 });
    const marker = (await versions(f.repoId)).filter((r) => r.decision_type === 'merge_after_reviews').map((r) => [r.version, r.disposition, r.preset]);
    expect(marker).toEqual([[1, 'announce', 'balanced'], [2, 'act', 'default']]);
    expect((await get(f.owner, f.repoId)).active_preset).toBe('balanced');
    // Choosing Balanced again writes announce again (the marker is not a written choice), and Autonomous writes nothing for a merge dial already at act.
    const again = (await (await call(f.owner, 'POST', `/repos/${f.repoId}/decision-settings/reset`, {})).json()) as Settings;
    expect(again.dials.length).toBeGreaterThan(0);
    const auto = (await (await call(f.owner, 'POST', `/repos/${f.repoId}/decision-settings/preset/preview`, { preset: 'autonomous' })).json()) as Preview;
    expect(auto.moves.map((m) => m.decision_type)).not.toContain('merge_after_reviews');
    const bal = (await (await call(f.owner, 'POST', `/repos/${f.repoId}/decision-settings/preset/preview`, { preset: 'balanced' })).json()) as Preview;
    expect(bal.moves.find((m) => m.decision_type === 'merge_after_reviews')).toEqual({ decision_type: 'merge_after_reviews', from: 'act', to: 'announce' });
  });

  it('a single dial change appends one version, leaves the preset derivation at custom, and the same value again is a no-op', async () => {
    const f = await fixture();
    const url = `/repos/${f.repoId}/decision-settings/dial`;
    const res = await call(f.owner, 'POST', url, { decision_type: 'test_strategy_choice', disposition: 'act' });
    expect(res.status).toBe(200);
    const s = (await res.json()) as Settings;
    expect(s.active_preset).toBeNull();
    expect(dialsByType(s).test_strategy_choice).toMatchObject({ disposition: 'act', source: 'override', preset: null, version: 1 });
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

  it('use the default: set, reset, read back source default; one new version and one audit row; the history keeps every step', async () => {
    const f = await fixture();
    const base = `/repos/${f.repoId}/decision-settings`;
    await call(f.owner, 'POST', `${base}/dial`, { decision_type: 'test_strategy_choice', disposition: 'act' });
    const res = await call(f.owner, 'POST', `${base}/reset`, { decision_type: 'test_strategy_choice' });
    expect(res.status).toBe(200);
    const s = (await res.json()) as Settings;
    expect(dialsByType(s).test_strategy_choice).toMatchObject({ disposition: 'announce', source: 'default', preset: null, version: 2 });
    // A fresh read agrees: derived, not stamped on the response.
    expect(dialsByType(await get(f.owner, f.repoId)).test_strategy_choice).toMatchObject({ disposition: 'announce', source: 'default', preset: null });
    expect((await versions(f.repoId)).map((v) => [v.version, v.disposition, v.preset])).toEqual([[1, 'act', null], [2, 'announce', 'default']]);
    expect((await auditRows(f.owner.accountId)).at(-1)!.payload).toMatchObject({ decision_type: 'test_strategy_choice', previous: 'act', new: 'announce' });
    // Already on the default: nothing more is written.
    await call(f.owner, 'POST', `${base}/reset`, { decision_type: 'test_strategy_choice' });
    expect(await versions(f.repoId)).toHaveLength(2);
    // A later write is an override again, with the next version.
    const again = (await (await call(f.owner, 'POST', `${base}/dial`, { decision_type: 'test_strategy_choice', disposition: 'ask' })).json()) as Settings;
    expect(dialsByType(again).test_strategy_choice).toMatchObject({ disposition: 'ask', source: 'override', version: 3 });
  });

  it('use the default with no decision type resets every class 2 dial the preset moved, and a repo with no versions writes nothing', async () => {
    const f = await fixture();
    const base = `/repos/${f.repoId}/decision-settings`;
    expect((await call(f.owner, 'POST', `${base}/reset`, {})).status).toBe(200);
    expect(await versions(f.repoId)).toHaveLength(0);
    await call(f.owner, 'POST', `${base}/preset`, { preset: 'autonomous' });
    const moved = (await versions(f.repoId)).length;
    expect(moved).toBeGreaterThan(0);
    const s = (await (await call(f.owner, 'POST', `${base}/reset`, {})).json()) as Settings;
    for (const d of s.dials.filter((x) => x.adjustable)) expect(d.source, d.decision_type).toBe('default');
    expect(s.active_preset).toBe((await get(f.owner, await seedRepo(f.owner.accountId))).active_preset);
    expect((await versions(f.repoId)).length).toBe(moved * 2);
  });

  it('use the default: a member and a token are refused, unknown types are 422, another account\'s repo is 404, and nothing is written', async () => {
    const f = await fixture();
    const other = await fixture();
    const url = `/repos/${f.repoId}/decision-settings/reset`;
    const plaintext = generateToken();
    await insertApiToken(appUserPool, {
      accountId: f.owner.accountId,
      createdBy: f.owner.userId,
      tokenHash: hashToken(plaintext),
      displayHint: 'fxat_...test',
      scopes: ['read'],
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await call(other.owner, 'POST', `/repos/${other.repoId}/decision-settings/dial`, { decision_type: 'test_strategy_choice', disposition: 'act' });
    const theirsBefore = await versions(other.repoId);
    const crossed = await call(f.owner, 'POST', `/repos/${other.repoId}/decision-settings/reset`, {});
    expect(crossed.status).toBe(404);
    const crossedSingle = await call(f.owner, 'POST', `/repos/${other.repoId}/decision-settings/reset`, { decision_type: 'test_strategy_choice' });
    expect(crossedSingle.status).toBe(404);
    expect(await versions(other.repoId)).toEqual(theirsBefore);
    const asToken = await call(f.owner, 'POST', url, {}, plaintext);
    expect(asToken.status).toBe(403);
    expect(((await asToken.json()) as ErrorBody).error.code).toBe('session_required');
    await call(f.owner, 'POST', `/repos/${f.repoId}/decision-settings/dial`, { decision_type: 'test_strategy_choice', disposition: 'act' });
    const before = (await versions(f.repoId)).length;
    expect((await call(f.member, 'POST', url, {})).status).toBe(403);
    expect((await call(f.owner, 'POST', url, { decision_type: 'no_such_type' })).status).toBe(422);
    expect((await call(f.owner, 'POST', url, { decision_type: 'test_strategy_choice', extra: 1 })).status).toBe(422);
    expect((await versions(f.repoId)).length).toBe(before);
  });

  it('naming the catalogue default on a dial with no version is a no-op: no version, no audit row', async () => {
    const f = await fixture();
    const res = await call(f.owner, 'POST', `/repos/${f.repoId}/decision-settings/dial`, { decision_type: 'test_strategy_choice', disposition: 'announce' });
    expect(res.status).toBe(200);
    expect(dialsByType((await res.json()) as Settings).test_strategy_choice).toMatchObject({ disposition: 'announce', source: 'default', version: null });
    expect(await versions(f.repoId)).toHaveLength(0);
    expect(await auditRows(f.owner.accountId)).toHaveLength(0);
  });

  it('a first dial write records the catalogue default as previous in the audit row', async () => {
    const f = await fixture();
    await call(f.owner, 'POST', `/repos/${f.repoId}/decision-settings/dial`, { decision_type: 'test_strategy_choice', disposition: 'act' });
    expect((await auditRows(f.owner.accountId)).at(-1)!.payload).toMatchObject({ decision_type: 'test_strategy_choice', previous: 'announce', new: 'act' });
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
    const table: Record<string, Record<string, string>> = {};
    for (const preset of ['cautious', 'balanced', 'autonomous']) {
      const f = await fixture(); // a repo of its own each: a preset is never applied over the looser dial another one left
      const s = (await (await call(f.owner, 'POST', `/repos/${f.repoId}/decision-settings/preset`, { preset })).json()) as Settings;
      table[preset] = Object.fromEntries(s.dials.map((d) => [d.decision_type, d.disposition]));
    }
    expect(table.cautious).toMatchObject({ nonbreaking_refactor_approach: 'ask', test_strategy_choice: 'ask', runner_run_on_member_plan: 'ask', publish_deprecation_notice: 'ask' });
    expect(table.balanced).toMatchObject({ nonbreaking_refactor_approach: 'announce', test_strategy_choice: 'announce', runner_run_on_member_plan: 'announce', publish_deprecation_notice: 'ask' });
    expect(table.autonomous).toMatchObject({ nonbreaking_refactor_approach: 'act', test_strategy_choice: 'act', runner_run_on_member_plan: 'announce', publish_deprecation_notice: 'ask' }); // held: a preset never loosens it (D#7 DW-R7)
    for (const type of ['dependency_patch_bump', 'retry_transient_step_failure']) for (const p of Object.keys(table)) expect(table[p]![type]).toBe('act');
    for (const type of ['publish_release_artifact', 'external_paid_api_call']) for (const p of Object.keys(table)) expect(table[p]![type]).toBe('ask');
  });
});

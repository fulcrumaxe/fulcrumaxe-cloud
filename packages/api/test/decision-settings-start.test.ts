import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { CATALOGUE, getCatalogueEntry } from '@fx/decisions';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { decideStart } from '@fx/core/src/decisions/startDecide.js';
import { presetOf } from '@fx/core/src/decisions/fixRoundGate.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { RUNTIME_NO_ROW_BALANCED } from '../src/routes/decision-settings.js';

const INVOKER_LOGIN = 'fx_dial_start_test';
const SMALL = ['small', 'bug', 'doc'] as const;

interface Identity {
  accountId: string;
  userId: string;
}
interface Dial {
  decision_type: string;
  disposition: string;
  source: string;
  version: number | null;
}
interface Settings {
  active_preset: string | null;
  dials: Dial[];
  held?: { decision_type: string }[];
}

/**
 * D#7 DW-PRESET-ONBOARD: the settings API reads a repository with no dial row the way the runtime does (Balanced), and the preset it writes changes what
 * the REAL start path does next. Each claim goes through `handleApiRequest` (real routes, RLS) and `decideStart` (the unattended start the sweep runs),
 * against real Postgres. Nothing here stubs either side.
 */
describe('D#7 DW-PRESET-ONBOARD: the settings API and the start path agree on a repo with no dial row [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let receiptPool: Pool;
  let t: SeedRefs;
  let who: Identity;

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${INVOKER_LOGIN}') THEN
          CREATE ROLE ${INVOKER_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
      END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${INVOKER_LOGIN}`);
    const u = new URL(process.env.API_DATABASE_URL_APP_USER!);
    u.username = INVOKER_LOGIN;
    u.password = '';
    receiptPool = createPool(u.toString());
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
    t = await seedAccount(admin, randomUUID());
    const userId = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'admin')`, [t.accountId, userId]);
    who = { accountId: t.accountId, userId };
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await Promise.all([adminPool.end(), platformOpsPool.end(), appUserPool.end(), receiptPool.end()]);
  });

  async function call(method: string, urlPath: string, body?: unknown): Promise<Response> {
    const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession(who)}` });
    if (body !== undefined) headers.set('content-type', 'application/json');
    return handleApiRequest(new Request(`http://localhost/api/v1${urlPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), appUserPool, platformOpsPool, ROUTES);
  }
  const newRepo = async (): Promise<string> =>
    (await admin.query<{ id: string }>(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, 'team') RETURNING id`, [t.accountId, t.installationId, 100 + Math.floor(Math.random() * 1e9)])).rows[0]!.id;
  const newItem = async (repoId: string): Promise<string> =>
    (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title) VALUES ($1, $2, 'issue', 'internal', 'Fix it') RETURNING id`, [t.accountId, repoId])).rows[0]!.id;
  const read = async (repoId: string): Promise<Settings> => {
    const res = await call('GET', `/repos/${repoId}/decision-settings`);
    expect(res.status).toBe(200);
    return (await res.json()) as Settings;
  };
  const write = async (repoId: string, path: string, body: unknown): Promise<Settings> => {
    const res = await call('POST', `/repos/${repoId}/decision-settings/${path}`, body);
    expect(res.status).toBe(200);
    return (await res.json()) as Settings;
  };
  const preset = (repoId: string, name: string) => write(repoId, 'preset', { preset: name });
  /** The next unattended start of a fresh item of that kind, through the real gate. */
  const nextStart = async (repoId: string, kind: (typeof SMALL)[number] = 'small') =>
    decideStart({ pool: receiptPool, accountId: t.accountId }, { workItemId: await newItem(repoId), origin: 'unattended', category: kind, cameInAs: null });
  const dial = (s: Settings, type: string): Dial => s.dials.find((d) => d.decision_type === type)!;

  it('a repo with no dial row reads Balanced, and every start dial starts as Balanced would: a policy receipt that announces', async () => {
    const repo = await newRepo();
    const s = await read(repo);
    expect(s.active_preset).toBe('balanced');
    for (const kind of SMALL) {
      expect(dial(s, `start_work_${kind}`)).toMatchObject({ disposition: 'announce', source: 'default', version: null });
      expect(await nextStart(repo, kind), kind).toMatchObject({ proceed: true, how: 'policy_receipt', preset: 'balanced', announce: true });
    }
    // The fix-round and child-launch dial reads a missing row as Balanced in the runtime too.
    expect(presetOf(undefined)).toBe('balanced');
    expect(dial(s, 'launch_sub_item').disposition).toBe('announce');
  });

  it('the list of dials the API reads as Balanced is the list the runtime overrides: the start dials, the fix-round dial, and the types the executor card declares', () => {
    const card = readFileSync(new URL('../../roles/cards/executor.md', import.meta.url), 'utf8');
    const declared = (/^decision_types:\s*\[([^\]]*)\]/m.exec(card)?.[1] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    expect(declared.length).toBeGreaterThan(0);
    expect([...RUNTIME_NO_ROW_BALANCED].sort()).toEqual(['launch_sub_item', 'start_work_bug', 'start_work_doc', 'start_work_small', ...declared].sort());
    for (const id of RUNTIME_NO_ROW_BALANCED) expect(getCatalogueEntry(id)?.class, id).toBe('human_over_the_loop');
    // "Run on a member's plan" keeps its own rule, and its catalogue default is already Balanced's value.
    expect(getCatalogueEntry('runner_run_on_member_plan')!.defaultDisposition).toBe('announce');
    expect(CATALOGUE.some((e) => e.id === 'tool_call' && e.defaultDisposition === 'ask')).toBe(true);
  });

  it('Cautious makes the next start an ask, Balanced stops it, Reset goes back, and Autonomous starts without saying so', async () => {
    const repo = await newRepo();
    expect(await nextStart(repo)).toMatchObject({ proceed: true, preset: 'balanced' });

    const cautious = await preset(repo, 'cautious');
    expect(cautious.active_preset).toBe('cautious');
    expect(await nextStart(repo)).toMatchObject({ proceed: false, reason: 'asked', decisionType: 'start_work_small', askId: expect.any(String) });
    expect(await nextStart(repo, 'bug')).toMatchObject({ proceed: false, reason: 'asked' });

    const balanced = await preset(repo, 'balanced');
    // The member-plan dial stays ask (a preset only tightens it), so the repo as a whole is custom; the start dials are Balanced again.
    expect(balanced.held!.map((h) => h.decision_type)).toEqual(['runner_run_on_member_plan']);
    expect(await nextStart(repo)).toMatchObject({ proceed: true, how: 'policy_receipt', preset: 'balanced', announce: true });
    expect(await nextStart(repo, 'doc')).toMatchObject({ proceed: true, preset: 'balanced' });

    await preset(repo, 'cautious');
    expect(await nextStart(repo)).toMatchObject({ proceed: false, reason: 'asked' });
    const reset = await write(repo, 'reset', {});
    expect(dial(reset, 'start_work_small')).toMatchObject({ disposition: 'announce', source: 'default' });
    expect(await nextStart(repo)).toMatchObject({ proceed: true, preset: 'balanced' });

    await preset(repo, 'autonomous');
    expect(await nextStart(repo)).toMatchObject({ proceed: true, preset: 'autonomous', announce: false });
  });

  it('Reset on a repo that never chose writes nothing; Reset after Cautious returns the repo to the label it started with', async () => {
    const repo = await newRepo();
    const count = async (): Promise<number> => (await admin.query(`SELECT count(*)::int AS n FROM decision_settings WHERE repo_id = $1`, [repo])).rows[0].n;
    await write(repo, 'reset', {});
    expect(await count()).toBe(0);
    await preset(repo, 'cautious');
    const after = await write(repo, 'reset', {});
    expect(after.active_preset).toBe('balanced');
    for (const d of after.dials.filter((x) => RUNTIME_NO_ROW_BALANCED.has(x.decision_type))) expect(d, d.decision_type).toMatchObject({ disposition: 'announce', source: 'default' });
    // The history keeps every step; a second Reset has nothing to do.
    const before = await count();
    await write(repo, 'reset', {});
    expect(await count()).toBe(before);
  });

  it('a "default" row an earlier reset wrote with the catalogue ask is read by the runtime as Cautious; the API shows the same, and Reset replaces it', async () => {
    const repo = await newRepo();
    await admin.query(`INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, preset, version, changed_by) VALUES ($1, $2, 'start_work_small', 'ask', 'default', 1, $3)`, [t.accountId, repo, who.userId]);
    const s = await read(repo);
    expect(dial(s, 'start_work_small')).toMatchObject({ disposition: 'ask', source: 'default', version: 1 });
    expect(await nextStart(repo)).toMatchObject({ proceed: false, reason: 'asked' });
    const fixed = await write(repo, 'reset', {});
    expect(dial(fixed, 'start_work_small')).toMatchObject({ disposition: 'announce', source: 'default', version: 2 });
    expect(fixed.active_preset).toBe('balanced');
    expect(await nextStart(repo)).toMatchObject({ proceed: true, preset: 'balanced' });
  });

  it('the picker\'s read works on a read-only preview repo: the settings route accepts a team_readonly repo, and a choice on it reads back', async () => {
    const inst = (await admin.query<{ id: string }>(`INSERT INTO installations (account_id, gh_installation_id, app_kind) VALUES ($1, $2, 'team_readonly') RETURNING id`, [t.accountId, 900000000 + Math.floor(Math.random() * 1e8)])).rows[0]!.id;
    const repo = (await admin.query<{ id: string }>(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, 'team') RETURNING id`, [t.accountId, inst, 100 + Math.floor(Math.random() * 1e9)])).rows[0]!.id;
    expect((await read(repo)).active_preset).toBe('balanced');
    expect((await preset(repo, 'cautious')).active_preset).toBe('cautious');
    expect((await read(repo)).active_preset).toBe('cautious');
    await preset(repo, 'balanced');
    expect(dial(await read(repo), 'start_work_small').disposition).toBe('announce');
  });
});

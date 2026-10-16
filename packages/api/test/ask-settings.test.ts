import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { CATALOGUE } from '@fx/decisions';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { FIXED_INVARIANTS } from '@fx/db/src/dialInventory.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { DECISION_LABELS, INVARIANT_LABELS } from '../src/routes/decision-labels.js';
import { formatWindow } from '../src/routes/ask-settings.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

interface Identity {
  accountId: string;
  userId: string;
}
interface Stored {
  answer_window_minutes: number | null;
  timeout_outcome: string | null;
  notify: string | null;
  version: number;
}
interface Row {
  decision_type: string;
  label: string;
  class: string | null;
  allowed_outcomes: string[];
  account: Stored | null;
  repo: Stored | null;
  effective: { answer_window_minutes: number; answer_window_text: string; timeout_outcome: string; notify: string } | null;
}
interface AskSettings {
  repo_id: string;
  can_change: boolean;
  preset_basis: string;
  bounds: { min_minutes: number; max_minutes: number; default_minutes: number };
  notify_values: string[];
  notify_default: string;
  rows: Row[];
}
interface ErrorBody {
  error: { code: string };
  details?: { path: string; code: string }[];
}

const ASKED = [
  'nonbreaking_refactor_approach',
  'test_strategy_choice',
  'runner_run_on_member_plan',
  'start_work_small',
  'start_work_bug',
  'start_work_doc',
  'launch_sub_item',
  'tool_call',
  'run_extension',
  'publish_deprecation_notice',
  'publish_release_artifact',
  'external_paid_api_call',
  'start_parent_item',
  'spend_past_envelope',
  'start_after_reclassify',
];
const STOP_ONLY = [
  'runner_run_on_member_plan',
  'start_work_small',
  'start_work_bug',
  'start_work_doc',
  'launch_sub_item',
  'tool_call',
  'publish_deprecation_notice',
  'publish_release_artifact',
  'external_paid_api_call',
  'start_parent_item',
  'spend_past_envelope',
  'start_after_reclassify',
];

/**
 * D#7 DP10b: the ask settings routes behind the Autonomy section, called through the real `handleApiRequest` against real Postgres (RLS,
 * the owner/admin INSERT policy, the next-version trigger, the audit function). Nothing here stubs a database answer.
 */
describe('D#7 DP10b: ask settings routes', () => {
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
      if (args.length > 0) return connect(...args);
      const client = await connect();
      // A pooled client comes back on every checkout: wrap it once, or each statement is recorded once per earlier checkout.
      if ((client as unknown as { __recorded?: boolean }).__recorded) return client;
      (client as unknown as { __recorded?: boolean }).__recorded = true;
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

  async function fixture(): Promise<{ owner: Identity; admin: Identity; member: Identity; repoId: string; otherRepoId: string }> {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    return {
      owner,
      admin: await addMember(owner.accountId, 'admin'),
      member: await addMember(owner.accountId, 'member'),
      repoId: await seedRepo(owner.accountId),
      otherRepoId: await seedRepo(owner.accountId),
    };
  }

  const get = async (who: Identity, repoId: string): Promise<AskSettings> => {
    const res = await call(who, 'GET', `/repos/${repoId}/ask-settings`);
    expect(res.status).toBe(200);
    return (await res.json()) as AskSettings;
  };
  const write = (who: Identity, repoId: string, body: Record<string, unknown>): Promise<Response> => call(who, 'POST', `/repos/${repoId}/ask-settings`, body);
  const byType = (s: AskSettings): Record<string, Row> => Object.fromEntries(s.rows.map((r) => [r.decision_type, r]));
  const versions = async (accountId: string): Promise<{ repo_id: string | null; decision_type: string; version: number; answer_window_minutes: number | null; timeout_outcome: string | null; notify: string | null; changed_by: string }[]> =>
    (await admin.query(`SELECT repo_id, decision_type, version, answer_window_minutes, timeout_outcome, notify, changed_by FROM decision_ask_settings WHERE account_id = $1 ORDER BY decision_type, repo_id NULLS FIRST, version`, [accountId])).rows;
  const auditRows = async (accountId: string): Promise<{ actor: string; payload: { decision_type: string; previous: Record<string, unknown>; new: Record<string, unknown> } }[]> =>
    (await admin.query(`SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'decision_ask_setting.changed' ORDER BY created_at, id`, [accountId])).rows;

  it('every catalogue entry and every fixed invariant has a customer-facing name, so no raw id reaches the page', () => {
    for (const entry of CATALOGUE) expect(DECISION_LABELS[entry.id], entry.id).toMatch(/\S/);
    for (const invariant of FIXED_INVARIANTS) expect(INVARIANT_LABELS[invariant.key], invariant.key).toMatch(/\S/);
    for (const label of [...Object.values(DECISION_LABELS), ...Object.values(INVARIANT_LABELS)]) expect(label).not.toMatch(/_|undefined|null/);
  });

  it('formatWindow reads whole units, largest first', () => {
    expect(formatWindow(15)).toBe('15 minutes');
    expect(formatWindow(60)).toBe('1 hour');
    expect(formatWindow(90)).toBe('1 hour 30 minutes');
    expect(formatWindow(1440)).toBe('1 day');
    expect(formatWindow(1441)).toBe('1 day 1 minute');
    expect(formatWindow(20160)).toBe('14 days');
  });

  it('GET with nothing stored: the * row plus every asked type, in effect = the R2 and R3 defaults under Cautious, named for a person', async () => {
    const f = await fixture();
    const s = await get(f.owner, f.repoId);
    expect(s.can_change).toBe(true);
    expect(s.preset_basis).toBe('cautious');
    expect(s.bounds).toEqual({ min_minutes: 15, max_minutes: 20160, default_minutes: 1440 });
    expect(s.notify_values).toEqual(['email', 'none']);
    expect(s.notify_default).toBe('email');
    expect(s.rows.map((r) => r.decision_type)).toEqual(['*', ...ASKED]);
    const rows = byType(s);
    expect(rows['*']).toMatchObject({ class: null, effective: null, allowed_outcomes: ['stop_and_flag', 'proceed_recommended'], account: null, repo: null });
    for (const type of ASKED) {
      expect(rows[type]!.effective, type).toEqual({ answer_window_minutes: 1440, answer_window_text: '1 day', timeout_outcome: 'stop_and_flag', notify: 'email' });
      expect(rows[type]!.label, type).not.toBe(type);
      expect(rows[type]!.account).toBeNull();
    }
    // The catalogue, not this route, decides what is allowed: only the two internal refactor/test entries and run_extension may go ahead on silence.
    for (const type of STOP_ONLY) expect(rows[type]!.allowed_outcomes, type).toEqual(['stop_and_flag']);
    expect(rows.nonbreaking_refactor_approach!.allowed_outcomes).toEqual(['stop_and_flag', 'proceed_recommended']);
    expect(rows.run_extension!.allowed_outcomes).toEqual(['stop_and_flag', 'proceed_recommended']);
    expect(rows.run_extension!.label).toBe('Extending a run past its limit');
    expect(await versions(f.owner.accountId)).toHaveLength(0);
  });

  it('a write appends one version and one audit row naming both values; the page shows it in effect, repo overriding account', async () => {
    const f = await fixture();
    const res = await write(f.owner, f.repoId, { scope: 'account', decision_type: '*', answer_window_minutes: 90, timeout_outcome: null, notify: 'none' });
    expect(res.status).toBe(200);
    const s = (await res.json()) as AskSettings;
    expect(byType(s)['*']!.account).toMatchObject({ answer_window_minutes: 90, timeout_outcome: null, notify: 'none', version: 1 });
    expect(byType(s).test_strategy_choice!.effective).toEqual({ answer_window_minutes: 90, answer_window_text: '1 hour 30 minutes', timeout_outcome: 'stop_and_flag', notify: 'none' });
    // A repo override beats the account value on that repo only.
    const repo = (await (await write(f.admin, f.repoId, { scope: 'repo', decision_type: 'test_strategy_choice', answer_window_minutes: 30, timeout_outcome: 'proceed_recommended', notify: null })).json()) as AskSettings;
    expect(byType(repo).test_strategy_choice).toMatchObject({ repo: { answer_window_minutes: 30, timeout_outcome: 'proceed_recommended', version: 1 }, effective: { answer_window_minutes: 30, timeout_outcome: 'proceed_recommended', notify: 'none' } });
    expect(byType(await get(f.owner, f.otherRepoId)).test_strategy_choice!.effective).toMatchObject({ answer_window_minutes: 90, timeout_outcome: 'stop_and_flag' });
    const rows = await versions(f.owner.accountId);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.decision_type === '*')).toMatchObject({ repo_id: null, changed_by: f.owner.userId });
    expect(rows.find((r) => r.decision_type === 'test_strategy_choice')).toMatchObject({ repo_id: f.repoId, changed_by: f.admin.userId });
    const audit = await auditRows(f.owner.accountId);
    expect(audit).toHaveLength(2);
    expect(audit[0]!.actor).toBe(f.owner.userId);
    expect(audit[0]!.payload).toMatchObject({ decision_type: '*', previous: { answer_window_minutes: null, notify: null }, new: { answer_window_minutes: 90, notify: 'none' } });
  });

  it('the active preset is the basis for what is in effect: Balanced goes ahead on a class 2 type that allows it and still stops on the locked ones', async () => {
    const f = await fixture();
    expect((await call(f.owner, 'POST', `/repos/${f.repoId}/decision-settings/preset`, { preset: 'balanced' })).status).toBe(200);
    const s = await get(f.member, f.repoId);
    expect(s.preset_basis).toBe('balanced');
    const rows = byType(s);
    expect(rows.nonbreaking_refactor_approach!.effective!.timeout_outcome).toBe('proceed_recommended');
    expect(rows.test_strategy_choice!.effective!.timeout_outcome).toBe('proceed_recommended');
    for (const type of STOP_ONLY) expect(rows[type]!.effective!.timeout_outcome, type).toBe('stop_and_flag');
  });

  it('refuses what the writer refuses, with the field named and nothing written: an outcome the entry does not allow, a window out of bounds, an unknown or class 1 type', async () => {
    const f = await fixture();
    const ok = { scope: 'account', decision_type: 'test_strategy_choice', answer_window_minutes: 60, timeout_outcome: 'stop_and_flag', notify: null };
    const cases: [Record<string, unknown>, string][] = [
      [{ ...ok, decision_type: 'publish_release_artifact', timeout_outcome: 'proceed_recommended' }, 'timeout_outcome'],
      [{ ...ok, answer_window_minutes: 14 }, 'answer_window_minutes'],
      [{ ...ok, answer_window_minutes: 20161 }, 'answer_window_minutes'],
      [{ ...ok, answer_window_minutes: 90.5 }, 'answer_window_minutes'],
      [{ ...ok, decision_type: 'no_such_type' }, 'decision_type'],
      [{ ...ok, decision_type: 'dependency_patch_bump' }, 'decision_type'],
    ];
    for (const [body, path] of cases) {
      const res = await write(f.owner, f.repoId, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(((await res.json()) as ErrorBody).details?.[0]?.path, JSON.stringify(body)).toBe(path);
    }
    for (const body of [{ ...ok, notify: 'sms' }, { ...ok, timeout_outcome: 'deny' }, { ...ok, scope: 'team' }, { ...ok, extra: 1 }, { scope: 'account', decision_type: '*' }]) {
      expect((await write(f.owner, f.repoId, body)).status, JSON.stringify(body)).toBe(422);
    }
    expect(await versions(f.owner.accountId)).toHaveLength(0);
    expect(await auditRows(f.owner.accountId)).toHaveLength(0);
  });

  it('undo is a new version: setting the values back, or all null, restores the earlier behaviour and keeps the history', async () => {
    const f = await fixture();
    const body = { scope: 'repo', decision_type: 'nonbreaking_refactor_approach' };
    await write(f.owner, f.repoId, { ...body, answer_window_minutes: 45, timeout_outcome: 'proceed_recommended', notify: null });
    const cleared = (await (await write(f.owner, f.repoId, { ...body, answer_window_minutes: null, timeout_outcome: null, notify: null })).json()) as AskSettings;
    expect(byType(cleared).nonbreaking_refactor_approach).toMatchObject({
      repo: { answer_window_minutes: null, timeout_outcome: null, notify: null, version: 2 },
      effective: { answer_window_minutes: 1440, timeout_outcome: 'stop_and_flag' },
    });
    const rows = await versions(f.owner.accountId);
    expect(rows.map((r) => [r.version, r.answer_window_minutes])).toEqual([[1, 45], [2, null]]);
    const audit = await auditRows(f.owner.accountId);
    expect(audit.at(-1)!.payload).toMatchObject({ previous: { answer_window_minutes: 45, timeout_outcome: 'proceed_recommended' }, new: { answer_window_minutes: null, timeout_outcome: null } });
  });

  it('a plain member reads but cannot write, a token can neither write nor read, and a missing, malformed or other-tenant repo is one 404', async () => {
    const f = await fixture();
    const other = await fixture();
    const plaintext = generateToken();
    await insertApiToken(appUserPool, {
      accountId: f.owner.accountId,
      createdBy: f.owner.userId,
      tokenHash: hashToken(plaintext),
      displayHint: 'fxat_...test',
      scopes: ['read'],
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const body = { scope: 'account', decision_type: '*', answer_window_minutes: 60, timeout_outcome: null, notify: null };
    expect((await get(f.member, f.repoId)).can_change).toBe(false);
    const asMember = await write(f.member, f.repoId, body);
    expect(asMember.status).toBe(403);
    expect(((await asMember.json()) as ErrorBody).error.code).toBe('insufficient_role');
    const asToken = await call(f.owner, 'POST', `/repos/${f.repoId}/ask-settings`, body, plaintext);
    expect(asToken.status).toBe(403);
    expect(((await asToken.json()) as ErrorBody).error.code).toBe('session_required');
    expect((await call(f.owner, 'GET', `/repos/${f.repoId}/ask-settings`, undefined, plaintext)).status).toBe(403);
    for (const id of [randomUUID(), 'not-a-uuid', other.repoId]) {
      expect((await call(f.owner, 'GET', `/repos/${id}/ask-settings`)).status, id).toBe(404);
      expect((await write(f.owner, id, body)).status, id).toBe(404);
    }
    expect(await versions(f.owner.accountId)).toHaveLength(0);
    expect(await versions(other.owner.accountId)).toHaveLength(0);
  });

  it('the database refuses a member session even if the route check were bypassed', async () => {
    const f = await fixture();
    const { writeAskSetting } = await import('@fx/db/src/decisionAskSettings.js');
    await expect(
      writeAskSetting(
        { pool: appUserPool, principal: f.member.userId },
        { accountId: f.member.accountId, repoId: null, decisionType: '*', answerWindowMinutes: 60, timeoutOutcome: null, notify: null },
      ),
    ).rejects.toMatchObject({ code: '42501' });
    expect(await versions(f.owner.accountId)).toHaveLength(0);
  });

  it('two writers racing for one version: the loser gets 409 ask_setting_changed, not 500', async () => {
    const f = await fixture();
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
        if (!raced && /^\s*INSERT INTO decision_ask_settings/.test(text)) {
          raced = true;
          await admin.query(
            `INSERT INTO decision_ask_settings (account_id, repo_id, decision_type, answer_window_minutes, version, changed_by) VALUES ($1, NULL, '*', 120, 1, $2)`,
            [f.owner.accountId, f.owner.userId],
          );
        }
        return query(...a);
      };
      return client;
    };
    try {
      const res = await write(f.owner, f.repoId, { scope: 'account', decision_type: '*', answer_window_minutes: 60, timeout_outcome: null, notify: null });
      expect(raced).toBe(true);
      expect(res.status).toBe(409);
      expect(((await res.json()) as ErrorBody).error.code).toBe('ask_setting_changed');
    } finally {
      (appUserPool as unknown as { connect: unknown }).connect = original;
    }
  });

  it('never issues an UPDATE or DELETE against decision_ask_settings: every write the routes made is an INSERT', async () => {
    const f = await fixture();
    sql.length = 0;
    await write(f.owner, f.repoId, { scope: 'account', decision_type: '*', answer_window_minutes: 60, timeout_outcome: null, notify: 'email' });
    await write(f.owner, f.repoId, { scope: 'account', decision_type: '*', answer_window_minutes: null, timeout_outcome: null, notify: 'email' });
    await get(f.owner, f.repoId);
    expect(sql.filter((q) => /INSERT\s+INTO\s+decision_ask_settings/i.test(q)).length).toBe(2);
    expect(sql.filter((q) => /\b(UPDATE|DELETE\s+FROM|TRUNCATE)\b[^;]*decision_ask_settings/i.test(q))).toEqual([]);
    expect(sql.filter((q) => /decision_ask_settings/i.test(q) && /FOR\s+(UPDATE|SHARE)/i.test(q))).toEqual([]);
  });
});

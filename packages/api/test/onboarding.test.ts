import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { insertApiToken, type Scope } from '@fx/core/src/tokens/service.js';
import { createRecordingRunActionSignal } from '@fx/core/src/runActions/index.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { validateRegistry } from '../src/registry.js';
import { ROUTES } from '../src/routes/index.js';
import { runActionDeps } from '../src/routes/run-actions.js';
import { onboardingDeps } from '../src/routes/onboarding.js';
// The real projection, by its source path: @fx/api does not depend on @fx/pipeline, but the monorepo resolves it.
import { parsePreviewResult } from '../../pipeline/src/preview/result.js';
import { seedAccountWithMember } from './helpers/seed.js';

interface Identity {
  accountId: string;
  userId: string;
}
interface ErrBody {
  error: { code: string; message: string; request_id: string };
  details?: { path: string; code: string }[];
}
interface Progress {
  started_at: string;
  steps: { step: string; completed_at: string | null }[];
}

const STEP_ORDER = ['model_key', 'readonly_app', 'preview', 'pay', 'write_app', 'first_pr'];
let keyCounter = 0;
const freshKey = () => `onb-key-${process.pid}-${++keyCounter}`;
/** The seams exactly as the module ships them, read before any test installs its own. */
const SHIPPED = { previewAvailable: onboardingDeps.previewAvailable, projectPreviewResult: onboardingDeps.projectPreviewResult };
const XSS ='<img src=x onerror=alert(1)>';

/** D#31 API-9: the onboarding progress read and the preview routes through the real dispatcher against real Postgres. */
describe('D#31 API-9: onboarding routes', () => {
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
    await adminPool.end();
    await platformOpsPool.end();
    await appUserPool.end();
  });
  beforeEach(() => {
    runActionDeps.getRunActionSignal = () => signal;
    onboardingDeps.previewAvailable = () => true;
    onboardingDeps.projectPreviewResult = null;
    signal.sent.length = 0;
  });
  afterEach(() => {
    runActionDeps.getRunActionSignal = () => null;
    onboardingDeps.previewAvailable = () => false;
    onboardingDeps.projectPreviewResult = null;
  });

  async function call(who: Identity | string, method: 'GET' | 'POST', urlPath: string, o: { body?: unknown; key?: string | null } = {}): Promise<Response> {
    const h = new Headers();
    if (typeof who === 'string') h.set('authorization', `Bearer ${who}`);
    else h.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(who)}`);
    if (method === 'POST') {
      h.set('content-type', 'application/json');
      if (o.key !== null) h.set('idempotency-key', o.key ?? freshKey());
    }
    return handleApiRequest(
      new Request(`http://localhost/api/v1${urlPath}`, { method, headers: h, body: method === 'POST' ? JSON.stringify(o.body ?? {}) : undefined }),
      appUserPool,
      platformOpsPool,
      ROUTES,
    );
  }
  const get = (who: Identity | string, p = '/onboarding') => call(who, 'GET', p);
  const post = (who: Identity | string, body: unknown, key?: string | null) => call(who, 'POST', '/onboarding/preview', { body, key });
  const code = async (res: Response) => ((await res.json()) as ErrBody).error.code;

  /** An account with an owner session (the db seed's owner) and a fresh api-package member in another role. */
  const owner = () => seedAccount(admin, randomUUID());
  async function memberOf(accountId: string, role: 'member' | 'admin'): Promise<Identity> {
    const userId = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, userId, role]);
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
  /** A repo on a live installation of `kind`, with its installer record. */
  async function repoOn(accountId: string, kind = 'team_readonly', ghOwner?: string): Promise<{ repoId: string; ghUserId: number }> {
    const inst = randomUUID();
    const repoId = randomUUID();
    const gh = randomInt(1, 2_000_000_000);
    const ghUserId = randomInt(1, 2_000_000_000);
    await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, $4)`, [inst, accountId, gh, kind]);
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner) VALUES ($1, $2, $3, 1, 'team', $4)`, [repoId, accountId, inst, ghOwner ?? `o${gh}`]);
    await admin.query(`INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id) VALUES ($1, $2, $3)`, [gh, kind, ghUserId]);
    return { repoId, ghUserId };
  }
  const withKey = (accountId: string) => admin.query(`UPDATE model_connections SET status = 'ok' WHERE account_id = $1`, [accountId]);
  /** An owner with a validated model key and a read-only repo: everything a preview request needs. */
  async function ready(): Promise<{ who: SeedRefs; repoId: string }> {
    const who = await owner();
    await withKey(who.accountId);
    return { who, repoId: (await repoOn(who.accountId)).repoId };
  }
  const counts = async (accountId: string) =>
    (
      await admin.query<{ p: number; q: number }>(
        `SELECT (SELECT count(*)::int FROM onboarding_previews WHERE account_id = $1) p,
                (SELECT count(*)::int FROM run_action_requests WHERE account_id = $1 AND kind = 'start_preview') q`,
        [accountId],
      )
    ).rows[0]!;
  async function expectNothingWritten(accountId: string) {
    expect(await counts(accountId)).toEqual({ p: 0, q: 0 });
    expect(signal.sent).toEqual([]);
  }

  describe('registry', () => {
    const entry = (id: string) => ROUTES.find((r) => r.operationId === id)!;

    it('the three operations are session-only, admin and carry the declared idempotency', () => {
      for (const [id, idem] of [['getOnboarding', 'never'], ['requestPreview', 'required'], ['getOnboardingPreview', 'never']] as const) {
        expect(entry(id), id).toBeDefined();
        expect(entry(id).principals, id).toEqual(['session']);
        expect(entry(id).minRole, id).toBe('admin');
        expect(entry(id).idempotency, id).toBe(idem);
      }
      expect(entry('requestPreview').startsRun).toBe(true);
      expect(entry('requestPreview').successStatus).toBe(202);
    });

    it('listing token on the run-starting POST makes the registry refuse to load', () => {
      expect(() => validateRegistry([{ ...entry('requestPreview'), principals: ['session', 'token'], scope: 'read' }])).toThrow(/startsRun/);
    });
  });

  describe('GET /onboarding', () => {
    it('answers the six steps in order, and a second session of the same account gets an equal body', async () => {
      const who = await seedAccountWithMember(admin, { status: 'unsubscribed', role: 'owner' });
      const other = await memberOf(who.accountId, 'admin');
      const res = await get(who);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Progress;
      expect(body.steps.map((s) => s.step)).toEqual(STEP_ORDER);
      expect(body.steps.every((s) => s.completed_at === null)).toBe(true);
      expect(typeof body.started_at).toBe('string');
      expect(await (await get(other)).json()).toEqual(body);
    });

    it('a member is 403 insufficient_role; a token of any scope is 403 session_required', async () => {
      const who = await owner();
      const member = await memberOf(who.accountId, 'member');
      const res = await get(member);
      expect(res.status).toBe(403);
      expect(await code(res)).toBe('insufficient_role');
      for (const scopes of [['read'], ['read', 'runs:cancel']] as Scope[][]) {
        const t = await get(await tokenFor(who, scopes));
        expect(t.status).toBe(403);
        expect(await code(t)).toBe('session_required');
      }
    });

    it('never shows another account\'s marks: each of two accounts sees only its own', async () => {
      // The marks are held by a trigger (0692): A's comes from a validated key, B's from an active subscription.
      const a = await owner();
      const b = await owner();
      await admin.query(`UPDATE accounts SET stripe_subscription_status = NULL WHERE id = $1`, [a.accountId]);
      await withKey(a.accountId);
      await admin.query(`UPDATE accounts SET stripe_subscription_status = 'active' WHERE id = $1`, [b.accountId]);
      const dbMark = async (accountId: string, col: string) =>
        ((await admin.query<{ t: Date | null }>(`SELECT ${col} AS t FROM accounts WHERE id = $1`, [accountId])).rows[0]!.t)?.toISOString() ?? null;
      const mark = (p: Progress, step: string) => p.steps.find((s) => s.step === step)!.completed_at;
      const pa = (await (await get(a)).json()) as Progress;
      const pb = (await (await get(b)).json()) as Progress;
      const keyA = await dbMark(a.accountId, 'onboarding_key_ok_at');
      const paidB = await dbMark(b.accountId, 'onboarding_paid_at');
      expect(keyA).not.toBeNull();
      expect(paidB).not.toBeNull();
      expect(mark(pa, 'model_key')).toBe(keyA);
      expect(mark(pa, 'pay')).toBeNull();
      expect(mark(pb, 'pay')).toBe(paidB);
      expect(mark(pb, 'model_key')).toBe(await dbMark(b.accountId, 'onboarding_key_ok_at'));
      expect(mark(pb, 'model_key')).not.toBe(keyA);
    });

    describe('steps 1 and 2 follow the current state', () => {
      const step = async (who: Identity, name: string) => ((await (await get(who)).json()) as Progress).steps.find((s) => s.step === name)!.completed_at;
      const setFlag = (accountId: string, sql: string) =>
        admin.query(
          `UPDATE installation_installers ii SET ${sql} FROM installations i
            WHERE i.account_id = $1 AND i.app_kind = 'team_readonly' AND ii.gh_installation_id = i.gh_installation_id AND ii.app_kind = i.app_kind`,
          [accountId],
        );

      it('model_key: done with a working key; removing it, a rejected key or an unchecked replacement sends it back to open; a new key brings it back', async () => {
        const who = await owner();
        expect(await step(who, 'model_key')).toBeNull();
        await withKey(who.accountId);
        const first = await step(who, 'model_key');
        expect(first).not.toBeNull();
        await admin.query(`UPDATE model_connections SET status = 'broken' WHERE account_id = $1`, [who.accountId]);
        expect(await step(who, 'model_key')).toBeNull();
        await admin.query(`UPDATE model_connections SET status = 'unvalidated' WHERE account_id = $1`, [who.accountId]);
        expect(await step(who, 'model_key')).toBeNull();
        await withKey(who.accountId);
        expect(await step(who, 'model_key')).toBe(first);
        await admin.query(`DELETE FROM model_connections WHERE account_id = $1`, [who.accountId]);
        expect(await step(who, 'model_key')).toBeNull();
        await admin.query(
          `INSERT INTO model_connections (account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint, status)
           VALUES ($1, 'anthropic', 'c', 'n', 'w', 1, $2, 'ok')`,
          [who.accountId, `fp-${randomUUID()}`],
        );
        expect(await step(who, 'model_key')).toBe(first);
      });

      it('readonly_app: done with a live read-only install; deleted or suspended sends it back to open; unsuspend and a reinstall bring it back', async () => {
        const who = await owner();
        expect(await step(who, 'readonly_app')).toBeNull();
        await repoOn(who.accountId);
        const first = await step(who, 'readonly_app');
        expect(first).not.toBeNull();
        await setFlag(who.accountId, 'suspended_at = now()');
        expect(await step(who, 'readonly_app')).toBeNull();
        await setFlag(who.accountId, 'suspended_at = NULL');
        expect(await step(who, 'readonly_app')).toBe(first);
        await setFlag(who.accountId, 'deleted_at = now()');
        expect(await step(who, 'readonly_app')).toBeNull();
        await repoOn(who.accountId); // the reinstall is a new GitHub installation
        expect(await step(who, 'readonly_app')).not.toBeNull();
      });

      it('a write install never counts for step 2, and an uninstalled read-only App leaves the later steps as they were', async () => {
        const who = await owner();
        await repoOn(who.accountId, 'team');
        expect(await step(who, 'readonly_app')).toBeNull();
        expect(await step(who, 'write_app')).not.toBeNull();
        await repoOn(who.accountId);
        await admin.query(`UPDATE accounts SET stripe_subscription_status = 'active' WHERE id = $1`, [who.accountId]);
        const paid = await step(who, 'pay');
        await setFlag(who.accountId, 'deleted_at = now()');
        expect(await step(who, 'readonly_app')).toBeNull();
        expect(await step(who, 'pay')).toBe(paid);
        expect(await step(who, 'write_app')).not.toBeNull();
      });

      it("another account's key and installation never mark this account's steps", async () => {
        const a = await owner();
        const b = await owner();
        await withKey(b.accountId);
        await repoOn(b.accountId);
        expect(await step(a, 'model_key')).toBeNull();
        expect(await step(a, 'readonly_app')).toBeNull();
      });

      it('a removed key blocks a new preview with model_key_required, in step with the step going back to open', async () => {
        const { who, repoId } = await ready();
        expect(await step(who, 'model_key')).not.toBeNull();
        await admin.query(`DELETE FROM model_connections WHERE account_id = $1`, [who.accountId]);
        expect(await step(who, 'model_key')).toBeNull();
        const res = await post(who, { repo_id: repoId, confirm_model_cap_usd: 20 });
        expect(res.status).toBe(409);
        expect(await code(res)).toBe('model_key_required');
      });
    });

    it('an unsubscribed account gets the same 200 answer', async () => {
      const fresh = await seedAccountWithMember(admin, { status: 'unsubscribed', role: 'owner' });
      const res = await get(fresh);
      expect(res.status).toBe(200);
      expect(((await res.json()) as Progress).steps).toHaveLength(6);
    });
  });

  describe('POST /onboarding/preview', () => {
    const body = (repoId: string) => ({ repo_id: repoId, confirm_model_cap_usd: 20 });

    it('202: one preview, one action, one start_preview signal; the answer carries the ids and state', async () => {
      const { who, repoId } = await ready();
      const res = await post(who, body(repoId));
      expect(res.status).toBe(202);
      const out = (await res.json()) as { preview_id: string; action_id: string; state: string };
      expect(out.state).toBe('accepted');
      expect(Object.keys(out).sort()).toEqual(['action_id', 'preview_id', 'state']);
      expect(await counts(who.accountId)).toEqual({ p: 1, q: 1 });
      expect(signal.sent).toEqual([{ actionId: out.action_id, accountId: who.accountId, kind: 'start_preview' }]);
      const row = (await admin.query('SELECT state, run_action_id FROM onboarding_previews WHERE id = $1', [out.preview_id])).rows[0];
      expect(row).toEqual({ state: 'requested', run_action_id: out.action_id });
    });

    it('an admin may request one too', async () => {
      const { who, repoId } = await ready();
      const admn = await memberOf(who.accountId, 'admin');
      expect((await post(admn, body(repoId))).status).toBe(202);
    });

    it('any token is 403 session_required and a member is 403 insufficient_role, and nothing is written', async () => {
      const { who, repoId } = await ready();
      for (const scopes of [['read'], ['runs:cancel'], ['read', 'runs:cancel']] as Scope[][]) {
        const res = await post(await tokenFor(who, scopes), body(repoId));
        expect(res.status).toBe(403);
        expect(await code(res)).toBe('session_required');
      }
      const res = await post(await memberOf(who.accountId, 'member'), body(repoId));
      expect(res.status).toBe(403);
      expect(await code(res)).toBe('insufficient_role');
      await expectNothingWritten(who.accountId);
    });

    it('a missing Idempotency-Key is 400 idempotency_key_required and nothing is written', async () => {
      const { who, repoId } = await ready();
      const res = await post(who, body(repoId), null);
      expect(res.status).toBe(400);
      expect(await code(res)).toBe('idempotency_key_required');
      await expectNothingWritten(who.accountId);
    });

    it.each([
      ['an unknown field', (r: string) => ({ ...body(r), extra: 1 })],
      ['a malformed repo_id', () => ({ repo_id: 'nope', confirm_model_cap_usd: 20 })],
      ['a missing cap', (r: string) => ({ repo_id: r })],
      ['a string cap', (r: string) => ({ repo_id: r, confirm_model_cap_usd: '20' })],
    ])('%s is 422 validation_failed and nothing is written', async (_name, make) => {
      const { who, repoId } = await ready();
      const res = await post(who, make(repoId));
      expect(res.status).toBe(422);
      expect(await code(res)).toBe('validation_failed');
      await expectNothingWritten(who.accountId);
    });

    it('a cap other than 20 is 422 preview_cap_not_confirmed with a pointed detail, and nothing is written', async () => {
      const { who, repoId } = await ready();
      for (const cap of [19, 21, 0, 20.5]) {
        const res = await post(who, { repo_id: repoId, confirm_model_cap_usd: cap });
        expect(res.status, String(cap)).toBe(422);
        const out = (await res.json()) as ErrBody;
        expect(out.error.code).toBe('preview_cap_not_confirmed');
        expect(out.details).toEqual([{ path: 'confirm_model_cap_usd', code: 'must_equal_20' }]);
      }
      await expectNothingWritten(who.accountId);
    });

    it('while the availability seam says no (its production default) it is 503 preview_unavailable and nothing is written', async () => {
      const { who, repoId } = await ready();
      onboardingDeps.previewAvailable = () => false;
      const res = await post(who, body(repoId));
      expect(res.status).toBe(503);
      expect(await code(res)).toBe('preview_unavailable');
      await expectNothingWritten(who.accountId);
    });

    it('with no run-action signal registered it is 503 preview_unavailable and nothing is written', async () => {
      const { who, repoId } = await ready();
      runActionDeps.getRunActionSignal = () => null;
      const res = await post(who, body(repoId));
      expect(res.status).toBe(503);
      expect(await code(res)).toBe('preview_unavailable');
      await expectNothingWritten(who.accountId);
    });

    it('the seams as shipped: previews unavailable, no projection', () => {
      expect(SHIPPED.previewAvailable()).toBe(false);
      expect(SHIPPED.projectPreviewResult).toBeNull();
    });

    it('no validated model key is 409 model_key_required and nothing is written', async () => {
      const who = await owner();
      const { repoId } = await repoOn(who.accountId);
      const res = await post(who, body(repoId));
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('model_key_required');
      await expectNothingWritten(who.accountId);
    });

    it('today\'s platform-wide allowance used up is 409 preview_capacity and nothing is written', async () => {
      const { who, repoId } = await ready();
      const bystander = await owner();
      await admin.query(
        `INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose) VALUES ($1, $2, 10, 'open', 'foreground_compute', 'preview')`,
        [bystander.accountId, bystander.runId],
      );
      try {
        const res = await post(who, body(repoId));
        expect(res.status).toBe(409);
        expect(await code(res)).toBe('preview_capacity');
        await expectNothingWritten(who.accountId);
      } finally {
        await admin.query(`DELETE FROM spend_reservations WHERE account_id = $1 AND purpose = 'preview'`, [bystander.accountId]);
      }
    });

    it('a second request for the same installer is 409 preview_exists with no extra row or signal', async () => {
      const { who, repoId } = await ready();
      expect((await post(who, body(repoId))).status).toBe(202);
      const res = await post(who, body(repoId));
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('preview_exists');
      expect(await counts(who.accountId)).toEqual({ p: 1, q: 1 });
      expect(signal.sent).toHaveLength(1);
    });

    it('a second account on a GitHub owner that already used its free preview is 409 preview_install_limit and writes nothing', async () => {
      const login = `lim${randomInt(1, 2_000_000_000)}`;
      const first = await owner();
      await withKey(first.accountId);
      expect((await post(first, body((await repoOn(first.accountId, 'team_readonly', login)).repoId))).status).toBe(202);
      const who = await owner();
      await withKey(who.accountId);
      const { repoId } = await repoOn(who.accountId, 'team_readonly', login);
      signal.sent.length = 0;
      const res = await post(who, body(repoId));
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('preview_install_limit');
      await expectNothingWritten(who.accountId);
    });

    it('another account\'s repo, an unknown one and a write-app one are all the same 404, and nothing is written', async () => {
      const { who } = await ready();
      const theirs = await repoOn((await owner()).accountId);
      const writeApp = await repoOn(who.accountId, 'team');
      const seen = new Set<string>();
      for (const repoId of [theirs.repoId, randomUUID(), writeApp.repoId]) {
        const res = await post(who, body(repoId));
        expect(res.status, repoId).toBe(404);
        const out = (await res.json()) as ErrBody;
        expect(out.error.code).toBe('not_found');
        seen.add(JSON.stringify({ ...out, error: { ...out.error, request_id: '' } }));
      }
      expect(seen.size).toBe(1);
      await expectNothingWritten(who.accountId);
    });

    it('a repo whose read-only App was uninstalled (detached, as the webhook does) is the same 404, nothing is written, and a reinstall makes it startable again', async () => {
      const { who, repoId } = await ready();
      // What the uninstall webhook does to the account's repos: installation_id goes NULL (the row is kept).
      await admin.query(`UPDATE repos SET installation_id = NULL WHERE id = $1`, [repoId]);
      const res = await post(who, body(repoId));
      expect(res.status).toBe(404);
      expect(await code(res)).toBe('not_found');
      await expectNothingWritten(who.accountId);
      // The same repo attached to a read-only installation again.
      const inst = randomUUID();
      const gh = randomInt(1, 2_000_000_000);
      await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, 'team_readonly')`, [inst, who.accountId, gh]);
      await admin.query(`INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id) VALUES ($1, 'team_readonly', $2)`, [gh, randomInt(1, 2_000_000_000)]);
      await admin.query(`UPDATE repos SET installation_id = $1 WHERE id = $2`, [inst, repoId]);
      expect((await post(who, body(repoId))).status).toBe(202);
    });

    it('the same key and body replays the first answer with Idempotent-Replayed, one preview row and one signal', async () => {
      const { who, repoId } = await ready();
      const key = freshKey();
      const first = await post(who, body(repoId), key);
      expect(first.status).toBe(202);
      expect(first.headers.get('idempotent-replayed')).toBeNull();
      const again = await post(who, body(repoId), key);
      expect(again.status).toBe(202);
      expect(again.headers.get('idempotent-replayed')).toBe('true');
      expect(await again.json()).toEqual(await first.json());
      expect(await counts(who.accountId)).toEqual({ p: 1, q: 1 });
      expect(signal.sent).toHaveLength(1);
    });

    it('the same key with a different body is 422 idempotency_key_reused and writes nothing more', async () => {
      const { who, repoId } = await ready();
      const key = freshKey();
      expect((await post(who, body(repoId), key)).status).toBe(202);
      const other = (await repoOn(who.accountId)).repoId;
      const res = await post(who, body(other), key);
      expect(res.status).toBe(422);
      expect(await code(res)).toBe('idempotency_key_reused');
      expect(await counts(who.accountId)).toEqual({ p: 1, q: 1 });
      expect(signal.sent).toHaveLength(1);
    });

    it('an unsubscribed account (a fresh signup) reaches the service and gets 202, like an active one', async () => {
      const fresh = await seedAccountWithMember(admin, { status: 'unsubscribed', role: 'owner' });
      const { repoId } = await repoOn(fresh.accountId);
      const noKey = await post(fresh, body(repoId));
      expect(noKey.status).toBe(409);
      expect(await code(noKey)).toBe('model_key_required');
      await admin.query(
        `INSERT INTO model_connections (account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint, status)
         VALUES ($1, 'ai_gateway', $2, $3, $4, 1, $5, 'ok')`,
        [fresh.accountId, Buffer.from('c'), Buffer.from('n'), Buffer.from('w'), 'fp-' + fresh.accountId],
      );
      expect((await post(fresh, body(repoId))).status).toBe(202);
      expect(await counts(fresh.accountId)).toEqual({ p: 1, q: 1 });
    });
  });

  describe('GET /onboarding/preview', () => {
    type PreviewBody = { preview: null | { preview_id: string; state: string; result: unknown; void_reason: string | null; run_status: string | null; repo_id: string } };
    const latest = async (who: Identity | string) => (await (await get(who, '/onboarding/preview')).json()) as PreviewBody;

    it('is { preview: null, progress: null } for an account with none', async () => {
      const res = await get(await owner(), '/onboarding/preview');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ preview: null, progress: null });
    });

    it('shows a requested preview with every field of the view', async () => {
      const { who, repoId } = await ready();
      const out = (await (await post(who, { repo_id: repoId, confirm_model_cap_usd: 20 })).json()) as { preview_id: string };
      const { preview } = await latest(who);
      expect(preview).toMatchObject({ preview_id: out.preview_id, state: 'requested', repo_id: repoId, started_at: null, finished_at: null, result: null, void_reason: null, run_status: null });
      expect(Object.keys(preview!).sort()).toEqual(['created_at', 'finished_at', 'preview_id', 'repo_id', 'result', 'run_status', 'started_at', 'state', 'void_reason']);
    });

    it('returns the newest preview, a void one included', async () => {
      const who = await owner();
      await withKey(who.accountId);
      const ids: string[] = [];
      for (const when of ['2026-01-01T00:00:00Z', '2026-01-03T00:00:00Z', '2026-01-02T00:00:00Z']) {
        const { repoId } = await repoOn(who.accountId);
        const out = (await (await post(who, { repo_id: repoId, confirm_model_cap_usd: 20 })).json()) as { preview_id: string };
        await admin.query('UPDATE onboarding_previews SET created_at = $2 WHERE id = $1', [out.preview_id, when]);
        ids.push(out.preview_id);
      }
      await admin.query(`UPDATE onboarding_previews SET state = 'void', void_reason = 'preview_unavailable' WHERE id = $1`, [ids[1]]);
      expect((await latest(who)).preview).toMatchObject({ preview_id: ids[1], state: 'void', void_reason: 'preview_unavailable' });
    });

    it('a member is 403 insufficient_role and a token is 403 session_required', async () => {
      const who = await owner();
      const m = await get(await memberOf(who.accountId, 'member'), '/onboarding/preview');
      expect(m.status).toBe(403);
      expect(await code(m)).toBe('insufficient_role');
      const t = await get(await tokenFor(who, ['read']), '/onboarding/preview');
      expect(t.status).toBe(403);
      expect(await code(t)).toBe('session_required');
    });

    it('two accounts each with a preview see only their own', async () => {
      const a = await ready();
      const b = await ready();
      const pa = (await (await post(a.who, { repo_id: a.repoId, confirm_model_cap_usd: 20 })).json()) as { preview_id: string };
      const pb = (await (await post(b.who, { repo_id: b.repoId, confirm_model_cap_usd: 20 })).json()) as { preview_id: string };
      expect((await latest(a.who)).preview?.preview_id).toBe(pa.preview_id);
      expect((await latest(b.who)).preview?.preview_id).toBe(pb.preview_id);
      await admin.query('UPDATE onboarding_previews SET created_at = now() + interval \'1 day\' WHERE id = $1', [pb.preview_id]);
      expect((await latest(a.who)).preview?.preview_id).toBe(pa.preview_id);
    });

    it('an unsubscribed account gets 200 { preview: null, progress: null }', async () => {
      const fresh = await seedAccountWithMember(admin, { status: 'unsubscribed', role: 'owner' });
      const res = await get(fresh, '/onboarding/preview');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ preview: null, progress: null });
    });

    describe('the live progress', () => {
      type ProgressBody = { progress: null | { outcome: string; repo_name: string | null; feed: Array<{ text: string }>; stages: Array<{ id: string; status: string }>; numbers: { compute: { basis: string }; model: { whose: string; usd: number | null } } } };
      const prog = async (who: Identity | string) => ((await (await get(who, '/onboarding/preview')).json()) as ProgressBody).progress;
      /** A started preview with its own run, and some recorded events. */
      async function withRun(): Promise<{ who: Identity; runId: string; previewId: string }> {
        const { who, repoId } = await ready();
        const out = (await (await post(who, { repo_id: repoId, confirm_model_cap_usd: 20 })).json()) as { preview_id: string };
        const runId = randomUUID();
        await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'preview', 'production', 'running')`, [runId, who.accountId]);
        await admin.query(`UPDATE onboarding_previews SET state = 'running', run_id = $2, started_at = now() WHERE id = $1`, [out.preview_id, runId]);
        return { who, runId, previewId: out.preview_id };
      }
      const add = (accountId: string, runId: string, seq: number, kind: string, payload: unknown) =>
        admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, $3, $4, $5::jsonb)`, [accountId, runId, seq, kind, JSON.stringify(payload)]);

      it('a requested preview reads as queued, with compute not yet started', async () => {
        const { who, repoId } = await ready();
        await post(who, { repo_id: repoId, confirm_model_cap_usd: 20 });
        const p = await prog(who);
        expect(p).toMatchObject({ outcome: 'queued', feed: [], numbers: { compute: { basis: 'none' } } });
        expect(p?.stages.map((s) => s.status)).toEqual(['active', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending']);
      });

      it('a running preview shows server-made lines only, and the wire body carries none of a hostile event', async () => {
        const { who, runId } = await withRun();
        await add(who.accountId, runId, 1, 'agent.activity', { tool: 'read', path: 'src/app.ts' });
        await add(who.accountId, runId, 2, 'agent.activity', { tool: 'read', path: '/outside/the/repo', text: 'FILE-BODY' });
        await add(who.accountId, runId, 3, 'agent.activity', { tool: 'search', pattern: 'https://evil.example/?k=sk-ant-api03-abcdefghijklmnopqrstuvwxyz' });
        await add(who.accountId, runId, 4, 'agent.output', { text: 'RAW-MODEL-TEXT' });
        const raw = await (await get(who, '/onboarding/preview')).text();
        for (const leak of ['outside/the/repo', 'FILE-BODY', 'evil.example', 'sk-ant', 'RAW-MODEL-TEXT']) expect(raw).not.toContain(leak);
        const p = (JSON.parse(raw) as ProgressBody).progress!;
        expect(p.feed.map((l) => l.text)).toEqual(['Reading src/app.ts', 'Searching the code', 'The agent sent its first message']);
        expect(p.outcome).toBe('running');
        expect(p.numbers.compute.basis).toBe('estimate');
      });

      it('model usage is labelled by whose it is: the customer key by default, the operator subscription for an operator account', async () => {
        const { who } = await withRun();
        expect((await prog(who))?.numbers.model.whose).toMatch(/^(ai_gateway|anthropic|customer)$/);
        onboardingDeps.isOperatorAccount = (id) => id === who.accountId;
        try {
          expect((await prog(who))?.numbers.model).toEqual({ whose: 'operator', usd: null });
        } finally {
          onboardingDeps.isOperatorAccount = null;
        }
      });

      it('another account never sees it: each of two accounts reads only the progress of its own preview', async () => {
        const a = await withRun();
        const b = await withRun();
        await add(a.who.accountId, a.runId, 1, 'agent.activity', { tool: 'read', path: 'only/a.ts' });
        await add(b.who.accountId, b.runId, 1, 'agent.activity', { tool: 'read', path: 'only/b.ts' });
        expect((await prog(a.who))?.feed.map((l) => l.text)).toEqual(['Reading only/a.ts']);
        expect((await prog(b.who))?.feed.map((l) => l.text)).toEqual(['Reading only/b.ts']);
      });

      it('a member (owner/admin only) and a token get no progress at all, an admin does', async () => {
        const { who } = await withRun();
        const m = await get(await memberOf(who.accountId, 'member'), '/onboarding/preview');
        expect(m.status).toBe(403);
        expect(JSON.stringify(await m.json())).not.toContain('progress');
        expect((await get(await tokenFor(who, ['read']), '/onboarding/preview')).status).toBe(403);
        expect((await get(await memberOf(who.accountId, 'admin'), '/onboarding/preview')).status).toBe(200);
      });

      it('an unauthenticated call reaches nothing', async () => {
        const res = await handleApiRequest(new Request('http://localhost/api/v1/onboarding/preview'), appUserPool, platformOpsPool, ROUTES);
        expect(res.status).toBe(401);
      });
    });

    describe('the result projection', () => {
      /** A preview whose run has succeeded with `envelope`. */
      async function succeeded(envelope: unknown): Promise<Identity> {
        const { who, repoId } = await ready();
        const out = (await (await post(who, { repo_id: repoId, confirm_model_cap_usd: 20 })).json()) as { preview_id: string };
        await admin.query(`UPDATE onboarding_previews SET state = 'running', run_id = $2, started_at = now() WHERE id = $1`, [out.preview_id, who.runId]);
        await admin.query(`UPDATE agent_runs SET status = 'succeeded', envelope = $2::jsonb WHERE id = $1`, [who.runId, JSON.stringify(envelope)]);
        return who;
      }
      const goodEnvelope = {
        issues: [
          { number: 1, title: `Fix ${XSS}`, category: 'bug', expected_model_usd: 1.5 },
          { number: 2, title: 'Add search', category: 'feature', expected_model_usd: 3 },
        ],
        sample_spec: { issue_number: 1, body: 'Acceptance: it works.' },
      };

      it('with the real parser a succeeded run projects, and a markup title is returned as that literal string', async () => {
        onboardingDeps.projectPreviewResult = parsePreviewResult;
        const who = await succeeded(goodEnvelope);
        const res = await get(who, '/onboarding/preview');
        expect(res.headers.get('content-type')).toMatch(/application\/json/);
        const { preview } = (await res.json()) as PreviewBody;
        expect(preview).toMatchObject({ state: 'finished', run_status: 'succeeded' });
        const result = preview!.result as { issues: { title: string }[]; sample_spec: { issue_number: number; body: string } };
        expect(result.issues[0]!.title).toBe(`Fix ${XSS}`);
        expect(result.issues).toHaveLength(2);
        expect(result.sample_spec).toEqual({ issue_number: 1, body: 'Acceptance: it works.' });
      });

      it('output that fails the parser is { error: "invalid_output" }', async () => {
        onboardingDeps.projectPreviewResult = parsePreviewResult;
        const who = await succeeded({ issues: 'not a list' });
        expect((await latest(who)).preview?.result).toEqual({ error: 'invalid_output' });
      });

      it('with no projection installed the result stays null', async () => {
        const who = await succeeded(goodEnvelope);
        expect((await latest(who)).preview).toMatchObject({ state: 'finished', result: null });
      });
    });
  });
});

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken, type Scope } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { seedAccountWithMember } from './helpers/seed.js';

interface Identity { accountId: string; userId: string }
interface Track { track: string; chosen_at: string | null; steps: { step: string; state?: string; completed_at: string | null; tier?: string | null }[] }
interface Body { started_at: string; steps: unknown[]; tracks: Track[] }

/** D#845 ON-5: the tracks in `GET /api/v1/onboarding` and `PUT /api/v1/onboarding/track`, through the real dispatcher against real Postgres. */
describe('D#845 ON-5: onboarding engine track routes', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;

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

  async function call(who: Identity | string | null, method: 'GET' | 'PUT', body?: unknown): Promise<Response> {
    const h = new Headers({ 'content-type': 'application/json' });
    if (typeof who === 'string') h.set('authorization', `Bearer ${who}`);
    else if (who) h.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(who)}`);
    const path = method === 'GET' ? '/onboarding' : '/onboarding/track';
    return handleApiRequest(new Request(`http://localhost/api/v1${path}`, { method, headers: h, body: method === 'PUT' ? JSON.stringify(body ?? {}) : undefined }), appUserPool, platformOpsPool, ROUTES);
  }
  const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
  const who = (role: 'owner' | 'admin' | 'member') => seedAccountWithMember(admin, { role });
  async function memberOf(accountId: string, role: 'member' | 'admin'): Promise<Identity> {
    const userId = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, userId, role]);
    return { accountId, userId };
  }
  async function tokenFor(w: Identity, scopes: Scope[]): Promise<string> {
    const plaintext = generateToken();
    await insertApiToken(appUserPool, { accountId: w.accountId, createdBy: w.userId, tokenHash: hashToken(plaintext), displayHint: 'fxat_...test', scopes, expiresAt: new Date(Date.now() + 86_400_000) });
    return plaintext;
  }
  async function runner(w: Identity, auth: boolean | null, engine: 'microvm' | 'os_sandbox'): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO runners (id, account_id, registered_by, public_key_jwk, jkt, credential_mode, protocol_version, last_seen_at, model_auth_present) VALUES ($1, $2, $3, $4::jsonb, $5, 'subscription', 22, now(), $6)`, [
      id, w.accountId, w.userId, JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'x'.repeat(43) }), randomUUID().replace(/-/g, '') + 'abcdefghijk', auth,
    ]);
    await admin.query(`INSERT INTO runner_facts (runner_id, account_id, os, arch, mem_gb_bucket, cpus, sandbox_engine) VALUES ($1, $2, 'linux', 'x64', 16, 8, $3)`, [id, w.accountId, engine]);
    return id;
  }
  const auditRows = async (accountId: string) => (await admin.query(`SELECT payload->>'track' AS track FROM audit_log WHERE account_id = $1 AND action = 'onboarding.track_chosen'`, [accountId])).rows.map((r) => r.track);

  it('the registry lists PUT /onboarding/track as session-only and admin', () => {
    const e = ROUTES.find((r) => r.operationId === 'putOnboardingTrack')!;
    expect(e).toMatchObject({ method: 'PUT', path: '/api/v1/onboarding/track', principals: ['session'], minRole: 'admin', idempotency: 'never' });
  });

  describe('GET /onboarding', () => {
    it('keeps started_at and steps at the top level and adds both tracks, pipeline first, the pipeline track equal to the top-level steps', async () => {
      const w = await who('owner');
      const body = (await (await call(w, 'GET')).json()) as Body;
      expect(Object.keys(body).sort()).toEqual(['started_at', 'steps', 'tracks']);
      expect(body.tracks.map((t) => t.track)).toEqual(['pipeline', 'engine']);
      expect(body.tracks[0]!.steps).toEqual(body.steps);
      expect(body.tracks[1]!.steps.map((s) => s.step)).toEqual(['machine', 'claude', 'github_app', 'project', 'plan', 'install', 'live']);
      expect(body.tracks[1]!.steps.map((s) => s.state)).toEqual(['active', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending']);
      expect(JSON.stringify(body)).not.toMatch(/undefined|NaN/);
    });

    it('machine and claude come from the account\'s own machines through the real facts read: a second account\'s signed-in machine counts for nobody else', async () => {
      const a = await who('owner');
      const b = await who('owner');
      await runner(b, true, 'microvm');
      await runner(a, false, 'os_sandbox');
      const steps = ((await (await call(a, 'GET')).json()) as Body).tracks[1]!.steps;
      expect(steps[0]).toMatchObject({ step: 'machine', state: 'done', tier: 'standard' });
      expect(steps[1]).toMatchObject({ step: 'claude', state: 'active', completed_at: null });
      await runner(a, true, 'os_sandbox');
      expect(((await (await call(a, 'GET')).json()) as Body).tracks[1]!.steps[1]).toMatchObject({ step: 'claude', state: 'done' });
      expect(((await (await call(b, 'GET')).json()) as Body).tracks[1]!.steps[0]).toMatchObject({ tier: 'microvm' });
    });

    it('is still session-only and admin: a member and a token are refused', async () => {
      const w = await who('owner');
      expect((await call(await memberOf(w.accountId, 'member'), 'GET')).status).toBe(403);
      expect(await code(await call(await tokenFor(w, ['read']), 'GET'))).toBe('session_required');
    });
  });

  describe('PUT /onboarding/track', () => {
    it('an owner and an admin choose a track: 200, one audit row each choice, and the GET shows chosen_at', async () => {
      const o = await who('owner');
      const admin2 = await memberOf(o.accountId, 'admin');
      const res = await call(o, 'PUT', { track: 'engine' });
      expect(res.status).toBe(200);
      const first = (await res.json()) as { track: string; chosen_at: string; created: boolean };
      expect(first).toMatchObject({ track: 'engine', created: true });
      expect((await (await call(admin2, 'PUT', { track: 'pipeline' })).json()) as { created: boolean }).toMatchObject({ created: true });
      expect((await auditRows(o.accountId)).sort()).toEqual(['engine', 'pipeline']);
      const tracks = ((await (await call(o, 'GET')).json()) as Body).tracks;
      expect(tracks.map((t) => [t.track, t.chosen_at !== null])).toEqual([['pipeline', true], ['engine', true]]);
      expect(tracks[1]!.chosen_at).toBe(first.chosen_at);
    });

    it('choosing the same track again changes nothing: created is false, the time stays, and there is one audit row', async () => {
      const o = await who('owner');
      const first = (await (await call(o, 'PUT', { track: 'engine' })).json()) as { chosen_at: string };
      const again = (await (await call(o, 'PUT', { track: 'engine' })).json()) as { created: boolean; chosen_at: string };
      expect(again).toMatchObject({ created: false, chosen_at: first.chosen_at });
      expect(await auditRows(o.accountId)).toEqual(['engine']);
    });

    it('a member is 403 insufficient_role and any token is 403 session_required; nothing is written; no credential is 401', async () => {
      const o = await who('owner');
      const member = await memberOf(o.accountId, 'member');
      const res = await call(member, 'PUT', { track: 'engine' });
      expect(res.status).toBe(403);
      expect(await code(res)).toBe('insufficient_role');
      for (const scopes of [['read'], ['read', 'runs:cancel']] as Scope[][]) {
        const t = await call(await tokenFor(o, scopes), 'PUT', { track: 'engine' });
        expect(t.status).toBe(403);
        expect(await code(t)).toBe('session_required');
      }
      expect((await call(null, 'PUT', { track: 'engine' })).status).toBe(401);
      expect(await auditRows(o.accountId)).toEqual([]);
      expect((await admin.query(`SELECT 1 FROM onboarding_tracks WHERE account_id = $1`, [o.accountId])).rowCount).toBe(0);
    });

    it('an unknown track, a missing track and an extra key are 422 and write nothing', async () => {
      const o = await who('owner');
      for (const body of [{ track: 'both' }, {}, { track: 'engine', chosen_by: randomUUID() }, { track: 7 }]) {
        expect((await call(o, 'PUT', body)).status, JSON.stringify(body)).toBe(422);
      }
      expect((await admin.query(`SELECT 1 FROM onboarding_tracks WHERE account_id = $1`, [o.accountId])).rowCount).toBe(0);
    });

    it('one account\'s choice never shows on another account', async () => {
      const a = await who('owner');
      const b = await who('owner');
      await call(a, 'PUT', { track: 'engine' });
      expect(((await (await call(b, 'GET')).json()) as Body).tracks.map((t) => t.chosen_at)).toEqual([null, null]);
    });
  });
});

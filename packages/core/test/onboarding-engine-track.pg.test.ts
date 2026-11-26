import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { PREFLIGHT_FIX } from '@fulcrumaxe/runner-protocol';
import { createPool } from '@fx/db/src/pool.js';
import { nextGhInstallationId } from '@fx/db/test/helpers/seed.js';
import { withTenant } from '../src/tenancy/withTenant.js';
import { chooseTrack, emitSetupChanged, getOnboarding, readChosenTracks, readEngineSources } from '../src/onboarding/index.js';

/** D#845 ON-5: the engine track's sources, the track choice and the setup notice, against the real schema with row security forced. */
describe('engine track (pg)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appPool.end();
  });

  interface Acct { accountId: string; userId: string; repoId: string }
  async function account(): Promise<Acct> {
    const accountId = randomUUID();
    const userId = randomUUID();
    const inst = randomUUID();
    const repoId = randomUUID();
    await admin.query(`INSERT INTO accounts (id) VALUES ($1)`, [accountId]);
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`, [accountId, userId]);
    await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, 'team_readonly')`, [inst, accountId, nextGhInstallationId()]);
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, $4, 'team')`, [repoId, accountId, inst, randomInt(1, 2_000_000_000)]);
    return { accountId, userId, repoId };
  }
    async function runner(a: Acct, o: { hello?: boolean; revoked?: boolean; engine?: 'microvm' | 'os_sandbox'; auth?: boolean | null; kvm?: 'present' | 'absent'; preflight?: string[] } = {}): Promise<string> {
    const id = randomUUID();
    const jkt = randomUUID().replace(/-/g, '') + 'abcdefghijk';
    await admin.query(
      `INSERT INTO runners (id, account_id, registered_by, public_key_jwk, jkt, credential_mode) VALUES ($1, $2, $3, $4::jsonb, $5, 'subscription')`,
      [id, a.accountId, a.userId, JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'x'.repeat(43) }), jkt],
    );
    // A registered machine that has been heard from (last_seen_at) but never recorded a hello (no protocol version).
    if (o.hello === false) await admin.query(`UPDATE runners SET last_seen_at = now() WHERE id = $1`, [id]);
    if (o.hello !== false) await admin.query(`UPDATE runners SET protocol_version = 22, last_seen_at = now(), model_auth_present = $2 WHERE id = $1`, [id, o.auth ?? null]);
    if (o.kvm) await admin.query(`UPDATE runners SET kvm = $2 WHERE id = $1`, [id, o.kvm]);
    if (o.preflight) await admin.query(`UPDATE runners SET preflight = $2::text[] WHERE id = $1`, [id, o.preflight]);
    if (o.revoked) await admin.query(`UPDATE runners SET revoked_at = now() WHERE id = $1`, [id]);
    if (o.engine) await admin.query(`INSERT INTO runner_facts (runner_id, account_id, os, arch, mem_gb_bucket, cpus, sandbox_engine) VALUES ($1, $2, 'linux', 'x64', 16, 8, $3)`, [id, a.accountId, o.engine]);
    return id;
  }
  const ctx = (a: Acct) => ({ pool: appPool, principal: { accountId: a.accountId, userId: a.userId } });
  const facts = (a: Acct) => async (accountId: string, userId: string) => {
    const { rows } = await withTenant(appPool, accountId, userId, (c) => c.query(`SELECT id, model_auth_present FROM runners WHERE account_id = $1 AND revoked_at IS NULL`, [a.accountId]));
    return new Map(rows.map((r) => [r.id as string, { model_auth_present: r.model_auth_present as boolean | null }]));
  };
  const engine = async (a: Acct) => (await getOnboarding(ctx(a), { readMachineFacts: facts(a) })).tracks[1].steps;
  const states = async (a: Acct) => Object.fromEntries((await engine(a)).map((s) => [s.step, s.state]));
  const setup = async (a: Acct, phase: string, fail?: string) => {
    const id = randomUUID();
    await admin.query(`INSERT INTO project_setups (id, account_id, repo_id, kind, phase, created_by) VALUES ($1, $2, $3, 'existing', $4, $5)`, [id, a.accountId, a.repoId, phase, a.userId]);
    if (fail) await admin.query(`UPDATE project_setups SET failure_code = $2, failure_at = now() WHERE id = $1`, [id, fail]);
    return id;
  };

  it('a bare account: the engine track opens on the machine, and the pipeline track equals the top-level steps', async () => {
    const a = await account();
    const p = await getOnboarding(ctx(a));
    expect(p.tracks.map((t) => t.track)).toEqual(['pipeline', 'engine']);
    expect(p.tracks[0].steps).toEqual(p.steps);
    expect(p.tracks.map((t) => t.chosen_at)).toEqual([null, null]);
    expect((await states(a))).toEqual({ machine: 'active', claude: 'pending', github_app: 'pending', project: 'pending', plan: 'pending', install: 'pending', live: 'pending' });
  });

  it('machine: needs a live runner with a recorded hello; revoked and never-heard runners do not count; the tier is the facts\' engine', async () => {
    const a = await account();
    await runner(a, { hello: false });
    await runner(a, { revoked: true, engine: 'microvm' });
    expect((await engine(a))[0]).toMatchObject({ state: 'active', completed_at: null, tier: null });
    await runner(a, { engine: 'os_sandbox' });
    expect((await engine(a))[0]).toMatchObject({ state: 'done', tier: 'standard' });
    const b = await account();
    await runner(b, { engine: 'microvm' });
    expect((await engine(b))[0]).toMatchObject({ state: 'done', tier: 'microvm' });
  });

  // D#845 ON-6c: the machine step carries the machine's KVM fact, and helper_missing when KVM is there and the engine is not microvm.
  it('machine: kvm and helper_missing follow the most recently heard machine; a machine that never said kvm carries neither', async () => {
    const a = await account();
    await runner(a, { engine: 'os_sandbox' });
    const old = (await engine(a))[0]!;
    expect(old).toMatchObject({ state: 'done', tier: 'standard' });
    expect(old).not.toHaveProperty('kvm');
    expect(old).not.toHaveProperty('helper_missing');
    const b = await account();
    await runner(b, { engine: 'os_sandbox', kvm: 'absent' });
    expect((await engine(b))[0]).toMatchObject({ kvm: 'absent', tier: 'standard' });
    expect((await engine(b))[0]).not.toHaveProperty('helper_missing');
    const c = await account();
    await runner(c, { engine: 'os_sandbox', kvm: 'present' });
    expect((await engine(c))[0]).toMatchObject({ kvm: 'present', helper_missing: true, tier: 'standard' });
    const d = await account();
    await runner(d, { engine: 'microvm', kvm: 'present' });
    expect((await engine(d))[0]).toMatchObject({ kvm: 'present', tier: 'microvm' });
    expect((await engine(d))[0]).not.toHaveProperty('helper_missing');
  });

  it('machine: a revoked machine\'s kvm is not read, and the newest heard machine wins', async () => {
    const a = await account();
    await runner(a, { engine: 'os_sandbox', kvm: 'absent', revoked: true });
    expect((await engine(a))[0]).not.toHaveProperty('kvm');
    await runner(a, { engine: 'os_sandbox', kvm: 'absent' });
    await new Promise((r) => setTimeout(r, 15));
    await runner(a, { engine: 'os_sandbox', kvm: 'present' });
    expect((await engine(a))[0]).toMatchObject({ kvm: 'present', helper_missing: true });
  });

  // D#845 ON-21b: the machine step carries the preflight codes of the most recently heard machine, read for this account only.
  it('machine: preflight follows the most recently heard machine, with the fixed lines; a machine that never said carries none, and an empty list is kept', async () => {
    const a = await account();
    await runner(a, { engine: 'os_sandbox' });
    expect((await engine(a))[0]).not.toHaveProperty('preflight');
    const b = await account();
    await runner(b, { engine: 'os_sandbox', preflight: ['dns_failed', 'kvm_absent'] });
    expect((await engine(b))[0]!.preflight).toEqual([
      { code: 'kvm_absent', fix: PREFLIGHT_FIX.kvm_absent },
      { code: 'dns_failed', fix: PREFLIGHT_FIX.dns_failed },
    ]);
    const c = await account();
    await runner(c, { engine: 'microvm', preflight: [] });
    expect((await engine(c))[0]!.preflight).toEqual([]);
  });

  it("machine: a revoked machine's codes are not read, the newest heard machine wins, and another account's codes never show", async () => {
    const a = await account();
    const other = await account();
    await runner(other, { engine: 'os_sandbox', preflight: ['disk_low'] });
    await runner(a, { engine: 'os_sandbox', preflight: ['clock_skew'], revoked: true });
    expect((await engine(a))[0]).not.toHaveProperty('preflight');
    await runner(a, { engine: 'os_sandbox', preflight: ['linger_off'] });
    await new Promise((r) => setTimeout(r, 15));
    await runner(a, { engine: 'os_sandbox', preflight: ['disk_low', 'vm_memory_low'] });
    expect((await engine(a))[0]!.preflight!.map((p) => p.code)).toEqual(['disk_low', 'vm_memory_low']);
    expect((await engine(other))[0]!.preflight!.map((p) => p.code)).toEqual(['disk_low']);
  });

  it('claude: done while the latest hello says true; false, never said and a revoked machine leave it open', async () => {
    const a = await account();
    const r = await runner(a, { auth: null });
    expect((await states(a)).claude).toBe('active');
    await admin.query(`UPDATE runners SET model_auth_present = false WHERE id = $1`, [r]);
    expect((await states(a)).claude).toBe('active');
    await admin.query(`UPDATE runners SET model_auth_present = true WHERE id = $1`, [r]);
    expect((await states(a)).claude).toBe('done');
    await admin.query(`UPDATE runners SET model_auth_present = false WHERE id = $1`, [r]);
    expect((await states(a)).claude).toBe('active');
    await admin.query(`UPDATE runners SET model_auth_present = true, revoked_at = now() WHERE id = $1`, [r]);
    expect((await states(a)).claude).not.toBe('done');
    const noReader = await getOnboarding(ctx(a));
    expect(noReader.tracks[1].steps[1]!.completed_at).toBeNull();
  });

  it('github_app, project, plan, install and live each follow their own source and nothing else', async () => {
    const a = await account();
    const r = await runner(a, { engine: 'microvm' });
    await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, 'team')`, [randomUUID(), a.accountId, nextGhInstallationId()]);
    expect((await states(a)).github_app).toBe('done');
    await admin.query(`INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')`, [a.repoId, a.accountId, r]);
    expect((await states(a)).project).toBe('done');
    await admin.query(`INSERT INTO project_drafts (account_id, repo_id, source, status) VALUES ($1, $2, 'blank', 'draft')`, [a.accountId, a.repoId]);
    expect((await states(a)).plan).not.toBe('done');
    await admin.query(`UPDATE project_drafts SET status = 'approved', approved_by = $2, approved_at = now(), final_at = now() WHERE account_id = $1`, [a.accountId, a.userId]);
    expect((await states(a)).plan).toBe('done');
    const s = await setup(a, 'await_merge');
    expect((await states(a)).install).not.toBe('done');
    await admin.query(`UPDATE project_setups SET phase = 'finish' WHERE id = $1`, [s]);
    expect((await states(a)).install).toBe('done');
    const sess = (kind: string) => admin.query(`INSERT INTO engine_sessions (account_id, runner_id, repo_id, engine_instance_id, session_kind, engine_version) VALUES ($1, $2, $3, $4, $5, '1.0.0')`, [a.accountId, r, a.repoId, randomUUID(), kind]);
    await sess('bridge');
    await admin.query(`UPDATE engine_sessions SET last_heartbeat_at = now() WHERE account_id = $1`, [a.accountId]);
    expect((await states(a)).live).not.toBe('done');
    await sess('engine');
    expect((await states(a)).live).not.toBe('done');
    await admin.query(`UPDATE engine_sessions SET last_heartbeat_at = now() WHERE account_id = $1 AND session_kind = 'engine'`, [a.accountId]);
    expect((await states(a)).live).toBe('done');
  });

  it('a stored failure maps by phase, shows while its step is open, and clears when the step turns done; a removed setup shows none', async () => {
    const a = await account();
    await runner(a, { engine: 'microvm' });
    const s = await setup(a, 'survey', 'survey_failed');
    expect((await engine(a)).find((x) => x.step === 'plan')).toMatchObject({ state: 'failed', failure: { code: 'survey_failed' } });
    await admin.query(`UPDATE project_setups SET phase = 'install', failure_code = 'push_denied', failure_at = now() WHERE id = $1`, [s]);
    expect((await engine(a)).find((x) => x.step === 'install')).toMatchObject({ state: 'failed', failure: { code: 'push_denied' } });
    expect((await engine(a)).find((x) => x.step === 'plan')!.failure).toBeNull();
    await admin.query(`UPDATE project_setups SET phase = 'finish' WHERE id = $1`, [s]);
    const steps = await engine(a);
    expect(steps.find((x) => x.step === 'install')).toMatchObject({ state: 'done', failure: null });
    expect(steps.find((x) => x.step === 'live')).toMatchObject({ state: 'failed', failure: { code: 'push_denied' } });
    await admin.query(`UPDATE project_setups SET phase = 'removed' WHERE id = $1`, [s]);
    expect((await engine(a)).filter((x) => x.failure)).toEqual([]);
  });

  it('tenant scoping: a second repo of the same account does not hide the first, and another account\'s rows never show', async () => {
    const a = await account();
    const b = await account();
    await runner(b, { engine: 'microvm', auth: true });
    await setup(b, 'finish', 'seed_failed');
    await admin.query(`INSERT INTO project_drafts (account_id, repo_id, source, status, approved_by, approved_at, final_at) VALUES ($1, $2, 'blank', 'approved', $3, now(), now())`, [b.accountId, b.repoId, b.userId]);
    expect(Object.values(await states(a))[0]).toBe('active');
    expect((await engine(a)).every((s) => s.completed_at === null && s.failure === null)).toBe(true);
    // Through the RLS-bypassing admin client, asking as A: every query's own account predicate must hold on its own. B has a row for every source.
    const rB = (await admin.query(`SELECT id FROM runners WHERE account_id = $1`, [b.accountId])).rows[0].id as string;
    await admin.query(`INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')`, [b.repoId, b.accountId, rB]);
    await admin.query(`INSERT INTO engine_sessions (account_id, runner_id, repo_id, engine_instance_id, engine_version, last_heartbeat_at) VALUES ($1, $2, $3, $4, '1.0.0', now())`, [b.accountId, rB, b.repoId, randomUUID()]);
    await admin.query(`INSERT INTO onboarding_tracks (account_id, track, chosen_by) VALUES ($1, 'engine', $2)`, [b.accountId, b.userId]);
    const mine = await readEngineSources(admin, a.accountId, null);
    expect(mine.runners).toEqual([]);
    expect(Object.values(mine.sources.done).every((v) => v === null)).toBe(true);
    expect(mine.sources.failures).toEqual({});
    expect(mine.sources.tier).toBeNull();
    expect((await readChosenTracks(admin, a.accountId)).size).toBe(0);
    const theirs = await readEngineSources(admin, b.accountId, null);
    expect(Object.entries(theirs.sources.done).filter(([, v]) => v !== null).map(([k]) => k)).toEqual(['machine', 'project', 'plan', 'install', 'live']);
    expect((await readChosenTracks(admin, b.accountId)).size).toBe(1);
    const repo2 = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) SELECT $2, account_id, installation_id, $3, 'team' FROM repos WHERE id = $1`, [a.repoId, repo2, randomInt(1, 2_000_000_000)]);
    await admin.query(`INSERT INTO project_setups (account_id, repo_id, kind, phase, created_by, failure_code, failure_at) VALUES ($1, $2, 'new', 'plan', $3, 'survey_timeout', now())`, [a.accountId, repo2, a.userId]);
    await setup(a, 'install');
    expect((await engine(a)).find((s) => s.step === 'plan')).toMatchObject({ state: 'failed', failure: { code: 'survey_timeout' } });
  });

  // D#845 ON-20b: the install step's pull request comes from this account's own active setup, never another account's, and never another setup's number.
  it('install carries the active setup\'s pull request: open, closed and merged by its phase, and a second account never sees it', async () => {
    const a = await account();
    const b = await account();
    const sa = await setup(a, 'await_merge');
    await admin.query(`UPDATE project_setups SET install_pr = 41 WHERE id = $1`, [sa]);
    const sb = await setup(b, 'await_merge');
    await admin.query(`UPDATE project_setups SET install_pr = 77 WHERE id = $1`, [sb]);
    // B's setup is the newer one: through the RLS-bypassing admin client asked as A, only A's own account predicate keeps it out
    expect((await readEngineSources(admin, a.accountId, null)).sources.installPr).toEqual({ setup_id: sa, pr_number: 41, pr_state: 'open' });
    expect((await readEngineSources(admin, randomUUID(), null)).sources.installPr).toBeNull();
    const install = async (x: Acct) => (await engine(x)).find((s) => s.step === 'install')!;
    expect(await install(a)).toMatchObject({ setup_id: sa, pr_number: 41, pr_state: 'open' });
    expect(await install(b)).toMatchObject({ setup_id: sb, pr_number: 77, pr_state: 'open' });
    await admin.query(`UPDATE project_setups SET failure_code = 'pr_closed', failure_at = now() WHERE id = $1`, [sa]);
    expect(await install(a)).toMatchObject({ setup_id: sa, pr_number: 41, pr_state: 'closed' });
    await admin.query(`UPDATE project_setups SET phase = 'finish', failure_code = NULL, failure_at = NULL WHERE id = $1`, [sa]);
    expect(await install(a)).toMatchObject({ state: 'done', pr_number: 41, pr_state: 'merged' });
    // the admin (RLS-bypassing) client asked as A: B's setup must not come back through the account predicate alone
    expect((await readEngineSources(admin, a.accountId, null)).sources.installPr).toEqual({ setup_id: sa, pr_number: 41, pr_state: 'merged' });
    // a setup with no pull request, and a removed one, give none
    const c = await account();
    await setup(c, 'install');
    expect(Object.keys(await install(c))).not.toContain('pr_number');
    await admin.query(`UPDATE project_setups SET phase = 'removed' WHERE id = $1`, [sb]);
    expect(Object.keys(await install(b))).not.toContain('setup_id');
    // a second repo of the same account: the most recently moved setup holding a pull request is the active one
    const repo2 = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) SELECT $2, account_id, installation_id, $3, 'team' FROM repos WHERE id = $1`, [a.repoId, repo2, randomInt(1, 2_000_000_000)]);
    const s2 = randomUUID();
    await admin.query(`INSERT INTO project_setups (id, account_id, repo_id, kind, phase, created_by, install_pr) VALUES ($1, $2, $3, 'new', 'await_merge', $4, 52)`, [s2, a.accountId, repo2, a.userId]);
    expect(await install(a)).toMatchObject({ setup_id: s2, pr_number: 52, pr_state: 'open' });
  });

  // D#845 ON-11a1: the engine track's `setup`, the one setup the screens work on.
  describe('track setup', () => {
    const trackSetup = async (a: Acct) => (await getOnboarding(ctx(a), { readMachineFacts: facts(a) })).tracks[1].setup;
    const repo = async (a: Acct): Promise<string> => {
      const id = randomUUID();
      await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) SELECT $2, account_id, installation_id, $3, 'team' FROM repos WHERE id = $1`, [a.repoId, id, randomInt(1, 2_000_000_000)]);
      return id;
    };
    const setupOn = async (a: Acct, repoId: string, phase: string, extra = ''): Promise<string> => {
      const id = randomUUID();
      await admin.query(`INSERT INTO project_setups (id, account_id, repo_id, kind, phase, created_by) VALUES ($1, $2, $3, 'existing', $4, $5)`, [id, a.accountId, repoId, phase, a.userId]);
      if (extra) await admin.query(`UPDATE project_setups SET ${extra} WHERE id = $1`, [id]);
      return id;
    };

    it('is null with no setup, and shows the live one with its phase and state', async () => {
      const a = await account();
      expect(await trackSetup(a)).toBeNull();
      const s = await setupOn(a, a.repoId, 'plan', `state = 'ok'`);
      expect(await trackSetup(a)).toEqual({ id: s, phase: 'plan', state: 'ok', survey_run_id: null, repo_id: a.repoId });
      await admin.query(`UPDATE project_setups SET phase = 'install', state = 'failed' WHERE id = $1`, [s]);
      expect(await trackSetup(a)).toEqual({ id: s, phase: 'install', state: 'failed', survey_run_id: null, repo_id: a.repoId });
    });

    it('a live setup in state skipped is returned as it is', async () => {
      const a = await account();
      const s = await setupOn(a, a.repoId, 'install', `state = 'skipped'`);
      expect(await trackSetup(a)).toEqual({ id: s, phase: 'install', state: 'skipped', survey_run_id: null, repo_id: a.repoId });
    });

    it('D#845 FU-297: names the repository of the live setup, even when the account has a second repo', async () => {
      const a = await account();
      const r2 = await repo(a);
      const s = await setupOn(a, r2, 'plan', `state = 'ok'`);
      expect(await trackSetup(a)).toEqual({ id: s, phase: 'plan', state: 'ok', survey_run_id: null, repo_id: r2 });
    });

    it('a removed setup and a done setup show nothing, whether or not the install merged; a live one shows beside them', async () => {
      const a = await account();
      const s = await setupOn(a, a.repoId, 'install');
      await admin.query(`UPDATE project_setups SET phase = 'removed' WHERE id = $1`, [s]);
      expect(await trackSetup(a)).toBeNull();
      const r2 = await repo(a);
      const done = await setupOn(a, r2, 'done');
      expect(await trackSetup(a)).toBeNull();
      await admin.query(`UPDATE project_setups SET install_pr_closed_number = 7, install_pr_closed_merged = false WHERE id = $1`, [done]);
      expect(await trackSetup(a)).toBeNull();
      await admin.query(`UPDATE project_setups SET install_pr_closed_merged = true WHERE id = $1`, [done]);
      expect(await trackSetup(a)).toBeNull();
      const live = await setupOn(a, a.repoId, 'survey');
      expect(await trackSetup(a)).toEqual({ id: live, phase: 'survey', state: 'started', survey_run_id: null, repo_id: a.repoId });
    });

    it("D#845 ON-10e2b: the survey's run shows once there is one, and is null while a public repo's survey waits for consent", async () => {
      const a = await account();
      const s = await setupOn(a, a.repoId, 'survey');
      expect(await trackSetup(a)).toEqual({ id: s, phase: 'survey', state: 'started', survey_run_id: null, repo_id: a.repoId });
      const run = randomUUID();
      await admin.query(
        `INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id, initiated_by) VALUES ($1, $2, 'project-surveyor', 'runner', 'pending', 'runner_local', $3, $4)`,
        [run, a.accountId, a.repoId, a.userId],
      );
      await admin.query(`UPDATE project_setups SET survey_run_id = $2 WHERE id = $1`, [s, run]);
      expect(await trackSetup(a)).toEqual({ id: s, phase: 'survey', state: 'started', survey_run_id: run, repo_id: a.repoId });
    });

    it('the newest wins among several live setups, and a newer done one does not hide an older live one', async () => {
      const a = await account();
      const r2 = await repo(a);
      await setupOn(a, a.repoId, 'plan', `created_at = now() - interval '2 hours'`);
      const newer = await setupOn(a, r2, 'install', `created_at = now() - interval '1 hour'`);
      expect((await trackSetup(a))?.id).toBe(newer);
      await setupOn(a, await repo(a), 'done', `created_at = now()`);
      expect((await trackSetup(a))?.id).toBe(newer);
    });

    it("another account's setup never appears, through the session read and through the RLS-bypassing client", async () => {
      const a = await account();
      const b = await account();
      await setupOn(b, b.repoId, 'plan');
      const bDone = await account();
      await setupOn(bDone, bDone.repoId, 'done');
      expect(await trackSetup(a)).toBeNull();
      // The admin client skips row security, so only the explicit account predicate keeps the foreign rows out: the live read carries it.
      expect((await readEngineSources(admin, a.accountId, null)).sources.setup).toBeNull();
      expect((await readEngineSources(admin, b.accountId, null)).sources.setup).toMatchObject({ phase: 'plan' });
      await setupOn(a, a.repoId, 'done');
      expect((await readEngineSources(admin, a.accountId, null)).sources.setup).toBeNull();
    });
  });

  it('chooseTrack: stores the choice, audits once, allows both tracks, and a repeat changes nothing', async () => {
    const a = await account();
    const first = await chooseTrack(ctx(a), 'engine');
    expect(first).toMatchObject({ track: 'engine', created: true });
    const again = await chooseTrack(ctx(a), 'engine');
    expect(again).toEqual({ ...first, created: false });
    expect((await chooseTrack(ctx(a), 'pipeline')).created).toBe(true);
    const audit = await admin.query(`SELECT payload->>'track' AS track FROM audit_log WHERE account_id = $1 AND action = 'onboarding.track_chosen' ORDER BY created_at`, [a.accountId]);
    expect(audit.rows.map((r) => r.track)).toEqual(['engine', 'pipeline']);
    const p = await getOnboarding(ctx(a));
    expect(p.tracks.map((t) => t.chosen_at !== null)).toEqual([true, true]);
    await expect(chooseTrack({ pool: appPool, principal: { accountId: a.accountId, userId: a.userId, tokenId: randomUUID() } }, 'engine')).rejects.toThrow(/token/);
  });

  describe('emitSetupChanged', () => {
    const emit = (a: Acct, setupId: string) => withTenant(appPool, a.accountId, a.userId, (c) => emitSetupChanged(c, { accountId: a.accountId, setupId, repoId: a.repoId }));
    const count = async (a: Acct) => (await admin.query(`SELECT count(*)::int AS n FROM domain_events WHERE account_id = $1 AND type = 'setup.changed'`, [a.accountId])).rows[0].n as number;

    it('writes ids only, and at most one per setup in the window; another setup gets its own', async () => {
      const a = await account();
      const s1 = randomUUID();
      const s2 = randomUUID();
      expect(await emit(a, s1)).toBe(true);
      expect(await emit(a, s1)).toBe(false);
      expect(await emit(a, s2)).toBe(true);
      expect(await count(a)).toBe(2);
      const row = (await admin.query(`SELECT subject_id, payload FROM domain_events WHERE account_id = $1 AND subject_id = $2`, [a.accountId, s1])).rows[0];
      expect(row.payload).toEqual({ setup_id: s1, repo_id: a.repoId });
    });

    it('a notice older than the window does not suppress the next; the window is two seconds', async () => {
      const a = await account();
      const s = randomUUID();
      await emit(a, s);
      await admin.query(`UPDATE domain_events SET created_at = now() - interval '3 seconds' WHERE account_id = $1 AND type = 'setup.changed'`, [a.accountId]);
      expect(await emit(a, s)).toBe(true);
      expect(await emit(a, s)).toBe(false);
    });

    it('two concurrent writers of one setup write one notice', async () => {
      const a = await account();
      const s = randomUUID();
      const results = await Promise.all([emit(a, s), emit(a, s), emit(a, s)]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await count(a)).toBe(1);
    });

    it('the per-setup lock serializes interleaved writers: A emits and holds its transaction open, B emits, A commits', async () => {
      const a = await account();
      const s = randomUUID();
      let release!: () => void;
      const hold = new Promise<void>((r) => (release = r));
      let aEmitted!: () => void;
      const emitted = new Promise<void>((r) => (aEmitted = r));
      const writerA = withTenant(appPool, a.accountId, a.userId, async (c) => {
        const wrote = await emitSetupChanged(c, { accountId: a.accountId, setupId: s, repoId: a.repoId });
        aEmitted();
        await hold;
        return wrote;
      });
      await emitted;
      const writerB = emit(a, s);
      // B has to wait on A's lock; give it time to reach it, then let A commit.
      await new Promise((r) => setTimeout(r, 300));
      release();
      expect([await writerA, await writerB]).toEqual([true, false]);
      expect(await count(a)).toBe(1);
    });

    it('the cap holds across a long-held transaction: A holds 2.5 s then emits, B begins at 2.6 s and emits, one notice', async () => {
      const a = await account();
      const s = randomUUID();
      const writerA = withTenant(appPool, a.accountId, a.userId, async (c) => {
        await new Promise((r) => setTimeout(r, 2500));
        return emitSetupChanged(c, { accountId: a.accountId, setupId: s, repoId: a.repoId });
      });
      await new Promise((r) => setTimeout(r, 2600));
      const writerB = emit(a, s);
      expect([await writerA, await writerB]).toEqual([true, false]);
      expect(await count(a)).toBe(1);
    });

    it('rolls back with the writer\'s transaction, and never reads another account\'s notices', async () => {
      const a = await account();
      const b = await account();
      const s = randomUUID();
      await expect(
        withTenant(appPool, a.accountId, a.userId, async (c) => {
          await emitSetupChanged(c, { accountId: a.accountId, setupId: s, repoId: a.repoId });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await count(a)).toBe(0);
      await withTenant(appPool, b.accountId, b.userId, (c) => emitSetupChanged(c, { accountId: b.accountId, setupId: s, repoId: b.repoId }));
      expect(await emit(a, s)).toBe(true);
    });
  });
});

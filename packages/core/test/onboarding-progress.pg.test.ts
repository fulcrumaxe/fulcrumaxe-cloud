import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { ONBOARDING_STEPS, getOnboarding } from '../src/onboarding/index.js';

/** D#2 H17d: getOnboarding against the real schema (0692 marks, getPreview, the stats first-PR rule). */
describe('getOnboarding (pg)', () => {
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

  interface Acct { accountId: string; userId: string }
  /** An account with nothing on it: no installation, repo, connection, run or work item. */
  async function bare(): Promise<Acct> {
    const accountId = randomUUID();
    const userId = randomUUID();
    await admin.query(`INSERT INTO accounts (id) VALUES ($1)`, [accountId]);
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`, [accountId, userId]);
    return { accountId, userId };
  }
  const ctx = (r: Acct, userId = r.userId) => ({ pool: appPool, principal: { accountId: r.accountId, userId } });
  const at = (day: number) => `2026-0${day}-01T00:00:00Z`;
  const steps = async (r: Acct) => Object.fromEntries((await getOnboarding(ctx(r))).steps.map((s) => [s.step, s.completed_at]));
  const iso = (day: number) => new Date(at(day)).toISOString();
  /** Every preview here sits on its own team_readonly install made at at(1), so step 2 reads that. */
  const RO = { readonly_app: iso(1) };
  const NONE = { model_key: null, readonly_app: null, preview: null, pay: null, write_app: null, first_pr: null };

  /** A claimed installation: the row plus its (live) installer record, as a real claim leaves them. */
  async function install(r: Acct, kind: string, createdAt: string): Promise<string> {
    const id = randomUUID();
    const gh = randomInt(1, 2_000_000_000);
    await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind, created_at) VALUES ($1, $2, $3, $4, $5)`, [id, r.accountId, gh, kind, createdAt]);
    await admin.query(`INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id) VALUES ($1, $2, 1)`, [gh, kind]);
    return id;
  }
  /** What the installation webhook does to the installer record. */
  async function lifecycle(installationId: string, column: 'deleted_at' | 'suspended_at', on: boolean) {
    await admin.query(
      `UPDATE installation_installers ii SET ${column} = ${on ? 'now()' : 'NULL'} FROM installations i
        WHERE i.id = $1 AND ii.gh_installation_id = i.gh_installation_id AND ii.app_kind = i.app_kind`,
      [installationId],
    );
  }
  async function connection(r: Acct, status: string) {
    await admin.query(
      `INSERT INTO model_connections (account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint, status)
       VALUES ($1, 'anthropic', 'c', 'n', 'w', 1, $2, $3)`,
      [r.accountId, `fp-${randomUUID()}`, status],
    );
  }
  /** A preview on its own installation and repo; `run` links an agent run with that status and end time. */
  async function preview(r: Acct, state: 'requested' | 'running' | 'void', run?: { status: string; endedAt: string | null }): Promise<string> {
    const inst = await install(r, 'team_readonly', at(1));
    const repoId = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, 1, 'team')`, [repoId, r.accountId, inst]);
    let runId: string | null = null;
    if (run) {
      runId = randomUUID();
      await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'code-reviewer', 'production', 'running')`, [runId, r.accountId]);
      if (run.status !== 'running') {
        // A trigger stamps ended_at with now(); the replica role lets the test pick the time.
        await admin.query('BEGIN');
        await admin.query(`SET LOCAL session_replication_role = replica`);
        await admin.query(`UPDATE agent_runs SET status = $2, ended_at = $3 WHERE id = $1`, [runId, run.status, run.endedAt]);
        await admin.query('COMMIT');
      }
    }
    const id = randomUUID();
    await admin.query(
      `INSERT INTO onboarding_previews (id, account_id, installation_id, repo_id, gh_user_id, gh_installation_id, gh_owner, run_action_id, run_id, state, started_at, void_reason)
       VALUES ($1, $2, $3, $4, $5, $11, $12, $6, $7, $8, $9, $10)`,
      [id, r.accountId, inst, repoId, randomInt(1, 2_000_000_000), randomUUID(), runId, state, runId ? at(1) : null, state === 'void' ? 'preview_unavailable' : null, randomInt(1, 2_000_000_000), randomUUID()],
    );
    return id;
  }
  async function pr(r: Acct, openedAt: string) {
    const inst = (await admin.query(`SELECT id FROM installations WHERE account_id = $1 LIMIT 1`, [r.accountId])).rows[0]?.id as string;
    const repoId = randomUUID();
    const wi = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, 1, 'team')`, [repoId, r.accountId, inst]);
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'feature', 'internal')`, [wi, r.accountId, repoId]);
    await admin.query(
      `INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, at, source, source_ref) VALUES ($1, $2, 'in_progress', 'pr_opened', $3, 'webhook', 'x')`,
      [r.accountId, wi, openedAt],
    );
  }

  it('returns the six steps in order with started_at = accounts.created_at, and six nulls for a fresh account', async () => {
    const a = await bare();
    const view = await getOnboarding(ctx(a));
    expect(view.steps.map((s) => s.step)).toEqual(['model_key', 'readonly_app', 'preview', 'pay', 'write_app', 'first_pr']);
    expect([...ONBOARDING_STEPS]).toEqual(view.steps.map((s) => s.step));
    expect(view.steps.every((s) => Object.keys(s).sort().join() === 'completed_at,skipped,step' && s.skipped === false)).toBe(true);
    expect(Object.keys(view).sort()).toEqual(['started_at', 'steps']);
    const created = (await admin.query(`SELECT created_at FROM accounts WHERE id = $1`, [a.accountId])).rows[0].created_at as Date;
    expect(view.started_at).toBe(created.toISOString());
    expect(await steps(a)).toEqual(NONE);
  });

  it('takes no input but the context', () => {
    expect(getOnboarding.length).toBe(1);
  });

  describe('each step moves only on its own source row', () => {
    it('model_key: done only while a working connection exists; broken, removed or unvalidated reopen it, and the first-ok mark gives the time', async () => {
      const a = await bare();
      await connection(a, 'unvalidated');
      expect(await steps(a)).toEqual(NONE);
      await admin.query(`UPDATE model_connections SET status = 'ok', last_validated_at = '2026-02-01T00:00:00Z' WHERE account_id = $1`, [a.accountId]);
      const first = (await steps(a)).model_key;
      expect(first).not.toBeNull();
      expect(await steps(a)).toEqual({ ...NONE, model_key: first });
      // a key that stops working is not a working key
      await admin.query(`UPDATE model_connections SET status = 'broken', last_validated_at = '2026-03-01T00:00:00Z' WHERE account_id = $1`, [a.accountId]);
      expect(await steps(a)).toEqual(NONE);
      // a rotated key not yet validated is not either
      await admin.query(`UPDATE model_connections SET status = 'unvalidated' WHERE account_id = $1`, [a.accountId]);
      expect(await steps(a)).toEqual(NONE);
      // working again: the write-once mark keeps the original time
      await admin.query(`UPDATE model_connections SET status = 'ok' WHERE account_id = $1`, [a.accountId]);
      expect(await steps(a)).toEqual({ ...NONE, model_key: first });
      // removed
      await admin.query(`DELETE FROM model_connections WHERE account_id = $1`, [a.accountId]);
      expect(await steps(a)).toEqual(NONE);
      // and a new key brings it back
      await connection(a, 'ok');
      expect(await steps(a)).toEqual({ ...NONE, model_key: first });
    });

    it('pay: the write-once mark', async () => {
      const a = await bare();
      await admin.query(`UPDATE accounts SET stripe_subscription_status = 'incomplete' WHERE id = $1`, [a.accountId]);
      expect(await steps(a)).toEqual(NONE);
      await admin.query(`UPDATE accounts SET stripe_subscription_status = 'active' WHERE id = $1`, [a.accountId]);
      const paid = (await steps(a)).pay;
      expect(paid).not.toBeNull();
      await admin.query(`UPDATE accounts SET stripe_subscription_status = 'canceled' WHERE id = $1`, [a.accountId]);
      expect(await steps(a)).toEqual({ ...NONE, pay: paid });
    });

    it('preview is skipped (no time) once the plan is paid without a finished preview; a real finish keeps its time, before or after paying', async () => {
      const skipped = async (r: Acct) => (await getOnboarding(ctx(r))).steps.filter((s) => s.skipped).map((s) => s.step);
      const pay = (r: Acct) => admin.query(`UPDATE accounts SET stripe_subscription_status = 'active' WHERE id = $1`, [r.accountId]);
      // unpaid, no preview: open, not skipped
      const a = await bare();
      expect(await skipped(a)).toEqual([]);
      // paid, preview never run: skipped, and it has no time
      await pay(a);
      expect(await skipped(a)).toEqual(['preview']);
      expect((await steps(a)).preview).toBeNull();
      // a void preview never counts, so still skipped
      await preview(a, 'void');
      expect(await skipped(a)).toEqual(['preview']);
      // paid with a run still going at the moment of paying: skipped until it ends, then done at its real time
      const b = await bare();
      await preview(b, 'running', { status: 'running', endedAt: null });
      await pay(b);
      expect(await skipped(b)).toEqual(['preview']);
      expect((await steps(b)).preview).toBeNull();
      await admin.query('BEGIN');
      await admin.query(`SET LOCAL session_replication_role = replica`);
      await admin.query(`UPDATE agent_runs SET status = 'succeeded', ended_at = $2 WHERE account_id = $1`, [b.accountId, at(3)]);
      await admin.query('COMMIT');
      expect(await skipped(b)).toEqual([]);
      expect((await steps(b)).preview).toBe(iso(3));
      // a preview that finished before paying keeps its real time
      const c = await bare();
      await preview(c, 'running', { status: 'succeeded', endedAt: at(2) });
      await pay(c);
      expect(await skipped(c)).toEqual([]);
      expect((await steps(c)).preview).toBe(iso(2));
    });

    it('readonly_app and write_app: a team_readonly install fills step 2 only, a team install step 5 only, sitekit neither', async () => {
      const a = await bare();
      await install(a, 'sitekit', at(1));
      expect(await steps(a)).toEqual(NONE);
      await install(a, 'team_readonly', at(3));
      await install(a, 'team_readonly', at(2));
      expect(await steps(a)).toEqual({ ...NONE, readonly_app: new Date(at(2)).toISOString() });
      await install(a, 'team', at(5));
      await install(a, 'team', at(4));
      expect(await steps(a)).toEqual({ ...NONE, readonly_app: new Date(at(2)).toISOString(), write_app: new Date(at(4)).toISOString() });
    });

    it('readonly_app: done only while a live read-only installation exists; deleted or suspended reopens it, unsuspend and a reinstall bring it back', async () => {
      const a = await bare();
      const first = await install(a, 'team_readonly', at(2));
      expect(await steps(a)).toEqual({ ...NONE, readonly_app: iso(2) });
      await lifecycle(first, 'suspended_at', true);
      expect(await steps(a)).toEqual(NONE);
      await lifecycle(first, 'suspended_at', false);
      expect(await steps(a)).toEqual({ ...NONE, readonly_app: iso(2) });
      await lifecycle(first, 'deleted_at', true);
      expect(await steps(a)).toEqual(NONE);
      // a reinstall is a new GitHub installation: it counts, with its own time
      await install(a, 'team_readonly', at(5));
      expect(await steps(a)).toEqual({ ...NONE, readonly_app: iso(5) });
    });

    it('readonly_app: one live installation is enough, and the time is the earliest LIVE one', async () => {
      const a = await bare();
      const early = await install(a, 'team_readonly', at(1));
      await install(a, 'team_readonly', at(4));
      await lifecycle(early, 'deleted_at', true);
      expect(await steps(a)).toEqual({ ...NONE, readonly_app: iso(4) });
    });

    it('readonly_app: an installation with no installer record is not live, and a write install never stands in for the read-only one', async () => {
      const a = await bare();
      const id = randomUUID();
      await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind, created_at) VALUES ($1, $2, $3, 'team_readonly', $4)`, [id, a.accountId, randomInt(1, 2_000_000_000), at(1)]);
      expect(await steps(a)).toEqual(NONE);
      const team = await install(a, 'team', at(3));
      expect(await steps(a)).toEqual({ ...NONE, write_app: iso(3) });
      await lifecycle(team, 'deleted_at', true);
      // write_app stays a milestone: deleting the write App does not reopen it
      expect(await steps(a)).toEqual({ ...NONE, write_app: iso(3) });
    });

    it('milestones stay: pay, preview and first_pr do not reopen when step 1 or 2 does', async () => {
      const a = await bare();
      await connection(a, 'ok');
      await preview(a, 'running', { status: 'succeeded', endedAt: at(3) }); // on its own live read-only install
      await admin.query(`UPDATE accounts SET stripe_subscription_status = 'active' WHERE id = $1`, [a.accountId]);
      await admin.query(`DELETE FROM model_connections WHERE account_id = $1`, [a.accountId]);
      await admin.query(
        `UPDATE installation_installers ii SET deleted_at = now() FROM installations i
          WHERE i.account_id = $1 AND ii.gh_installation_id = i.gh_installation_id AND ii.app_kind = i.app_kind`,
        [a.accountId],
      );
      expect((await steps(a)).readonly_app).toBeNull();
      const s = await steps(a);
      expect(s.model_key).toBeNull();
      expect(s.preview).not.toBeNull();
      expect(s.pay).not.toBeNull();
    });

    it('a team install alone fills write_app only, not readonly_app', async () => {
      const a = await bare();
      await install(a, 'team', at(4));
      expect(await steps(a)).toEqual({ ...NONE, write_app: iso(4) });
    });

    it('first_pr: the first PR on or after the team install, by the stats rule; none for a team_readonly install', async () => {
      const a = await bare();
      const ro = await install(a, 'team_readonly', at(1));
      await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, 1, 'team')`, [randomUUID(), a.accountId, ro]);
      expect(await steps(a)).toEqual({ ...NONE, readonly_app: iso(1) });
      await install(a, 'team', at(2));
      expect(await steps(a)).toEqual({ ...NONE, readonly_app: iso(1), write_app: iso(2) });
      await pr(a, at(1)); // before the team install: does not count
      expect(await steps(a)).toEqual({ ...NONE, readonly_app: iso(1), write_app: iso(2) });
      await pr(a, at(4));
      await pr(a, at(3));
      expect(await steps(a)).toEqual({ ...NONE, readonly_app: iso(1), write_app: iso(2), first_pr: iso(3) });
    });
  });

  describe('preview', () => {
    it('a requested or running preview leaves step 3 null', async () => {
      const a = await bare();
      await preview(a, 'requested');
      await preview(a, 'running', { status: 'running', endedAt: null });
      expect(await steps(a)).toEqual({ ...NONE, ...RO });
    });

    it('a run that succeeded counts at its ended_at', async () => {
      const a = await bare();
      await preview(a, 'running', { status: 'succeeded', endedAt: at(3) });
      expect(await steps(a)).toEqual({ ...NONE, ...RO, preview: iso(3) });
    });

    it('a failed or cancelled run ended but does not complete the step, so the flow does not move on', async () => {
      for (const status of ['failed', 'cancelled']) {
        const a = await bare();
        await preview(a, 'running', { status, endedAt: at(3) });
        expect(await steps(a), status).toEqual({ ...NONE, ...RO });
      }
    });

    it('a void preview never counts, including one that kept its run link', async () => {
      const a = await bare();
      await preview(a, 'void');
      await preview(a, 'void', { status: 'failed', endedAt: at(2) });
      expect(await steps(a)).toEqual({ ...NONE, ...RO });
    });

    it('two previews give the earlier success, whatever order they were made in; a failed one is ignored', async () => {
      const a = await bare();
      await preview(a, 'running', { status: 'succeeded', endedAt: at(5) });
      await preview(a, 'running', { status: 'succeeded', endedAt: at(4) });
      await preview(a, 'running', { status: 'failed', endedAt: at(3) });
      await preview(a, 'running', { status: 'running', endedAt: null });
      expect(await steps(a)).toEqual({ ...NONE, ...RO, preview: iso(4) });
    });
  });

  describe('tenancy', () => {
    it("another account's installs, previews, connection, subscription and PRs move none of this account's steps", async () => {
      const a = await bare();
      const b = await bare();
      await connection(b, 'ok');
      await admin.query(`UPDATE accounts SET stripe_subscription_status = 'active' WHERE id = $1`, [b.accountId]);
      await install(b, 'team', at(1));
      await pr(b, at(2));
      await preview(b, 'running', { status: 'succeeded', endedAt: at(3) });
      expect(await steps(a)).toEqual(NONE);
      const theirs = await steps(b);
      expect(Object.values(theirs).every((v) => v !== null)).toBe(true);
    });

    it('a second member of the same account sees an identical result', async () => {
      const a = await bare();
      await connection(a, 'ok');
      await install(a, 'team_readonly', at(2));
      await preview(a, 'running', { status: 'succeeded', endedAt: at(3) });
      const member = randomUUID();
      await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [member, `${member}@example.test`]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [a.accountId, member]);
      const first = await getOnboarding(ctx(a));
      const second = await getOnboarding(ctx(a, member));
      expect(second).toEqual(first);
      expect(first.steps.filter((s) => s.completed_at !== null)).toHaveLength(3);
    });
  });
});

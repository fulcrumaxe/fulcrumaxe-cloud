import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MACHINE_JOB_CLAIM_PATH, machineJobProgressPath, signMachineJob, signRequest, verifyMachineJob, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import {
  CLAIM_PATH, HELLO_PATH, LocalOnlyGithubError, autoPlaceProject, cleanupOpen, removeProjectCloudOnly, removeProjectIn, claimRun, localOnlyGithub, machineJobClaimRun, machineJobProgressRun, moveProject, placeProject, readRepoRemovals, removeProjectRoute, removeProjectsOnRunner, runnerHello, toResponse,
  type GithubRequest, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerLeaseOps,
} from "../src/index.js";
import { ORIGIN, harness, newKey, registerKey, respond, signed, type Harness, type TestKey } from "./helpers.js";

/**
 * [pg] D#845 ON-16a1: removing a project. The route's one transaction (and a fault injected before its commit), the cleanup row only when the machine has something to stop, the refusals,
 * the removal pull request after commit, the repeat, MC-12's seam, the claim that issues the machine's jobs, the `removal_pending` placement refusal, and the whole round over real HTTP with
 * a fake runner that verifies the signed jobs and reports through the real progress route. Row security is forced throughout; the GitHub client is the real `engineRemove` fence over a
 * recording fake.
 */
describe("removing a project [pg]", () => {
  let h: Harness;
  const jobKeys = generateKeyPairSync("ed25519");
  const keyring = { "job-key-1": jobKeys.publicKey };
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const unused = async (): Promise<never> => {
    throw new Error("not used by these tests");
  };
  const idleLeases = (): RunnerLeaseOps => ({
    claimRunnerRun: async () => ({ kind: "idle", retryAfter: 60 }),
    heartbeatRunnerRun: unused, ingestRunnerEvents: unused, beginRunnerDone: unused, finishRunnerDone: unused, gitTicketContext: unused, signGitTicket: unused,
  });
  /** What GitHub was asked, through the real fence. `fail` answers 502 to everything. */
  const github = (o: { fail?: boolean; onCall?: () => Promise<void> } = {}) => {
    const sent: GithubRequest[] = [];
    const client = localOnlyGithub({
      async request(req) {
        sent.push(req);
        await o.onCall?.();
        return o.fail ? { status: 502, body: {} } : { status: 404, body: {} };
      },
    }, { exclude: ["A10"], engineRemove: true });
    return { sent, client };
  };
  const signer = async () => ({ keyId: "job-key-1", signEngineCommand: () => { throw new Error("unused"); }, signMachineJob: (job: MachineJob) => signMachineJob(job, "job-key-1", jobKeys.privateKey) }) as never;
  const depsFor = (over: Partial<RunnerCloudDeps> = {}): RunnerCloudDeps => h.deps({ leases: idleLeases(), engineCommandSigner: signer, log: () => undefined, ...over });

  interface Rig { who: SeedRefs; key: TestKey; runnerId: string; ghRepoId: number; setupId: string; admin: string; member: string }
  async function addMember(accountId: string, role: "admin" | "member"): Promise<string> {
    const userId = randomUUID();
    await h.admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
    await h.admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)", [accountId, userId, role]);
    return userId;
  }
  /** A machine that said hello at protocol 22 (with the session capability unless `caps` says otherwise) and reported enough memory and disk, so it is eligible once it holds no project. */
  async function machine(who: SeedRefs, o: { caps?: string[]; key?: TestKey; name?: string } = {}): Promise<{ runnerId: string; key: TestKey }> {
    const key = o.key ?? newKey();
    const runnerId = await registerKey(h.admin, who.accountId, who.userId, key);
    const hello = await respond(() => runnerHello(h.deps(), signed(key, HELLO_PATH, {
      protocol_version: 22, binary_version: "0.5.0", model_auth_present: true, isolation: "host_sandbox", capabilities: o.caps ?? ["engine_session_v1"], facts: { os: "linux", arch: "x64", mem_gb_bucket: 16, cpus: 8, sandbox_engine: "os_sandbox" },
    })));
    expect(hello.status).toBe(200);
    await h.admin.query("UPDATE runners SET last_seen_at = now() WHERE id = $1", [runnerId]);
    await h.admin.query("UPDATE runner_facts SET host_mem_avail_mb = 9000, host_disk_free_mb = 50000, host_setups_running = 0, host_load_at = now() WHERE runner_id = $1", [runnerId]);
    await h.admin.query("INSERT INTO runner_settings (runner_id, account_id, name) VALUES ($1, $2, $3)", [runnerId, who.accountId, o.name ?? "Studio box"]);
    return { runnerId, key };
  }
  /** One repo placed on one machine: on its repository list, ticked, with a finished setup (install PR 5, engine 1.2.3), and the engine's sandbox listed unless `session: false`. */
  async function rig(o: { session?: boolean; caps?: string[] } = {}): Promise<Rig> {
    const who = await seedAccount(h.admin, randomUUID());
    await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets', execution_mode = 'runner_local' WHERE id = $1", [who.repoId]);
    const ghRepoId = Number((await h.admin.query<{ gh_repo_id: string }>("SELECT gh_repo_id FROM repos WHERE id = $1", [who.repoId])).rows[0]!.gh_repo_id);
    const { runnerId, key } = await machine(who, { caps: o.caps });
    await h.admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [who.repoId, who.accountId, runnerId]);
    await h.admin.query("UPDATE runners SET allowed_repo_ids = ARRAY[$2::uuid] WHERE id = $1", [runnerId, who.repoId]);
    await h.admin.query("INSERT INTO engine_bridge_settings (account_id, watch_enabled, operate_enabled) VALUES ($1, true, true)", [who.accountId]);
    await h.admin.query("INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)", [who.accountId, who.repoId]);
    const setupId = (await h.admin.query<{ id: string }>("INSERT INTO project_setups (account_id, repo_id, runner_id, kind, phase, install_pr, engine_version, created_by) VALUES ($1, $2, $3, 'existing', 'done', 5, '1.2.3', $4) RETURNING id", [who.accountId, who.repoId, runnerId, who.userId])).rows[0]!.id;
    if (o.session !== false) {
      await h.admin.query("INSERT INTO runner_sandboxes (runner_id, slot, account_id, name, state, created_at, disk_bytes, snapshot_count) VALUES ($1, 0, $2, $3, 'stopped', now() - interval '1 hour', 1000, 1)", [runnerId, who.accountId, `fx-engine-${ghRepoId}`]);
    }
    return { who, key, runnerId, ghRepoId, setupId, admin: await addMember(who.accountId, "admin"), member: await addMember(who.accountId, "member") };
  }
  /** A job row as a runner's reports would leave it, its bytes bound to its columns (the table's CHECK). Inserted as the admin role. */
  async function insertJob(r: Rig, o: { kind: string; state: "issued" | "delivered" | "done" | "failed"; setupId?: string; at?: Date; code?: string }): Promise<string> {
    const id = randomUUID();
    const at = o.at ?? new Date();
    const expires = new Date(at.getTime() + 600_000);
    const job = { job: { job_id: id, kind: o.kind, runner_id: r.runnerId, ...(o.setupId ? { setup_id: o.setupId } : {}), issued_at: at.toISOString(), expires_at: expires.toISOString() } };
    const ended = o.state === "done" || o.state === "failed";
    await h.admin.query(
      `INSERT INTO machine_jobs (id, account_id, runner_id, repo_id, setup_id, kind, job, state, issued_at, expires_at, delivered_at, last_seq, last_step, start_mode, failure_code, ended_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [id, r.who.accountId, r.runnerId, r.who.repoId, o.setupId ?? null, o.kind, JSON.stringify(job), o.state, at, expires, o.state === "issued" ? null : at, ended ? 1 : null,
        ended ? (o.state === "done" ? "done" : "admission") : null, o.kind === "engine_session_start" && o.state === "done" ? "created" : null, o.state === "failed" ? (o.code ?? "vm_teardown_incomplete") : null, ended ? new Date() : null],
    );
    return id;
  }
  const as = (r: Rig, who: "owner" | "admin" | "member" = "owner") => ({ accountId: r.who.accountId, userId: who === "owner" ? r.who.userId : who === "admin" ? r.admin : r.member });
  const remove = (r: Rig, body: unknown = { delete_sandbox: true, removal_pr: false }, o: { who?: "owner" | "admin" | "member"; deps?: Partial<RunnerCloudDeps>; beforeCommit?: () => Promise<void>; repoId?: string } = {}) =>
    toResponse(() => removeProjectRoute(depsFor(o.deps), as(r, o.who), o.repoId ?? r.who.repoId, body, { beforeCommit: o.beforeCommit }));
  /** Everything the removal touches, read as the admin role. */
  const snapshot = async (r: Rig) => ({
    placements: (await h.admin.query("SELECT runner_id FROM project_placements WHERE account_id = $1", [r.who.accountId])).rows,
    allowed: (await h.admin.query<{ a: string[] }>("SELECT allowed_repo_ids AS a FROM runners WHERE id = $1", [r.runnerId])).rows[0]!.a,
    ticks: (await h.admin.query("SELECT repo_id FROM engine_bridge_repos WHERE account_id = $1", [r.who.accountId])).rows,
    phases: (await h.admin.query("SELECT phase FROM project_setups WHERE account_id = $1 ORDER BY created_at", [r.who.accountId])).rows.map((x) => x.phase as string),
    cleanups: (await h.admin.query("SELECT repo_id, runner_id, reason, delete_sandbox, requested_by, requested_at FROM machine_cleanups WHERE account_id = $1", [r.who.accountId])).rows,
    removed: (await h.admin.query("SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'project.removed' ORDER BY created_at", [r.who.accountId])).rows.map((x) => x.payload as Record<string, unknown>),
    jobs: (await h.admin.query("SELECT kind, state FROM machine_jobs WHERE account_id = $1 ORDER BY issued_at", [r.who.accountId])).rows,
  });
  const err = (res: { status: number; body: unknown }) => `${res.status} ${(res.body as { error?: { code?: string } }).error?.code ?? JSON.stringify(res.body)}`;
  const tenant = <T>(r: Rig, fn: (c: PoolClient) => Promise<T>) => withTenant(h.appPool, r.who.accountId, r.who.userId, fn);
  const claimReply = async (r: Rig, deps: RunnerCloudDeps = depsFor()) => {
    await h.admin.query("DELETE FROM runner_claim_stamps WHERE runner_id = $1", [r.runnerId]);
    return toResponse(() => claimRun(deps, signed(r.key, CLAIM_PATH, {}, { nonce: randomBytes(16).toString("base64url") })));
  };

  describe("the route", () => {
    it("removes the placement, the machine's repo, the tick and the setup in one transaction, writes the cleanup and the audit row, and issues no job", async () => {
      const r = await rig();
      const res = await remove(r, { delete_sandbox: true, removal_pr: false }, { who: "admin" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ repo_id: r.who.repoId, runner_id: r.runnerId, machine_parts: "queued", already_removed: false, pr: null });
      const s = await snapshot(r);
      expect(s).toMatchObject({ placements: [], allowed: [], ticks: [], phases: ["removed"], jobs: [] });
      expect(s.cleanups).toMatchObject([{ repo_id: r.who.repoId, runner_id: r.runnerId, reason: "remove", delete_sandbox: true, requested_by: r.admin }]);
      expect(s.removed).toEqual([{ repo_id: r.who.repoId, runner_id: r.runnerId, delete_sandbox: true, removal_pr: false, machine_parts: "queued" }]);
      const bridge = (await h.admin.query("SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'engine_bridge.settings_changed'", [r.who.accountId])).rows.map((x) => x.payload);
      expect(bridge).toEqual([{ kind: "repo_removed", repo_id: r.who.repoId }]);
    });

    it("a fault before commit leaves every row as it was", async () => {
      const r = await rig();
      const before = await snapshot(r);
      const res = await remove(r, undefined, { beforeCommit: async () => { throw new Error("injected"); } }).catch((e: Error) => ({ status: 500, body: e.message }));
      expect(res.status).toBe(500);
      expect(await snapshot(r)).toEqual(before);
    });

    it("writes no cleanup when the machine never ran a session, or is revoked", async () => {
      const fresh = await rig({ session: false });
      expect((await remove(fresh)).body).toMatchObject({ machine_parts: "none" });
      expect((await snapshot(fresh)).cleanups).toEqual([]);
      expect((await snapshot(fresh)).removed).toEqual([{ repo_id: fresh.who.repoId, runner_id: fresh.runnerId, delete_sandbox: true, removal_pr: false, machine_parts: "none" }]);

      // A machine that once finished a start has a session too, even with no sandbox listed.
      const started = await rig({ session: false });
      await insertJob(started, { kind: "engine_session_start", state: "done", at: new Date(Date.now() - 3_600_000) });
      expect((await remove(started)).body).toMatchObject({ machine_parts: "queued" });

      const revoked = await rig();
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [revoked.runnerId]);
      expect((await remove(revoked)).body).toMatchObject({ machine_parts: "none" });
      expect(await snapshot(revoked)).toMatchObject({ placements: [], cleanups: [], ticks: [], phases: ["removed"] });
    });

    // Ruling 92.1: a start the machine was never handed is taken back in the removal's transaction; one it holds is left to the cleanup chain.
    const startRows = async (r: Rig) => (await h.admin.query<{ state: string; ended_at: Date | null }>(
      "SELECT state, ended_at FROM machine_jobs WHERE account_id = $1 AND repo_id = $2 AND runner_id = $3 AND kind = 'engine_session_start' ORDER BY issued_at", [r.who.accountId, r.who.repoId, r.runnerId],
    )).rows;

    it("supersedes an issued, undelivered start, and writes no cleanup unless the machine had a session; a second repo's start on another machine stays issued", async () => {
      const fresh = await rig({ session: false });
      const other = await rig({ session: false });
      await insertJob(fresh, { kind: "engine_session_start", state: "issued" });
      await insertJob(other, { kind: "engine_session_start", state: "issued" });
      // The same account's second repo, with its own issued start on the same machine, keeps it (the removal names the repo).
      const repo2 = randomUUID();
      await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) SELECT $1, account_id, installation_id, gh_repo_id + 8000, product, 'acme', 'gadgets', 'runner_local' FROM repos WHERE id = $2", [repo2, fresh.who.repoId]);
      const keptId = await insertJob({ ...fresh, who: { ...fresh.who, repoId: repo2 } }, { kind: "engine_session_start", state: "issued" });
      // The same repo's start on another machine of the account is not this removal's (the removal names the machine it was placed on).
      const elsewhere = await machine(fresh.who);
      const elsewhereId = await insertJob({ ...fresh, runnerId: elsewhere.runnerId }, { kind: "engine_session_start", state: "issued" });
      const res = await remove(fresh);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ machine_parts: "none" });
      expect((await h.admin.query("SELECT state FROM machine_jobs WHERE id = $1", [elsewhereId])).rows).toEqual([{ state: "issued" }]);
      expect(await startRows(fresh)).toMatchObject([{ state: "superseded" }]);
      expect((await startRows(fresh))[0]!.ended_at).not.toBeNull();
      expect((await snapshot(fresh)).cleanups).toEqual([]);
      expect((await h.admin.query("SELECT state FROM machine_jobs WHERE id = $1", [keptId])).rows).toEqual([{ state: "issued" }]);
      // Another account's start is never touched.
      expect(await startRows(other)).toMatchObject([{ state: "issued" }]);

      // With a session as well, the start is superseded and the cleanup is written.
      const had = await rig();
      await insertJob(had, { kind: "engine_session_start", state: "issued" });
      expect((await remove(had)).body).toMatchObject({ machine_parts: "queued" });
      expect(await startRows(had)).toMatchObject([{ state: "superseded" }]);
      expect((await snapshot(had)).cleanups).toHaveLength(1);
    });

    it("leaves a delivered start to the cleanup chain: the cleanup row is written, and the machine's claim issues the stop and delete after it", async () => {
      const r = await rig({ session: false });
      const startId = await insertJob(r, { kind: "engine_session_start", state: "delivered", at: new Date(Date.now() - 60_000) });
      const res = await remove(r);
      expect(res.body).toMatchObject({ machine_parts: "queued" });
      expect(await startRows(r)).toMatchObject([{ state: "delivered" }]);
      expect((await snapshot(r)).cleanups).toMatchObject([{ repo_id: r.who.repoId, runner_id: r.runnerId, delete_sandbox: true }]);
      const reply = await claimReply(r);
      expect(reply.status).toBe(200);
      const chain = (await h.admin.query<{ id: string; kind: string; state: string; issued_at: Date }>(
        "SELECT id, kind, state, issued_at FROM machine_jobs WHERE account_id = $1 AND repo_id = $2 ORDER BY issued_at, id", [r.who.accountId, r.who.repoId],
      )).rows;
      expect(chain.map((j) => [j.kind, j.state])).toEqual([["engine_session_start", "delivered"], ["engine_session_stop", "issued"], ["engine_session_delete", "issued"]]);
      expect(chain[0]!.id).toBe(startId);
      expect(chain[1]!.issued_at.getTime()).toBeGreaterThan(chain[0]!.issued_at.getTime());
    });

    it("refuses before any write: 403 for a member, 404 for another account's repo and a malformed id, 400 for any other body, 409 setup_running while an install job is out", async () => {
      const r = await rig();
      const other = await rig();
      const before = await snapshot(r);
      expect(err(await remove(r, undefined, { who: "member" }))).toBe("403 forbidden");
      expect(err(await remove(r, undefined, { repoId: other.who.repoId }))).toBe("404 not_found");
      expect(err(await remove(r, undefined, { repoId: "not-a-uuid" }))).toBe("404 not_found");
      for (const body of [{}, { delete_sandbox: true }, { delete_sandbox: "yes", removal_pr: false }, { delete_sandbox: true, removal_pr: false, extra: 1 }, null, []]) expect(err(await remove(r, body))).toBe("400 invalid_message");
      await insertJob(r, { kind: "project_setup", state: "issued", setupId: r.setupId });
      expect(err(await remove(r))).toBe("409 setup_running");
      expect(await snapshot(r)).toEqual({ ...before, jobs: [{ kind: "project_setup", state: "issued" }] });
      expect((await snapshot(other)).placements).toHaveLength(1);
    });

    it("a ticked removal PR runs after commit; a failed one still answers 200 with its code, and GitHub is never asked to delete anything", async () => {
      const r = await rig();
      let committed: number | null = null;
      const gh = github({ fail: true, onCall: async () => { committed ??= (await h.admin.query("SELECT 1 FROM project_placements WHERE account_id = $1", [r.who.accountId])).rows.length; } });
      const res = await remove(r, { delete_sandbox: false, removal_pr: true }, { deps: { engineRemovalGithub: async () => gh.client } });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ machine_parts: "queued", pr: { code: "github_unavailable" } });
      expect(committed).toBe(0);
      expect(gh.sent.length).toBeGreaterThan(0);
      expect(gh.sent.filter((q) => q.method !== "GET" && q.method !== "POST")).toEqual([]);
      // The fence itself refuses a repository delete before any request is made.
      await expect(gh.client.request({ method: "DELETE" as never, path: "/repos/acme/widgets" })).rejects.toBeInstanceOf(LocalOnlyGithubError);
      expect((await snapshot(r)).removed).toEqual([{ repo_id: r.who.repoId, runner_id: r.runnerId, delete_sandbox: false, removal_pr: true, machine_parts: "queued" }]);

      // No merged install on record: the closed code, and GitHub is not asked.
      const none = await rig();
      await h.admin.query("UPDATE project_setups SET install_pr = NULL WHERE account_id = $1", [none.who.accountId]);
      const quiet = github();
      expect((await remove(none, { delete_sandbox: true, removal_pr: true }, { deps: { engineRemovalGithub: async () => quiet.client } })).body).toMatchObject({ pr: { code: "install_pr_not_merged" } });
      expect(quiet.sent).toEqual([]);
      // No client configured: the removal still happens.
      const bare = await rig();
      expect((await remove(bare, { delete_sandbox: true, removal_pr: true })).body).toMatchObject({ machine_parts: "queued", pr: { code: "github_unavailable" } });
      expect((await snapshot(bare)).placements).toEqual([]);
    });

    it("repeating the call writes nothing in the cloud and only tries the PR again", async () => {
      const r = await rig();
      expect((await remove(r)).status).toBe(200);
      const after = await snapshot(r);
      const gh = github({ fail: true });
      const again = await remove(r, { delete_sandbox: false, removal_pr: true }, { deps: { engineRemovalGithub: async () => gh.client } });
      expect(again.body).toEqual({ repo_id: r.who.repoId, runner_id: null, machine_parts: "none", already_removed: true, pr: { code: "github_unavailable" } });
      expect(gh.sent.length).toBeGreaterThan(0);
      expect(await snapshot(r)).toEqual(after);
    });
  });

  describe("tenant and repo predicates", () => {
    it("a second repo of the same account keeps its placement, tick, setup and cleanup when the first is removed", async () => {
      const r = await rig();
      const other = await machine(r.who);
      const repo2 = randomUUID();
      await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) SELECT $1, account_id, installation_id, gh_repo_id + 8000, product, 'acme', 'gadgets', 'runner_local' FROM repos WHERE id = $2", [repo2, r.who.repoId]);
      await h.admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [repo2, r.who.accountId, other.runnerId]);
      await h.admin.query("UPDATE runners SET allowed_repo_ids = ARRAY[$2::uuid] WHERE id = $1", [other.runnerId, repo2]);
      await h.admin.query("UPDATE runners SET allowed_repo_ids = array_append(allowed_repo_ids, $2::uuid) WHERE id = $1", [r.runnerId, repo2]);
      await h.admin.query("INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)", [r.who.accountId, repo2]);
      await h.admin.query("INSERT INTO project_setups (account_id, repo_id, kind, phase, created_by) VALUES ($1, $2, 'existing', 'plan', $3)", [r.who.accountId, repo2, r.who.userId]);
      await tenant(r, (c) => c.query("SELECT machine_cleanup_request($1, $2, false)", [repo2, r.runnerId]));
      // The second repo's install job is out: it does not hold up removing the first.
      const setup2 = (await h.admin.query<{ id: string }>("SELECT id FROM project_setups WHERE repo_id = $1", [repo2])).rows[0]!.id;
      await insertJob({ ...r, who: { ...r.who, repoId: repo2 } }, { kind: "project_setup", state: "issued", setupId: setup2 });
      expect((await remove(r)).status).toBe(200);
      const left = async (sql: string) => (await h.admin.query(sql, [repo2])).rows.length;
      expect(await left("SELECT 1 FROM project_placements WHERE repo_id = $1")).toBe(1);
      expect(await left("SELECT 1 FROM engine_bridge_repos WHERE repo_id = $1")).toBe(1);
      expect(await left("SELECT 1 FROM project_setups WHERE repo_id = $1 AND phase = 'plan'")).toBe(1);
      expect(await left("SELECT 1 FROM machine_cleanups WHERE repo_id = $1 AND delete_sandbox = false")).toBe(1);
      expect((await snapshot(r)).allowed).toEqual([repo2]);
    });

    it("through the RLS-bypassing admin client, a foreign account id finds nothing to remove, no open cleanup and no removal to read", async () => {
      const r = await rig();
      await remove(r, { delete_sandbox: true, removal_pr: false });
      const fresh = await rig();
      const foreign = await rig();
      // Another account's install job is out: it must not read as this one's.
      await insertJob(fresh, { kind: "project_setup", state: "issued", setupId: fresh.setupId });
      const before = await snapshot(fresh);
      await h.admin.query("BEGIN");
      try {
        const out = await removeProjectIn(h.admin, { accountId: foreign.who.accountId, userId: foreign.who.userId }, fresh.who.repoId, { deleteSandbox: true, removalPr: false, machineParts: true });
        expect(out).toEqual({ repo_id: fresh.who.repoId, runner_id: null, machine_parts: "none", changed: false });
      } finally {
        await h.admin.query("ROLLBACK");
      }
      expect(await snapshot(fresh)).toEqual(before);
      expect(await cleanupOpen(h.admin, foreign.who.accountId, r.who.repoId, r.runnerId)).toBe(false);
      expect(await cleanupOpen(h.admin, r.who.accountId, r.who.repoId, r.runnerId)).toBe(true);
      expect((await readRepoRemovals(h.admin, foreign.who.accountId, [r.who.repoId])).size).toBe(0);
      expect((await readRepoRemovals(h.admin, r.who.accountId, [r.who.repoId])).size).toBe(1);
    });
  });

  describe("removeProjectsOnRunner (MC-12's seam)", () => {
    it("with machineParts false removes exactly the runner's placement, with no cleanup, and leaves another repo on another machine alone", async () => {
      const r = await rig();
      const other = await machine(r.who);
      const repo2 = randomUUID();
      await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) SELECT $1, account_id, installation_id, gh_repo_id + 9000, product, 'acme', 'gadgets' FROM repos WHERE id = $2", [repo2, r.who.repoId]);
      await h.admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [repo2, r.who.accountId, other.runnerId]);
      const out = await tenant(r, (c) => removeProjectsOnRunner(c, as(r), r.runnerId, { machineParts: false }));
      expect(out).toEqual([{ repo_id: r.who.repoId, runner_id: r.runnerId, machine_parts: "none", changed: true }]);
      const s = await snapshot(r);
      expect(s.cleanups).toEqual([]);
      expect(s.placements).toEqual([{ runner_id: other.runnerId }]);
      const member = withTenant(h.appPool, r.who.accountId, r.member, (c) => removeProjectsOnRunner(c, as(r, "member"), other.runnerId, { machineParts: false }));
      await expect(member).rejects.toMatchObject({ status: 403, code: "forbidden" });
    });
  });

  describe("removeProjectCloudOnly (MC-12: Also delete server)", () => {
    const cloudOnly = (r: Rig, removalPr: boolean, deps: Partial<RunnerCloudDeps> = {}, who: "owner" | "member" = "owner") =>
      toResponse(() => removeProjectCloudOnly(depsFor(deps), as(r, who), r.who.repoId, removalPr));

    it("removes the placement, the machine's repo, the tick and the setup, and skips the machine parts although the machine ran a session: no cleanup, no job, the audit row says none", async () => {
      const r = await rig();
      const res = await cloudOnly(r, false);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ repo_id: r.who.repoId, runner_id: r.runnerId, machine_parts: "none", already_removed: false, pr: null });
      expect(await snapshot(r)).toMatchObject({
        placements: [], allowed: [], ticks: [], phases: ["removed"], cleanups: [], jobs: [],
        removed: [{ repo_id: r.who.repoId, runner_id: r.runnerId, delete_sandbox: false, removal_pr: false, machine_parts: "none" }],
      });
      // The claim that would issue the machine's stop and delete has nothing to issue.
      await claimReply(r);
      expect((await snapshot(r)).jobs).toEqual([]);
    });

    it("builds the removal PR after commit when ticked, and a repeat writes nothing and only tries the PR again; a member is refused", async () => {
      const r = await rig();
      expect((await cloudOnly(r, false, {}, "member")).status).toBe(403);
      expect((await snapshot(r)).placements).toHaveLength(1);
      let committed: number | null = null;
      const gh = github({ fail: true, onCall: async () => { committed ??= (await h.admin.query("SELECT 1 FROM project_placements WHERE account_id = $1", [r.who.accountId])).rows.length; } });
      const res = await cloudOnly(r, true, { engineRemovalGithub: async () => gh.client });
      expect(res.body).toMatchObject({ machine_parts: "none", pr: { code: "github_unavailable" } });
      expect(committed).toBe(0);
      const after = await snapshot(r);
      expect(after.cleanups).toEqual([]);
      const again = await cloudOnly(r, true, { engineRemovalGithub: async () => gh.client });
      expect(again.body).toMatchObject({ already_removed: true, machine_parts: "none" });
      expect(await snapshot(r)).toEqual(after);
    });
  });

  describe("the claim", () => {
    it("an online runner with the session capability gets machine_job: true on its claim after a removal; one without it gets nothing issued", async () => {
      const r = await rig();
      expect((await remove(r)).status).toBe(200);
      const reply = await claimReply(r);
      expect(reply.status).toBe(200);
      expect(reply.body).toMatchObject({ machine_job: true });
      expect((await snapshot(r)).jobs).toEqual([{ kind: "engine_session_stop", state: "issued" }, { kind: "engine_session_delete", state: "issued" }]);
      // The next claim issues nothing twice.
      await claimReply(r);
      expect((await snapshot(r)).jobs).toHaveLength(2);

      const old = await rig({ caps: [] });
      expect((await remove(old)).status).toBe(200);
      const quiet = await claimReply(old);
      expect(quiet.status).toBe(200);
      expect((quiet.body as { machine_job?: boolean }).machine_job).toBeUndefined();
      expect((await snapshot(old)).jobs).toEqual([]);
    });

    it("a claim with no signer configured still answers, and issues nothing", async () => {
      const r = await rig();
      await remove(r);
      const reply = await claimReply(r, depsFor({ engineCommandSigner: null }));
      expect(reply.status).toBe(200);
      expect((await snapshot(r)).jobs).toEqual([]);
    });
  });

  describe("placing the same repo again", () => {
    it("is refused on the same machine with 409 removal_pending while the cleanup is open; another repo may go there, and the repo may go elsewhere", async () => {
      const r = await rig();
      await remove(r);
      const actor = as(r);
      const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { status?: number; code?: string; message?: string }) => `${e.status} ${e.code}`);
      expect(await code(tenant(r, (c) => placeProject(c, actor, { repoId: r.who.repoId, runnerId: r.runnerId })))).toBe("409 removal_pending");
      // An automatic placement skips that machine: with no other, none is eligible.
      expect(await code(tenant(r, (c) => autoPlaceProject(c, actor, { repoId: r.who.repoId })))).toBe("409 no_eligible_machine");
      // Elsewhere is fine, and moving back onto the machine still removing it is refused.
      const other = await machine(r.who);
      expect(await code(tenant(r, (c) => placeProject(c, actor, { repoId: r.who.repoId, runnerId: other.runnerId })))).toBe("ok");
      expect(await code(tenant(r, (c) => moveProject(c, actor, { repoId: r.who.repoId, toRunnerId: r.runnerId })))).toBe("409 removal_pending");
      // Another repo of the account may be placed on the machine that is still removing the first.
      const repo2 = randomUUID();
      await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) SELECT $1, account_id, installation_id, gh_repo_id + 7000, product, 'acme', 'gadgets' FROM repos WHERE id = $2", [repo2, r.who.repoId]);
      expect(await code(tenant(r, (c) => placeProject(c, actor, { repoId: repo2, runnerId: r.runnerId })))).toBe("ok");
    });

    it("is allowed again once the cleanup is closed", async () => {
      const r = await rig();
      await remove(r, { delete_sandbox: false, removal_pr: false });
      await claimReply(r);
      await h.admin.query("UPDATE machine_jobs SET state = 'done', delivered_at = issued_at, last_seq = 1, last_step = 'done', ended_at = now() WHERE account_id = $1", [r.who.accountId]);
      await expect(tenant(r, (c) => placeProject(c, as(r), { repoId: r.who.repoId, runnerId: r.runnerId }))).resolves.toBeUndefined();
    });
  });

  describe("the removal read", () => {
    it("says waiting_machine while the machine is offline or held, removing while it is online, failed once it gave up, and nothing once closed; another account reads nothing", async () => {
      const r = await rig();
      await remove(r);
      const read = async (who: Rig = r, repo = r.who.repoId) => (await tenant(who, (c) => readRepoRemovals(c, who.who.accountId, [repo]))).get(repo) ?? null;
      expect(await read()).toEqual({ state: "removing", machine_name: "Studio box", failure_code: null });
      await h.admin.query("UPDATE runner_settings SET paused_at = now() WHERE runner_id = $1", [r.runnerId]);
      expect((await read())?.state).toBe("waiting_machine");
      await h.admin.query("UPDATE runner_settings SET paused_at = NULL WHERE runner_id = $1", [r.runnerId]);
      await h.admin.query("UPDATE runners SET last_seen_at = now() - interval '1 hour' WHERE id = $1", [r.runnerId]);
      expect((await read())?.state).toBe("waiting_machine");
      const other = await rig();
      expect(await read(other, r.who.repoId)).toBeNull();
      // Three failures of the final job: given up.
      for (let i = 0; i < 3; i++) {
        await insertJob(r, { kind: "engine_session_delete", state: "failed", at: new Date(Date.now() + 1000 * (i + 1)) });
      }
      // A stop that failed later, with another code, is not the final job: the code shown is the last failed delete's.
      await insertJob(r, { kind: "engine_session_stop", state: "failed", at: new Date(Date.now() + 9000), code: "snapshot_failed" });
      expect(await read()).toEqual({ state: "failed", machine_name: "Studio box", failure_code: "vm_teardown_incomplete" });
      // Removing the machine closes it.
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [r.runnerId]);
      expect(await read()).toBeNull();
    });
  });

  describe("over real HTTP", () => {
    let server: Server;
    let base = "";
    let deps: RunnerCloudDeps;
    beforeAll(async () => {
      deps = depsFor();
      server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const path = (req.url ?? "/").split("?")[0]!;
          const request: RunnerHttpRequest = { method: req.method ?? "GET", headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v])), body: Buffer.concat(chunks) };
          const progress = /^\/api\/runner\/machine-job\/([^/]+)\/progress$/.exec(path);
          const run = path === CLAIM_PATH ? () => claimRun(deps, request)
            : path === MACHINE_JOB_CLAIM_PATH ? () => machineJobClaimRun(deps, request)
            : progress ? () => machineJobProgressRun(deps, request, progress[1]!)
            : null;
          if (run === null) {
            res.writeHead(404).end();
            return;
          }
          void toResponse(run).then((out) => {
            res.writeHead(out.status, { "content-type": "application/json", ...(out.headers ?? {}) });
            res.end(JSON.stringify(out.body));
          });
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

    /** The fake runner: signs for the configured origin, as a runner behind the edge would, and sends to the local server. */
    const send = async (key: TestKey, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
      const bytes = Buffer.from(JSON.stringify(body));
      const headers = signRequest({ method: "POST", url: `${ORIGIN}${path}`, body: bytes, privateKey: key.privateKey, keyid: key.jkt, nonce: randomBytes(16).toString("base64url"), created: Math.floor(Date.now() / 1000) });
      const res = await fetch(`${base}${path}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: bytes });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    it("a stop reporting done, then a delete reporting done, closes the cleanup and the removal reads null", async () => {
      const r = await rig();
      expect((await remove(r)).status).toBe(200);
      const claim = await send(r.key, CLAIM_PATH, {});
      expect(claim).toMatchObject({ status: 200, body: { machine_job: true } });
      const seen: string[] = [];
      for (const kind of ["engine_session_stop", "engine_session_delete"]) {
        const picked = await send(r.key, MACHINE_JOB_CLAIM_PATH, {});
        expect(picked.status).toBe(200);
        const job = verifyMachineJob(picked.body.signed_job, keyring, r.runnerId);
        expect(job).toMatchObject({ kind, repo_gh_id: r.ghRepoId, requires_engine: "any" });
        if (job.kind === "engine_session_stop") expect(job.args.reason).toBe("remove");
        seen.push(job.kind);
        expect((await send(r.key, machineJobProgressPath(job.job_id), { seq: 1, step: "admission", state: "ok" })).status).toBe(200);
        expect((await send(r.key, machineJobProgressPath(job.job_id), { seq: 2, step: "done", state: "ok" })).status).toBe(200);
      }
      expect(seen).toEqual(["engine_session_stop", "engine_session_delete"]);
      expect((await snapshot(r)).jobs).toEqual([{ kind: "engine_session_stop", state: "done" }, { kind: "engine_session_delete", state: "done" }]);
      expect((await tenant(r, (c) => readRepoRemovals(c, r.who.accountId, [r.who.repoId]))).get(r.who.repoId) ?? null).toBeNull();
      // Nothing more is due, and the repo may go back on the machine.
      expect((await send(r.key, MACHINE_JOB_CLAIM_PATH, {})).body).toMatchObject({ retry_after: expect.any(Number) });
      await expect(tenant(r, (c) => placeProject(c, as(r), { repoId: r.who.repoId, runnerId: r.runnerId }))).resolves.toBeUndefined();
    });
  });
});

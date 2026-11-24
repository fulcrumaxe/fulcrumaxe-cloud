import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_BASE_COMMIT, MACHINE_JOB_CLAIM_PATH, SetupPushTokenReply, setupProgressPath, setupPushTokenPath, signMachineJob, verifyMachineJob, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { HELLO_PATH, machineJobClaimRun, runnerHello, setupProgressRun, setupPushTokenRun, type RunnerCloudDeps, type RunPullRequestPort } from "../src/index.js";
import { harness, newKey, registerKey, respond, signed, type Harness, type TestKey } from "./helpers.js";
import { JOB_KEYRING, issueTestJob } from "./helpers/machineJobIssuer.js";

const TOKEN = "ghs_sentinel_setup_push_token_0123456789";
const HEAD = "d".repeat(40);
const PUSHED = "f".repeat(40);

/**
 * [pg] D#845 ON-8f1: the push-token route, the pushed commit recorded with `push ok` (Ruling 73), and the replacement of a direct-mode job that lost the race, over the real signed HTTP path, real Ed25519 job signatures,
 * the real SECURITY DEFINER functions as the runner login, and row security forced. The GitHub App is a fake that enforces what the real port does for these calls (one repository, a fixed shape of answer).
 */
describe("setup push [pg]", () => {
  let h: Harness;
  const jobKeys = generateKeyPairSync("ed25519");
  const keyring = { "k1": jobKeys.publicKey };
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const minted: Array<{ id: string; owner: string; name: string }> = [];
  const revoked: string[] = [];
  const port = (over: { fail?: unknown } = {}) => ({
    async mint(repo: { id: string; owner: string; name: string }) {
      if (over.fail !== undefined) throw over.fail;
      minted.push(repo);
      return { token: TOKEN, expiresAt: new Date(Date.now() + 3600_000) };
    },
    async revoke(token: string) {
      revoked.push(token);
    },
  });
  const github = (head: string | null): RunPullRequestPort => ({ defaultBranch: async () => "main", branchState: async () => ({ exists: head !== null, headOid: head, aheadBy: 0, defaultBranch: "main" }) }) as unknown as RunPullRequestPort;
  const depsFor = (over: Partial<RunnerCloudDeps> = {}): RunnerCloudDeps =>
    h.deps({ setupPush: port(), pullRequests: github(HEAD), engineCommandSigner: async () => ({ keyId: "k1", signMachineJob: (job: MachineJob) => signMachineJob(job, "k1", jobKeys.privateKey) }) as never, ...over });

  interface Rig { who: SeedRefs; key: TestKey; runnerId: string; setupId: string; jobId: string }
  /** A fresh account with a named repo, a runner, a setup in install and one job (PR mode unless `mode` says direct) that the runner has taken. */
  async function rig(o: { mode?: "pr" | "direct" } = {}): Promise<Rig> {
    const who = await seedAccount(h.admin, randomUUID());
    await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [who.repoId]);
    const key = newKey();
    const runnerId = await registerKey(h.admin, who.accountId, who.userId, key);
    const hello = await respond(() => runnerHello(h.deps(), signed(key, HELLO_PATH, { protocol_version: 22, binary_version: "0.5.0", model_auth_present: true, isolation: "host_sandbox", capabilities: ["project_setup_v1"], facts: { os: "linux", arch: "x64", mem_gb_bucket: 16, cpus: 8, sandbox_engine: "os_sandbox" } })));
    expect(hello.status).toBe(200);
    const setupId = (await h.admin.query<{ id: string }>("INSERT INTO project_setups (account_id, repo_id, kind, created_by, phase) VALUES ($1, $2, 'existing', $3, 'install') RETURNING id", [who.accountId, who.repoId, who.userId])).rows[0]!.id;
    const direct = o.mode === "direct";
    const issued = await issueTestJob(h.appPool, h.admin, { accountId: who.accountId, userId: who.userId, runnerId, repoId: who.repoId, setupId, args: direct ? { mode: "direct", base_sha: EMPTY_BASE_COMMIT } : {} });
    const taken = await respond(() => machineJobClaimRun(h.deps(), signed(key, MACHINE_JOB_CLAIM_PATH, {})));
    expect(taken.status).toBe(200);
    return { who, key, runnerId, setupId, jobId: issued.id };
  }
  let seq = 0;
  const progress = (r: Rig, body: Record<string, unknown>, deps: RunnerCloudDeps = depsFor()) => respond(() => setupProgressRun(deps, signed(r.key, setupProgressPath(r.setupId), { job_id: r.jobId, seq: seq++, ...body }), r.setupId));
  const token = (r: Rig, o: { setupId?: string; key?: TestKey; body?: unknown; deps?: RunnerCloudDeps } = {}) => {
    const setupId = o.setupId ?? r.setupId;
    return respond(() => setupPushTokenRun(o.deps ?? depsFor(), signed(o.key ?? r.key, setupPushTokenPath(setupId), o.body ?? { job_id: r.jobId }), setupId));
  };
  const started = (r: Rig) => progress(r, { sub_step: "push", state: "started" });
  const setupRow = async (id: string) => (await h.admin.query("SELECT phase, sub_step, state, failure_code, attempt, install_head_sha FROM project_setups WHERE id = $1", [id])).rows[0];
  const jobs = async (setupId: string) => (await h.admin.query<{ id: string; state: string; attempt: number; job: { job: MachineJob } }>("SELECT id, state, attempt, job FROM machine_jobs WHERE setup_id = $1 ORDER BY attempt", [setupId])).rows;

  describe("the push-token route", () => {
    it("hands over one credential once the push step began, for the repository of our own rows, and never again for the job", async () => {
      const r = await rig();
      expect(await token(r)).toMatchObject({ status: 409, body: { error: { code: "push_not_started" } } });
      expect((await started(r)).status).toBe(200);
      minted.length = 0;
      const got = await token(r);
      expect(got.status).toBe(200);
      expect(got.headers?.["cache-control"]).toBe("no-store");
      expect(SetupPushTokenReply.parse(got.body).token).toBe(TOKEN);
      expect(minted).toEqual([{ id: r.who.repoId, owner: "acme", name: "widgets" }]);
      expect(await token(r)).toMatchObject({ status: 409, body: { error: { code: "already_issued" } } });
      expect(minted).toHaveLength(1);
      // the cloud keeps no copy of the credential anywhere
      for (const table of ["machine_jobs", "project_setups", "audit_log"]) expect(JSON.stringify((await h.admin.query(`SELECT t.* FROM ${table} t`)).rows)).not.toContain(TOKEN);
    });

    it("takes no repository, owner or branch from the message", async () => {
      const r = await rig();
      await started(r);
      expect((await token(r, { body: { job_id: r.jobId, repo: "evil/other" } })).status).toBe(400);
      expect((await token(r, { body: {} })).status).toBe(400);
      expect(minted.filter((m) => m.owner === "evil")).toEqual([]);
    });

    it("answers 404 for another runner's key, another job id and another account's setup, and 409 for a superseded or ended job", async () => {
      const r = await rig();
      await started(r);
      const other = await rig();
      await started(other);
      expect((await token(r, { key: other.key })).status).toBe(404);
      expect((await token(r, { body: { job_id: randomUUID() } })).status).toBe(404);
      expect((await token(r, { setupId: other.setupId })).status).toBe(404);
      expect((await token(r, { setupId: randomUUID() })).status).toBe(404);
      await issueTestJob(h.appPool, h.admin, { accountId: r.who.accountId, userId: r.who.userId, runnerId: r.runnerId, repoId: r.who.repoId, setupId: r.setupId });
      expect(await token(r)).toMatchObject({ status: 409, body: { error: { code: "job_superseded" } } });
      const failed = await rig();
      await started(failed);
      await progress(failed, { sub_step: "push", state: "failed", failure_code: "push_failed" });
      expect(await token(failed)).toMatchObject({ status: 409, body: { error: { code: "job_not_active" } } });
    });

    it("maps a mint that cannot be made to a fixed status and answers 503 when no port is configured", async () => {
      const a = await rig();
      await started(a);
      expect(await token(a, { deps: depsFor({ setupPush: port({ fail: Object.assign(new Error("x"), { code: "app_not_installed" }) }) }) })).toMatchObject({ status: 409, body: { error: { code: "app_not_installed" } } });
      const b = await rig();
      await started(b);
      expect(await token(b, { deps: depsFor({ setupPush: port({ fail: Object.assign(new Error("secret text"), { reason: "token_scope_mismatch" }) }) }) })).toMatchObject({ status: 502 });
      const c = await rig();
      await started(c);
      const down = await token(c, { deps: depsFor({ setupPush: port({ fail: new Error("secret text ghs_zzz") }) }) });
      expect(down.status).toBe(503);
      expect(JSON.stringify(down.body)).not.toContain("secret");
      expect((await token(c, { deps: depsFor({ setupPush: null }) })).status).toBe(503);
    });
  });

  describe("the pushed commit (Ruling 73)", () => {
    it("is recorded with the push step's ok, once, and a push ok without it is refused", async () => {
      const r = await rig();
      await started(r);
      expect((await progress(r, { sub_step: "push", state: "ok" })).status).toBe(400);
      expect((await progress(r, { sub_step: "push", state: "ok", head_sha: "ABC" })).status).toBe(400);
      expect((await progress(r, { sub_step: "pr_open", state: "ok", head_sha: PUSHED })).status).toBe(400);
      expect((await progress(r, { sub_step: "push", state: "started", head_sha: PUSHED })).status).toBe(400);
      expect((await progress(r, { sub_step: "push", state: "ok", head_sha: PUSHED })).status).toBe(200);
      expect(await setupRow(r.setupId)).toMatchObject({ sub_step: "push", state: "ok", install_head_sha: PUSHED });
      // a second head for the same attempt is refused and its report undone
      const again = await progress(r, { sub_step: "push", state: "ok", head_sha: HEAD });
      expect(again).toMatchObject({ status: 409, body: { error: { code: "head_not_recorded" } } });
      expect(await setupRow(r.setupId)).toMatchObject({ install_head_sha: PUSHED });
    });

    it("is not recorded for a job that is no longer current, and a new attempt starts with none", async () => {
      const r = await rig();
      await started(r);
      await issueTestJob(h.appPool, h.admin, { accountId: r.who.accountId, userId: r.who.userId, runnerId: r.runnerId, repoId: r.who.repoId, setupId: r.setupId });
      expect((await progress(r, { sub_step: "push", state: "ok", head_sha: PUSHED })).status).toBe(409);
      expect((await setupRow(r.setupId)).install_head_sha).toBeNull();
    });
  });

  describe("a direct-mode job that lost the race", () => {
    const raced = (r: Rig, deps?: RunnerCloudDeps) => progress(r, { sub_step: "push", state: "failed", failure_code: "direct_raced" }, deps);

    it("is replaced by the same setup in PR mode at the new head, attempt + 1, with every other argument the old job's own", async () => {
      const r = await rig({ mode: "direct" });
      await started(r);
      expect((await raced(r)).status).toBe(200);
      const [first, second] = await jobs(r.setupId);
      expect(first).toMatchObject({ id: r.jobId, state: "failed", attempt: 1 });
      expect(second).toMatchObject({ state: "issued", attempt: 2 });
      const a = verifyMachineJob(first!.job, { ...keyring, ...JOB_KEYRING }, r.runnerId);
      const b = verifyMachineJob(second!.job, keyring, r.runnerId);
      if (a.kind !== "project_setup" || b.kind !== "project_setup") throw new Error("kind");
      expect(b.args).toEqual({ ...a.args, mode: "pr", base_sha: HEAD });
      expect(b).toMatchObject({ setup_id: r.setupId, runner_id: r.runnerId, repo_gh_id: a.repo_gh_id, requires_engine: a.requires_engine });
      expect(await setupRow(r.setupId)).toMatchObject({ phase: "install", state: "started", sub_step: null, failure_code: null, attempt: 2, install_head_sha: null });
      // the runner takes it through the ordinary claim
      const next = await respond(() => machineJobClaimRun(h.deps(), signed(r.key, MACHINE_JOB_CLAIM_PATH, {})));
      expect((next.body as { signed_job?: { job: { job_id: string } } }).signed_job?.job.job_id).toBe(second!.id);
    });

    it("stays failed for a person's Retry when the branch still has no commit, when no signer or GitHub is configured, and for a PR-mode job", async () => {
      const empty = await rig({ mode: "direct" });
      await started(empty);
      await raced(empty, depsFor({ pullRequests: github(null) }));
      expect(await setupRow(empty.setupId)).toMatchObject({ state: "failed", failure_code: "direct_raced", attempt: 1 });
      expect(await jobs(empty.setupId)).toHaveLength(1);
      const unsigned = await rig({ mode: "direct" });
      await started(unsigned);
      await raced(unsigned, depsFor({ engineCommandSigner: null, pullRequests: null }));
      expect(await jobs(unsigned.setupId)).toHaveLength(1);
      const pr = await rig({ mode: "pr" });
      await started(pr);
      await raced(pr);
      expect(await jobs(pr.setupId)).toHaveLength(1);
    });

    it("cannot be used by a runner to change anything but the mode and the base: the definer refuses another engine, another plan, another runner's job and a person's session", async () => {
      const r = await rig({ mode: "direct" });
      await started(r);
      await raced(r, depsFor({ pullRequests: github(null) }));
      const prev = (await jobs(r.setupId))[0]!;
      const base = prev.job.job as unknown as { args: Record<string, unknown> } & Record<string, unknown>;
      const issued = new Date();
      const expires = new Date(issued.getTime() + 600_000);
      const attempt = async (mutate: (j: Record<string, unknown>) => void, as: { runner: boolean } = { runner: true }) => {
        const id = randomUUID();
        const job = JSON.parse(JSON.stringify(base)) as { args: Record<string, unknown> } & Record<string, unknown>;
        Object.assign(job, { job_id: id, issued_at: issued.toISOString(), expires_at: expires.toISOString() });
        job.args = { ...job.args, mode: "pr", base_sha: HEAD };
        mutate(job);
        const body = JSON.stringify({ job, key_id: "k1", signature: "x".repeat(86) });
        const run = (client: import("pg").PoolClient) => client.query("SELECT machine_job_reissue($1::uuid, $2::uuid, $3::jsonb, $4, $5)", [r.jobId, id, body, issued, expires]);
        if (!as.runner) return withTenant(h.appPool, r.who.accountId, r.who.userId, run);
        return withTenant(h.appPool, r.who.accountId, async (client) => {
          await client.query("SELECT set_config('app.runner_id', $1, true)", [r.runnerId]);
          return run(client);
        });
      };
      await expect(attempt((j) => (j.args = { ...(j.args as object), engine: { version: "9.9.9", commit_sha: "1".repeat(40), tarball_url: "https://codeload.github.com/x/y/tar.gz/aa", tarball_sha256: "2".repeat(64) } }))).rejects.toThrow();
      await expect(attempt((j) => (j.args = { ...(j.args as object), plan_ref: { draft_id: randomUUID(), version: 1, sha256: "3".repeat(64) } }))).rejects.toThrow();
      await expect(attempt((j) => (j.args = { ...(j.args as object), mode: "direct" }))).rejects.toThrow();
      await expect(attempt((j) => (j.requires_engine = "microvm"))).rejects.toThrow();
      await expect(attempt(() => undefined, { runner: false })).rejects.toThrow();
      expect(await jobs(r.setupId)).toHaveLength(1);
      // the same call with nothing changed but the allowed fields passes
      await expect(attempt(() => undefined)).resolves.toBeDefined();
      expect(await jobs(r.setupId)).toHaveLength(2);
    });
  });
});

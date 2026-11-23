import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MACHINE_JOB_CLAIM_PATH, MACHINE_JOB_KINDS, MachineJobClaimReply, SETUP_FAILURE_CODES, SETUP_SUB_STEPS, setupProgressPath, verifyMachineJob } from "@fulcrumaxe/runner-protocol";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { readEngineSources } from "@fx/core/src/onboarding/engineTrack.js";
import { CLAIM_PATH, HELLO_PATH, claimRun, machineJobClaimRun, runnerHello, setupProgressRun, type RunnerLeaseOps } from "../src/index.js";
import { harness, newKey, registerKey, respond, signed, type Harness, type TestKey } from "./helpers.js";
import { JOB_KEYRING, issueTestJob } from "./helpers/machineJobIssuer.js";

/**
 * [pg] D#845 ON-8a: the machine job claim path and the setup progress route, over the real HTTP path (the RFC 9421 signature, the single-use nonce), real Ed25519 job signatures, the real SECURITY DEFINER
 * functions as the runner login the routes use, and row security forced. The issuer is a test helper (test/helpers/machineJobIssuer.ts); ON-8b ships the real one.
 */
describe("machine job claim and setup progress [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const idle = { claimRunnerRun: async () => ({ kind: "idle" as const, retryAfter: 60 }) } as unknown as RunnerLeaseOps;
  const SIX = ["device_register_v1", "project_setup_v1", "survey_v1", "engine_session_v1", "machine_login_v1", "repo_token_refresh_v1"];
  const helloBody = (o: { protocol: number; caps: string[]; engine: "os_sandbox" | "microvm" }) => ({
    protocol_version: o.protocol, binary_version: "0.5.0", model_auth_present: true, isolation: o.engine === "microvm" ? "microvm" : "host_sandbox", capabilities: o.caps,
    facts: { os: "linux", arch: "x64", mem_gb_bucket: 16, cpus: 8, sandbox_engine: o.engine },
  });
  const unthrottle = (id: string) => h.admin.query("UPDATE runner_claim_stamps SET last_claim_at = now() - interval '1 hour' WHERE runner_id = $1", [id]);

  interface Rig {
    who: SeedRefs;
    runnerId: string;
    key: TestKey;
    setupId: string;
  }
  /** A fresh account with a repo, a live setup in phase install, and one runner whose hello said what `o` says. */
  async function rig(o: { protocol?: number; caps?: string[]; engine?: "os_sandbox" | "microvm"; who?: SeedRefs; setupId?: string } = {}): Promise<Rig> {
    const who = o.who ?? (await seedAccount(h.admin, randomUUID()));
    const key = newKey();
    const runnerId = await registerKey(h.admin, who.accountId, who.userId, key);
    const hello = await respond(() => runnerHello(h.deps(), signed(key, HELLO_PATH, helloBody({ protocol: o.protocol ?? 22, caps: o.caps ?? ["project_setup_v1"], engine: o.engine ?? "os_sandbox" }))));
    expect(hello.status, JSON.stringify(hello.body)).toBe(200);
    const setupId = o.setupId ?? (await h.admin.query<{ id: string }>("INSERT INTO project_setups (account_id, repo_id, kind, created_by, phase) VALUES ($1, $2, 'existing', $3, 'install') RETURNING id", [who.accountId, who.repoId, who.userId])).rows[0]!.id;
    return { who, runnerId, key, setupId };
  }
  const issue = (r: Rig, over: Partial<Parameters<typeof issueTestJob>[2]> = {}) =>
    issueTestJob(h.appPool, h.admin, { accountId: r.who.accountId, userId: r.who.userId, runnerId: r.runnerId, repoId: r.who.repoId, setupId: r.setupId, ...over });
  const claimReply = async (r: Rig) => {
    await unthrottle(r.runnerId);
    return respond(() => claimRun(h.deps({ leases: idle }), signed(r.key, CLAIM_PATH, {})));
  };
  const pickup = (r: Rig, key: TestKey = r.key) => respond(() => machineJobClaimRun(h.deps(), signed(key, MACHINE_JOB_CLAIM_PATH, {})));
  const progress = (r: Rig, body: Record<string, unknown>, o: { setupId?: string; key?: TestKey } = {}) => {
    const setupId = o.setupId ?? r.setupId;
    return respond(() => setupProgressRun(h.deps(), signed(o.key ?? r.key, setupProgressPath(setupId), body), setupId));
  };
  const setupRow = async (id: string) => (await h.admin.query("SELECT sub_step, state, failure_code, failure_reason, failure_at FROM project_setups WHERE id = $1", [id])).rows[0];
  const jobState = async (id: string) => (await h.admin.query<{ state: string }>("SELECT state FROM machine_jobs WHERE id = $1", [id])).rows[0]!.state;
  const step = (jobId: string, seq: number, over: Record<string, unknown> = {}) => ({ job_id: jobId, seq, sub_step: "engine_fetch", state: "started", ...over });
  const handedOver = (body: unknown): boolean => typeof body === "object" && body !== null && "signed_job" in body;
  const signalled = (reply: { body: unknown }) => (reply.body as { machine_job?: boolean }).machine_job === true;

  it("a protocol 22 hello with each of the six capabilities is stored by the widened list, and an unknown one is still refused", async () => {
    const r = await rig({ caps: SIX });
    expect((await h.admin.query<{ capabilities: string[] }>("SELECT capabilities FROM runner_capabilities WHERE runner_id = $1", [r.runnerId])).rows[0]!.capabilities.sort()).toEqual([...SIX].sort());
    await expect(h.admin.query("INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, ARRAY['machine_login_v2'])", [randomUUID(), r.who.accountId])).rejects.toThrow();
  });

  it("signals the runner, hands over one job exactly once, verifies with the runner's keyring, and then signals and hands over nothing", async () => {
    const r = await rig();
    expect(signalled(await claimReply(r))).toBe(false);
    const job = await issue(r);
    expect(job.attempt).toBe(1);
    const hint = await claimReply(r);
    expect(hint).toMatchObject({ status: 200, body: { machine_job: true } });
    const got = await pickup(r);
    expect(got.status).toBe(200);
    expect(got.headers?.["cache-control"]).toBe("no-store");
    const reply = MachineJobClaimReply.parse(got.body);
    expect("signed_job" in reply && verifyMachineJob(reply.signed_job, JOB_KEYRING, r.runnerId).job_id).toBe(job.id);
    expect(await jobState(job.id)).toBe("delivered");
    expect(await pickup(r)).toMatchObject({ status: 200, body: { retry_after: 60 } });
    expect(signalled(await claimReply(r))).toBe(false);
  });

  it("carries every kind the same way, one at a time", async () => {
    const r = await rig({ caps: ["project_setup_v1", "engine_session_v1"] });
    for (const kind of MACHINE_JOB_KINDS) {
      const setupId = kind === "project_setup" ? r.setupId : null;
      const job = await issue(r, { kind, setupId });
      const got = MachineJobClaimReply.parse((await pickup(r)).body);
      expect("signed_job" in got && got.signed_job.job.kind).toBe(kind);
      await h.admin.query("UPDATE machine_jobs SET state = 'done' WHERE id = $1", [job.id]);
    }
  });

  it("gives nothing to an older hello, a hello without the capability, a held runner, and an os_sandbox runner asked to boot a microVM", async () => {
    const old = await rig({ protocol: 21, caps: [] });
    const noCap = await rig({ caps: ["survey_v1"] });
    const held = await rig();
    await h.admin.query("INSERT INTO runner_settings (account_id, runner_id, paused_at) VALUES ($1, $2, now())", [held.who.accountId, held.runnerId]);
    const plain = await rig({ engine: "os_sandbox" });
    const jobs = [await issue(old), await issue(noCap), await issue(held), await issue(plain, { requiresEngine: "microvm" })];
    for (const r of [old, noCap, held, plain]) {
      expect(signalled(await claimReply(r))).toBe(false);
      expect(await pickup(r)).toMatchObject({ status: 200, body: { retry_after: 60 } });
    }
    for (const job of jobs) expect(await jobState(job.id)).toBe("issued");
    const vm = await rig({ engine: "microvm" });
    await issue(vm, { requiresEngine: "microvm" });
    expect(signalled(await claimReply(vm))).toBe(true);
    expect(handedOver((await pickup(vm)).body)).toBe(true);
  });

  it("never delivers a second job while the runner holds a delivered one, and delivers it once the first has ended", async () => {
    const r = await rig({ caps: ["engine_session_v1"] });
    const first = await issue(r, { kind: "engine_session_stop", setupId: null });
    const second = await issue(r, { kind: "engine_session_delete", setupId: null });
    expect(handedOver((await pickup(r)).body)).toBe(true);
    expect(await jobState(first.id)).toBe("delivered");
    expect(await pickup(r)).toMatchObject({ body: { retry_after: 60 } });
    await h.admin.query("UPDATE machine_jobs SET state = 'done' WHERE id = $1", [first.id]);
    const next = await pickup(r);
    expect((next.body as { signed_job?: { job: { job_id: string } } }).signed_job?.job.job_id).toBe(second.id);
    // The database holds the line the route draws: two delivered jobs for one runner are refused outright.
    await h.admin.query("UPDATE machine_jobs SET state = 'issued', delivered_at = NULL WHERE id = $1", [first.id]);
    await expect(h.admin.query("UPDATE machine_jobs SET state = 'delivered', delivered_at = now() WHERE id = $1", [first.id])).rejects.toThrow(/machine_jobs_one_delivered/);
  });

  it("two pickups at once deliver one job to one of them", async () => {
    const r = await rig();
    const job = await issue(r);
    const both = await Promise.all([pickup(r), pickup(r)]);
    expect(both.filter((x) => "signed_job" in (x.body as object))).toHaveLength(1);
    expect(await jobState(job.id)).toBe("delivered");
  });

  it("records a progress report: the step, the state and the failure pair, with a setup.changed notice", async () => {
    const r = await rig();
    const job = await issue(r);
    await pickup(r);
    expect(await progress(r, step(job.id, 0))).toMatchObject({ status: 200, body: { recorded: true } });
    expect(await setupRow(r.setupId)).toMatchObject({ sub_step: "engine_fetch", state: "started", failure_code: null });
    expect((await h.admin.query("SELECT 1 FROM domain_events WHERE account_id = $1 AND type = 'setup.changed' AND subject_id = $2", [r.who.accountId, r.setupId])).rows).toHaveLength(1);
    expect(await progress(r, step(job.id, 1, { sub_step: "labels", state: "skipped", failure_code: "cloud_owned" }))).toMatchObject({ status: 200 });
    expect(await setupRow(r.setupId)).toMatchObject({ sub_step: "labels", state: "skipped", failure_code: null, failure_reason: null });
    expect(await progress(r, step(job.id, 2, { sub_step: "bundle_out", state: "failed", failure_code: "bundle_refused", failure_reason: "workflow" }))).toMatchObject({ status: 200 });
    expect(await setupRow(r.setupId)).toMatchObject({ sub_step: "bundle_out", state: "failed", failure_code: "bundle_refused", failure_reason: "workflow" });
    expect((await setupRow(r.setupId)).failure_at).toBeInstanceOf(Date);
    expect(await jobState(job.id)).toBe("failed");
    expect(await progress(r, step(job.id, 3))).toMatchObject({ status: 409, body: { error: { code: "job_not_active" } } });
  });

  it("stores the topic of a missing_topic code as its reason, and every setup failure code", async () => {
    const r = await rig();
    const job = await issue(r);
    await pickup(r);
    expect(await progress(r, step(job.id, 0, { sub_step: "interview", state: "failed", failure_code: "missing_topic:identity" }))).toMatchObject({ status: 200 });
    expect(await setupRow(r.setupId)).toMatchObject({ failure_code: "missing_topic", failure_reason: "identity" });
    for (const code of SETUP_FAILURE_CODES) {
      const s = await rig();
      const j = await issue(s);
      await pickup(s);
      expect(await progress(s, step(j.id, 0, { state: "failed", failure_code: code })), code).toMatchObject({ status: 200 });
      expect((await setupRow(s.setupId)).failure_code).toBe(code);
    }
  });

  it("a later step that is not failed clears the failure, and a topic the column refuses is a 400 that writes nothing", async () => {
    const r = await rig();
    const job = await issue(r);
    await pickup(r);
    expect(await progress(r, step(job.id, 0, { sub_step: "interview", state: "failed", failure_code: "missing_topic:_a_very_long_topic_name_over_the_column_limit" }))).toMatchObject({ status: 400 });
    expect(await setupRow(r.setupId)).toMatchObject({ sub_step: null, failure_code: null });
    expect(await progress(r, step(job.id, 0))).toMatchObject({ status: 200 });
    expect(await jobState(job.id)).toBe("delivered");
  });

  it("refuses a sequence number that is not above the last, a late report from an earlier attempt, and a job that is not delivered", async () => {
    const r = await rig();
    const first = await issue(r);
    expect(await progress(r, step(first.id, 0))).toMatchObject({ status: 409, body: { error: { code: "job_not_active" } } });
    await pickup(r);
    expect((await progress(r, step(first.id, 4))).status).toBe(200);
    for (const seq of [4, 3, 0]) expect(await progress(r, step(first.id, seq))).toMatchObject({ status: 409, body: { error: { code: "seq_not_increasing" } } });
    expect((await progress(r, step(first.id, 5))).status).toBe(200);
    const second = await issue(r);
    expect(second.attempt).toBe(2);
    expect(await jobState(first.id)).toBe("superseded");
    expect(await progress(r, step(first.id, 6))).toMatchObject({ status: 409, body: { error: { code: "job_superseded" } } });
    expect(await progress(r, step(second.id, 0))).toMatchObject({ status: 409, body: { error: { code: "job_not_active" } } });
    await pickup(r);
    expect((await progress(r, step(second.id, 0))).status).toBe(200);
  });

  it("answers 404 for a job that is not this runner's, this setup's or this account's, and 400 for a body outside the closed shape", async () => {
    const r = await rig();
    const other = await rig({ who: r.who, setupId: r.setupId });
    const stranger = await rig();
    const job = await issue(r);
    await pickup(r);
    const second = await h.admin.query<{ id: string }>("INSERT INTO repos (account_id, installation_id, gh_repo_id, product) SELECT account_id, installation_id, gh_repo_id + 1, product FROM repos WHERE id = $1 RETURNING id", [r.who.repoId]);
    const setup2 = (await h.admin.query<{ id: string }>("INSERT INTO project_setups (account_id, repo_id, kind, created_by, phase) VALUES ($1, $2, 'new', $3, 'install') RETURNING id", [r.who.accountId, second.rows[0]!.id, r.who.userId])).rows[0]!.id;
    expect(await progress(other, step(job.id, 0), { setupId: r.setupId })).toMatchObject({ status: 404 });
    expect(await progress(stranger, step(job.id, 0), { setupId: r.setupId })).toMatchObject({ status: 404 });
    expect(await progress(r, step(job.id, 0), { setupId: setup2 })).toMatchObject({ status: 404 });
    expect(await progress(r, step(randomUUID(), 0))).toMatchObject({ status: 404 });
    expect(await progress(r, step(job.id, 0), { setupId: "not-a-uuid" })).toMatchObject({ status: 404 });
    expect(await setupRow(r.setupId)).toMatchObject({ sub_step: null });
    for (const bad of [{ ...step(job.id, 0), extra: 1 }, { ...step(job.id, 0), sub_step: "archive" }, { seq: 0, sub_step: "engine_fetch", state: "started" }, step(job.id, 0, { state: "failed" })]) expect((await progress(r, bad)).status).toBe(400);
    expect((await progress(r, step(job.id, 0))).status).toBe(200);
  });

  it("holds the tenant line: another runner never sees or takes this one's job, and a foreign account id reads no rows", async () => {
    const r = await rig();
    const stranger = await rig();
    const job = await issue(r);
    expect(signalled(await claimReply(stranger))).toBe(false);
    expect(await pickup(r, stranger.key)).toMatchObject({ body: { retry_after: 60 } });
    expect((await h.admin.query("SELECT 1 FROM machine_jobs WHERE account_id = $1 AND id = $2", [stranger.who.accountId, job.id])).rows).toHaveLength(0);
    expect((await h.admin.query("SELECT 1 FROM machine_jobs WHERE account_id = $1 AND id = $2", [r.who.accountId, job.id])).rows).toHaveLength(1);
    // A tenant session of the other account, and a runner session of the same account but another runner, read none of it; neither can read the signed bytes at all.
    expect((await withTenant(h.appPool, stranger.who.accountId, (c) => c.query("SELECT id FROM machine_jobs WHERE id = $1", [job.id]))).rows).toHaveLength(0);
    await expect(withTenant(h.appPool, r.who.accountId, (c) => c.query("SELECT job FROM machine_jobs WHERE id = $1", [job.id]))).rejects.toThrow(/permission denied/);
    // A second runner of the SAME account: it is told nothing, and the definers themselves (called with the job's id) give it nothing.
    const sibling = await rig({ who: r.who, setupId: r.setupId });
    expect(signalled(await claimReply(sibling))).toBe(false);
    expect(await pickup(r, sibling.key)).toMatchObject({ body: { retry_after: 60 } });
    const asSibling = <T>(sql: string, values: unknown[]) =>
      withTenant(h.appPool, r.who.accountId, async (c) => {
        await c.query("SELECT set_config('app.runner_id', $1, true)", [sibling.runnerId]);
        return (await c.query(sql, values)).rows as T[];
      });
    expect(await asSibling("SELECT o_id FROM machine_job_pending()", [])).toEqual([]);
    expect(await asSibling("SELECT machine_job_deliver($1::uuid) AS job", [job.id])).toEqual([{ job: null }]);
    expect(await jobState(job.id)).toBe("issued");
    await expect(issue(sibling, { runnerId: stranger.runnerId })).rejects.toThrow();
  });

  it("expires a job that was never taken, and fails its setup with job_expired", async () => {
    const r = await rig();
    const job = await issue(r, { issuedAgoS: 600, lifeS: 1 });
    expect(signalled(await claimReply(r))).toBe(false);
    expect(await jobState(job.id)).toBe("expired");
    expect(await setupRow(r.setupId)).toMatchObject({ state: "failed", failure_code: "job_expired" });
    expect(await pickup(r)).toMatchObject({ body: { retry_after: 60 } });
  });

  const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("expires a delivered job that never reported at expires_at with job_expired, and refuses its late report", async () => {
    const r = await rig();
    const job = await issue(r, { issuedAgoS: 0, lifeS: 2 });
    await pickup(r);
    await later(2300);
    expect(await progress(r, step(job.id, 0))).toMatchObject({ status: 409, body: { error: { code: "job_not_active" } } });
    expect(await jobState(job.id)).toBe("expired");
    expect(await setupRow(r.setupId)).toMatchObject({ state: "failed", failure_code: "job_expired" });
  });

  it("does not cut off a job that keeps reporting at expires_at", async () => {
    const r = await rig();
    const job = await issue(r, { issuedAgoS: 0, lifeS: 2 });
    await pickup(r);
    expect((await progress(r, step(job.id, 0))).status).toBe(200);
    await later(2300);
    expect((await progress(r, step(job.id, 1, { sub_step: "bootstrap" }))).status).toBe(200);
    expect(await jobState(job.id)).toBe("delivered");
    expect(await setupRow(r.setupId)).toMatchObject({ state: "started", failure_code: null });
  });

  it("expires a job that reported and then went silent for 10 minutes with job_silent", async () => {
    const r = await rig();
    const job = await issue(r);
    await pickup(r);
    await progress(r, step(job.id, 0));
    await h.admin.query("UPDATE machine_jobs SET last_progress_at = now() - interval '9 minutes' WHERE id = $1", [job.id]);
    expect((await progress(r, step(job.id, 1))).status).toBe(200);
    await h.admin.query("UPDATE machine_jobs SET last_progress_at = now() - interval '11 minutes' WHERE id = $1", [job.id]);
    expect(await progress(r, step(job.id, 2))).toMatchObject({ status: 409, body: { error: { code: "job_not_active" } } });
    expect(await jobState(job.id)).toBe("expired");
    expect(await setupRow(r.setupId)).toMatchObject({ state: "failed", failure_code: "job_silent" });
    expect(signalled(await claimReply(r))).toBe(false);
  });

  it("expires a job 3 hours after delivery however fresh its reports are, with job_overran", async () => {
    const r = await rig();
    const job = await issue(r);
    await pickup(r);
    await progress(r, step(job.id, 0));
    await h.admin.query("UPDATE machine_jobs SET delivered_at = now() - interval '181 minutes' WHERE id = $1", [job.id]);
    expect(await progress(r, step(job.id, 1))).toMatchObject({ status: 409, body: { error: { code: "job_not_active" } } });
    expect(await setupRow(r.setupId)).toMatchObject({ state: "failed", failure_code: "job_overran" });
  });

  it("ends a job done on the last runner step ok, frees the runner's slot in the same transaction, and a later expiry pass leaves the setup alone", async () => {
    const r = await rig({ caps: ["project_setup_v1", "engine_session_v1"] });
    const job = await issue(r);
    const next = await issue(r, { kind: "engine_session_stop", setupId: null });
    expect(handedOver((await pickup(r)).body)).toBe(true);
    expect(await pickup(r)).toMatchObject({ body: { retry_after: 60 } });
    expect((await progress(r, step(job.id, 0, { sub_step: "pr_open", state: "ok" }))).status).toBe(200);
    expect(await jobState(job.id)).toBe("delivered");
    expect((await progress(r, step(job.id, 1, { sub_step: "gh_labels", state: "ok" }))).status).toBe(200);
    expect(await jobState(job.id)).toBe("done");
    expect(await setupRow(r.setupId)).toMatchObject({ sub_step: "gh_labels", state: "ok", failure_code: null });
    expect((await progress(r, step(job.id, 2))).status).toBe(409);
    const got = (await pickup(r)).body as { signed_job?: { job: { job_id: string } } };
    expect(got.signed_job?.job.job_id).toBe(next.id);
    await h.admin.query("UPDATE machine_jobs SET delivered_at = now() - interval '4 hours', last_progress_at = now() - interval '4 hours' WHERE id = $1", [job.id]);
    await claimReply(r);
    expect(await jobState(job.id)).toBe("done");
    expect(await setupRow(r.setupId)).toMatchObject({ state: "ok", failure_code: null });
  });

  it("never ends a job of another kind on a step report: an engine_update job reporting gh_labels ok stays delivered", async () => {
    const r = await rig();
    const job = await issue(r, { kind: "engine_update" });
    expect(handedOver((await pickup(r)).body)).toBe(true);
    expect((await progress(r, step(job.id, 0, { sub_step: "gh_labels", state: "ok" }))).status).toBe(200);
    expect(await jobState(job.id)).toBe("delivered");
    expect(await pickup(r)).toMatchObject({ body: { retry_after: 60 } });
  });

  it("refuses a signed job with a missing key the row is bound to: job_id, issued_at or expires_at", async () => {
    const r = await rig();
    const good = await issue(r);
    for (const missing of ["job_id", "issued_at", "expires_at"]) {
      const id = randomUUID();
      const job = { ...good.signed.job, job_id: id } as Record<string, unknown>;
      delete job[missing];
      const call = withTenant(h.appPool, r.who.accountId, r.who.userId, (c) =>
        // Everything else the row is bound to agrees with the signed bytes, so only the missing key can be what refuses it.
        c.query("SELECT machine_job_issue($1, $2, $3, $4, 'project_setup', $5::jsonb, $6, $7)", [id, r.runnerId, r.who.repoId, r.setupId, JSON.stringify({ ...good.signed, job }), good.signed.job.issued_at, good.signed.job.expires_at]),
      );
      await expect(call, missing).rejects.toThrow(/machine_jobs_job_binds/);
    }
  });

  it("frees the slot when a step fails, so the runner takes its next job", async () => {
    const r = await rig({ caps: ["project_setup_v1", "engine_session_v1"] });
    const job = await issue(r);
    const next = await issue(r, { kind: "engine_session_stop", setupId: null });
    await pickup(r);
    await progress(r, step(job.id, 0, { state: "failed", failure_code: "engine_fetch_failed" }));
    expect(await jobState(job.id)).toBe("failed");
    const got = (await pickup(r)).body as { signed_job?: { job: { job_id: string } } };
    expect(got.signed_job?.job.job_id).toBe(next.id);
  });

  it("holds the signed setup, issue time and expiry to the row: a call that disagrees with its own signed bytes is refused", async () => {
    const r = await rig();
    for (const callAs of [{ setupId: null }, { issuedDeltaMs: -1000 }, { expiresDeltaMs: 1000 }]) {
      await expect(issue(r, { callAs }), JSON.stringify(callAs)).rejects.toThrow(/machine_jobs_job_binds/);
    }
    expect((await h.admin.query("SELECT 1 FROM machine_jobs WHERE runner_id = $1", [r.runnerId])).rows).toHaveLength(0);
  });

  it("is a runner-session-only path: a tenant session cannot call the pickup, and a runner session cannot issue", async () => {
    const r = await rig();
    await expect(withTenant(h.appPool, r.who.accountId, (c) => c.query("SELECT machine_job_pending()"))).rejects.toThrow(/live runner/);
    await expect(
      withTenant(h.appPool, r.who.accountId, async (c) => {
        await c.query("SELECT set_config('app.runner_id', $1, true)", [r.runnerId]);
        await c.query("SELECT machine_job_issue($1, $2, $3, NULL, 'engine_session_delete', '{}'::jsonb, now(), now() + interval '1 minute')", [randomUUID(), r.runnerId, r.who.repoId]);
      }),
    ).rejects.toThrow(/refused/);
    for (const fn of ["machine_job_runner()", "machine_job_expire(uuid)"]) await expect(h.appPool.query(`SELECT ${fn.replace("(uuid)", "(NULL)")}`)).rejects.toThrow(/permission denied/);
  });

  it("reads a skipped step as ok: the engine track shows no failure and the install step turns done with the phase", async () => {
    const r = await rig();
    const job = await issue(r);
    await pickup(r);
    await progress(r, step(job.id, 0, { sub_step: "labels", state: "skipped", failure_code: "cloud_owned" }));
    const read = () => withTenant(h.appPool, r.who.accountId, (c) => readEngineSources(c, r.who.accountId, null));
    expect((await read()).sources.failures).toEqual({});
    expect((await read()).sources.done.install).toBeNull();
    await h.admin.query("UPDATE project_setups SET phase = 'finish' WHERE id = $1", [r.setupId]);
    expect((await read()).sources.done.install).not.toBeNull();
    expect((await setupRow(r.setupId)).state).toBe("skipped");
  });

  it("writes the row the onboarding view-model reads: the install phase, and the sub-step and state the progress route reported", async () => {
    // The page code that renders this row (installDetail in the onboarding app) lives in an app, which a package test must not import. Its mapping from exactly this row shape is pinned in
    // apps/workspace/test/onboarding-engine.test.mjs; here the row is read back and each sub-step name is checked against the protocol's closed list.
    const r = await rig();
    const job = await issue(r);
    await pickup(r);
    const read = async () => (await h.admin.query("SELECT phase, sub_step, state FROM project_setups WHERE id = $1", [r.setupId])).rows[0];
    await progress(r, step(job.id, 0, { sub_step: "deps", state: "started" }));
    expect(await read()).toEqual({ phase: "install", sub_step: "deps", state: "started" });
    await progress(r, step(job.id, 1, { sub_step: "gh_labels", state: "skipped", failure_code: "cloud_owned" }));
    expect(await read()).toEqual({ phase: "install", sub_step: "gh_labels", state: "skipped" });
    for (const name of ["deps", "gh_labels"]) expect(SETUP_SUB_STEPS).toContain(name);
  });
});

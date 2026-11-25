import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MachineJobClaimReply, SESSION_JOB_STEP_ORDER, machineJobProgressPath, type MachineJobKind } from "@fulcrumaxe/runner-protocol";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { HELLO_PATH, machineJobClaimRun, machineJobProgressRun, runnerHello } from "../src/index.js";
import { MACHINE_JOB_CLAIM_PATH } from "@fulcrumaxe/runner-protocol";
import { harness, newKey, registerKey, respond, signed, type Harness, type TestKey } from "./helpers.js";
import { issueTestJob } from "./helpers/machineJobIssuer.js";

/**
 * [pg] D#845 ON-13a0: POST /api/runner/machine-job/:job_id/progress over the real HTTP path (the RFC 9421 signature, the single-use nonce), the real SECURITY DEFINER functions as the runner login the
 * route uses, and row security forced. The issuer is the test helper (it signs with a test key and writes through `machine_job_issue`, so the rows are what the cloud's own issuer will write).
 */
describe("session job progress route [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  interface Rig {
    who: SeedRefs;
    runnerId: string;
    key: TestKey;
  }
  /** A fresh account with a repo and one runner that listed `engine_session_v1` at protocol 22 on a microVM machine. */
  async function rig(o: { who?: SeedRefs } = {}): Promise<Rig> {
    const who = o.who ?? (await seedAccount(h.admin, randomUUID()));
    const key = newKey();
    const runnerId = await registerKey(h.admin, who.accountId, who.userId, key);
    const hello = await respond(() =>
      runnerHello(h.deps(), signed(key, HELLO_PATH, {
        protocol_version: 22, binary_version: "0.5.0", model_auth_present: true, isolation: "microvm", capabilities: ["engine_session_v1", "project_setup_v1"],
        facts: { os: "linux", arch: "x64", mem_gb_bucket: 16, cpus: 8, sandbox_engine: "microvm" },
      })),
    );
    expect(hello.status, JSON.stringify(hello.body)).toBe(200);
    // A start is delivered only while the plan covers it and the repo is operated (migration 1077), so these accounts hold a plan and operate on.
    await h.admin.query("UPDATE accounts SET engine_quantity = 1, stripe_subscription_status = 'active' WHERE id = $1", [who.accountId]);
    await h.admin.query("INSERT INTO engine_bridge_settings (account_id, watch_enabled, operate_enabled) VALUES ($1, true, true) ON CONFLICT (account_id) DO NOTHING", [who.accountId]);
    await h.admin.query("INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [who.accountId, who.repoId]);
    return { who, runnerId, key };
  }
  const issue = (r: Rig, kind: MachineJobKind, setupId: string | null = null) =>
    issueTestJob(h.appPool, h.admin, { accountId: r.who.accountId, userId: r.who.userId, runnerId: r.runnerId, repoId: r.who.repoId, kind, setupId });
  const pickup = (r: Rig) => respond(() => machineJobClaimRun(h.deps(), signed(r.key, MACHINE_JOB_CLAIM_PATH, {})));
  const taken = async (r: Rig): Promise<string | undefined> => {
    const reply = MachineJobClaimReply.parse((await pickup(r)).body);
    return "signed_job" in reply ? reply.signed_job.job.job_id : undefined;
  };
  const progress = (r: Rig, jobId: string, body: Record<string, unknown>, o: { signAs?: string; key?: TestKey } = {}) =>
    respond(() => machineJobProgressRun(h.deps(), signed(o.key ?? r.key, machineJobProgressPath(o.signAs ?? jobId), body), jobId));
  const row = async (id: string) =>
    (await h.admin.query("SELECT state, last_seq, last_step, failure_code, failure_reason, start_mode, ended_at FROM machine_jobs WHERE id = $1", [id])).rows[0] as {
      state: string; last_seq: number | null; last_step: string | null; failure_code: string | null; failure_reason: string | null; start_mode: string | null; ended_at: Date | null;
    };
  const step = (seq: number, name: string, state = "started", over: Record<string, unknown> = {}) => ({ seq, step: name, state, ...over });
  /** An issued job of `kind`, taken by its runner (delivered). */
  async function delivered(r: Rig, kind: MachineJobKind): Promise<string> {
    const job = await issue(r, kind);
    expect(await taken(r)).toBe(job.id);
    return job.id;
  }

  it("records a start's steps in order, ends it done on `done` ok with its mode, and frees the runner's slot for the next job at once", async () => {
    const r = await rig();
    const start = await delivered(r, "engine_session_start");
    const stop = await issue(r, "engine_session_stop");
    expect(await taken(r)).toBeUndefined(); // the start still holds the one slot
    let seq = 0;
    for (const name of SESSION_JOB_STEP_ORDER.engine_session_start.filter((s) => s !== "done")) {
      expect(await progress(r, start, step(seq++, name)), name).toMatchObject({ status: 200, body: { recorded: true }, headers: { "cache-control": "no-store" } });
      expect(await progress(r, start, step(seq++, name, "ok")), name).toMatchObject({ status: 200 });
    }
    expect(await row(start)).toMatchObject({ state: "delivered", last_step: "supervisor", start_mode: null, ended_at: null });
    expect(await progress(r, start, step(seq++, "done", "ok", { start_mode: "fresh" }))).toMatchObject({ status: 200, body: { recorded: true } });
    const ended = await row(start);
    expect(ended).toMatchObject({ state: "done", last_step: "done", start_mode: "fresh", failure_code: null });
    expect(ended.ended_at).toBeInstanceOf(Date);
    expect(await progress(r, start, step(seq, "done", "ok", { start_mode: "fresh" }))).toMatchObject({ status: 409, body: { error: { code: "job_not_active" } } });
    expect(await taken(r)).toBe(stop.id); // the session outlives the job: the stop is taken straight away

    for (const [n, name] of ["admission", "session_stop", "snapshot"].entries()) expect((await progress(r, stop.id, step(n, name, n === 1 ? "skipped" : "ok"))).status).toBe(200);
    expect(await row(stop.id)).toMatchObject({ state: "delivered", last_step: "snapshot" });
    expect((await progress(r, stop.id, step(3, "done", "ok"))).status).toBe(200);
    expect(await row(stop.id)).toMatchObject({ state: "done", start_mode: null });
  });

  it("ends a job failed on a failed step, with its closed code and reason, and answers the next report 409 job_not_active", async () => {
    const r = await rig();
    const job = await delivered(r, "engine_session_start");
    expect((await progress(r, job, step(0, "admission"))).status).toBe(200);
    expect(await progress(r, job, step(1, "admission", "failed", { failure_code: "machine_single_project", failure_reason: "other_project" }))).toMatchObject({ status: 200, body: { recorded: true } });
    const failed = await row(job);
    expect(failed).toMatchObject({ state: "failed", last_step: "admission", failure_code: "machine_single_project", failure_reason: "other_project", start_mode: null });
    expect(failed.ended_at).toBeInstanceOf(Date);
    expect(await progress(r, job, step(2, "session_create"))).toMatchObject({ status: 409, body: { error: { code: "job_not_active" } } });
  });

  it("answers 409 job_not_active for a job that was never taken, 409 seq_not_increasing for a number at or below the last (so a retry counts as recorded), and takes the next one", async () => {
    const r = await rig();
    const job = await issue(r, "engine_session_delete");
    expect(await progress(r, job.id, step(0, "admission"))).toMatchObject({ status: 409, body: { error: { code: "job_not_active" } } });
    expect(await row(job.id)).toMatchObject({ state: "issued", last_seq: null });
    expect(await taken(r)).toBe(job.id);
    expect((await progress(r, job.id, step(4, "admission"))).status).toBe(200);
    for (const seq of [4, 3, 0]) expect(await progress(r, job.id, step(seq, "admission")), String(seq)).toMatchObject({ status: 409, body: { error: { code: "seq_not_increasing" } } });
    expect((await progress(r, job.id, step(5, "session_delete"))).status).toBe(200);
    expect(await row(job.id)).toMatchObject({ last_seq: 5, last_step: "session_delete" });
  });

  it("answers 409 job_not_active for a job that expired or was superseded, and the expiry names its reason on the row", async () => {
    const r = await rig();
    const job = await delivered(r, "engine_session_stop");
    expect((await progress(r, job, step(0, "admission"))).status).toBe(200);
    await h.admin.query("UPDATE machine_jobs SET last_progress_at = now() - interval '11 minutes' WHERE id = $1", [job]);
    expect(await progress(r, job, step(1, "session_stop"))).toMatchObject({ status: 409, body: { error: { code: "job_not_active" } } });
    expect(await row(job)).toMatchObject({ state: "expired", failure_code: "job_silent" });
    expect((await row(job)).ended_at).toBeInstanceOf(Date);

    const start = await issue(r, "engine_session_start");
    await h.admin.query("UPDATE machine_jobs SET state = 'superseded' WHERE id = $1", [start.id]);
    expect(await progress(r, start.id, step(0, "admission"))).toMatchObject({ status: 409, body: { error: { code: "job_not_active" } } });
  });

  it("answers 404 for a job that is not this runner's, this account's or a session job's, and for an id that is no id, and changes nothing", async () => {
    const r = await rig();
    const sibling = await rig({ who: r.who });
    const stranger = await rig();
    const job = await delivered(r, "engine_session_start");
    // A setup job (it has a setup row) and a job of a kind that is not a session kind: this route is not theirs.
    const setupId = (await h.admin.query<{ id: string }>("INSERT INTO project_setups (account_id, repo_id, kind, created_by, phase) VALUES ($1, $2, 'existing', $3, 'install') RETURNING id", [r.who.accountId, r.who.repoId, r.who.userId])).rows[0]!.id;
    const setupJob = await issueTestJob(h.appPool, h.admin, { accountId: r.who.accountId, userId: r.who.userId, runnerId: sibling.runnerId, repoId: r.who.repoId, kind: "project_setup", setupId });
    const update = await issue(sibling, "engine_update");
    await taken(sibling);

    expect(await progress(sibling, job, step(0, "admission"))).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
    expect(await progress(stranger, job, step(0, "admission"))).toMatchObject({ status: 404 });
    expect(await progress(r, randomUUID(), step(0, "admission"))).toMatchObject({ status: 404 });
    expect(await progress(sibling, setupJob.id, step(0, "admission"))).toMatchObject({ status: 404 });
    expect(await progress(sibling, update.id, step(0, "admission"))).toMatchObject({ status: 404 });
    expect(await progress(r, "not-a-uuid", step(0, "admission"))).toMatchObject({ status: 404 });
    expect(await row(job)).toMatchObject({ state: "delivered", last_seq: null, last_step: null });
    expect(await row(setupJob.id)).toMatchObject({ last_seq: null, last_step: null });
    expect((await progress(r, job, step(0, "admission"))).status).toBe(200);
  });

  it("answers 400 for a body outside the closed shape, a step the job's kind does not have, and a mode anywhere but a start's done, and writes nothing", async () => {
    const r = await rig();
    const start = await delivered(r, "engine_session_start");
    const bodyBad: Array<Record<string, unknown>> = [
      { ...step(0, "admission"), extra: 1 },
      { ...step(0, "admission"), job_id: start },
      { ...step(0, "admission"), sub_step: "engine_fetch" },
      step(0, "engine_fetch"),
      step(0, "admission", "failed"),
      step(0, "admission", "ok", { failure_code: "vm_memory_low" }),
      step(0, "admission", "failed", { failure_code: "job_silent" }),
      step(0, "admission", "failed", { failure_code: "vm_memory_low", failure_reason: "Low Memory" }),
      step(0, "admission", "started", { failure_reason: "low_memory" }),
      step(0, "supervisor", "ok", { start_mode: "created" }),
      step(0, "done", "ok", { start_mode: "cold" }),
      { state: "started", step: "admission" },
      {},
    ];
    for (const bad of bodyBad) expect((await progress(r, start, bad)).status, JSON.stringify(bad)).toBe(400);
    // The wrong kind's steps: the definer refuses what the schema allows.
    for (const name of ["session_stop", "snapshot", "session_delete"]) expect((await progress(r, start, step(0, name))).status, `start ${name}`).toBe(400);
    // A start's done ok needs its mode.
    expect((await progress(r, start, step(0, "done", "ok"))).status).toBe(400);
    expect(await row(start)).toMatchObject({ state: "delivered", last_seq: null, last_step: null, start_mode: null });

    await h.admin.query("UPDATE machine_jobs SET state = 'done' WHERE id = $1", [start]);
    const stop = await delivered(r, "engine_session_stop");
    for (const name of ["session_create", "seed", "session_boot", "credentials", "supervisor", "session_delete"]) expect((await progress(r, stop, step(0, name))).status, `stop ${name}`).toBe(400);
    expect((await progress(r, stop, step(0, "done", "ok", { start_mode: "created" }))).status).toBe(400);
    expect(await row(stop)).toMatchObject({ state: "delivered", last_seq: null, start_mode: null });
    expect((await progress(r, stop, step(0, "snapshot"))).status).toBe(200);

    await h.admin.query("UPDATE machine_jobs SET state = 'done' WHERE id = $1", [stop]);
    const del = await delivered(r, "engine_session_delete");
    for (const name of ["session_create", "session_stop", "snapshot", "supervisor"]) expect((await progress(r, del, step(0, name))).status, `delete ${name}`).toBe(400);
    expect((await progress(r, del, step(0, "session_delete"))).status).toBe(200);
  });

  it("answers 401 to a signature made for another job's path, and to an unsigned request, before it looks at the id", async () => {
    const r = await rig();
    const job = await delivered(r, "engine_session_start");
    const other = randomUUID();
    expect(await progress(r, job, step(0, "admission"), { signAs: other })).toMatchObject({ status: 401 });
    expect(await progress(r, "not-a-uuid", step(0, "admission"), { signAs: other })).toMatchObject({ status: 401 });
    const stranger = newKey();
    expect(await progress(r, job, step(0, "admission"), { key: stranger })).toMatchObject({ status: 401 });
    expect(await row(job)).toMatchObject({ last_seq: null });
  });
});

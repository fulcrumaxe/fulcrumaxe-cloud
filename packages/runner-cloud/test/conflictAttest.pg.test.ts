import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Text, signJob, type Job } from "@fulcrumaxe/runner-protocol";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { donePath, doneRun, toResponse, type RunnerDoneStored, type RunnerHttpRequest, type RunnerLeaseOps } from "../src/index.js";
import { harness, newKey, registerKey, signed, type Harness, type TestKey } from "./helpers.js";

/**
 * [pg] D#519 MQ4-e2-c1 (C18-3, C19-2, C19-4b): the `done` route accepts a conflict attestation only from the cloud's own rows. Real tables for the run, its signed job, the round row, the
 * runner's capabilities and the stored event; the lease facade is a recording stand-in (as in done.pg.test.ts). Inert: nothing reads the event yet.
 */
describe("done route: the conflict attestation [pg]", () => {
  let h: Harness;
  let A: SeedRefs;
  let key: TestKey;
  let runnerId: string;
  const signing = generateKeyPairSync("ed25519").privateKey;
  const FROM = "a".repeat(40);
  const BASE = "b".repeat(40);
  const HEAD = "c".repeat(40);

  const begun: Array<Record<string, unknown>> = [];
  const never = async () => {
    throw new Error("not used by these tests");
  };
  const leases: RunnerLeaseOps = {
    claimRunnerRun: never,
    heartbeatRunnerRun: never,
    ingestRunnerEvents: never,
    gitTicketContext: never,
    signGitTicket: never,
    beginRunnerDone: async (input) => (begun.push({ ...input }), { kind: "proceed" }),
    finishRunnerDone: async (input) => ({ kind: "recorded", verdict: input.verdict as RunnerDoneStored }),
  };

  beforeAll(async () => {
    h = await harness();
    A = await seedAccount(h.admin, randomUUID());
    key = newKey();
    runnerId = await registerKey(h.admin, A.accountId, A.userId, key);
    await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets', execution_mode = 'runner_local' WHERE id = $1", [A.repoId]);
  });
  afterAll(() => h.close());
  beforeEach(async () => {
    begun.length = 0;
    await h.admin.query("DELETE FROM runner_capabilities WHERE runner_id = $1", [runnerId]);
    await h.admin.query("INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, ARRAY['conflict_facts_v1'])", [runnerId, A.accountId]);
  });

  const attestation = (over: Record<string, unknown> = {}) => ({
    head: HEAD,
    parents: [FROM, BASE],
    from_sha: FROM,
    base_sha: BASE,
    history: "descendant",
    pushed_by_round: true,
    second_parent_on_default: true,
    still_conflicting: "no",
    touched_paths: ["src/a.ts"],
    truncated: false,
    ...over,
  });

  interface Opts {
    /** The key the signed job carries; `false`: none (an ordinary fix round). */
    key?: { from_sha: string; base_sha: string; base_ref: string } | false;
    /** The round row naming the run; `false`: none. */
    row?: { from_sha: string; base_sha: string; base_ref: string } | false;
    gen?: number;
  }
  async function scene(o: Opts = {}) {
    const runId = randomUUID();
    const gen = 1;
    const branch = `fx/${randomUUID()}-g1`;
    const jobKey = o.key === undefined ? { from_sha: FROM, base_sha: BASE, base_ref: "main" } : o.key;
    const job: Job = {
      schema_version: 1,
      job_id: randomUUID(),
      run_id: runId,
      repo: { id: A.repoId, owner: "acme", name: "widgets", private: true },
      role: "executor",
      mode: "local",
      spec: null,
      task: { kind: "fix", prompt: "p", prompt_sha256: sha256Text("p") },
      role_card: { text: "c", sha256: sha256Text("c") },
      role_tools_sha256: "a".repeat(64),
      continues: { parent_run_id: randomUUID(), session_id: "sess-1", branch },
      branch_prefix: "fx/",
      model_hint: null,
      issued_at: "2026-10-10T12:00:00.000Z",
      expires_at: "2026-10-13T12:00:00.000Z",
      key_id: "k1",
      ...(jobKey === false ? {} : { conflict_round: jobKey }),
    };
    await h.admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, job_signed, runner_id, lease_generation, lease_expires_at, started_at)
       VALUES ($1, $2, $3, 'executor', 'runner', 'running', 'runner_local', $4, $5::jsonb, $6, $7, now() + interval '90 seconds', now())`,
      [runId, A.accountId, A.workItemId, A.repoId, JSON.stringify(signJob(job, signing)), runnerId, o.gen ?? gen],
    );
    const row = o.row === undefined ? { from_sha: FROM, base_sha: BASE, base_ref: "main" } : o.row;
    if (row !== false) {
      const round = Number((await h.admin.query("SELECT COALESCE(max(round), 0) + 1 AS n FROM merge_conflict_rounds WHERE work_item_id = $1", [A.workItemId])).rows[0].n);
      await h.admin.query("INSERT INTO merge_conflict_rounds (account_id, repo_id, work_item_id, round, from_sha, base_sha, base_ref, conflict_files, run_id) VALUES ($1, $2, $3, $4, $5, $6, $7, ARRAY['src/a.ts'], $8)", [A.accountId, A.repoId, A.workItemId, round, row.from_sha, row.base_sha, row.base_ref, runId]);
    }
    const call = (attest?: unknown) =>
      toResponse(() => {
        const payload = { run_id: runId, lease_generation: gen, ...(attest === undefined ? {} : { conflict_attest: attest }) };
        const req: RunnerHttpRequest = signed(key, donePath(runId), payload);
        return doneRun(h.deps({ leases, pullRequests: null }), req, runId);
      });
    const events = async () => (await h.admin.query("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'conflict.attestation'", [runId])).rows.map((r) => r.payload);
    return { runId, call, events };
  }

  const refused = async (s: Awaited<ReturnType<typeof scene>>, attest: unknown = attestation()) => {
    const res = await s.call(attest);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "invalid_message" } });
    expect(begun).toEqual([]);
    expect(await s.events()).toEqual([]);
  };

  it("accepts the attestation for a conflict round the cloud issued and stores it once as a run event", async () => {
    const s = await scene();
    await s.call(attestation());
    expect(begun).toHaveLength(1);
    expect(await s.events()).toEqual([attestation()]);
    // The same value again (a retried done) is a no-op; the run still has exactly one event.
    await s.call(attestation());
    expect(await s.events()).toHaveLength(1);
  });

  it("a second, different value for the same run is a 400 and changes nothing", async () => {
    const s = await scene();
    await s.call(attestation());
    begun.length = 0;
    const res = await s.call(attestation({ history: "not" }));
    expect(res.status).toBe(400);
    expect(begun).toEqual([]);
    expect(await s.events()).toEqual([attestation()]);
  });

  it("is a 400 for a runner whose latest hello did not keep conflict_facts_v1", async () => {
    await h.admin.query("DELETE FROM runner_capabilities WHERE runner_id = $1", [runnerId]);
    await h.admin.query("INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, ARRAY['wake_v1'])", [runnerId, A.accountId]);
    await refused(await scene());
  });

  it("is a 400 for a runner with no capabilities row at all", async () => {
    await h.admin.query("DELETE FROM runner_capabilities WHERE runner_id = $1", [runnerId]);
    await refused(await scene());
  });

  it("is a 400 for a run whose signed job lacks the key: an ordinary fix round never takes the field", async () => {
    await refused(await scene({ key: false }));
  });

  it("is a 400 for a run no round row names (the key alone is not enough)", async () => {
    await refused(await scene({ row: false }));
  });

  it("is a 400 when the key and the row disagree on any of the three values", async () => {
    await refused(await scene({ row: { from_sha: "d".repeat(40), base_sha: BASE, base_ref: "main" } }));
    await refused(await scene({ row: { from_sha: FROM, base_sha: "d".repeat(40), base_ref: "main" } }));
    await refused(await scene({ row: { from_sha: FROM, base_sha: BASE, base_ref: "release" } }));
  });

  it("is a 400 when the attestation does not echo the signed anchors", async () => {
    await refused(await scene(), attestation({ from_sha: "d".repeat(40) }));
    await refused(await scene(), attestation({ base_sha: "d".repeat(40) }));
  });

  it("is a 400 for a run issued under another lease generation (not this runner's lease)", async () => {
    await refused(await scene({ gen: 2 }));
  });

  it("is a 400 for a run id the cloud never issued", async () => {
    const s = await scene();
    const other = randomUUID();
    const res = await toResponse(() => doneRun(h.deps({ leases, pullRequests: null }), signed(key, donePath(other), { run_id: other, lease_generation: 1, conflict_attest: attestation() }), other));
    expect(res.status).toBe(400);
    expect(begun).toEqual([]);
    expect(await s.events()).toEqual([]);
  });

  it("a done without the field is judged as before (the lease is begun, nothing is stored)", async () => {
    const s = await scene({ key: false, row: false });
    await s.call();
    expect(begun).toHaveLength(1);
    expect(await s.events()).toEqual([]);
  });
});

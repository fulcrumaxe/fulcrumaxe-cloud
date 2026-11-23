import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DoneReply, MACHINE_ONBOARDING_MIN_PROTOCOL, MAX_PRD_BYTES, RUNNER_ELIGIBLE_ROLES, SURVEY_FAILURE_REASONS, SURVEY_ROLE, StopReply, taskKindOffered } from "@fulcrumaxe/runner-protocol";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { CLAIM_PATH, claimRun, donePath, doneRun, toResponse, type RunnerCloudDeps } from "@fx/runner-cloud";
import { RunActionInputError } from "../src/index.js";
import { createRunnerClaimFacade } from "../src/runnerClaims.js";
import { createRunnerGitTicketFacade } from "../src/runnerGitTicket.js";
import { createRunnerDoneFacade, type RunnerDoneFacade } from "../src/runnerDone.js";
import { rolesForCapabilities } from "../src/runnerRouting.js";
import { ORIGIN, newKey, signed, type TestKey } from "../../runner-cloud/test/helpers.js";
import { issueSurveyRun } from "./helpers/surveyRunIssuer.js";

const row = (key: string, depends_on: string[] = []) => ({ row_key: key, title: `Row ${key}`, summary: "Does a thing.", size: "M", depends_on });
const DRAFT = { v: 1, prd_md: "# Plan\n\nDistinctPrdMarker: a small service.\n", roadmap: [row("A"), row("B", ["A"]), row("C", ["A", "B"])] };
const SECRET = `github_pat_${"A".repeat(40)}`;

/**
 * [pg] D#845 ON-10a: the survey run's `done`, through the real routes (signed Ed25519 requests), the real lease facades and the real definers (1059). What it proves: a valid answer is one draft and the run stores only its id, every
 * bad answer is `survey_failed` with no row and no text anywhere, and the fences hold (another runner, another account, a stale generation, a repeat).
 */
describe("survey done [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  const signing = generateKeyPairSync("ed25519").privateKey;
  const T0 = Math.floor(Date.now() / 1000) * 1000;
  let A: SeedRefs;
  let key: TestKey;
  let runner: string;
  let facade: RunnerDoneFacade;
  let claims: ReturnType<typeof createRunnerClaimFacade>;
  let deps: RunnerCloudDeps;
  const gitTickets = createRunnerGitTicketFacade(null as never, { signer: null, audience: null });

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    facade = createRunnerDoneFacade(writerPool, { now: () => T0 });
    claims = createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, now: () => T0, randomBetween: (min) => min });
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool, appPool]) await p.end();
  });
  beforeEach(async () => {
    await admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE runtime = 'runner' AND status IN ('running', 'pending')`);
    A = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET execution_mode = 'runner_local', gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [A.repoId]);
    key = newKey();
    runner = await newRunner(A, key);
    deps = { appUserPool: appPool, origin: ORIGIN, failRunnerLeases: null, leases: { ...claims, ...facade, ...gitTickets } };
  });

  async function newRunner(acct: SeedRefs, k: TestKey, capabilities = "{survey_v1}"): Promise<string> {
    const id = await insertRunner(admin, acct.accountId, acct.userId, { jwk: k.jwk, jkt: k.jkt, credentialMode: "api_key", protocolVersion: MACHINE_ONBOARDING_MIN_PROTOCOL });
    await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = '{}' WHERE id = $1", [id, [acct.repoId]]);
    await admin.query("INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, $3)", [id, acct.accountId, capabilities]);
    return id;
  }
  const survey = (acct = A, over: { role?: string; taskKind?: "survey" | "implement"; setupId?: string } = {}) =>
    issueSurveyRun(admin, appPool, { accountId: acct.accountId, userId: acct.userId, repoId: acct.repoId, signing, createdMs: T0 - 5000, expiresMs: T0 + 72 * 3_600_000, ...over });
  const send = (path: string, body: unknown, k = key) => signed(k, path, body);
  const run = (fn: () => Promise<{ status: number; body: unknown }>) => toResponse(fn);
  async function claim(id: string, k = key): Promise<number> {
    const res = await run(() => claimRun(deps, send(CLAIM_PATH, {}, k)));
    const body = res.body as { run_id?: string; lease_generation?: number };
    if (res.status !== 200 || body.run_id !== id) throw new Error(`claim: ${res.status} ${JSON.stringify(res.body)}`);
    return body.lease_generation!;
  }
  const done = (id: string, g: number, extra: object = {}, k = key) => run(() => doneRun(deps, send(donePath(id), { run_id: id, lease_generation: g, ...extra }, k), id));
  const setup = async (id: string) => (await admin.query("SELECT * FROM project_setups WHERE id = $1", [id])).rows[0];
  const draftsOf = async (setupId: string) => (await admin.query("SELECT * FROM project_drafts WHERE setup_id = $1 ORDER BY version", [setupId])).rows;
  const runRow = async (id: string) => (await admin.query("SELECT status, envelope FROM agent_runs WHERE id = $1", [id])).rows[0];
  /** Nothing of an answer is anywhere: not in the run's envelope, its events or the setup. */
  const nowhere = async (id: string, setupId: string, ...needles: string[]) => {
    const dump = JSON.stringify([(await runRow(id)).envelope, (await admin.query("SELECT payload FROM run_events WHERE run_id = $1", [id])).rows, await setup(setupId)]);
    for (const n of needles) expect(dump, n).not.toContain(n);
  };

  it("a valid answer is one draft (survey, version 1, setup_id, every row keep) and the run's envelope is only its id", async () => {
    const { runId, setupId } = await survey();
    const g = await claim(runId);
    const res = await done(runId, g, { agentOutput: DRAFT });
    expect(res.status).toBe(200);
    expect(DoneReply.parse(res.body)).toEqual({ continue: false, outcome: "succeeded", failure_reason: null, pr_number: null });
    const [d, ...rest] = await draftsOf(setupId);
    expect(rest).toEqual([]);
    expect(d).toMatchObject({ source: "survey", version: 1, setup_id: setupId, status: "draft", prd_md: DRAFT.prd_md });
    expect(d.roadmap).toEqual(DRAFT.roadmap.map((r) => ({ ...r, keep: true })));
    expect(await setup(setupId)).toMatchObject({ phase: "plan", state: "ok", survey_run_id: runId });
    expect(await runRow(runId)).toEqual({ status: "succeeded", envelope: { draft_id: d.id } });
    await nowhere(runId, setupId, "DistinctPrdMarker");
  });

  it("a repeated done answers the same and inserts nothing; a second survey on the same repo gets version 2", async () => {
    const { runId, setupId } = await survey();
    const g = await claim(runId);
    const first = await done(runId, g, { agentOutput: DRAFT });
    const again = await done(runId, g, { agentOutput: DRAFT });
    expect(again).toEqual(first);
    expect(await draftsOf(setupId)).toHaveLength(1);
    await admin.query("UPDATE project_setups SET phase = 'done' WHERE id = $1", [setupId]);
    const second = await survey();
    // The first runner was just throttled by the claim route, so the second survey is run by another runner of the account.
    const k2 = newKey();
    await newRunner(A, k2);
    await done(second.runId, await claim(second.runId, k2), { agentOutput: DRAFT }, k2);
    expect((await draftsOf(second.setupId)).map((d) => d.version)).toEqual([2]);
  });

  it("redacts the PRD, each title and each summary before anything is stored", async () => {
    const { runId, setupId } = await survey();
    const g = await claim(runId);
    await done(runId, g, { agentOutput: { v: 1, prd_md: `key ${SECRET}`, roadmap: [{ ...row("A"), title: `t ${SECRET}`, summary: `s ${SECRET}` }] } });
    const [d] = await draftsOf(setupId);
    expect(JSON.stringify(d)).not.toContain(SECRET);
    expect(d.prd_md).toContain("[redacted]");
    await nowhere(runId, setupId, SECRET);
  });

  const BAD: Array<[string, unknown, string]> = [
    ["a duplicate key", { ...DRAFT, roadmap: [row("A"), row("A")] }, "output_invalid"],
    ["an unresolved dependency", { ...DRAFT, roadmap: [row("A", ["Z"])] }, "output_invalid"],
    ["a self dependency", { ...DRAFT, roadmap: [row("A", ["A"])] }, "output_invalid"],
    ["a dependency cycle", { ...DRAFT, roadmap: [row("A", ["B"]), row("B", ["A"])] }, "output_invalid"],
    ["an unknown key", { ...DRAFT, extra: "UnknownKeyMarker" }, "output_invalid"],
    ["an unknown key on a row", { ...DRAFT, roadmap: [{ ...row("A"), keep: true }] }, "output_invalid"],
    ["an oversize PRD", { ...DRAFT, prd_md: `OversizeMarker${"x".repeat(MAX_PRD_BYTES)}` }, "output_too_large"],
    ["no roadmap rows", { ...DRAFT, roadmap: [] }, "output_invalid"],
  ];
  it.each(BAD)("%s: survey_failed, the run failed, no draft and no text of the answer anywhere", async (_label, output, reason) => {
    const { runId, setupId } = await survey();
    const g = await claim(runId);
    const res = await done(runId, g, { agentOutput: output });
    expect(res.status).toBe(200);
    expect(DoneReply.parse(res.body)).toEqual({ continue: false, outcome: "failed", failure_reason: "survey_output_invalid", pr_number: null });
    expect(await draftsOf(setupId)).toEqual([]);
    expect(await setup(setupId)).toMatchObject({ phase: "survey", state: "failed", failure_code: "survey_failed", failure_reason: reason });
    expect(await runRow(runId)).toEqual({ status: "failed", envelope: { code: "survey_failed" } });
    await nowhere(runId, setupId, "DistinctPrdMarker", "UnknownKeyMarker", "OversizeMarker");
  });

  it("an answer with no output is survey_failed / no_output, and every failure reason the cloud writes is in the closed list", async () => {
    const { runId, setupId } = await survey();
    await done(runId, await claim(runId));
    expect(await setup(setupId)).toMatchObject({ state: "failed", failure_code: "survey_failed", failure_reason: "no_output" });
    expect(await runRow(runId)).toEqual({ status: "failed", envelope: { code: "survey_failed" } });
    expect(SURVEY_FAILURE_REASONS).toContain("no_output");
  });

  it("another runner of the account, another account's runner and a stale generation are each refused, and nothing is stored", async () => {
    const { runId, setupId } = await survey();
    const g = await claim(runId);
    const otherKey = newKey();
    await newRunner(A, otherKey);
    const B = await seedAccount(admin, randomUUID());
    const foreignKey = newKey();
    await newRunner(B, foreignKey);
    for (const [label, res] of [["another runner", await done(runId, g, { agentOutput: DRAFT }, otherKey)], ["stale generation", await done(runId, g + 1, { agentOutput: DRAFT })], ["another account", await done(runId, g, { agentOutput: DRAFT }, foreignKey)]] as const) {
      expect([200, 401, 404, 409], label).toContain(res.status);
      if (res.status === 200) expect(DoneReply.safeParse(res.body).success, label).toBe(false);
      if (res.status === 409) expect(StopReply.safeParse(res.body).success, label).toBe(true);
    }
    expect(await draftsOf(setupId)).toEqual([]);
    expect(await setup(setupId)).toMatchObject({ phase: "survey", state: "started" });
    expect((await runRow(runId)).status).toBe("running");
  });

  it("a survey run's agentOutput that reaches the facade without the survey path is refused, never stored as the envelope", async () => {
    const { runId, setupId } = await survey();
    const g = await claim(runId);
    await expect(facade.finishRunnerDone({ accountId: A.accountId, runnerId: runner, runId, leaseGeneration: g, verdict: { outcome: "succeeded", failureReason: null, prNumber: null }, agentOutput: { ...DRAFT } })).rejects.toBeInstanceOf(RunActionInputError);
    expect((await runRow(runId)).status).toBe("running");
    await nowhere(runId, setupId, "DistinctPrdMarker");
  });

  it("a valid answer for a setup that no longer waits for this run ends the run failed with nothing stored", async () => {
    const { runId, setupId } = await survey();
    const g = await claim(runId);
    await admin.query("UPDATE project_setups SET phase = 'install' WHERE id = $1", [setupId]);
    const res = await done(runId, g, { agentOutput: DRAFT });
    expect(DoneReply.parse(res.body)).toEqual({ continue: false, outcome: "failed", failure_reason: "survey_output_invalid", pr_number: null });
    expect(await draftsOf(setupId)).toEqual([]);
    expect(await setup(setupId)).toMatchObject({ phase: "install", state: "started" });
    expect(await runRow(runId)).toEqual({ status: "failed", envelope: { code: "survey_failed" } });
    await nowhere(runId, setupId, "DistinctPrdMarker");
  });

  it("the facade stores only the draft id even when an agentOutput comes with the survey", async () => {
    const { runId, setupId } = await survey();
    const g = await claim(runId);
    const out = await facade.finishRunnerDone({ accountId: A.accountId, runnerId: runner, runId, leaseGeneration: g, verdict: { outcome: "succeeded", failureReason: null, prNumber: null }, agentOutput: { ...DRAFT }, survey: { draft: DRAFT } });
    expect(out.kind).toBe("recorded");
    const [d] = await draftsOf(setupId);
    expect(await runRow(runId)).toEqual({ status: "succeeded", envelope: { draft_id: d.id } });
    await nowhere(runId, setupId, "DistinctPrdMarker");
  });

  it("the role, the capability and the kind: only a runner that listed survey_v1 is offered the run, and the claim's role filter is taskKindOffered", async () => {
    const plain = newKey();
    const without = await newRunner(A, plain, "{}");
    const { runId } = await survey();
    const res = await run(() => claimRun(deps, send(CLAIM_PATH, {}, plain)));
    expect((res.body as { run_id?: string }).run_id).toBeUndefined();
    expect(await claim(runId)).toBeGreaterThan(0);
    expect(without).not.toBe(runner);
    for (const protocol_version of [MACHINE_ONBOARDING_MIN_PROTOCOL, 25]) {
      for (const capabilities of [[], ["survey_v1"], ["project_setup_v1"], ["survey_v1", "wake_v1"]]) {
        const offered = rolesForCapabilities([...RUNNER_ELIGIBLE_ROLES], capabilities).includes(SURVEY_ROLE);
        expect(taskKindOffered("survey", { protocol_version, capabilities }), JSON.stringify(capabilities)).toBe(offered);
      }
    }
  });

});

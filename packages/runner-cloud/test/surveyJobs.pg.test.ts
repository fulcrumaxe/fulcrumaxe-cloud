import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SURVEY_ROLE } from "@fulcrumaxe/runner-protocol";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { RunPullRequestError } from "../src/runPullRequest.js";
import { RunnerHttpError, requestHandoff, startSurvey, type RunnerCloudDeps, type RunPullRequestPort, type SurveyRunPort } from "../src/index.js";
import { harness, type Harness } from "./helpers.js";

const HEAD = "d".repeat(40);
type StartInput = Parameters<SurveyRunPort["startSurveyRun"]>[0];
type StartAnswer = Awaited<ReturnType<SurveyRunPort["startSurveyRun"]>>;

/**
 * [pg] D#845 ON-10b1 (Ruling 88 item 8): the cloud's start of a survey, as the person. Its own first look is the person's tenant transaction on the web login; the worker's start is a fake port that records what it was given
 * (the worker's own start is tested against the real run starter in packages/worker). Every refusal writes nothing and never reaches the port.
 */
describe("startSurvey [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const github = (o: { head?: string | null; fail?: "unavailable" | "refused" } = {}): RunPullRequestPort =>
    ({
      defaultBranch: async () => {
        if (o.fail === "unavailable") throw new RunPullRequestError("unavailable", 503, {});
        if (o.fail === "refused") throw new RunPullRequestError("rejected", 403, {});
        return "main";
      },
      branchState: async () => ({ exists: o.head !== null, headOid: o.head === undefined ? HEAD : o.head, aheadBy: 0, defaultBranch: "main" }),
    }) as unknown as RunPullRequestPort;

  interface Rig {
    f: F2Fixture;
    repoId: string;
    runnerId: string;
    setupId: string;
    calls: StartInput[];
    deps: (over?: Partial<RunnerCloudDeps>) => RunnerCloudDeps;
  }
  async function rig(o: { credential?: "subscription" | "api_key"; registrant?: "o1" | "o2"; engine?: "os_sandbox" | "microvm" | null; place?: boolean; phase?: string; answer?: StartAnswer; visibility?: "private" | "public" | "unknown"; github?: RunPullRequestPort | null; port?: boolean; prior?: boolean } = {}): Promise<Rig> {
    const f = await seedF2(h.admin);
    const repoId = randomUUID();
    await h.admin.query("INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, $2, $3, 'team', 'acme', 'widgets', 'runner_local')", [repoId, f.accountId, Math.floor(Math.random() * 1e12)]);
    const runnerId = await insertRunner(h.admin, f.accountId, f[o.registrant ?? "o1"], { credentialMode: o.credential ?? "api_key" });
    if (o.engine !== null) await h.admin.query("INSERT INTO runner_facts (runner_id, account_id, os, arch, mem_gb_bucket, cpus, sandbox_engine) VALUES ($1, $2, 'linux', 'x64', 16, 8, $3)", [runnerId, f.accountId, o.engine ?? "os_sandbox"]);
    if (o.place !== false) await h.admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'person')", [repoId, f.accountId, runnerId]);
    const setupId = randomUUID();
    await h.admin.query("INSERT INTO project_setups (id, account_id, repo_id, kind, phase, created_by) VALUES ($1, $2, $3, 'existing', $4, $5)", [setupId, f.accountId, repoId, o.phase ?? "survey", f.o1]);
    if (o.prior === true) {
      const run = randomUUID();
      await h.admin.query("INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id) VALUES ($1, $2, $3, 'runner', 'failed', 'runner_local', $4)", [run, f.accountId, SURVEY_ROLE, repoId]);
      await h.admin.query("UPDATE project_setups SET survey_run_id = $2, state = 'failed' WHERE id = $1", [setupId, run]);
    }
    const calls: StartInput[] = [];
    const port: SurveyRunPort = {
      startSurveyRun: async (input) => {
        calls.push(input);
        return o.answer ?? { ok: true, runId: "11111111-1111-4111-8111-111111111111" };
      },
    };
    return {
      f,
      repoId,
      runnerId,
      setupId,
      calls,
      deps: (over = {}) => h.deps({ pullRequests: o.github === undefined ? github() : o.github, repoVisibility: async () => o.visibility ?? "private", surveyRuns: o.port === false ? null : async () => port, ...over }),
    };
  }
  const written = async (r: Rig) => ({
    runs: Number((await h.admin.query("SELECT count(*) FROM agent_runs WHERE account_id = $1", [r.f.accountId])).rows[0].count),
    keys: Number((await h.admin.query("SELECT count(*) FROM agent_run_idempotency_keys WHERE account_id = $1", [r.f.accountId])).rows[0].count),
    setup: (await h.admin.query("SELECT phase, state, survey_run_id, survey_started_at FROM project_setups WHERE id = $1", [r.setupId])).rows[0],
  });
  const as = (r: Rig, userId = r.f.o1) => ({ accountId: r.f.accountId, userId });
  async function refusal(p: Promise<unknown>): Promise<RunnerHttpError> {
    try {
      await p;
    } catch (error) {
      expect(error).toBeInstanceOf(RunnerHttpError);
      return error as RunnerHttpError;
    }
    throw new Error("expected a refusal");
  }
  /** A refusal that wrote nothing and never reached the worker. */
  async function refused(r: Rig, status: number, code: string, over: { who?: string; deps?: RunnerCloudDeps; setupId?: string } = {}): Promise<RunnerHttpError> {
    const before = await written(r);
    const error = await refusal(startSurvey(over.deps ?? r.deps(), as(r, over.who), over.setupId ?? r.setupId));
    expect([error.status, error.code]).toEqual([status, code]);
    expect(await written(r)).toEqual(before);
    expect(r.calls).toEqual([]);
    return error;
  }

  describe("the start", () => {
    it("hands the worker the setup, the repo, the placed machine, the read head and the prior run, as the person, and answers the setup and the run", async () => {
      const r = await rig({ prior: true });
      const prior = (await h.admin.query("SELECT survey_run_id FROM project_setups WHERE id = $1", [r.setupId])).rows[0].survey_run_id;
      const out = await startSurvey(r.deps(), as(r), r.setupId.toUpperCase());
      expect(out).toEqual({ setup_id: r.setupId, run_id: "11111111-1111-4111-8111-111111111111" });
      expect(r.calls).toEqual([{ accountId: r.f.accountId, userId: r.f.o1, setupId: r.setupId, repoId: r.repoId, runnerId: r.runnerId, owner: "acme", name: "widgets", headSha: HEAD, priorRunId: prior }]);
      expect("requiresEngine" in r.calls[0]!).toBe(false);
    });

    it("an admin may start it, and a machine whose engine is microvm asks for it; one that never reported an engine asks for none", async () => {
      const vm = await rig({ engine: "microvm" });
      await startSurvey(vm.deps(), as(vm, vm.f.a1), vm.setupId);
      expect(vm.calls[0]).toMatchObject({ userId: vm.f.a1, requiresEngine: "microvm" });
      const none = await rig({ engine: null });
      await startSurvey(none.deps(), as(none), none.setupId);
      expect("requiresEngine" in none.calls[0]!).toBe(false);
    });

    it("the machine is this repo's placement, not another machine of the account that holds a second project", async () => {
      const r = await rig();
      const second = randomUUID();
      await h.admin.query("INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, $2, $3, 'team', 'acme', 'other', 'runner_local')", [second, r.f.accountId, Math.floor(Math.random() * 1e12)]);
      const other = await insertRunner(h.admin, r.f.accountId, r.f.o1, { credentialMode: "api_key" });
      await h.admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'person')", [second, r.f.accountId, other]);
      await startSurvey(r.deps(), as(r), r.setupId);
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]).toMatchObject({ repoId: r.repoId, runnerId: r.runnerId });
      expect(r.calls[0]!.runnerId).not.toBe(other);
    });

    it("a subscription machine registered by the person themselves is fine; an API-key machine registered by someone else is fine too", async () => {
      const own = await rig({ credential: "subscription", registrant: "o1" });
      await startSurvey(own.deps(), as(own), own.setupId);
      expect(own.calls).toHaveLength(1);
      const keyed = await rig({ credential: "api_key", registrant: "o2" });
      await startSurvey(keyed.deps(), as(keyed), keyed.setupId);
      expect(keyed.calls).toHaveLength(1);
    });
  });

  describe("every refusal writes nothing and never reaches the worker", () => {
    it("403 for a member", async () => {
      const r = await rig();
      await refused(r, 403, "forbidden", { who: r.f.m1 });
    });
    it("403 for a user who is not in the account at all", async () => {
      const r = await rig();
      const stranger = await rig();
      await refused(r, 403, "forbidden", { who: stranger.f.o1 });
    });
    it("404 for a setup that does not exist, for a malformed id, and for another account's setup", async () => {
      const r = await rig();
      const other = await rig();
      await refused(r, 404, "not_found", { setupId: randomUUID() });
      await refused(r, 404, "not_found", { setupId: "x" });
      await refused(r, 404, "not_found", { setupId: other.setupId });
      expect(other.calls).toEqual([]);
    });
    it("404 for another account's setup even through a client that bypasses row security (the predicates name the account)", async () => {
      const r = await rig();
      const other = await rig();
      const error = await refusal(startSurvey(r.deps({ appUserPool: h.adminPool }), as(r), other.setupId));
      expect([error.status, error.code]).toEqual([404, "not_found"]);
      expect(r.calls).toEqual([]);
      expect(other.calls).toEqual([]);
    });
    it("409 setup_phase when the setup is past the survey step", async () => {
      for (const phase of ["plan", "install", "done"]) await refused(await rig({ phase }), 409, "setup_phase");
    });
    it("409 setup_not_placed when the repo has no machine, and when its machine was revoked", async () => {
      await refused(await rig({ place: false }), 409, "setup_not_placed");
      const r = await rig();
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [r.runnerId]);
      await refused(r, 409, "setup_not_placed");
    });
    it("409 survey_needs_machine_owner when the machine's Claude login is a subscription registered by someone else", async () => {
      const r = await rig({ credential: "subscription", registrant: "o2" });
      await refused(r, 409, "survey_needs_machine_owner");
    });
    it("409 public_repo and repo_visibility_unknown", async () => {
      await refused(await rig({ visibility: "public" }), 409, "public_repo");
      await refused(await rig({ visibility: "unknown" }), 409, "repo_visibility_unknown");
    });
    it("409 default_branch_empty, 503 github_unavailable and 502 github_refused", async () => {
      await refused(await rig({ github: github({ head: null }) }), 409, "default_branch_empty");
      await refused(await rig({ github: github({ fail: "unavailable" }) }), 503, "github_unavailable");
      await refused(await rig({ github: github({ fail: "refused" }) }), 502, "github_refused");
    });
    it("503 not_configured when the worker port, the port's worker or GitHub's port is missing, before anything is read", async () => {
      await refused(await rig({ port: false }), 503, "not_configured");
      const r = await rig();
      await refused(r, 503, "not_configured", { deps: r.deps({ surveyRuns: async () => null }) });
      const g = await rig({ github: null });
      await refused(g, 503, "not_configured");
    });
  });

  describe("what the worker answers", () => {
    it.each([
      [{ ok: false, status: 403, code: "forbidden" } as const, 403, "forbidden", {}],
      [{ ok: false, status: 409, code: "survey_running", runId: "22222222-2222-4222-8222-222222222222" } as const, 409, "survey_running", { run_id: "22222222-2222-4222-8222-222222222222" }],
      [{ ok: false, status: 409, code: "survey_not_started", reason: "model_budget_unset" } as const, 409, "survey_not_started", { reason: "model_budget_unset" }],
      [{ ok: false, status: 500, code: "internal" } as const, 500, "internal", {}],
    ])("%j becomes %i %s", async (answer, status, code, extra) => {
      const r = await rig({ answer });
      const error = await refusal(startSurvey(r.deps(), as(r), r.setupId));
      expect([error.status, error.code, error.extra]).toEqual([status, code, extra]);
      expect(r.calls).toHaveLength(1);
    });
  });

  describe("a survey run is never handed off", () => {
    it("a running survey run has no work item, so moving it is 409 run_not_movable and nothing is changed", async () => {
      const r = await rig();
      const runId = randomUUID();
      await h.admin.query("INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id, runner_id) VALUES ($1, $2, $3, 'runner', 'running', 'runner_local', $4, $5)", [runId, r.f.accountId, SURVEY_ROLE, r.repoId, r.runnerId]);
      for (const to of ["cloud", "runner"]) {
        const error = await refusal(requestHandoff({ appUserPool: h.appPool, runnerJobsConfigured: () => true, repoVisibility: async () => "private" }, as(r), runId, to));
        expect([error.status, error.code]).toEqual([409, "run_not_movable"]);
      }
      expect((await h.admin.query("SELECT status FROM agent_runs WHERE id = $1", [runId])).rows[0].status).toBe("running");
      expect((await h.admin.query("SELECT count(*) FROM run_handoffs WHERE run_id = $1", [runId])).rows[0].count).toBe("0");
    });
  });
});

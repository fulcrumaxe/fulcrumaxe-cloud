import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { listDriverEvents } from "@fx/core/src/work-items/driverEvents.js";
import type { GitHubHttp } from "../../src/build/githubMergePort.js";
import { createCiGate, type CiGate } from "../../src/review/ciWait.js";
import { readPublicPullRequest } from "../../src/review/publicPullRequest.js";
import { recordRound } from "../../src/review/roundDecision.js";
import { discussingItem } from "../plan/helpers/panelFixtures.js";
import { createFakeExecutionTarget } from "../build/helpers/fakeExecutionTarget.js";
import { seedAccount, seedRepo } from "../build/helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { fakeGitHubRest, freshRepo, type FakeRepoState } from "./helpers/fakeGitHubRest.js";
import { fakeGitHubLocal } from "./helpers/fakeGitHubLocal.js";
import { startMergeTlsGitHub, type MergeTlsGitHub } from "./helpers/fakeGitHubMergeTls.js";

/**
 * D#598 P7b [pg]: a verdict is not recorded while the head's CI or a repo-wide guard is still running.
 *
 * Real Postgres (work items, reviewer runs, transitions), and the CI read goes through the real GitHub port: once over the REST fake that
 * answers like the real API (fakeGitHubRest.ts), once over a strict TLS server (fakeGitHubMergeTls.ts) so the request goes through Node's
 * real connection path with the headers GitHub demands. Everything is a fixture customer repository: another owner and name than ours, a
 * single plane, no pairing, no setting of any kind.
 *
 * Not faked faithfully (said in the PR): how long GitHub takes to start a check after a push, and rate limits. A test moves time by changing
 * the fake's state between two calls.
 */
const h = pgHarness();
const HEAD = "a".repeat(40);
const PR = 41;
const registry = { sandbox: createFakeExecutionTarget().target };
const REQUIRED = ["code-reviewer", "acceptance-tester"] as const;

interface World {
  accountId: string;
  workItemId: string;
  gh: FakeRepoState;
}

async function world(over: { owner?: string; name?: string; repo?: Partial<FakeRepoState> } = {}): Promise<World> {
  const accountId = randomUUID();
  const repoId = randomUUID();
  const owner = over.owner ?? "customer-co";
  const name = over.name ?? "storefront";
  await seedAccount(h.admin, accountId);
  await seedRepo(h.admin, accountId, repoId);
  await h.admin.query("UPDATE repos SET gh_owner = $2, gh_name = $3 WHERE id = $1", [repoId, owner, name]);
  const { workItemId } = await discussingItem(h.runWriterPool, accountId, { title: "Add a footer", body: "Show the year in the footer.", category: "feature", repoId });
  await h.admin.query("UPDATE work_items SET gh_number = 7, repo_id = $2, stage = 'pr_opened', provenance = 'internal' WHERE id = $1", [workItemId, repoId]);
  const body = "1. The footer shows the year.";
  await h.admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, $3, $4, 'system')", [accountId, workItemId, body, createHash("sha256").update(body).digest("hex")]);
  return { accountId, workItemId, gh: freshRepo({ owner, name, prNumber: PR, headSha: HEAD, checks: { [HEAD]: [] }, ...over.repo }) };
}

async function verdicts(w: World, spec: Array<["code-reviewer" | "acceptance-tester", "pass" | "needs-fix"]>) {
  const out = [];
  for (const [role, verdict] of spec) {
    const id = randomUUID();
    await h.admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, envelope, head_sha) VALUES ($1, $2, $3, $4, 'production', 'succeeded', $5::jsonb, $6)", [id, w.accountId, w.workItemId, role, JSON.stringify({ verdict }), HEAD]);
    out.push({ role, verdict, runId: id });
  }
  return out;
}

const gateOver = (w: World, http: GitHubHttp = fakeGitHubRest(w.gh)): CiGate => createCiGate({ pool: h.runWriterPool, openHttp: async () => http });
const record = async (w: World, spec: Array<["code-reviewer" | "acceptance-tester", "pass" | "needs-fix"]>, gate: CiGate = gateOver(w), prNumber = PR) =>
  recordRound(h.runWriterPool, registry, { accountId: w.accountId, workItemId: w.workItemId, headSha: HEAD, prNumber, requiredRoles: REQUIRED, verdicts: await verdicts(w, spec) }, gate);
const stageOf = async (w: World) => (await h.admin.query<{ stage: string }>("SELECT stage FROM work_items WHERE account_id = $1 AND id = $2", [w.accountId, w.workItemId])).rows[0]!.stage;
const transitions = async (w: World) => (await h.admin.query("SELECT to_stage FROM work_item_transitions WHERE work_item_id = $1 AND to_stage IN ('changes_requested', 'review_passed')", [w.workItemId])).rows;
const verdictEvents = async (w: World) => (await withTenant(h.runWriterPool, w.accountId, (c) => listDriverEvents(c, w.workItemId))).filter((e) => e.kind === "review_verdicts");
const PASS_BOTH: Array<["code-reviewer" | "acceptance-tester", "pass"]> = [["code-reviewer", "pass"], ["acceptance-tester", "pass"]];

/** Nothing of the round reached the database: no stage change, no transition, no verdict event. */
async function expectNothingRecorded(w: World) {
  expect(await stageOf(w)).toBe("pr_opened");
  expect(await transitions(w)).toEqual([]);
  expect(await verdictEvents(w)).toEqual([]);
}

describe("a pass recorded while CI is running", () => {
  it("is refused: ci_pending, nothing recorded, and the item stays at pr_opened", async () => {
    const w = await world({ repo: { checks: { [HEAD]: [{ name: "build", status: "in_progress", conclusion: null }] } } });
    const out = await record(w, PASS_BOTH);
    expect(out).toMatchObject({ decision: "ci_pending", recorded: [], ciReasons: ["check_running"] });
    await expectNothingRecorded(w);
  });

  it("is recorded after CI turns green: the same verdicts, asked again, all_passed and review_passed", async () => {
    const w = await world({ repo: { checks: { [HEAD]: [{ name: "build", status: "queued", conclusion: null }] } } });
    const input = await verdicts(w, [["code-reviewer", "pass"], ["acceptance-tester", "pass"]]);
    const ask = () => recordRound(h.runWriterPool, registry, { accountId: w.accountId, workItemId: w.workItemId, headSha: HEAD, prNumber: PR, requiredRoles: REQUIRED, verdicts: input }, gateOver(w));
    expect((await ask()).decision).toBe("ci_pending");
    await expectNothingRecorded(w);
    w.gh.checks[HEAD] = [{ name: "build", status: "completed", conclusion: "success" }];
    const out = await ask();
    expect(out.decision).toBe("all_passed");
    expect(await stageOf(w)).toBe("review_passed");
    expect(await verdictEvents(w)).toHaveLength(1);
  });

  it("a needs-fix is a verdict too: it is not recorded while CI runs, and starts the fix round decision once CI finishes", async () => {
    const w = await world({ repo: { checks: { [HEAD]: [{ name: "build", status: "in_progress", conclusion: null }] } } });
    const spec: Array<["code-reviewer" | "acceptance-tester", "pass" | "needs-fix"]> = [["code-reviewer", "needs-fix"], ["acceptance-tester", "pass"]];
    expect((await record(w, spec)).decision).toBe("ci_pending");
    await expectNothingRecorded(w);
    w.gh.checks[HEAD] = [{ name: "build", status: "completed", conclusion: "success" }];
    expect((await record(w, spec)).decision).toBe("fix");
    expect(await stageOf(w)).toBe("changes_requested");
  });

  it("is recorded straight away when CI has already finished green", async () => {
    const w = await world({ repo: { checks: { [HEAD]: [{ name: "build", status: "completed", conclusion: "success" }] } } });
    expect((await record(w, PASS_BOTH)).decision).toBe("all_passed");
    expect(await stageOf(w)).toBe("review_passed");
  });

  it("a repository with no CI at all has nothing to wait for", async () => {
    const w = await world();
    expect((await record(w, PASS_BOTH)).decision).toBe("all_passed");
  });

  it("a check that finished red is a finished signal: the verdicts are recorded as given (the merge gate is what refuses a red head)", async () => {
    const w = await world({ repo: { checks: { [HEAD]: [{ name: "build", status: "completed", conclusion: "failure" }] } } });
    expect((await record(w, PASS_BOTH)).decision).toBe("all_passed");
  });
});

describe("a repo-wide guard that has not run yet", () => {
  const GUARDS = ["telemetry-error-codes", "audit-log-guard"];

  it("the base branch requires guards that have not appeared on the head: pending until each has reported", async () => {
    const w = await world({ repo: { requiredContexts: GUARDS, checks: { [HEAD]: [{ name: "build", status: "completed", conclusion: "success" }] } } });
    expect(await record(w, PASS_BOTH)).toMatchObject({ decision: "ci_pending", ciReasons: ["required_missing"] });
    await expectNothingRecorded(w);
    // One guard reports; the other has not started.
    w.gh.checks[HEAD]!.push({ name: "telemetry-error-codes", status: "completed", conclusion: "success" });
    expect((await record(w, PASS_BOTH)).decision).toBe("ci_pending");
    // The last guard is running, then done.
    w.gh.checks[HEAD]!.push({ name: "audit-log-guard", status: "in_progress", conclusion: null });
    expect(await record(w, PASS_BOTH)).toMatchObject({ decision: "ci_pending", ciReasons: ["check_running"] });
    w.gh.checks[HEAD]![2] = { name: "audit-log-guard", status: "completed", conclusion: "success" };
    expect((await record(w, PASS_BOTH)).decision).toBe("all_passed");
  });

  it("a guard reported as a commit status counts the same", async () => {
    const w = await world({ repo: { requiredContexts: ["legacy/guard"], statuses: { [HEAD]: { "legacy/guard": "pending" } } } });
    expect(await record(w, PASS_BOTH)).toMatchObject({ decision: "ci_pending", ciReasons: ["status_pending"] });
    w.gh.statuses[HEAD]!["legacy/guard"] = "success";
    expect((await record(w, PASS_BOTH)).decision).toBe("all_passed");
  });
});

describe("the wait needs GitHub's answer", () => {
  it("an unreadable CI state (GitHub 500) throws and records nothing; it is never read as settled", async () => {
    const w = await world();
    const broken: GitHubHttp = { request: async (req) => (req.path.includes("/check-runs") ? { status: 500, body: { message: "Server Error" } } : fakeGitHubRest(w.gh).request(req)) };
    await expect(record(w, PASS_BOTH, gateOver(w, broken))).rejects.toThrow();
    await expectNothingRecorded(w);
  });

  it("a head that is not a full sha is refused before any call", async () => {
    const w = await world();
    await expect(gateOver(w).read({ accountId: w.accountId, workItemId: w.workItemId, prNumber: PR, headSha: "main" })).rejects.toThrow();
    expect(w.gh.requests).toEqual([]);
  });
});

describe("every account's runs (D#598 C1 section 2 item 3), on a fixture customer repository", () => {
  it("another owner and name, no pairing, no setting: the same refusal and the same record, with no change to the repo row beyond its coordinates", async () => {
    const w = await world({ owner: "some-shop", name: "web", repo: { checks: { [HEAD]: [{ name: "ci", status: "in_progress", conclusion: null }] } } });
    expect((await record(w, PASS_BOTH)).decision).toBe("ci_pending");
    w.gh.checks[HEAD] = [{ name: "ci", status: "completed", conclusion: "success" }];
    expect((await record(w, PASS_BOTH)).decision).toBe("all_passed");
    // The reads went to the customer's own repository.
    expect(w.gh.requests.every((r) => r.path.startsWith("/repos/some-shop/web/"))).toBe(true);
  });
});

describe("through Node's real connection path (TLS, User-Agent, API version and bearer checked by the server)", () => {
  const open: MergeTlsGitHub[] = [];
  afterEach(async () => {
    while (open.length > 0) await open.pop()!.close();
  });

  it("check runs in progress: pending; completed: recorded; the server saw the check-runs and status reads of the head", async () => {
    const w = await world({ owner: "acme", name: "widgets" });
    const g = await startMergeTlsGitHub({ prNumber: 7, headSha: HEAD, checkRuns: [{ name: "build", status: "in_progress", conclusion: null }, { name: "audit-log-guard", status: "queued", conclusion: null }] });
    open.push(g);
    await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = (SELECT repo_id FROM work_items WHERE id = $1)", [w.workItemId]);
    const gate = gateOver(w, g.http);
    expect((await record(w, PASS_BOTH, gate, 7)).decision).toBe("ci_pending");
    await expectNothingRecorded(w);
    g.world.checkRuns = [{ name: "build", status: "completed", conclusion: "success" }, { name: "audit-log-guard", status: "completed", conclusion: "success" }];
    expect((await record(w, PASS_BOTH, gate, 7)).decision).toBe("all_passed");
    const paths = g.world.calls.map((c) => c.path);
    expect(paths).toContain(`/repos/acme/widgets/commits/${HEAD}/check-runs`);
    expect(paths).toContain(`/repos/acme/widgets/commits/${HEAD}/status`);
  });

  it("a commit status still pending over TLS holds the verdict back too", async () => {
    const w = await world({ owner: "acme", name: "widgets" });
    const g = await startMergeTlsGitHub({ prNumber: 7, headSha: HEAD, checkNames: [], statuses: { "ci/legacy": "pending" } });
    open.push(g);
    expect((await record(w, PASS_BOTH, gateOver(w, g.http), 7)).decision).toBe("ci_pending");
    g.world.statuses = { "ci/legacy": "success" };
    expect((await record(w, PASS_BOTH, gateOver(w, g.http), 7)).decision).toBe("all_passed");
  });
});

// ---- Fix round 1 on #325: a moved head is its own answer ----------------------------------------------------------------------

const MOVED = "b".repeat(40);
const RUN_BRANCH = "fx/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g1";

/** A runner_local world: the run recorded its pull request and branch with its `done`, as the review port reads them. */
async function localWorld(repo: Partial<FakeRepoState> = {}): Promise<World> {
  const w = await world({ repo: { runBranch: RUN_BRANCH, ...repo } });
  await h.admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = (SELECT repo_id FROM work_items WHERE id = $1)", [w.workItemId]);
  const executor = randomUUID();
  await h.admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode) VALUES ($1, $2, $3, 'executor', 'runner', 'succeeded', 'runner_local')", [executor, w.accountId, w.workItemId]);
  await h.admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'run.status_changed', $3::jsonb)", [w.accountId, executor, JSON.stringify({ from: "running", to: "succeeded", viaRunnerDone: true, prNumber: PR, branch: RUN_BRANCH })]);
  return w;
}
const localGate = (w: World): CiGate => createCiGate({ pool: h.runWriterPool, openHttp: async () => fakeGitHubLocal(w.gh).http });

describe("a push to the pull request while the reviewers ran (the head moved)", () => {
  it("runner_local: the CommitChecks read follows the PR's last commit, so a moved head answers head_moved at once: nothing recorded, no wait", async () => {
    // The reviewers judged HEAD; the pull request's last commit is now MOVED, whose checks are still running.
    const w = await localWorld({ headSha: MOVED, checks: { [HEAD]: [], [MOVED]: [{ name: "build", status: "in_progress", conclusion: null }] } });
    const out = await record(w, PASS_BOTH, localGate(w));
    expect(out).toMatchObject({ decision: "head_moved", recorded: [] });
    expect(out.ciReasons).toBeUndefined();
    await expectNothingRecorded(w);
  });

  it("runner_local: a needs-fix on the old head is not recorded either", async () => {
    const w = await localWorld({ headSha: MOVED, checks: { [MOVED]: [] } });
    expect((await record(w, [["code-reviewer", "needs-fix"], ["acceptance-tester", "pass"]], localGate(w))).decision).toBe("head_moved");
    await expectNothingRecorded(w);
  });

  it("runner_local: when the head has not moved the wait is as before (running: ci_pending; finished: recorded)", async () => {
    const w = await localWorld({ checks: { [HEAD]: [{ name: "build", status: "queued", conclusion: null }] } });
    expect((await record(w, PASS_BOTH, localGate(w))).decision).toBe("ci_pending");
    w.gh.checks[HEAD] = [{ name: "build", status: "completed", conclusion: "success" }];
    expect((await record(w, PASS_BOTH, localGate(w))).decision).toBe("all_passed");
  });

  it("sandbox: the read is of the reviewed sha's own checks, so the behaviour is unchanged (the verdicts are recorded; the merge gate's head_moved sends the driver back later)", async () => {
    const w = await world({ repo: { headSha: MOVED, checks: { [HEAD]: [{ name: "build", status: "completed", conclusion: "success" }], [MOVED]: [{ name: "build", status: "in_progress", conclusion: null }] } } });
    expect((await record(w, PASS_BOTH)).decision).toBe("all_passed");
  });

  it("sandbox: the reviewed sha's own checks still running keep the wait (ci_pending), whatever the PR's head is", async () => {
    const w = await world({ repo: { headSha: MOVED, checks: { [HEAD]: [{ name: "build", status: "in_progress", conclusion: null }], [MOVED]: [] } } });
    expect((await record(w, PASS_BOTH)).decision).toBe("ci_pending");
    await expectNothingRecorded(w);
  });
});

/**
 * Two planes: a paired item has a private pull request (reviewed) and a public one on the code repository (the one that merges, with the real CI).
 * The wait reads the public one. Both repositories are fakes that answer like GitHub (fakeGitHubRest.ts), and each opener refuses any coordinates
 * but the expected ones, so a wait that read the private repository's copy, or guessed the code repository, fails here.
 */
describe("a paired item: the wait reads the public pull request's CI", () => {
  const PUB_HEAD = "c".repeat(40);
  const PUB_PR = 12;
  const PUB_REPO = { owner: "customer-co", name: "storefront-public" };
  const green = [{ name: "build", status: "completed", conclusion: "success" }];

  async function pairedWorld(opts: { priv?: FakeRepoState["checks"]; pub?: FakeRepoState["checks"]; prNumber?: number | null; stamp?: string | null; state?: string; managed?: boolean; pubHead?: string; pairing?: boolean; pairedWith?: string; local?: boolean }) {
    const privChecks = opts.priv ?? { [HEAD]: [{ name: "build", status: "queued", conclusion: null }] };
    const w = opts.local === true ? await localWorld({ checks: privChecks }) : await world({ repo: { checks: privChecks } });
    const pubHead = opts.pubHead ?? PUB_HEAD;
    const pub = freshRepo({ ...PUB_REPO, prNumber: PUB_PR, headSha: pubHead, checks: opts.pub ?? { [pubHead]: green } });
    const repoId = (await h.admin.query<{ repo_id: string }>("SELECT repo_id FROM work_items WHERE id = $1", [w.workItemId])).rows[0]!.repo_id;
    if (opts.pairing !== false) await h.admin.query("INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, $3, ARRAY['.autonomous-team/**'])", [repoId, w.accountId, opts.pairedWith ?? "customer-co/storefront-public"]);
    const withPr = opts.prNumber !== null;
    const stamp = opts.stamp === undefined ? PUB_HEAD : opts.stamp;
    await h.admin.query(
      `INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest, state${withPr ? ", head_sha, tip_sha, pr_number, pr_url" : ""}${opts.managed ? ", managed_by_person_at" : ""})
       VALUES ($1, $2, $3, 'customer-co/storefront-public', $4, ${withPr ? `'${opts.state ?? "pr_opened"}', $5, $5, $6, $7` : "'building'"}${opts.managed ? ", now()" : ""})`,
      withPr ? [w.accountId, w.workItemId, repoId, "a".repeat(64), stamp, opts.prNumber ?? PUB_PR, `https://github.com/customer-co/storefront-public/pull/${opts.prNumber ?? PUB_PR}`] : [w.accountId, w.workItemId, repoId, "a".repeat(64)],
    );
    const opened: string[] = [];
    const privHttp = opts.local === true ? fakeGitHubLocal(w.gh).http : fakeGitHubRest(w.gh);
    const pubHttp = fakeGitHubRest(pub);
    const gate = createCiGate({
      pool: h.runWriterPool,
      publicPullRequest: readPublicPullRequest(h.runWriterPool),
      openHttp: async (c) => {
        expect(`${c.owner}/${c.name}`).toBe("customer-co/storefront");
        opened.push("private");
        return privHttp;
      },
      openPublicHttp: async (c) => {
        expect(`${c.owner}/${c.name}`).toBe("customer-co/storefront-public");
        expect(c.repoId).toBe(repoId);
        opened.push("public");
        return pubHttp;
      },
    });
    return { w, pub, gate, opened };
  }

  it("the private copy's CI never finishes but the public one is green: the round proceeds and the pass is recorded", async () => {
    const t = await pairedWorld({});
    const out = await record(t.w, PASS_BOTH, t.gate);
    expect(out.decision).toBe("all_passed");
    expect(await stageOf(t.w)).toBe("review_passed");
    expect(t.opened).toEqual(["public"]);
    // Nothing was asked of the private repository's pull request or checks.
    expect(t.w.gh.requests).toEqual([]);
  });

  it("the public CI still running: ci_pending, nothing recorded, even though the private copy is green", async () => {
    const t = await pairedWorld({ priv: { [HEAD]: green }, pub: { [PUB_HEAD]: [{ name: "build", status: "in_progress", conclusion: null }] } });
    expect(await record(t.w, PASS_BOTH, t.gate)).toMatchObject({ decision: "ci_pending", recorded: [], ciReasons: ["check_running"] });
    await expectNothingRecorded(t.w);
    // It finishes: the same verdicts, asked again, are recorded.
    t.pub.checks[PUB_HEAD] = green;
    expect((await record(t.w, PASS_BOTH, t.gate)).decision).toBe("all_passed");
  });

  it("a required guard missing on the public head keeps the wait", async () => {
    const t = await pairedWorld({});
    t.pub.requiredContexts = ["audit-log-guard"];
    expect(await record(t.w, PASS_BOTH, t.gate)).toMatchObject({ decision: "ci_pending", ciReasons: ["required_missing"] });
  });

  it("a public check that finished red is a finished signal, as on a single plane (the merge gate refuses a red head)", async () => {
    const t = await pairedWorld({ pub: { [PUB_HEAD]: [{ name: "build", status: "completed", conclusion: "failure" }] } });
    expect((await record(t.w, PASS_BOTH, t.gate)).decision).toBe("all_passed");
  });

  it("a public head that is not the one the platform pushed is a wait (wrong_head), unless a person took the branch over", async () => {
    const moved = "d".repeat(40);
    const t = await pairedWorld({ pubHead: moved, pub: { [moved]: green } });
    expect(await record(t.w, PASS_BOTH, t.gate)).toMatchObject({ decision: "ci_pending", ciReasons: ["wrong_head"] });
    await expectNothingRecorded(t.w);
    const mine = await pairedWorld({ pubHead: moved, pub: { [moved]: green }, managed: true });
    expect((await record(mine.w, PASS_BOTH, mine.gate)).decision).toBe("all_passed");
  });

  it("the public pull request is not open yet: the private copy is read, as before", async () => {
    const t = await pairedWorld({ prNumber: null });
    expect((await record(t.w, PASS_BOTH, t.gate)).decision).toBe("ci_pending");
    expect(t.opened).toEqual(["private"]);
  });

  it("the public pull request is already merged: the private copy is read, as before", async () => {
    const t = await pairedWorld({ state: "pr_merged" });
    expect((await record(t.w, PASS_BOTH, t.gate)).decision).toBe("ci_pending");
    expect(t.opened).toEqual(["private"]);
  });

  it("a pairing that was cleared returns the item to the single-repository read", async () => {
    const t = await pairedWorld({ pairing: false });
    expect((await record(t.w, PASS_BOTH, t.gate)).decision).toBe("ci_pending");
    expect(t.opened).toEqual(["private"]);
  });

  it("a paired runner_local item keeps the private read through the local-only client; the public client is never opened", async () => {
    const t = await pairedWorld({ local: true });
    expect((await record(t.w, PASS_BOTH, t.gate)).decision).toBe("ci_pending");
    expect(t.opened).toEqual(["private"]);
  });

  it("a stale pairing that names another code repository does not match the push record: the private copy is read", async () => {
    const t = await pairedWorld({ pairedWith: "other-co/elsewhere" });
    expect((await record(t.w, PASS_BOTH, t.gate)).decision).toBe("ci_pending");
    expect(t.opened).toEqual(["private"]);
  });

  it("a single-plane item is unchanged, with a public opener wired", async () => {
    const w = await world({ repo: { checks: { [HEAD]: [{ name: "build", status: "queued", conclusion: null }] } } });
    const calls: string[] = [];
    const gate = createCiGate({
      pool: h.runWriterPool,
      publicPullRequest: readPublicPullRequest(h.runWriterPool),
      openHttp: async () => fakeGitHubRest(w.gh),
      openPublicHttp: async () => {
        calls.push("public");
        throw new Error("must not open");
      },
    });
    expect((await record(w, PASS_BOTH, gate)).decision).toBe("ci_pending");
    w.gh.checks[HEAD] = green;
    expect((await record(w, PASS_BOTH, gate)).decision).toBe("all_passed");
    expect(calls).toEqual([]);
  });

  it("a failed public read throws and records nothing (the step retries), never falling back to the private copy", async () => {
    const t = await pairedWorld({ priv: { [HEAD]: green } });
    const gate = createCiGate({ pool: h.runWriterPool, publicPullRequest: readPublicPullRequest(h.runWriterPool), openHttp: async () => fakeGitHubRest(t.w.gh), openPublicHttp: async () => ({ request: async () => ({ status: 500, body: { message: "Server Error" } }) }) });
    await expect(record(t.w, PASS_BOTH, gate)).rejects.toThrow();
    await expectNothingRecorded(t.w);
  });
});

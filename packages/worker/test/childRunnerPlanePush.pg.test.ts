import { sandboxRunBranch } from "@fx/core/src/work-items/buildIdentity.js";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PLANE_PUSH_REPORT_PATH, PLANE_PUSH_TOKEN_PATH, PlanePushTokenReply, sha256Text, signJob, type Job } from "@fulcrumaxe/runner-protocol";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { plannedFixture, reapprove, type PlannedFixture } from "@fx/db/test/helpers/plannedChildren.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { stampPlanePush } from "@fx/core/src/repos/planePushRecord.js";
import { applyMappedEvent, mapEvent, type GithubPullRequestPayload } from "@fx/github";
import { planePushReportRun, planePushTokenRun, toResponse, type PlanePushHostedPort, type RunnerCloudDeps, type RunnerLeaseOps } from "@fx/runner-cloud";
import { createRunnerClaimFacade } from "../src/runnerClaims.js";
import { createRunnerPlanePushFacade } from "../src/runnerPlanePush.js";
import { ORIGIN, newKey, signed, type TestKey } from "../../runner-cloud/test/helpers.js";

/**
 * [pg] D#483 S5-b2c-4, acceptance 8: a planned PR child on a repository paired with a public one, built by a runner. The plane-push grant renders the pairing's footer with the PARENT's number under the
 * keyword rule, the body references the parent and never closes it, the report records the code-plane pull request once the hosted side confirmed it, and the public pull request maps to the child.
 * The routes, the worker's methods and the database are real (the real fence, real run rows, real `plane_pushes`); GitHub is the recording stand-in the sibling test (planePush.pg.test.ts) uses, whose
 * real calls are exercised over TLS in packages/github/test/planePushHosted.test.ts and in childPairedPublish.pg.test.ts.
 */
describe("a planned PR child's runner plane push [pg]", { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  const signing = generateKeyPairSync("ed25519").privateKey;
  const T0 = Math.floor(Date.now() / 1000) * 1000;
  const clock = T0;
  let claims: ReturnType<typeof createRunnerClaimFacade>;
  let key: TestKey;
  const HEAD = "a".repeat(40);
  const TIP = "b".repeat(40);
  const TOKEN = ["g", "hs", "w".repeat(36)].join("_"); // gitleaks:allow
  const github = { pr: { url: "https://github.com/acme/widgets-public/pull/9" } as { url: string } | null };
  const port: PlanePushHostedPort = {
    mintToken: async () => ({ token: TOKEN, expiresAt: new Date(clock + 55 * 60_000) }),
    verifyPushed: async () => true,
    verifyPullRequest: async () => github.pr,
    revokeToken: async () => true,
  };
  const facade = () => createRunnerPlanePushFacade(writerPool, { now: () => clock });
  const deps = (): RunnerCloudDeps =>
    ({ appUserPool: appPool, origin: ORIGIN, failRunnerLeases: null, leases: { ...claims, ...facade() } as unknown as RunnerLeaseOps, planePush: port, planePushIdentity: () => ({ name: "Fulcrumaxe Bot", email: "bot@example.com" }), now: () => new Date(clock) }) as RunnerCloudDeps;
  const created = () => Math.floor(clock / 1000);
  const askToken = (run: { id: string; generation: number }) => toResponse(() => planePushTokenRun(deps(), signed(key, PLANE_PUSH_TOKEN_PATH, { run_id: run.id, lease_generation: run.generation }, { created: created() })));

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    claims = createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, now: () => clock, randomBetween: (min) => min });
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool, appPool]) await p.end();
  });
  beforeEach(async () => {
    await admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE runtime = 'runner' AND status IN ('running', 'pending')`);
    key = newKey();
  });

  /** A parent with an approved Spec and its children on a paired runner repository; the child `api` has a stamped push record. A held executor run of the child, with a real signed job. */
  async function runnerChild(footer: string | null): Promise<{ f: PlannedFixture; child: string; run: { id: string; generation: number }; row: { id: string; branch: string } }> {
    const f = await plannedFixture(admin, appPool, { dial: null, weeklyUsd: null });
    await admin.query("UPDATE repos SET execution_mode = 'runner_local', gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [f.t.repoId]);
    await admin.query("UPDATE work_items SET gh_number = 41, stage = 'in_progress' WHERE id = $1", [f.parent]);
    await admin.query(`INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs, pr_footer) VALUES ($1, $2, 'acme/widgets-public', ARRAY['docs/ops/'], $3)`, [f.t.repoId, f.t.accountId, footer]);
    const child = f.kids["api"]!;
    await admin.query("UPDATE work_items SET stage = 'in_progress', envelope_id = (SELECT envelope_id FROM work_items WHERE id = $2) WHERE id = $1", [child, f.parent]);
    const stamped = (await withTenant(appPool, f.t.accountId, (c) => stampPlanePush(c, { accountId: f.t.accountId, workItemId: child, repoId: f.t.repoId })))!;
    const runner = await insertRunner(admin, f.t.accountId, f.t.userId, { jwk: key.jwk, jkt: key.jkt, credentialMode: "api_key" });
    await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = '{}' WHERE id = $1", [runner, [f.t.repoId]]);
    const id = randomUUID();
    const job: Job = {
      schema_version: 1, job_id: randomUUID(), run_id: id, repo: { id: f.t.repoId, owner: "acme", name: "widgets", private: true }, role: "executor", mode: "local", spec: null,
      task: { kind: "implement", prompt: "p", prompt_sha256: sha256Text("p") }, role_card: { text: "c", sha256: sha256Text("c") }, role_tools_sha256: "a".repeat(64), continues: null,
      branch_prefix: "fx/", model_hint: null, issued_at: new Date(T0 - 1000).toISOString(), expires_at: new Date(T0 + 72 * 3_600_000).toISOString(), key_id: "k1",
    };
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, job_signed, initiated_by, created_at, spec_version_id)
       VALUES ($1, $2, $3, 'executor', 'runner', 'pending', 'runner_local', $4, $5::jsonb, $6, to_timestamp($7 / 1000.0), $8)`,
      [id, f.t.accountId, child, f.t.repoId, JSON.stringify(signJob(job, signing)), f.t.userId, T0 - 5000, f.specV1],
    );
    const claimed = await claims.claimRunnerRun({ accountId: f.t.accountId, runnerId: runner });
    if (claimed.kind !== "claimed" || claimed.runId !== id) throw new Error("not claimed");
    return { f, child, run: { id, generation: claimed.leaseGeneration }, row: stamped };
  }
  const bindings = async (runId: string) => (await admin.query<{ payload: Record<string, unknown> }>("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'child.binding_pr'", [runId])).rows.map((r) => r.payload);
  const notices = async (runId: string) => (await admin.query<{ payload: Record<string, unknown> }>("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'plane.pr_footer_skipped'", [runId])).rows.map((r) => r.payload);

  it("a footer with no placeholder renders as written, and the public body carries no #<number>", async () => {
    const k = await runnerChild("Part of the Acme roadmap");
    const res = await askToken(k.run);
    expect(res.status).toBe(200);
    const reply = PlanePushTokenReply.parse(res.body);
    expect(reply.pr.body).not.toMatch(/(?:^|[^\w])#\d/);
    expect(reply.pr.body).toContain("Part of the Acme roadmap");
    expect(reply.pr.body).not.toMatch(/(closes|fixes|resolves) #/i);
    expect(await notices(k.run.id)).toEqual([]);
  });

  it("SANDBOX-RERUN-BRANCH-a criterion 7: the runner's plane push grant is unchanged by an earlier sandbox run on a run branch: the same answers as the first test above, the push row's public branch, one attempt row", async () => {
    const k = await runnerChild("Part of the Acme roadmap");
    const earlier = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, created_at) VALUES ($1, $2, $3, 'executor', 'production', 'failed', to_timestamp($4 / 1000.0))`, [earlier, k.f.t.accountId, k.child, T0 - 60_000]);
    await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'build.branch', $3::jsonb)`, [k.f.t.accountId, earlier, JSON.stringify({ branch: sandboxRunBranch(earlier) })]);
    const res = await askToken(k.run);
    expect(res.status).toBe(200);
    const reply = PlanePushTokenReply.parse(res.body);
    expect(reply.branch).toBe(k.row.branch);
    expect(reply.pr.body).toContain("Part of the Acme roadmap");
    expect(reply.pr.body).not.toMatch(/(?:^|[^\w])#\d/);
    expect(await notices(k.run.id)).toEqual([]);
  });

  it.each(["Closes GH-{issue_number}", "Part of D#{issue_number}", "Refs GH-{issue_number}", "Closes #{issue_number}"])(
    "the footer %s (a stored footer outside the save-time check) is left off the child's body with child_issue_placeholder, and the grant writes its one attempt row as usual", async (footer) => {
    const k = await runnerChild(footer);
    const reply = PlanePushTokenReply.parse((await askToken(k.run)).body);
    expect(reply.pr.body).not.toMatch(/(?:^|[^\w])#\d/);
    expect(reply.pr.body).not.toMatch(/closes/i);
    expect(await notices(k.run.id)).toEqual([{ reason: "child_issue_placeholder" }]);
  });

  it("a literal closing footer (no placeholder) is left off with child_closing_keyword", async () => {
    const k = await runnerChild("Closes GH-7");
    const reply = PlanePushTokenReply.parse((await askToken(k.run)).body);
    expect(reply.pr.body).not.toMatch(/closes/i);
    expect(await notices(k.run.id)).toEqual([{ reason: "child_closing_keyword" }]);
  });

  it("a child whose parent was re-specced and not approved again gets no grant: the resolver's code is the status's, and no attempt row or token exists", async () => {
    const k = await runnerChild(null);
    await admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind, frontmatter) VALUES ($1, $2, 2, 'v2', encode(sha256(convert_to('v2','UTF8')),'hex'), 'agent', '{}'::jsonb)", [k.f.t.accountId, k.f.parent]);
    const res = await askToken(k.run);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: "respec_needs_approval" } });
    expect((await admin.query("SELECT 1 FROM plane_push_attempts WHERE account_id = $1", [k.f.t.accountId])).rowCount).toBe(0);
    // approved again, a started child keeps going on its pinned version (R11)
    await reapprove(appPool, k.f);
    // the second spec version carries no planned-PR table, so the key left the approved version: the refusal is the key's, not the Spec's
    expect((await askToken(k.run)).body).toMatchObject({ error: { code: "key_not_in_approved_spec" } });
  });

  it("S5b2c4-8: after the hook reports the pull request and the hosted side confirms it, the run holds one code-plane binding, and the public pull request maps to the child", async () => {
    const k = await runnerChild("Part of D#{issue_number}");
    expect((await askToken(k.run)).status).toBe(200);
    const digest = (await admin.query<{ pairing_digest: string }>("SELECT pairing_digest FROM plane_pushes WHERE id = $1", [k.row.id])).rows[0]!.pairing_digest;
    const res = await toResponse(() =>
      planePushReportRun(deps(), signed(key, PLANE_PUSH_REPORT_PATH, { run_id: k.run.id, lease_generation: k.run.generation, phase: "pr_opened", head_sha: HEAD, tip_sha: TIP, pr_number: 9, pairing_digest: digest, token_revoked: true }, { created: created() })),
    );
    expect(res.status).toBe(200);
    expect(await bindings(k.run.id)).toEqual([{ branch: k.row.branch, prNumber: 9, plane: "code", codeRepo: "acme/widgets-public" }]);
    // the public pull request's events map to the child (never to the parent)
    const payload = (action: "closed", merged: boolean): GithubPullRequestPayload =>
      ({
        action, number: 9,
        pull_request: {
          number: 9, state: "closed", body: "x", created_at: "2026-10-26T12:00:00Z", merged_at: merged ? "2026-10-26T13:00:00Z" : null, merged, user: { login: "fulcrumaxe[bot]", type: "Bot" }, author_association: "OWNER",
          head: { ref: k.row.branch, sha: "c".repeat(40), repo: { id: 9002, full_name: "acme/widgets-public" } }, base: { ref: "main", sha: "d".repeat(40), repo: { id: 9002, full_name: "acme/widgets-public" } },
        },
        repository: { id: 9002, full_name: "acme/widgets-public", default_branch: "main" }, installation: { id: 4243 },
      }) as unknown as GithubPullRequestPayload;
    // the child is at a pull-request stage by now (its opened event, or the stage driver, moved it)
    await admin.query("INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, at, source, source_ref) VALUES ($1, $2, 'in_progress', 'pr_opened', now(), 'control_plane', $3)", [k.f.t.accountId, k.child, `seed:${randomUUID()}`]);
    await admin.query("UPDATE work_items SET stage = 'pr_opened' WHERE id = $1", [k.child]);
    const p = payload("closed", true);
    const out = await withTenant(appPool, k.f.t.accountId, (c) => applyMappedEvent(c, { accountId: k.f.t.accountId, installationId: randomUUID(), repoId: k.f.t.repoId, repo: { accountId: k.f.t.accountId, repoId: k.f.t.repoId, ghRepoId: 9002, fullName: "acme/widgets-public" }, deliveryId: `d-${randomUUID()}` }, mapEvent("pull_request", p, { allowlist: [] })));
    expect(out).toMatchObject({ applied: "transitioned", workItemId: k.child });
    expect((await admin.query<{ stage: string }>("SELECT stage FROM work_items WHERE id = $1", [k.child])).rows[0]!.stage).toBe("merged");
    expect((await admin.query<{ stage: string }>("SELECT stage FROM work_items WHERE id = $1", [k.f.parent])).rows[0]!.stage).toBe("in_progress");
  });
});

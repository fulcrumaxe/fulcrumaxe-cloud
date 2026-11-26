import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mergeQueue, readPublicPullRequest, runMergeGateForItem, type GoAttestation, type LocalReviewOptInPort } from "@fx/pipeline";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { listDriverEvents, readGateBlockReasonsSince } from "@fx/core/src/work-items/driverEvents.js";
import { fakeGitHubLocal } from "../../../pipeline/test/review/helpers/fakeGitHubLocal.js";
import { freshRepo } from "../../../pipeline/test/review/helpers/fakeGitHubRest.js";
import { discussingItem } from "../../../pipeline/test/plan/helpers/panelFixtures.js";
import { createWorld, stageOf, type World } from "./world.js";

/**
 * PIPELINE-SCENARIO-HARNESS, scenario 4 [pg]: the merge gate blocks an order for ordering ("overlap_unreviewed") twice on the same head. Each order leaves its own
 * gate fact (a replay of one order leaves one), the reroute's own lookup ("the gate's answer at or after this order") finds the SECOND order's fact, and the
 * second order reroutes into a merge-update round on the paired runner_local item. The gate is the real `runMergeGateForItem` (go phase) over the strict
 * local-only fakes of the pipeline's tests behind the real fence; the round start is the real queue code. Nothing is merged in either repository.
 *
 * What this does NOT cover: the reroute glue in apps/web (the step that reads the gate's reasons, decides they are all ordering ones and calls the round start) cannot be imported by a
 * worker test, so the "every reason is an ordering one" check and the call into the round start below restate it by hand. The shared lookup and the gate's per-order facts are proven here;
 * a regression in that glue itself would not fail this test.
 */
describe("scenario: a second blocked merge order on the same head is rerouted [pg]", { timeout: 90_000 }, () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld();
  });
  afterAll(async () => {
    await w.close();
  });

  const HEAD = "a".repeat(40);
  const PUB_HEAD = "c".repeat(40);
  const BASE = "d".repeat(40);
  const PUB_PR = 12;
  const BRANCH = "fx/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g1";
  const BOT_LOGIN = "fulcrumaxe-app[bot]";
  const green = { name: "build", status: "completed", conclusion: "success" };
  const file = (filename: string) => ({ filename, status: "modified", sha: "f".repeat(40), changes: 1 });
  const on: LocalReviewOptInPort = { enabled: async () => true };
  const overlapFact = { verdict: "none" as const, tip_sha: BASE, behind: true, overlap: true };
  const tenant = <T>(accountId: string, fn: (c: PoolClient) => Promise<T>) => withTenant(w.appPool, accountId, fn);

  /** A paired runner_local item at PR opened with every reviewer passed on its head, and the public pull request the platform pushed for it. */
  async function paired() {
    const a = await w.account();
    const { admin } = w;
    const ghRepoId = Number((await admin.query("SELECT gh_repo_id FROM repos WHERE id = $1", [a.repoId])).rows[0].gh_repo_id);
    await admin.query("UPDATE repos SET settings = $2::jsonb WHERE id = $1", [a.repoId, JSON.stringify({ autoMerge: true })]);
    const { workItemId } = await discussingItem(w.writerPool, a.accountId, { title: "Fix the total", body: "The total is right.", category: "feature", repoId: a.repoId });
    await admin.query("UPDATE work_items SET gh_number = 7, repo_id = $2, stage = 'pr_opened', provenance = 'internal' WHERE id = $1", [workItemId, a.repoId]);
    const body = "1. The total is right.";
    await admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, $3, $4, 'system')", [a.accountId, workItemId, body, createHash("sha256").update(body).digest("hex")]);
    const runnerId = (await w.runner(a)).id;
    const priv = freshRepo({ ghId: ghRepoId, headSha: HEAD, draft: true, checks: { [HEAD]: [green] }, protectedWithoutChecks: true, runBranch: BRANCH, files: [file("src/widget/total.ts")] });
    const executor = randomUUID();
    await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, runner_id) VALUES ($1, $2, $3, 'executor', 'runner', 'succeeded', 'runner_local', $4)", [executor, a.accountId, workItemId, runnerId]);
    await admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'run.status_changed', $3::jsonb)", [a.accountId, executor, JSON.stringify({ from: "running", to: "succeeded", viaRunnerDone: true, prNumber: priv.prNumber, branch: BRANCH })]);
    for (const role of ["code-reviewer", "acceptance-tester", "security-reviewer"]) {
      await admin.query("INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha, execution_mode, runner_id) VALUES ($1, $2, $3, 'runner', 'succeeded', '{\"verdict\":\"pass\"}'::jsonb, $4, 'runner_local', $5)", [a.accountId, workItemId, role, HEAD, runnerId]);
    }
    await admin.query("INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, 'acme/widgets-public', ARRAY['.autonomous-team/**'])", [a.repoId, a.accountId]);
    await admin.query(
      `INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest, state, head_sha, tip_sha, pr_number, pr_url, source_head)
       VALUES ($1, $2, $3, 'acme/widgets-public', $4, 'pr_opened', $5, $5, $6, 'https://github.com/acme/widgets-public/pull/12', $7)`,
      [a.accountId, workItemId, a.repoId, "a".repeat(64), PUB_HEAD, PUB_PR, HEAD],
    );
    const pubBranch = String((await admin.query("SELECT branch FROM plane_pushes WHERE work_item_id = $1", [workItemId])).rows[0].branch);
    const pub = freshRepo({ owner: "acme", name: "widgets-public", prNumber: PUB_PR, isPublic: true, authorLogin: BOT_LOGIN, headSha: PUB_HEAD, checks: { [PUB_HEAD]: [green] }, protectedWithoutChecks: true, runBranch: pubBranch, files: [file("src/widget/total.ts")], ghId: 8123456 });
    return { a, workItemId, priv, pub, privLocal: fakeGitHubLocal(priv), pubLocal: fakeGitHubLocal(pub, { exclude: ["A10"] }) };
  }
  type Paired = Awaited<ReturnType<typeof paired>>;

  /** The gate's go phase for one order (the plane merge order's id keys its fact). The delegate would merge: it is recorded so a test can see it was never asked. */
  function ask(p: Paired, orderId: string) {
    const delegated: unknown[] = [];
    const attestation: GoAttestation = { reviewedHead: HEAD, publicHead: PUB_HEAD, same: true, incomplete: false, paths: ["src/widget/total.ts"], orderedCapable: true, ordered: overlapFact };
    const run = () =>
      runMergeGateForItem(
        {
          pool: w.writerPool,
          repoVisibility: async () => "private" as const,
          authorTrust: { botLogins: async () => [BOT_LOGIN], allowlist: () => null },
          http: p.privLocal.http,
          localReviewOptIn: on,
          publicPlane: { open: async () => p.pubLocal.http, read: readPublicPullRequest(w.writerPool) },
          mergeDelegate: async (x) => (delegated.push(x), { delegated: true }),
        },
        { accountId: p.a.accountId, workItemId: p.workItemId, prNumber: p.priv.prNumber, goPhase: { attestation, orderId } },
      );
    return { run, delegated };
  }

  const gateRows = async (p: Paired) => (await w.admin.query("SELECT dedupe_key, reasons FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'merge_gate' AND code = 'ready_human_merges' ORDER BY seq", [p.workItemId])).rows as Array<{ dedupe_key: string; reasons: string[] }>;
  const now = async () => (await w.admin.query("SELECT clock_timestamp() AS t")).rows[0].t as Date;

  it("two blocked orders on one head leave two gate facts; the reroute's lookup finds the second order's; it starts a merge-update round and nothing merges", async () => {
    const p = await paired();
    const o1 = randomUUID();
    const o2 = randomUUID();

    // Order 1 is blocked for the overlap, and the item has its fact.
    const firstAt = await now();
    const first = ask(p, o1);
    expect(await first.run()).toMatchObject({ outcome: "ready_human_merges", reasons: ["overlap_unreviewed"] });
    expect(await tenant(p.a.accountId, (c) => readGateBlockReasonsSince(c, p.a.accountId, p.workItemId, firstAt))).toEqual(["overlap_unreviewed"]);
    expect(await gateRows(p)).toHaveLength(1);

    // The person asks again on the same head. Before the second order's gate runs, "at or after this order" finds nothing: the first order's answer is older.
    const secondAt = await now();
    expect(await tenant(p.a.accountId, (c) => readGateBlockReasonsSince(c, p.a.accountId, p.workItemId, secondAt))).toBeNull();
    const second = ask(p, o2);
    expect(await second.run()).toMatchObject({ outcome: "ready_human_merges", reasons: ["overlap_unreviewed"] });
    // The second order has its own fact, so the lookup finds it; a replay of the same order is not a third.
    expect(await tenant(p.a.accountId, (c) => readGateBlockReasonsSince(c, p.a.accountId, p.workItemId, secondAt))).toEqual(["overlap_unreviewed"]);
    await ask(p, o2).run();
    const rows = await gateRows(p);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.dedupe_key).some((k) => k.includes(`:go:${o1}:`))).toBe(true);
    expect(rows.map((r) => r.dedupe_key).some((k) => k.includes(`:go:${o2}:`))).toBe(true);
    // Every reason is an ordering one, which is what the reroute requires.
    expect(rows.every((r) => r.reasons.length === 1 && r.reasons[0] === "overlap_unreviewed")).toBe(true);

    // The reroute: the round starts from the runner's platform-authored facts (the real queue code over the real tables).
    const subject = { id: p.workItemId, accountId: p.a.accountId, repoId: p.a.repoId, workItemId: p.workItemId, prNumber: p.priv.prNumber, headSha: HEAD, entryId: null, roundsUsed: 0 };
    const started: string[] = [];
    const out = await mergeQueue.startEntrylessFromRunnerFacts(
      {
        inTenant: tenant,
        async startConflictRound({ round }: { round: { fromSha: string } }) {
          const runId = randomUUID();
          await w.admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, head_sha) VALUES ($1, $2, $3, 'executor', 'runner', 'running', $4)", [runId, p.a.accountId, p.workItemId, round.fromSha]);
          started.push(runId);
          return { ok: true as const, runId };
        },
      } as never,
      subject as never,
      { verdict: "conflict_platform", baseSha: BASE, baseRef: "main", files: ["src/widget/total.ts"] },
      { eventCode: "overlap_unreviewed" },
    );
    expect(out).toEqual({ outcome: "started" });
    expect(started).toHaveLength(1);
    expect((await tenant(p.a.accountId, (c) => mergeQueue.listConflictRounds(c, p.a.accountId, p.workItemId))).length).toBe(1);

    // The item is still at PR opened (the round is open), the delegate was never asked, and neither repository saw a merge.
    expect(await stageOf(w, p.a, p.workItemId)).toBe("pr_opened");
    expect(first.delegated).toEqual([]);
    expect(second.delegated).toEqual([]);
    expect(p.pub.merges).toEqual([]);
    expect(p.priv.merges).toEqual([]);
    expect([...p.pubLocal.calls, ...p.privLocal.calls].filter((c) => c.label === "A10")).toEqual([]);
    const gateEvents = (await tenant(p.a.accountId, (c) => listDriverEvents(c, p.workItemId))).filter((e) => e.kind === "merge_gate");
    expect(gateEvents.length).toBeGreaterThanOrEqual(2);
  });
});

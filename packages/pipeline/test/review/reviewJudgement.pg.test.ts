import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readReviewJudgement, reviewModeOf, type LocalReviewOptInPort } from "../../src/review/mergeGateRun.js";
import { discussingItem } from "../plan/helpers/panelFixtures.js";
import { seedAccount, seedRepo } from "../build/helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";

/**
 * D#483 S5-j2f [pg]: what the merge queue's tick reads about an item's reviews, by the gate's own definitions: the review mode (a `runner_local` repository's opt-in decides it; a failed
 * read is off) and the security flag the head's code reviewer set (a trusted runner's run counts only with local review on).
 */
const h = pgHarness();
const HEAD = "a".repeat(40);
const optIn = (on: boolean): LocalReviewOptInPort => ({ enabled: async () => on });

async function world(local: boolean) {
  const accountId = randomUUID();
  const repoId = randomUUID();
  await seedAccount(h.admin, accountId);
  await seedRepo(h.admin, accountId, repoId);
  await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets', execution_mode = $2 WHERE id = $1", [repoId, local ? "runner_local" : "sandbox"]);
  const { workItemId } = await discussingItem(h.runWriterPool, accountId, { title: "Add a footer", body: "Show the year in the footer.", category: "feature", repoId });
  await h.admin.query("UPDATE work_items SET gh_number = 7, repo_id = $2, stage = 'pr_opened', provenance = 'internal' WHERE id = $1", [workItemId, repoId]);
  const body = "1. The footer shows the year.";
  await h.admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, $3, $4, 'system')", [accountId, workItemId, body, createHash("sha256").update(body).digest("hex")]);
  let runnerId: string | null = null;
  if (local) {
    const admin = randomUUID();
    await h.admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [admin, `${admin}@fixture.test`]);
    await h.admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'admin')", [accountId, admin]);
    runnerId = randomUUID();
    const k = randomUUID().replace(/-/g, "").padEnd(43, "k");
    await h.admin.query(`INSERT INTO runners (id, account_id, registered_by, public_key_jwk, jkt, credential_mode) VALUES ($1, $2, $3, $4::jsonb, $5, 'subscription')`, [runnerId, accountId, admin, JSON.stringify({ kty: "OKP", crv: "Ed25519", x: k }), k]);
  }
  const review = (envelope: string) =>
    local
      ? h.admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha, execution_mode, runner_id) VALUES ($1, $2, 'code-reviewer', 'runner', 'succeeded', $3::jsonb, $4, 'runner_local', $5)`, [accountId, workItemId, envelope, HEAD, runnerId])
      : h.admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha, execution_mode) VALUES ($1, $2, 'code-reviewer', 'production', 'succeeded', $3::jsonb, $4, 'sandbox')`, [accountId, workItemId, envelope, HEAD]);
  return { accountId, workItemId, review };
}

describe("D#483 S5-j2f the tick's review judgement [pg]", () => {
  it("a hosted item: cloud mode; the flag is the code reviewer's security_review_needed, true only when exactly true", async () => {
    const w = await world(false);
    const read = () => readReviewJudgement(h.runWriterPool, optIn(true), { accountId: w.accountId, workItemId: w.workItemId, headSha: HEAD });
    expect(await read()).toEqual({ mode: "cloud", flagged: false });
    await w.review('{"verdict":"pass","security_review_needed":"true"}');
    expect(await read()).toEqual({ mode: "cloud", flagged: false });
    await w.review('{"verdict":"pass","security_review_needed":true}');
    expect(await read()).toEqual({ mode: "cloud", flagged: true });
    // Another head's flag says nothing about this one.
    expect(await readReviewJudgement(h.runWriterPool, undefined, { accountId: w.accountId, workItemId: w.workItemId, headSha: "b".repeat(40) })).toEqual({ mode: "cloud", flagged: false });
  });

  it("a runner_local item: off without the opt-in (and when the read fails), on with it; a trusted runner's flag counts only when on", async () => {
    const w = await world(true);
    await w.review('{"verdict":"pass","security_review_needed":true}');
    const input = { accountId: w.accountId, workItemId: w.workItemId, headSha: HEAD };
    expect(await readReviewJudgement(h.runWriterPool, optIn(false), input)).toEqual({ mode: "runner_local_off", flagged: false });
    expect(await readReviewJudgement(h.runWriterPool, undefined, input)).toEqual({ mode: "runner_local_off", flagged: false });
    expect(await readReviewJudgement(h.runWriterPool, { enabled: async () => Promise.reject(new Error("read failed")) }, input)).toEqual({ mode: "runner_local_off", flagged: false });
    expect(await readReviewJudgement(h.runWriterPool, optIn(true), input)).toEqual({ mode: "runner_local_on", flagged: true });
  });

  it("an item whose context cannot be loaded throws: the tick reads that as no evidence", async () => {
    const w = await world(false);
    await expect(readReviewJudgement(h.runWriterPool, undefined, { accountId: w.accountId, workItemId: randomUUID(), headSha: HEAD })).rejects.toThrow(/review judgement/);
  });

  it("reviewModeOf: only a runner_local repository can be on", async () => {
    expect(await reviewModeOf(optIn(true), "a", { executionMode: "sandbox", repoId: "r" })).toBe("cloud");
    expect(await reviewModeOf(optIn(true), "a", { executionMode: "runner_local", repoId: "r" })).toBe("runner_local_on");
  });
});

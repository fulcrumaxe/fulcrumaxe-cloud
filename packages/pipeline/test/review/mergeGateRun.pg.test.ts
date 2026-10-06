import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { listDriverEvents } from "@fx/core/src/work-items/driverEvents.js";
import { runMergeGateForItem } from "../../src/review/mergeGateRun.js";
import { loadReviewContext, loadSpecText } from "../../src/review/context.js";
import { REVIEW_STATUS_CONTEXT } from "../../src/review/githubReads.js";
import { discussingItem } from "../plan/helpers/panelFixtures.js";
import { seedAccount, seedRepo } from "../build/helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { fakeGitHubRest, freshRepo, type FakeRepoState } from "./helpers/fakeGitHubRest.js";

/**
 * D#483 P3 [pg]: the merge gate for one work item with the real GitHub port, over a fake GitHub that answers like the
 * real one (see helpers/fakeGitHubRest.ts) and real agent_runs rows. The rules under test: the commit status
 * `fulcrumaxe/review` is posted only when every required reviewer passed on THAT head by our records; the gate then
 * still needs CI (a repository's own checks must pass too), the repository's auto-merge setting exactly true, and
 * every outcome is recorded as facts.
 */
const h = pgHarness();
const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);

interface World {
  accountId: string;
  workItemId: string;
  repoId: string;
  gh: FakeRepoState;
}

async function world(opts: { kind?: "feature" | "critical"; settings?: Record<string, unknown>; provenance?: string; debaterMode?: string; repo?: Partial<FakeRepoState> } = {}): Promise<World> {
  const accountId = randomUUID();
  const repoId = randomUUID();
  await seedAccount(h.admin, accountId);
  await seedRepo(h.admin, accountId, repoId);
  await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets', settings = $2::jsonb WHERE id = $1", [repoId, JSON.stringify(opts.settings ?? { autoMerge: true })]);
  const { workItemId } = await discussingItem(h.runWriterPool, accountId, { title: "Add a footer", body: "Show the year in the footer.", category: opts.kind ?? "feature", repoId });
  await h.admin.query("UPDATE work_items SET gh_number = 7, repo_id = $2, stage = 'pr_opened', provenance = $3 WHERE id = $1", [workItemId, repoId, opts.provenance ?? "internal"]);
  const body = "1. The footer shows the year.";
  await h.admin.query(
    "INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, $3, $4, 'system')",
    [accountId, workItemId, body, createHash("sha256").update(body).digest("hex")],
  );
  if (opts.debaterMode) await h.admin.query("INSERT INTO role_settings (account_id, repo_id, role, mode) VALUES ($1, $2, 'debater', $3) ON CONFLICT (repo_id, role) DO UPDATE SET mode = EXCLUDED.mode", [accountId, repoId, opts.debaterMode]);
  const gh = freshRepo({ headSha: HEAD, checks: { [HEAD]: [] }, ...opts.repo });
  return { accountId, workItemId, repoId, gh };
}

async function run(w: World, role: string, verdict: string | null, over: { head?: string; status?: string; runtime?: string; extra?: Record<string, unknown> } = {}): Promise<void> {
  await h.admin.query(
    "INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)",
    [w.accountId, w.workItemId, role, over.runtime ?? "production", over.status ?? "succeeded", verdict === null ? null : JSON.stringify({ verdict, ...(over.extra ?? {}) }), over.head ?? HEAD],
  );
}
const passBoth = async (w: World) => {
  await run(w, "code-reviewer", "pass");
  await run(w, "acceptance-tester", "pass");
};
const gate = (w: World) => runMergeGateForItem({ pool: h.runWriterPool, http: fakeGitHubRest(w.gh) }, { accountId: w.accountId, workItemId: w.workItemId, prNumber: w.gh.prNumber });
const events = (w: World) => withTenant(h.runWriterPool, w.accountId, (c) => listDriverEvents(c, w.workItemId));
const greenCheck = { name: "ci", status: "completed", conclusion: "success" };

describe("a repository with no CI of its own (the platform's status is the signal)", () => {
  it("every required reviewer passed on the head: the status is posted on that commit, then the gate merges, bound to that sha", async () => {
    const w = await world();
    await passBoth(w);
    const out = await gate(w);
    expect(out).toMatchObject({ outcome: "merged", headSha: HEAD, status: "posted", reasons: [] });
    expect(w.gh.posts).toHaveLength(1);
    expect(w.gh.posts[0]).toMatchObject({ sha: HEAD, body: { state: "success", context: REVIEW_STATUS_CONTEXT } });
    expect(w.gh.merges).toEqual([{ sha: HEAD, method: "squash" }]);
    // The status came before the merge.
    const order = w.gh.requests.map((r) => `${r.method} ${r.path.split("/").slice(4).join("/")}`);
    expect(order.indexOf(`POST statuses/${HEAD}`)).toBeLessThan(order.indexOf("PUT pulls/41/merge"));
  });

  it("the outcome is recorded as facts: the status was posted, the gate's outcome, and that the gate itself merged", async () => {
    const w = await world();
    await passBoth(w);
    await gate(w);
    const ev = await events(w);
    expect(ev.map((e) => e.kind)).toEqual(["review_status", "merge_gate", "merged_by_gate"]);
    expect(ev[0]).toMatchObject({ code: "posted", head_sha: HEAD, pr_number: 41 });
    expect(ev[1]).toMatchObject({ code: "merged", reasons: [], head_sha: HEAD });
    expect(ev[2]).toMatchObject({ head_sha: HEAD });
  });

  it("auto-merge off (the default): the status is posted, the gate does NOT merge, and its reasons are recorded", async () => {
    const w = await world({ settings: {} });
    await passBoth(w);
    const out = await gate(w);
    expect(out).toMatchObject({ outcome: "ready_human_merges", reasons: ["auto_merge_not_allowed"], status: "posted" });
    expect(w.gh.merges).toEqual([]);
    const ev = await events(w);
    expect(ev.find((e) => e.kind === "merge_gate")).toMatchObject({ code: "ready_human_merges", reasons: ["auto_merge_not_allowed"] });
    expect(ev.some((e) => e.kind === "merged_by_gate")).toBe(false);
  });

  it.each([
    ["the string true", { autoMerge: "true" }],
    ["the number 1", { autoMerge: 1 }],
    ["false", { autoMerge: false }],
    ["null", { autoMerge: null }],
    ["a nested true", { autoMerge: { enabled: true } }],
    ["nothing", {}],
  ])("an auto-merge setting of %s is not true: the gate never merges", async (_n, settings) => {
    const w = await world({ settings });
    await passBoth(w);
    expect((await gate(w)).outcome).toBe("ready_human_merges");
    expect(w.gh.merges).toEqual([]);
  });

  it("an external item is never gated by the driver at all (a person moves it): refused before GitHub is touched, whatever the guard says", async () => {
    for (const settings of [{ autoMerge: true }, { autoMerge: true, blockExternalAutoMerge: false }]) {
      const w = await world({ provenance: "external", settings });
      await passBoth(w);
      expect(await gate(w)).toEqual({ outcome: "refused", reason: "external_requires_human" });
      expect(w.gh.requests).toEqual([]);
    }
  });
});

describe("the status is posted only when the reviewers clear THIS head by our records", () => {
  it("a needs-fix on the head: no status, no merge, and the reasons name the role", async () => {
    const w = await world();
    await run(w, "code-reviewer", "needs-fix");
    await run(w, "acceptance-tester", "pass");
    const out = await gate(w);
    expect(out).toMatchObject({ outcome: "ready_human_merges", status: "skipped" });
    expect(out.outcome === "ready_human_merges" && out.reasons).toContain("verdict_not_pass_code_reviewer");
    expect(w.gh.posts).toEqual([]);
    expect(w.gh.merges).toEqual([]);
    expect((await events(w)).find((e) => e.kind === "review_status")).toMatchObject({ code: "skipped" });
  });

  it("a missing reviewer, a failed run, a local runtime and an envelope that says pass on a run that did not succeed each block it", async () => {
    for (const [label, apply] of [
      ["missing acceptance", async (w: World) => run(w, "code-reviewer", "pass")],
      ["failed run", async (w: World) => { await run(w, "code-reviewer", "pass"); await run(w, "acceptance-tester", "pass", { status: "failed" }); }],
      ["local runtime", async (w: World) => { await run(w, "code-reviewer", "pass"); await run(w, "acceptance-tester", "pass", { runtime: "local" }); }],
      ["no envelope", async (w: World) => { await run(w, "code-reviewer", "pass"); await run(w, "acceptance-tester", null); }],
      ["a PASS in capitals", async (w: World) => { await run(w, "code-reviewer", "PASS"); await run(w, "acceptance-tester", "pass"); }],
    ] as const) {
      const w = await world();
      await apply(w);
      const out = await gate(w);
      expect(out.outcome, label).toBe("ready_human_merges");
      expect(w.gh.posts, label).toEqual([]);
      expect(w.gh.merges, label).toEqual([]);
    }
  });

  it("reviews of an OLDER head do not clear a new head: no status, nothing merged", async () => {
    const w = await world();
    await run(w, "code-reviewer", "pass", { head: OTHER });
    await run(w, "acceptance-tester", "pass", { head: OTHER });
    const out = await gate(w);
    expect(out).toMatchObject({ outcome: "ready_human_merges", status: "skipped" });
    expect(out.outcome === "ready_human_merges" && out.reasons).toEqual(expect.arrayContaining(["missing_run_code_reviewer", "missing_run_acceptance_tester"]));
    expect(w.gh.posts).toEqual([]);
  });

  it("a rejection of a role that is not required still vetoes: no status, no merge", async () => {
    const w = await world();
    await passBoth(w);
    await run(w, "security-reviewer", "needs-fix");
    const out = await gate(w);
    expect(out.outcome).toBe("ready_human_merges");
    expect(w.gh.posts).toEqual([]);
    expect(w.gh.merges).toEqual([]);
  });
});

describe("a repository with CI of its own must pass it too", () => {
  it("green checks plus the platform's status: merged", async () => {
    const w = await world({ repo: { checks: { [HEAD]: [greenCheck] } } });
    await passBoth(w);
    expect((await gate(w)).outcome).toBe("merged");
  });

  it("a failing check blocks the merge even though the platform's status was posted", async () => {
    const w = await world({ repo: { checks: { [HEAD]: [greenCheck, { name: "e2e", status: "completed", conclusion: "failure" }] } } });
    await passBoth(w);
    const out = await gate(w);
    expect(out).toMatchObject({ outcome: "ready_human_merges", status: "posted", reasons: ["ci_not_green"] });
    expect(w.gh.merges).toEqual([]);
  });

  it("a check still running blocks it", async () => {
    const w = await world({ repo: { checks: { [HEAD]: [{ name: "ci", status: "in_progress", conclusion: null }] } } });
    await passBoth(w);
    expect((await gate(w)).outcome).toBe("ready_human_merges");
  });

  it("a required status the repository's branch protection names, which nobody posted, blocks it", async () => {
    const w = await world({ repo: { requiredContexts: ["buildkite/ci"] } });
    await passBoth(w);
    expect(await gate(w)).toMatchObject({ outcome: "ready_human_merges", reasons: ["ci_not_green"] });
  });

  it("when the platform's status cannot be posted the gate still runs, and for a repository with no other CI it says so", async () => {
    const w = await world({ repo: { statusPostFails: 500 } });
    await passBoth(w);
    const out = await gate(w);
    expect(out).toMatchObject({ outcome: "ready_human_merges", status: "failed", reasons: ["ci_not_green"] });
    expect((await events(w)).find((e) => e.kind === "review_status")).toMatchObject({ code: "failed" });
  });
});

describe("who is required on the head", () => {
  it("a critical item needs the security reviewer: without its pass nothing is posted or merged; with it, merged", async () => {
    const w = await world({ kind: "critical" });
    await passBoth(w);
    const out = await gate(w);
    expect(out.outcome).toBe("ready_human_merges");
    expect(out.outcome === "ready_human_merges" && out.reasons).toContain("missing_run_security_reviewer");
    expect(w.gh.posts).toEqual([]);
    await run(w, "security-reviewer", "pass");
    expect((await gate(w)).outcome).toBe("merged");
  });

  it("a diff that touches a security surface needs it too, decided by the diff check on THIS head's files", async () => {
    const w = await world({ repo: { files: [{ filename: "src/auth/session.ts", patch: "@@\n+x", changes: 1 }] } });
    await passBoth(w);
    const out = await gate(w);
    expect(out.outcome === "ready_human_merges" && out.reasons).toContain("missing_run_security_reviewer");
    expect(w.gh.posts).toEqual([]);
  });

  it("a file list the platform could not read to the end counts as a security surface (fail toward review)", async () => {
    const files = Array.from({ length: 3000 }, (_v, i) => ({ filename: `docs/page-${i}.md`, patch: "@@\n+text", changes: 1 }));
    const w = await world({ repo: { files } });
    await passBoth(w);
    const out = await gate(w);
    expect(out.outcome === "ready_human_merges" && out.reasons).toContain("missing_run_security_reviewer");
  });

  it("the code reviewer's flag on this head needs the security reviewer; a flag that is not the JSON true does not", async () => {
    const flagged = await world();
    await run(flagged, "code-reviewer", "pass", { extra: { security_review_needed: true } });
    await run(flagged, "acceptance-tester", "pass");
    expect((await gate(flagged)).outcome === "ready_human_merges").toBe(true);
    const notFlagged = await world();
    await run(notFlagged, "code-reviewer", "pass", { extra: { security_review_needed: "true" } });
    await run(notFlagged, "acceptance-tester", "pass");
    expect((await gate(notFlagged)).outcome).toBe("merged");
  });

  it("the debater is required only when the repo's role setting allows it (default off)", async () => {
    const off = await world({ kind: "feature" });
    await passBoth(off);
    expect((await gate(off)).outcome).toBe("merged");
    const on = await world({ kind: "feature", debaterMode: "feature_critical" });
    await passBoth(on);
    const out = await gate(on);
    expect(out.outcome === "ready_human_merges" && out.reasons).toContain("missing_run_debater");
    expect(on.gh.posts).toEqual([]);
    await run(on, "debater", "pass");
    expect((await gate(on)).outcome).toBe("merged");
    const small = await world({ kind: "feature", debaterMode: "off" });
    await passBoth(small);
    expect((await gate(small)).outcome).toBe("merged");
  });
});

describe("the pull request itself", () => {
  it("a closed or merged pull request is not gated, marked or merged, and no status is posted", async () => {
    for (const over of [{ state: "closed" as const }, { merged: true, state: "closed" as const }]) {
      const w = await world({ repo: over });
      await passBoth(w);
      const out = await gate(w);
      expect(out.outcome).toBe("pr_not_open");
      expect(w.gh.posts).toEqual([]);
      expect(w.gh.merges).toEqual([]);
    }
  });

  it("a draft is not merged", async () => {
    const w = await world({ repo: { draft: true } });
    await passBoth(w);
    expect(await gate(w)).toMatchObject({ outcome: "ready_human_merges", reasons: ["pr_draft"] });
  });

  it("a push that races the merge makes GitHub refuse (the sha is sent); the gate reports head_moved and merges nothing", async () => {
    const w = await world({ repo: { onMerge: (s) => void (s.headSha = OTHER) } });
    await passBoth(w);
    const out = await gate(w);
    expect(out).toMatchObject({ outcome: "head_moved", headSha: HEAD });
    expect(w.gh.merges).toEqual([{ sha: HEAD, method: "squash" }]);
    expect(w.gh.merged).toBe(false);
    expect((await events(w)).find((e) => e.kind === "merge_gate")).toMatchObject({ code: "head_moved" });
  });

  it("GitHub refusing the merge for another reason is recorded as merge_call_refused", async () => {
    const w = await world({ repo: { mergeStatus: 405 } });
    await passBoth(w);
    expect(await gate(w)).toMatchObject({ outcome: "ready_human_merges", reasons: ["merge_call_refused"] });
  });

  it("a failed read of the files THROWS (the step retries), and nothing is posted or merged", async () => {
    const w = await world({ repo: { filesFail: 500 } });
    await passBoth(w);
    await expect(gate(w)).rejects.toThrow(/files github_unavailable/);
    expect(w.gh.posts).toEqual([]);
    expect(w.gh.merges).toEqual([]);
  });

  it("an item the review cannot load is refused with its reason and touches nothing", async () => {
    const w = await world();
    await h.admin.query("UPDATE work_items SET provenance = 'external' WHERE id = $1", [w.workItemId]);
    expect(await gate(w)).toEqual({ outcome: "refused", reason: "external_requires_human" });
    expect(w.gh.requests).toEqual([]);
  });

  it("a replayed gate on the same head writes its facts once", async () => {
    const w = await world({ settings: {} });
    await passBoth(w);
    await gate(w);
    await gate(w);
    const ev = await events(w);
    expect(ev.filter((e) => e.kind === "review_status")).toHaveLength(1);
    expect(ev.filter((e) => e.kind === "merge_gate")).toHaveLength(1);
  });
});

describe("loadReviewContext and loadSpecText", () => {
  it("reads the tier from the discussion, the Spec version, the debater setting and the raw guard settings", async () => {
    const w = await world({ kind: "critical", debaterMode: "always", settings: { autoMerge: true, blockExternalAutoMerge: false } });
    const r = await loadReviewContext(h.runWriterPool, w.accountId, w.workItemId);
    expect(r).toMatchObject({ ok: true, ctx: { tier: "critical", specVersion: 1, debaterMode: "always", owner: "acme", name: "widgets", issue: 7, autoMerge: true, blockExternalAutoMerge: false } });
  });

  it.each([
    ["an external item", "UPDATE work_items SET provenance = 'external' WHERE id = $1", "external_requires_human"],
    ["an item with no repository", "UPDATE work_items SET repo_id = NULL WHERE id = $1", "no_repo"],
    ["an item with no issue", "UPDATE work_items SET gh_number = NULL WHERE id = $1", "no_issue_link"],
    ["a project", "UPDATE discussions SET kind = 'project' WHERE root_work_item_id = $1", "tier_unknown"],
    ["an item whose Spec was erased", "UPDATE spec_versions SET erased_at = now() WHERE work_item_id = $1", "no_spec"],
  ])("%s is refused (%s)", async (_n, sql, reason) => {
    const w = await world();
    await h.admin.query(sql, [w.workItemId]);
    expect(await loadReviewContext(h.runWriterPool, w.accountId, w.workItemId)).toEqual({ ok: false, reason });
  });

  it("an unknown item is not_found, and another tenant's item is invisible", async () => {
    const w = await world();
    const other = await world();
    expect(await loadReviewContext(h.runWriterPool, w.accountId, randomUUID())).toEqual({ ok: false, reason: "not_found" });
    expect(await loadReviewContext(h.runWriterPool, w.accountId, other.workItemId)).toEqual({ ok: false, reason: "not_found" });
  });

  it("the Spec text is returned only for the version the person approved: a newer version means null", async () => {
    const w = await world();
    expect(await loadSpecText(h.runWriterPool, w.accountId, w.workItemId, 1)).toEqual({ version: 1, body: "1. The footer shows the year." });
    const body = "2. A newer Spec.";
    await h.admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 2, $3, $4, 'system')", [w.accountId, w.workItemId, body, createHash("sha256").update(body).digest("hex")]);
    expect(await loadSpecText(h.runWriterPool, w.accountId, w.workItemId, 1)).toBeNull();
    expect(await loadSpecText(h.runWriterPool, w.accountId, w.workItemId, 2)).toEqual({ version: 2, body });
  });
});

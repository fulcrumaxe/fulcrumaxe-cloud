import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { runMergeGateForItem, localReviewOptInOff, type LocalReviewOptInPort } from "../../src/review/mergeGateRun.js";
import { createPgLocalReviewOptIn } from "../../src/review/localReviewOptIn.js";
import { LOCAL_REVIEW_DESCRIPTION, REVIEW_STATUS_CONTEXT } from "../../src/review/githubReads.js";
import { discussingItem } from "../plan/helpers/panelFixtures.js";
import { seedAccount, seedRepo } from "../build/helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { fakeGitHubRest, freshRepo, type FakeRepoState } from "./helpers/fakeGitHubRest.js";

/**
 * D#6 R3b [pg] (correction C12 section 1): the merge gate for a `runner_local` repo, whose reviewers ran on the customer's
 * machine. Over a fake GitHub that answers like the real one and real `agent_runs`, `runners` and `account_members` rows.
 * Every merge-or-not decision below is read from the fake GitHub's merge log (`gh.merges`), not from the gate's own answer.
 */
const h = pgHarness();
const HEAD = "a".repeat(40);
const greenCheck = { name: "ci", status: "completed", conclusion: "success" };
let nextKey = 0;

interface World {
  accountId: string;
  workItemId: string;
  repoId: string;
  gh: FakeRepoState;
  /** A runner registered by an owner/admin of the account. */
  adminRunner: string;
}

async function user(accountId: string, role: "owner" | "admin" | "member"): Promise<string> {
  const id = randomUUID();
  await h.admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [id, `${id}@fixture.test`]);
  await h.admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)", [accountId, id, role]);
  return id;
}

async function runner(accountId: string, registeredBy: string, over: { revoked?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  const k = String(++nextKey).padStart(43, "k");
  await h.admin.query(
    `INSERT INTO runners (id, account_id, registered_by, public_key_jwk, jkt, credential_mode, revoked_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, 'subscription', $6)`,
    [id, accountId, registeredBy, JSON.stringify({ kty: "OKP", crv: "Ed25519", x: k }), k, over.revoked ? new Date() : null],
  );
  return id;
}

async function world(opts: { executionMode?: string; repo?: Partial<FakeRepoState>; kind?: "feature" | "critical" } = {}): Promise<World> {
  const accountId = randomUUID();
  const repoId = randomUUID();
  await seedAccount(h.admin, accountId);
  await seedRepo(h.admin, accountId, repoId);
  await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets', execution_mode = $2, settings = '{\"autoMerge\":true}'::jsonb WHERE id = $1", [repoId, opts.executionMode ?? "runner_local"]);
  const { workItemId } = await discussingItem(h.runWriterPool, accountId, { title: "Add a footer", body: "Show the year in the footer.", category: opts.kind ?? "feature", repoId });
  await h.admin.query("UPDATE work_items SET gh_number = 7, repo_id = $2, stage = 'pr_opened', provenance = 'internal' WHERE id = $1", [workItemId, repoId]);
  const body = "1. The footer shows the year.";
  await h.admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, $3, $4, 'system')", [accountId, workItemId, body, createHash("sha256").update(body).digest("hex")]);
  const admin = await user(accountId, "admin");
  const adminRunner = await runner(accountId, admin);
  // The repository's own CI is green, and the base branch is protected: the fully satisfied state. Tests take one piece away.
  const gh = freshRepo({ headSha: HEAD, checks: { [HEAD]: [greenCheck] }, protectedWithoutChecks: true, ...opts.repo });
  return { accountId, workItemId, repoId, gh, adminRunner };
}

/** A reviewer run on HEAD. Runner runs are `runner_local` ones by default. */
async function run(w: World, role: string, verdict: string, over: { runnerId?: string | null; runtime?: string; mode?: string | null; head?: string; extra?: Record<string, unknown> } = {}): Promise<void> {
  const runtime = over.runtime ?? "runner";
  await h.admin.query(
    `INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha, execution_mode, runner_id)
     VALUES ($1, $2, $3, $4, 'succeeded', $5::jsonb, $6, $7, $8)`,
    [w.accountId, w.workItemId, role, runtime, JSON.stringify({ verdict, ...(over.extra ?? {}) }), over.head ?? HEAD, over.mode === undefined ? (runtime === "runner" ? "runner_local" : "sandbox") : over.mode, over.runnerId === undefined ? (runtime === "runner" ? w.adminRunner : null) : over.runnerId],
  );
}
const passBoth = async (w: World, over: Parameters<typeof run>[3] = {}) => {
  await run(w, "code-reviewer", "pass", over);
  await run(w, "acceptance-tester", "pass", over);
};

const on: LocalReviewOptInPort = { enabled: async () => true };
const gate = (w: World, optIn: LocalReviewOptInPort = on) =>
  runMergeGateForItem({ pool: h.runWriterPool, http: fakeGitHubRest(w.gh), localReviewOptIn: optIn }, { accountId: w.accountId, workItemId: w.workItemId, prNumber: w.gh.prNumber });
const reasonsOf = (out: Awaited<ReturnType<typeof gate>>) => (out.outcome === "ready_human_merges" ? out.reasons : []);

describe("runner_local: every condition met", () => {
  it("merges on the head SHA, once, and the status reads 'Local review'", async () => {
    const w = await world();
    await passBoth(w);
    const out = await gate(w);
    expect(out).toMatchObject({ outcome: "merged", headSha: HEAD, status: "posted" });
    expect(w.gh.merges).toEqual([{ sha: HEAD, method: "squash" }]);
    expect(w.gh.posts).toHaveLength(1);
    expect(w.gh.posts[0]).toMatchObject({ sha: HEAD, body: { state: "success", context: REVIEW_STATUS_CONTEXT, description: LOCAL_REVIEW_DESCRIPTION } });
    expect(LOCAL_REVIEW_DESCRIPTION.startsWith("Local review")).toBe(true);
    expect(LOCAL_REVIEW_DESCRIPTION.length).toBeLessThanOrEqual(140);
  });

  it("a ruleset that applies to the base branch is protection too", async () => {
    const w = await world({ repo: { protectedWithoutChecks: false, rulesetRules: [{ type: "pull_request" }] } });
    await passBoth(w);
    expect((await gate(w)).outcome).toBe("merged");
  });

  it("the owner of the account counts as an admin registrant", async () => {
    const w = await world();
    const owner = await user(w.accountId, "owner");
    await passBoth(w, { runnerId: await runner(w.accountId, owner) });
    expect((await gate(w)).outcome).toBe("merged");
  });
});

describe("(a) the opt-in", () => {
  it("off (the port R2b will replace says off today): verdicts that all pass get NO merge call", async () => {
    const w = await world();
    await passBoth(w);
    const out = await gate(w, localReviewOptInOff);
    expect(out.outcome).toBe("ready_human_merges");
    expect(reasonsOf(out)).toEqual(expect.arrayContaining(["local_review_not_enabled", "run_not_production_code_reviewer", "run_not_production_acceptance_tester"]));
    expect(w.gh.merges).toEqual([]);
    expect(w.gh.posts).toEqual([]);
  });

  it("no port given at all is off", async () => {
    const w = await world();
    await passBoth(w);
    const out = await runMergeGateForItem({ pool: h.runWriterPool, http: fakeGitHubRest(w.gh) }, { accountId: w.accountId, workItemId: w.workItemId, prNumber: w.gh.prNumber });
    expect(out.outcome).toBe("ready_human_merges");
    expect(w.gh.merges).toEqual([]);
  });

  it("a port that throws, or answers anything but true, is off", async () => {
    for (const port of [{ enabled: async () => Promise.reject(new Error("db down")) }, { enabled: async () => "true" as unknown as boolean }, { enabled: async () => 1 as unknown as boolean }]) {
      const w = await world();
      await passBoth(w);
      expect((await gate(w, port)).outcome).toBe("ready_human_merges");
      expect(w.gh.merges).toEqual([]);
    }
  });

  it("with the opt-in off, even production-runtime passes do not merge a runner_local repo", async () => {
    const w = await world();
    await passBoth(w, { runtime: "production" });
    const out = await gate(w, localReviewOptInOff);
    expect(reasonsOf(out)).toContain("local_review_not_enabled");
    expect(w.gh.merges).toEqual([]);
  });

  it("asks the port about this repo and account, and only for a runner_local repo", async () => {
    const w = await world();
    await passBoth(w);
    const calls: unknown[] = [];
    await gate(w, { enabled: async (i) => (calls.push(i), true) });
    expect(calls).toEqual([{ accountId: w.accountId, repoId: w.repoId }]);
    const sandbox = await world({ executionMode: "sandbox" });
    const calls2: unknown[] = [];
    await passBoth(sandbox, { runtime: "production" });
    await gate(sandbox, { enabled: async (i) => (calls2.push(i), true) });
    expect(calls2).toEqual([]);
  });
});

describe("(b) only runners an admin registered", () => {
  it("a runner registered by a plain member is advisory: no merge", async () => {
    const w = await world();
    const member = await user(w.accountId, "member");
    await passBoth(w, { runnerId: await runner(w.accountId, member) });
    const out = await gate(w);
    expect(reasonsOf(out)).toEqual(expect.arrayContaining(["runner_not_trusted_code_reviewer", "runner_not_trusted_acceptance_tester"]));
    expect(w.gh.merges).toEqual([]);
    expect(w.gh.posts).toEqual([]);
  });

  it("a revoked runner's verdict: no merge", async () => {
    const w = await world();
    const admin = await user(w.accountId, "admin");
    await passBoth(w, { runnerId: await runner(w.accountId, admin, { revoked: true }) });
    expect(reasonsOf(await gate(w))).toEqual(expect.arrayContaining(["runner_not_trusted_code_reviewer"]));
    expect(w.gh.merges).toEqual([]);
  });

  it("the gate checks the registrant's role itself: an admin demoted after registering makes the verdict advisory", async () => {
    const w = await world();
    const admin = await user(w.accountId, "admin");
    const id = await runner(w.accountId, admin);
    await passBoth(w, { runnerId: id });
    // The revoke-on-demotion trigger is C9's; take it out of the picture by demoting with it disabled for this statement.
    await h.admin.query("BEGIN");
    try {
      await h.admin.query("ALTER TABLE account_members DISABLE TRIGGER USER");
      await h.admin.query("UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2", [w.accountId, admin]);
      await h.admin.query("ALTER TABLE account_members ENABLE TRIGGER USER");
      await h.admin.query("COMMIT");
    } catch (e) {
      await h.admin.query("ROLLBACK");
      throw e;
    }
    expect((await h.admin.query("SELECT revoked_at FROM runners WHERE id = $1", [id])).rows[0].revoked_at).toBeNull();
    expect(reasonsOf(await gate(w))).toContain("runner_not_trusted_code_reviewer");
    expect(w.gh.merges).toEqual([]);
  });

  it("a run with no runner on it (the runner row was deleted) is advisory", async () => {
    const w = await world();
    await passBoth(w, { runnerId: null });
    expect(reasonsOf(await gate(w))).toContain("runner_not_trusted_code_reviewer");
    expect(w.gh.merges).toEqual([]);
  });

  it("a runner-runtime row that is not a runner_local run (no mode, or sandbox) is advisory", async () => {
    for (const mode of [null, "sandbox"]) {
      const w = await world();
      await passBoth(w, { mode });
      expect(reasonsOf(await gate(w)), String(mode)).toContain("runner_not_trusted_code_reviewer");
      expect(w.gh.merges).toEqual([]);
    }
  });

  it("an untrusted runner's rejection of a role that is not required still blocks (it cannot be hidden)", async () => {
    const w = await world();
    await passBoth(w);
    const member = await user(w.accountId, "member");
    await run(w, "security-reviewer", "needs-fix", { runnerId: await runner(w.accountId, member) });
    expect(reasonsOf(await gate(w))).toContain("runner_not_trusted_security_reviewer");
    expect(w.gh.merges).toEqual([]);
  });

  it("a trusted runner's rejection vetoes", async () => {
    const w = await world();
    await passBoth(w);
    await run(w, "security-reviewer", "needs-fix");
    expect(reasonsOf(await gate(w))).toContain("verdict_not_pass_security_reviewer");
    expect(w.gh.merges).toEqual([]);
  });

  it("a trusted code reviewer's security flag makes the security reviewer required, as it does in the cloud", async () => {
    const w = await world();
    await run(w, "code-reviewer", "pass", { extra: { security_review_needed: true } });
    await run(w, "acceptance-tester", "pass");
    const out = await gate(w);
    expect(reasonsOf(out)).toContain("missing_run_security_reviewer");
    expect(w.gh.merges).toEqual([]);
    await run(w, "security-reviewer", "pass");
    expect((await gate(w)).outcome).toBe("merged");
  });

  it("an untrusted code reviewer's security flag is not read (and its pass does not count)", async () => {
    const w = await world();
    const member = await user(w.accountId, "member");
    await run(w, "code-reviewer", "pass", { runnerId: await runner(w.accountId, member), extra: { security_review_needed: true } });
    await run(w, "acceptance-tester", "pass");
    const reasons = reasonsOf(await gate(w));
    expect(reasons).toContain("runner_not_trusted_code_reviewer");
    expect(reasons).not.toContain("missing_run_security_reviewer");
  });

  it("only a pass on the exact head counts: a trusted pass on an older commit does not", async () => {
    const w = await world();
    await passBoth(w, { head: "b".repeat(40) });
    expect(reasonsOf(await gate(w))).toEqual(expect.arrayContaining(["missing_run_code_reviewer", "missing_run_acceptance_tester"]));
    expect(w.gh.merges).toEqual([]);
  });
});

describe("(c) GitHub still decides CI and protection", () => {
  it("CI not green: no merge, reason ci_not_green and nothing else", async () => {
    const w = await world({ repo: { checks: { [HEAD]: [greenCheck, { name: "e2e", status: "completed", conclusion: "failure" }] } } });
    await passBoth(w);
    const out = await gate(w);
    expect(reasonsOf(out)).toEqual(["ci_not_green"]);
    expect(w.gh.merges).toEqual([]);
  });

  it("a CI check still running: no merge", async () => {
    const w = await world({ repo: { checks: { [HEAD]: [{ name: "ci", status: "in_progress", conclusion: null }] } } });
    await passBoth(w);
    expect(reasonsOf(await gate(w))).toContain("ci_not_green");
    expect(w.gh.merges).toEqual([]);
  });

  it("no CI of the repo's own, only the platform's status: no merge, reason repo_ci_missing and nothing else", async () => {
    const w = await world({ repo: { checks: { [HEAD]: [] } } });
    await passBoth(w);
    const out = await gate(w);
    expect(reasonsOf(out)).toEqual(["repo_ci_missing"]);
    expect(w.gh.merges).toEqual([]);
    expect(w.gh.posts).toHaveLength(1);
  });

  it("no branch protection: no merge, reason no_branch_protection and nothing else", async () => {
    const w = await world({ repo: { protectedWithoutChecks: false } });
    await passBoth(w);
    const out = await gate(w);
    expect(reasonsOf(out)).toEqual(["no_branch_protection"]);
    expect(w.gh.merges).toEqual([]);
  });

  it("each of the three is its own reason when all fail at once (a failed check is not the repo's passing CI either)", async () => {
    const w = await world({ repo: { protectedWithoutChecks: false, checks: { [HEAD]: [{ name: "ci", status: "completed", conclusion: "failure" }] } } });
    await passBoth(w);
    const reasons = reasonsOf(await gate(w));
    expect(reasons).toEqual(expect.arrayContaining(["ci_not_green", "no_branch_protection", "repo_ci_missing"]));
  });

  it("a base branch whose protection GitHub refuses to show (403) reads as no_branch_protection: a block, not an error, and nothing merges", async () => {
    const w = await world();
    await passBoth(w);
    const http = fakeGitHubRest(w.gh);
    const refused = { request: async (req: Parameters<typeof http.request>[0]) => (req.path.includes("/protection/") ? { status: 403, body: { message: "Resource not accessible" } } : http.request(req)) };
    const out = await runMergeGateForItem({ pool: h.runWriterPool, http: refused, localReviewOptIn: on }, { accountId: w.accountId, workItemId: w.workItemId, prNumber: w.gh.prNumber });
    expect(reasonsOf(out)).toEqual(expect.arrayContaining(["no_branch_protection", "ci_not_green"]));
    expect(w.gh.merges).toEqual([]);
  });

  it("a protection read that fails any other way (500) still throws and nothing merges", async () => {
    const w = await world();
    await passBoth(w);
    const http = fakeGitHubRest(w.gh);
    const broken = { request: async (req: Parameters<typeof http.request>[0]) => (req.path.includes("/protection/") ? { status: 500, body: { message: "boom" } } : http.request(req)) };
    await expect(
      runMergeGateForItem({ pool: h.runWriterPool, http: broken, localReviewOptIn: on }, { accountId: w.accountId, workItemId: w.workItemId, prNumber: w.gh.prNumber }),
    ).rejects.toThrow(/branch protection/);
    expect(w.gh.merges).toEqual([]);
  });
});

/** A ruleset requires `slow-ci`; only `build` has passed; the classic protection read is refused, so the required checks are unknown. */
const slowCiRuleset = [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "slow-ci" }] } }] as never;
const refuse403 = (w: World) => {
  const http = fakeGitHubRest(w.gh);
  return { request: async (req: Parameters<typeof http.request>[0]) => (req.path.includes("/protection/") ? { status: 403, body: { message: "Resource not accessible" } } : http.request(req)) };
};

describe("an unreadable protection read never makes CI look greener (CWE-636)", () => {
  const input = (w: World) => ({ accountId: w.accountId, workItemId: w.workItemId, prNumber: w.gh.prNumber });

  it("cloud mode: a 403 on protection with only `build` green does not merge, though a ruleset requires slow-ci", async () => {
    const w = await world({ executionMode: "sandbox", repo: { rulesetRules: slowCiRuleset } });
    await passBoth(w, { runtime: "production" });
    const out = await runMergeGateForItem({ pool: h.runWriterPool, http: refuse403(w), localReviewOptIn: on }, input(w));
    expect(reasonsOf(out)).toContain("ci_not_green");
    expect(w.gh.merges).toEqual([]);
  });

  it("runner_local with the opt-in off: the same 403 does not merge either", async () => {
    const w = await world({ repo: { rulesetRules: slowCiRuleset } });
    await passBoth(w);
    const out = await runMergeGateForItem({ pool: h.runWriterPool, http: refuse403(w), localReviewOptIn: { enabled: async () => false } }, input(w));
    expect(reasonsOf(out)).toEqual(expect.arrayContaining(["ci_not_green", "local_review_not_enabled"]));
    expect(w.gh.merges).toEqual([]);
  });

  it("control: the same repo with a readable protection read and slow-ci missing is also blocked, and with slow-ci green it merges", async () => {
    const w = await world({ executionMode: "sandbox", repo: { requiredContexts: ["slow-ci"] } });
    await passBoth(w, { runtime: "production" });
    expect(reasonsOf(await gate(w))).toContain("ci_not_green");
    const ok = await world({ executionMode: "sandbox", repo: { requiredContexts: ["slow-ci"], checks: { [HEAD]: [greenCheck, { name: "slow-ci", status: "completed", conclusion: "success" }] } } });
    await passBoth(ok, { runtime: "production" });
    expect((await gate(ok)).outcome).toBe("merged");
  });
});

describe("a repo that is not runner_local keeps the production rule", () => {
  it("a runtime = 'runner' row is blocked, whoever registered the runner and whatever else is true", async () => {
    const w = await world({ executionMode: "sandbox" });
    await passBoth(w);
    const out = await gate(w);
    expect(reasonsOf(out)).toEqual(expect.arrayContaining(["run_not_production_code_reviewer", "run_not_production_acceptance_tester"]));
    expect(reasonsOf(out).some((r) => r.startsWith("runner_not_trusted") || r === "local_review_not_enabled")).toBe(false);
    expect(w.gh.merges).toEqual([]);
    expect(w.gh.posts).toEqual([]);
  });

  it("production rows merge it exactly as before, with the ordinary status text", async () => {
    const w = await world({ executionMode: "sandbox" });
    await passBoth(w, { runtime: "production" });
    expect((await gate(w)).outcome).toBe("merged");
    expect(w.gh.posts[0]!.body.description).toBe("Every required reviewer passed on this commit");
  });
});

describe("the stored opt-in, end to end (D#6 R2b, migration 0733)", () => {
  /** The real port over the real table; an admin turns the opt-in on or off through the one definer, as the app does. */
  const real = () => createPgLocalReviewOptIn(h.runWriterPool);
  const setOptIn = (w: World, userId: string, enabled: boolean) =>
    withTenant(h.pureAppUserPool, w.accountId, userId, (c) => c.query("SELECT repo_local_review_optin_set($1, $2)", [w.repoId, enabled]));

  it("a repo with no stored opt-in is advisory: verdicts that all pass get no merge call", async () => {
    const w = await world();
    await passBoth(w);
    const out = await gate(w, real());
    expect(reasonsOf(out)).toContain("local_review_not_enabled");
    expect(w.gh.merges).toEqual([]);
  });

  it("turned on by an admin it merges on the head SHA", async () => {
    const w = await world();
    await setOptIn(w, await user(w.accountId, "admin"), true);
    await passBoth(w);
    expect(await real().enabled({ accountId: w.accountId, repoId: w.repoId })).toBe(true);
    expect((await gate(w, real())).outcome).toBe("merged");
    expect(w.gh.merges).toEqual([{ sha: HEAD, method: "squash" }]);
  });

  it("turned off again it stops, with the verdicts unchanged", async () => {
    const w = await world();
    const owner = await user(w.accountId, "owner");
    await setOptIn(w, owner, true);
    await passBoth(w);
    await setOptIn(w, owner, false);
    expect(reasonsOf(await gate(w, real()))).toContain("local_review_not_enabled");
    expect(w.gh.merges).toEqual([]);
  });

  it("a member cannot turn it on, so nothing merges", async () => {
    const w = await world();
    await expect(setOptIn(w, await user(w.accountId, "member"), true)).rejects.toMatchObject({ code: "42501" });
    await passBoth(w);
    expect((await gate(w, real())).outcome).toBe("ready_human_merges");
    expect(w.gh.merges).toEqual([]);
  });

  it("one repo's opt-in does not count for another repo of the same account, or for another account's repo", async () => {
    const w = await world();
    const other = await world();
    await setOptIn(w, await user(w.accountId, "owner"), true);
    const sibling = randomUUID();
    await seedRepo(h.admin, w.accountId, sibling);
    await h.admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [sibling]);
    expect(await real().enabled({ accountId: w.accountId, repoId: sibling })).toBe(false);
    expect(await real().enabled({ accountId: other.accountId, repoId: other.repoId })).toBe(false);
    // Naming this account's repo from the other account's context finds nothing either.
    expect(await real().enabled({ accountId: other.accountId, repoId: w.repoId })).toBe(false);
  });

  it("a read that fails throws out of the port, and the gate reads that as off", async () => {
    const broken = createPgLocalReviewOptIn({ connect: () => Promise.reject(new Error("db down")) } as never);
    await expect(broken.enabled({ accountId: randomUUID(), repoId: randomUUID() })).rejects.toThrow("db down");
    const w = await world();
    await passBoth(w);
    expect((await gate(w, broken)).outcome).toBe("ready_human_merges");
    expect(w.gh.merges).toEqual([]);
  });
});

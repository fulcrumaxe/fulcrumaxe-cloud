import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyJob } from "@fulcrumaxe/runner-protocol";
import type { ExecutionRun } from "../src/executionTarget.js";
import { createJobIssuer, createJobSigner, createPgJobContext, type ContinuationBasePort } from "../src/targets/jobIssuer.js";
import { insertAgentRun } from "../src/runStatusWriter.js";
import { seedAccount, seedMember, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { createFakeVisibility } from "./helpers/runnerTargetFakes.js";
import { createFakeContinuationBinding, type FakeBindingState } from "./helpers/fakeContinuationBinding.js";
import { pgHarness } from "./helpers/pgHarness.js";

/** A model with no price-table entry, so no window figure: these jobs carry no `context_window`. */
const NO_WINDOW_MODEL = "windowless-model";

/**
 * D#6 CHECK-FIX-SCOPE: the cloud's check-fix start may name failed test files (the ones the check's import graph put inside the change). The issuer signs them into that one round's job `scope`, beside the
 * Spec's patterns, and nowhere else. Real Postgres and the real definers; GitHub is the fake in `helpers/fakeContinuationBinding.ts`.
 */
describe("scope: a check-fix round's job carries the cloud-counted failed files beside the Spec's list [pg] (D#6 CHECK-FIX-SCOPE)", () => {
  const db = pgHarness();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const signer = createJobSigner({ keyId: "job-key-1", privateKey });
  const NOW = new Date("2026-10-15T12:00:00.000Z");
  const ISSUE = 12;
  const OWNER = "acme";
  const REPO_GH_ID = 7001;
  const ITEM_BRANCH = `fx/issue-${ISSUE}`;
  const SPEC = ["packages/spend/src/**", "docs/a.md"];
  const FILE = "packages/worker/test/runnerUsage.pg.test.ts";
  const base: ContinuationBasePort = { headOid: async () => "a".repeat(40) };

  async function world(withSpecList = true) {
    const accountId = randomUUID();
    const userId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedMember(db.admin, accountId, userId);
    await seedRepo(db.admin, accountId, repoId, { executionMode: "runner_local" });
    await db.admin.query("UPDATE repos SET gh_owner = $2, gh_name = 'widgets' WHERE id = $1", [repoId, OWNER]);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: ISSUE });
    const body = "1. The footer shows the year.";
    await db.admin.query("INSERT INTO discussions (account_id, number, repo_id, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, 6, $2, 'feature', 'Footer', $3, 'internal', 'system')", [accountId, repoId, workItemId]);
    await db.admin.query("UPDATE work_items SET discussion_id = (SELECT id FROM discussions WHERE account_id = $1 AND root_work_item_id = $2) WHERE id = $2", [accountId, workItemId]);
    await db.admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind, frontmatter) VALUES ($1, $2, 1, $3, $4, 'system', $5::jsonb)", [accountId, workItemId, body, createHash("sha256").update(body).digest("hex"), JSON.stringify(withSpecList ? { acceptance_files: SPEC } : {})]);
    return { accountId, userId, repoId, workItemId };
  }
  type World = Awaited<ReturnType<typeof world>>;

  async function executor(w: World, parentRunId: string | null = null): Promise<ExecutionRun> {
    const id = randomUUID();
    const pin = parentRunId ? undefined : (await db.admin.query<{ id: string }>("SELECT id FROM spec_versions WHERE work_item_id = $1 ORDER BY version DESC LIMIT 1", [w.workItemId])).rows[0]?.id;
    await insertAgentRun(db.runWriterPool, { id, accountId: w.accountId, workItemId: w.workItemId, parentRunId, ...(pin ? { specVersionId: pin } : {}), role: "executor", runtime: "runner", executionMode: "runner_local", dispatchRepoId: w.repoId, initiatedBy: w.userId });
    return { id, accountId: w.accountId, workItemId: w.workItemId, parentRunId, role: "executor", product: "team", repoId: w.repoId, headSha: null, roleCard: "You are the executor.\n", prompt: "Fix the failing test.\n", model: NO_WINDOW_MODEL, capUsd: 0, spend: { plan: "starter", estimateComputeUsd: 0, trigger: "foreground" } };
  }

  const openPull = (over: Partial<FakeBindingState["pulls"][number]> = {}): FakeBindingState["pulls"][number] => ({ number: 41, state: "open", headRepoId: REPO_GH_ID, baseRepoId: REPO_GH_ID, headRef: ITEM_BRANCH, headOwner: OWNER, ...over });

  const issuerWith = (binding: ReturnType<typeof createFakeContinuationBinding>) =>
    createJobIssuer({ pool: db.runWriterPool, signer, visibility: createFakeVisibility("private"), context: createPgJobContext(db.runWriterPool), continuationBase: base, continuationBinding: binding, now: () => NOW, newId: () => "7b9d1c6e-4f0a-4c53-9a58-2f0d5b6c3a11" });

  const row = async (id: string) => (await db.admin.query<{ job_signed: unknown }>("SELECT job_signed FROM agent_runs WHERE id = $1", [id])).rows[0]!;
  const approveCheck = (w: World) => db.admin.query("INSERT INTO repo_runner_sandbox_allowances (account_id, repo_id, version, entries, command_timeout_s, set_sha256, set_aside, approved_by, check_argv, check_dev_shell, check_timeout_s) VALUES ($1, $2, 1, $6::jsonb, 900, $3, false, $4, $5, true, 5400)", [w.accountId, w.repoId, "e".repeat(64), w.userId, ["bash", "scripts/check.sh"], JSON.stringify([{ kind: "domain", value: "registry.npmjs.org", access: "connect", reason: "pnpm install fetches the locked packages" }])]);
  const scopeOf = async (id: string) => verifyJob((await row(id)).job_signed, { "job-key-1": publicKey }, { now: NOW }).scope;

  async function issue(extra: readonly string[] | undefined, kind: "check_fix" | "review_fix" | undefined, withSpecList = true) {
    const w = await world(withSpecList);
    const parent = await executor(w);
    const run = await executor(w, parent.id);
    await approveCheck(w);
    const started = { ...run, ...(kind ? { fixRoundKind: kind } : {}), ...(extra ? { scopeExtra: extra } : {}) };
    await issuerWith(createFakeContinuationBinding({ pulls: [openPull()] })).issue({ run: started, continues: { parentRunId: parent.id, sessionId: null, branch: ITEM_BRANCH, prNumber: 41 } });
    return { w, run };
  }

  it("a check-fix round gets the Spec's patterns plus the named file", async () => {
    const { run } = await issue([FILE], "check_fix");
    expect(await scopeOf(run.id)).toEqual([...SPEC, FILE]);
  });

  it("the Spec's own row is not changed", async () => {
    const { w } = await issue([FILE], "check_fix");
    const stored = (await db.admin.query<{ frontmatter: { acceptance_files: string[] } }>("SELECT frontmatter FROM spec_versions WHERE work_item_id = $1", [w.workItemId])).rows[0]!;
    expect(stored.frontmatter.acceptance_files).toEqual(SPEC);
  });

  it("a check-fix round with nothing named keeps the Spec's list alone", async () => {
    const { run } = await issue(undefined, "check_fix");
    expect(await scopeOf(run.id)).toEqual(SPEC);
  });

  it.each([
    ["a review fix round", "review_fix" as const],
    ["a round with no kind (a build, a merge update)", undefined],
  ])("%s gets no widening even if the start named files", async (_name, kind) => {
    const { run } = await issue([FILE], kind);
    expect(await scopeOf(run.id)).toEqual(SPEC);
  });

  it("a Spec with no readable list gets no scope at all, so nothing is added to it", async () => {
    const { run } = await issue([FILE], "check_fix", false);
    expect(await scopeOf(run.id)).toBeUndefined();
  });

  it("only plain files pass: dot segments, an absolute path, globs, braces and spaces are dropped; a duplicate and a Spec entry are not listed twice", async () => {
    const { run } = await issue(["../test/x.ts", "a/../test/b.ts", "/abs/test/path.ts", "packages/**", "packages/a/*.test.*", "a/{b,c}.test.ts", "a b.test.ts", "docs/a.md", "packages/worker/src/usage.ts", "packages/worker/test/vitest.config.ts", FILE, FILE], "check_fix");
    expect(await scopeOf(run.id)).toEqual([...SPEC, FILE]);
  });

  it("at most 20 files are added", async () => {
    const many = Array.from({ length: 40 }, (_v, n) => `packages/worker/test/t${String(n).padStart(2, "0")}.test.ts`);
    const { run } = await issue(many, "check_fix");
    expect(await scopeOf(run.id)).toEqual([...SPEC, ...many.slice(0, 20)]);
  });
});

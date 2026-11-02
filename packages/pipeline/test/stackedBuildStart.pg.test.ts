import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { startBuildForItem } from "../src/advance/buildTesting.js";
import type { StackBasePort, StackParentFacts } from "../src/advance/stackBase.js";
import type { AdvanceRunOutcome, AdvanceRunPorts, AdvanceRunRequest, AdvanceRunStart } from "../src/advance/runPorts.js";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedAccount, seedRepo } from "./build/helpers/seed.js";

/**
 * D#598 P3b [pg] (body acceptance 10 and 11, C1 item 1): an item with a `stack_parent_id` starts its executor from the parent's open
 * pull request head, or is refused with a fixed reason. The fixture is a plain customer repo: no pairing row, no plan, no allowlist, a
 * repository that is not ours, so the same path is proven for every connected repo.
 */
const h = pgHarness();
const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);

class World implements AdvanceRunPorts {
  readonly requests: AdvanceRunRequest[] = [];
  private readonly byStep = new Map<string, string>();
  constructor(
    private readonly accountId: string,
    private readonly workItemId: string,
  ) {}
  async startRun(req: AdvanceRunRequest): Promise<AdvanceRunStart> {
    this.requests.push(req);
    const known = this.byStep.get(req.step);
    if (known) return { ok: true, runId: known };
    const id = randomUUID();
    await h.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, $4, 'production', 'running')`, [id, this.accountId, this.workItemId, req.role]);
    this.byStep.set(req.step, id);
    return { ok: true, runId: id };
  }
  async findStep(prefix: string): Promise<{ step: string; runId: string } | null> {
    for (const [step, runId] of this.byStep) if (step === prefix) return { step, runId };
    return null;
  }
  async outcome(): Promise<AdvanceRunOutcome> {
    return { status: "running", done: false, envelope: null };
  }
  async cancel(): Promise<void> {}
}

class Github implements StackBasePort {
  reads: Array<{ repoId: string; owner: string; name: string; prNumber: number }> = [];
  constructor(private readonly answer: () => Promise<StackParentFacts> | StackParentFacts) {}
  async readParent(input: { repoId: string; owner: string; name: string; prNumber: number }): Promise<StackParentFacts> {
    this.reads.push(input);
    return this.answer();
  }
}
const openParent = (over: Partial<StackParentFacts> = {}): StackParentFacts => ({ state: "open", merged: false, headSha: HEAD, headRef: "fx/issue-41", headInBaseRepo: true, branchTipSha: HEAD, ...over });

async function item(accountId: string, repoId: string, ghNumber: number, stage: string): Promise<string> {
  const id = randomUUID();
  await h.admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, gh_number) VALUES ($1, $2, $3, 'bug', 'internal', $4)`, [id, accountId, repoId, ghNumber]);
  await h.admin.query(
    `INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind, frontmatter) VALUES ($1, $2, 1, 'Do the thing.', encode(sha256(convert_to('Do the thing.', 'UTF8')), 'hex'), 'system', '{}'::jsonb)`,
    [accountId, id],
  );
  await h.admin.query("UPDATE work_items SET stage = $2 WHERE id = $1", [id, stage]);
  return id;
}

/**
 * `parentStage` defaults to `needs_human`: an item with an open pull request that holds no build slot. Until D#483 S5-j lifts the
 * one-build-per-repository clamp, a parent in `pr_opened` holds the repository's only slot and the child's start waits (the last test pins that).
 */
async function stackedWorld(opts: { parentPr?: number | null; executionMode?: string; parentStage?: string } = {}) {
  const accountId = randomUUID();
  await seedAccount(h.admin, accountId);
  const repoId = randomUUID();
  await seedRepo(h.admin, accountId, repoId);
  await h.admin.query("UPDATE repos SET gh_owner = 'customer-co', gh_name = 'storefront' WHERE id = $1", [repoId]);
  if (opts.executionMode) await h.admin.query("UPDATE repos SET execution_mode = $2 WHERE id = $1", [repoId, opts.executionMode]);
  const parentId = await item(accountId, repoId, 41, opts.parentStage ?? "needs_human");
  const parentPr = opts.parentPr === undefined ? 41 : opts.parentPr;
  if (parentPr !== null) {
    await h.admin.query(
      `INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha, dispatch_repo_id, dispatch_pr_number) VALUES ($1, $2, 'code-reviewer', 'production', 'succeeded', '{"verdict":"pass"}'::jsonb, $3, $4, $5)`,
      [accountId, parentId, HEAD, repoId, parentPr],
    );
  }
  const childId = await item(accountId, repoId, 42, "spec_ready");
  await h.admin.query("UPDATE work_items SET stack_parent_id = $2 WHERE id = $1", [childId, parentId]);
  return { accountId, repoId, parentId, childId, world: new World(accountId, childId) };
}

const start = (t: Awaited<ReturnType<typeof stackedWorld>>, port: StackBasePort | undefined, approval = randomUUID()) =>
  startBuildForItem(h.runWriterPool, t.accountId, t.childId, approval, t.world, port ? { stackBase: port } : {});
const stageOf = async (id: string) => (await h.admin.query<{ stage: string }>("SELECT stage FROM work_items WHERE id = $1", [id])).rows[0]!.stage;

describe("D#598 P3b: a stacked child's executor starts from the parent's open pull request head", () => {
  it("the fetched tip equals the pull request's head: the run starts, its prompt checks out that commit and opens the pull request against the parent's branch; the item moves to in_progress", async () => {
    const t = await stackedWorld();
    const gh = new Github(() => openParent());
    const out = await start(t, gh);
    expect(out).toMatchObject({ status: "started", branch: "fx/issue-42" });
    expect(gh.reads).toEqual([{ repoId: t.repoId, owner: "customer-co", name: "storefront", prNumber: 41 }]);
    const prompt = t.world.requests[0]!.prompt;
    expect(prompt).toContain(`test "$(git rev-parse origin/fx/issue-41)" = "${HEAD}"`);
    expect(prompt).toContain("BASE=fx/issue-41");
    expect(prompt).toContain('git checkout -b fx/issue-42 "origin/$BASE"');
    expect(prompt).toContain(`"base":"'"$BASE"'"`);
    expect(await stageOf(t.childId)).toBe("in_progress");
  });

  it("D#519 MQ4-b0: the run's recorded start commit (head_sha) is the parent head it was told to build on; a default-branch start records none", async () => {
    const t = await stackedWorld();
    await start(t, new Github(() => openParent()));
    expect(t.world.requests[0]!.headSha).toBe(HEAD);
    const merged = await stackedWorld();
    await start(merged, new Github(() => openParent({ state: "closed", merged: true })));
    expect(merged.world.requests[0]!.headSha).toBeUndefined();
  });

  it("the fetched tip differs from the pull request's head: refused with a reason, no run, the item stays at spec_ready", async () => {
    const t = await stackedWorld();
    const out = await start(t, new Github(() => openParent({ branchTipSha: MOVED })));
    expect(out).toEqual({ status: "refused", reason: "stack_parent_head_moved" });
    expect(t.world.requests).toEqual([]);
    expect(await stageOf(t.childId)).toBe("spec_ready");
    expect((await h.admin.query("SELECT 1 FROM agent_runs WHERE work_item_id = $1", [t.childId])).rowCount).toBe(0);
  });

  it.each([
    ["the parent's pull request was closed without merging", { state: "closed" as const }, "stack_parent_closed"],
    ["the parent's branch is in a fork", { headInBaseRepo: false }, "stack_parent_branch_unusable"],
    ["the parent's branch name is not safe for a command line", { headRef: "x; curl evil" }, "stack_parent_branch_unusable"],
    ["GitHub's head sha is not a commit id", { headSha: "nope" }, "stack_parent_unreadable"],
  ])("%s: refused with %s's fixed code, nothing started", async (_n, over, reason) => {
    const t = await stackedWorld();
    expect(await start(t, new Github(() => openParent(over)))).toEqual({ status: "refused", reason });
    expect(t.world.requests).toEqual([]);
    expect(await stageOf(t.childId)).toBe("spec_ready");
  });

  it("the parent already merged: the child builds on the default branch, with the prompt every item has", async () => {
    const t = await stackedWorld();
    expect(await start(t, new Github(() => openParent({ state: "closed", merged: true })))).toMatchObject({ status: "started" });
    const prompt = t.world.requests[0]!.prompt;
    expect(prompt).toContain("BASE=$(git rev-parse --abbrev-ref HEAD)");
    expect(prompt).not.toContain("refs/remotes/origin");
  });

  it("GitHub cannot be read: refused as unreadable, never started from the default branch", async () => {
    const t = await stackedWorld();
    const out = await start(t, new Github(() => Promise.reject(new Error("GitHub 502"))));
    expect(out).toEqual({ status: "refused", reason: "stack_parent_unreadable" });
    expect(t.world.requests).toEqual([]);
  });

  it("a start wired without the GitHub reader is refused, not built from main", async () => {
    const t = await stackedWorld();
    expect(await start(t, undefined)).toEqual({ status: "refused", reason: "stack_base_unavailable" });
    expect(t.world.requests).toEqual([]);
  });

  it("the parent has no pull request yet (its runs name none): refused without asking GitHub", async () => {
    const t = await stackedWorld({ parentPr: null });
    const gh = new Github(() => openParent());
    expect(await start(t, gh)).toEqual({ status: "refused", reason: "stack_parent_no_pull_request" });
    expect(gh.reads).toEqual([]);
    expect(t.world.requests).toEqual([]);
  });

  it("a runner repository is refused: the platform opens that pull request against the default branch, so the stack would not hold", async () => {
    const t = await stackedWorld({ executionMode: "runner_local" });
    // A runner build needs the Spec's file list before anything else is asked.
    await h.admin.query("UPDATE spec_versions SET frontmatter = '{\"acceptance_files\":[\"src/app.ts\"]}'::jsonb WHERE work_item_id = $1", [t.childId]);
    const gh = new Github(() => openParent());
    expect(await start(t, gh)).toEqual({ status: "refused", reason: "stack_runtime_unsupported" });
    expect(gh.reads).toEqual([]);
    expect(t.world.requests).toEqual([]);
  });

  it("an item with no stack parent never asks GitHub and builds as before", async () => {
    const t = await stackedWorld();
    await h.admin.query("UPDATE work_items SET stack_parent_id = NULL WHERE id = $1", [t.childId]);
    const gh = new Github(() => openParent());
    expect(await start(t, gh)).toMatchObject({ status: "started" });
    expect(gh.reads).toEqual([]);
    expect(t.world.requests[0]!.prompt).toContain("BASE=$(git rev-parse --abbrev-ref HEAD)");
  });

  it("a replay of the same approval after the run exists finds its run and reads nothing: a parent that moved since does not undo a started build", async () => {
    const t = await stackedWorld();
    const approval = randomUUID();
    const first = await start(t, new Github(() => openParent()), approval);
    expect(first).toMatchObject({ status: "started" });
    const gh = new Github(() => openParent({ branchTipSha: MOVED }));
    const again = await start(t, gh, approval);
    expect(again).toMatchObject({ status: "started", runId: (first as { runId: string }).runId });
    expect(gh.reads).toEqual([]);
  });

  it("while the parent holds the repository's only build slot (pr_opened), the start waits on the existing slot rule, after the stack check passed; nothing is built", async () => {
    const t = await stackedWorld({ parentStage: "pr_opened" });
    expect(await start(t, new Github(() => openParent()))).toEqual({ status: "refused", reason: "one_build_per_repo_until_d598" });
    expect(t.world.requests).toEqual([]);
    expect(await stageOf(t.childId)).toBe("spec_ready");
  });

  it("another account cannot be read through the link: a parent in another account is not a parent (row security)", async () => {
    const t = await stackedWorld();
    const other = await stackedWorld();
    await expect(h.admin.query("UPDATE work_items SET stack_parent_id = $2 WHERE id = $1", [t.childId, other.parentId])).rejects.toThrow();
  });
});

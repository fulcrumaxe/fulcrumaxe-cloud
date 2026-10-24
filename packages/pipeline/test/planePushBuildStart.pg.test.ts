import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedAccount, seedRepo } from "./build/helpers/seed.js";
import { startBuildForItem } from "../src/advance/buildTesting.js";
import { branchNameOk } from "@fulcrumaxe/runner-protocol/planePush";
import type { AdvanceRunOutcome, AdvanceRunPorts, AdvanceRunRequest, AdvanceRunStart } from "../src/advance/runPorts.js";

/**
 * D#598 P1f-1 [pg]: starting a build writes the item's public-change record on a paired repo, and nothing on an unpaired one. The ports are
 * a small world that behaves like the worker's: a step key names one run.
 */
const h = pgHarness();

const BASE = "a".repeat(40);
const planeBase = { defaultHead: async () => BASE };

class World implements AdvanceRunPorts {
  private readonly byStep = new Map<string, string>();
  /** What each start asked for, in order. */
  readonly starts: AdvanceRunRequest[] = [];
  constructor(
    private readonly accountId: string,
    private readonly workItemId: string,
  ) {}
  async startRun(req: AdvanceRunRequest): Promise<AdvanceRunStart> {
    this.starts.push(req);
    const known = this.byStep.get(req.step);
    if (known) return { ok: true, runId: known };
    const id = randomUUID();
    await h.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, $4, 'production', 'running')`, [id, this.accountId, this.workItemId, req.role]);
    this.byStep.set(req.step, id);
    return { ok: true, runId: id };
  }
  async findStep(prefix: string): Promise<{ step: string; runId: string } | null> {
    for (const [step, runId] of this.byStep) if (step === prefix || step.startsWith(`${prefix}:n`)) return { step, runId };
    return null;
  }
  async outcome(): Promise<AdvanceRunOutcome> {
    return { status: "running", done: false, envelope: null };
  }
  async cancel(): Promise<void> {}
}

async function atSpecReady(paired: boolean) {
  const accountId = randomUUID();
  await seedAccount(h.admin, accountId);
  const repoId = randomUUID();
  await seedRepo(h.admin, accountId, repoId);
  await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [repoId]);
  if (paired) await h.admin.query(`INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, 'acme/widgets-public', ARRAY['docs/ops/'])`, [repoId, accountId]);
  const workItemId = randomUUID();
  await h.admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, gh_number) VALUES ($1, $2, $3, 'bug', 'internal', 41)`, [workItemId, accountId, repoId]);
  await h.admin.query(
    `INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind, frontmatter) VALUES ($1, $2, 1, 'Do the thing.', encode(sha256(convert_to('Do the thing.', 'UTF8')), 'hex'), 'system', '{}'::jsonb)`,
    [accountId, workItemId],
  );
  await h.admin.query("UPDATE work_items SET stage = 'spec_ready' WHERE id = $1", [workItemId]);
  return { accountId, workItemId, world: new World(accountId, workItemId) };
}
const rowsOf = async (workItemId: string) => (await h.admin.query(`SELECT id, code_repo, pairing_digest, branch, state FROM plane_pushes WHERE work_item_id = $1`, [workItemId])).rows;

describe("build start and the public-change record (D#598 P1f-1)", () => {
  it("on a paired repo one row is written with the repo, the digest and branch fx/p-<id>, and a second approval does not add another", async () => {
    const t = await atSpecReady(true);
    const out = await startBuildForItem(h.runWriterPool, t.accountId, t.workItemId, randomUUID(), t.world, { planeBase });
    expect(out).toMatchObject({ status: "started" });
    const rows = await rowsOf(t.workItemId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ code_repo: "acme/widgets-public", state: "building" });
    expect(rows[0].pairing_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].branch).toBe(`fx/p-${rows[0].id}`);
    expect(branchNameOk(rows[0].branch)).toBe(true);
    // Build again after a failure: the same run key replay finds the row, a fresh approval re-stamps the same row.
    await h.admin.query("UPDATE work_items SET stage = 'needs_human' WHERE id = $1", [t.workItemId]);
    await startBuildForItem(h.runWriterPool, t.accountId, t.workItemId, randomUUID(), t.world, { planeBase });
    expect(await rowsOf(t.workItemId)).toHaveLength(1);
  });

  it("on an unpaired repo it writes no row (count 0) and the start is the same", async () => {
    const t = await atSpecReady(false);
    const out = await startBuildForItem(h.runWriterPool, t.accountId, t.workItemId, randomUUID(), t.world);
    expect(out).toMatchObject({ status: "started" });
    expect(await rowsOf(t.workItemId)).toHaveLength(0);
  });

  it("a replay of the same step leaves a row a run already moved on exactly as it is", async () => {
    const t = await atSpecReady(true);
    const approval = randomUUID();
    await startBuildForItem(h.runWriterPool, t.accountId, t.workItemId, approval, t.world, { planeBase });
    await h.admin.query("UPDATE plane_pushes SET state = 'scanning' WHERE work_item_id = $1", [t.workItemId]);
    await startBuildForItem(h.runWriterPool, t.accountId, t.workItemId, approval, t.world, { planeBase });
    expect((await rowsOf(t.workItemId))[0]).toMatchObject({ state: "scanning" });
  });
});

describe("a paired sandbox build records its base (D#598 P1f-5c)", () => {
  it("passes the default branch's head as the run's head_sha and builds the paired prompt on exactly it", async () => {
    const t = await atSpecReady(true);
    await startBuildForItem(h.runWriterPool, t.accountId, t.workItemId, randomUUID(), t.world, { planeBase });
    expect(t.world.starts).toHaveLength(1);
    expect(t.world.starts[0]).toMatchObject({ role: "executor", headSha: BASE });
    expect(t.world.starts[0]!.prompt).toContain(`git fetch --depth 1 origin ${BASE}`);
    expect(t.world.starts[0]!.prompt).not.toContain("/pulls");
  });

  it("an unpaired build sets no head_sha, reads no head, and keeps the pull request step", async () => {
    const t = await atSpecReady(false);
    let reads = 0;
    await startBuildForItem(h.runWriterPool, t.accountId, t.workItemId, randomUUID(), t.world, { planeBase: { defaultHead: async () => (reads++, BASE) } });
    expect(reads).toBe(0);
    expect(t.world.starts[0]!.headSha).toBeUndefined();
    expect(t.world.starts[0]!.prompt).toContain("/pulls");
  });

  it.each([
    ["no port at all", undefined],
    ["a head that cannot be read", { defaultHead: async () => Promise.reject(new Error("github down")) }],
    ["a repository with no head", { defaultHead: async () => null }],
    ["an answer that is not a full sha", { defaultHead: async () => "main" }],
  ])("%s refuses plane_base_unavailable: no run is started, no record is written, and the item stays at Spec ready", async (_label, port) => {
    const t = await atSpecReady(true);
    const out = await startBuildForItem(h.runWriterPool, t.accountId, t.workItemId, randomUUID(), t.world, port ? { planeBase: port } : {});
    expect(out).toEqual({ status: "refused", reason: "plane_base_unavailable" });
    expect(t.world.starts).toEqual([]);
    expect(await rowsOf(t.workItemId)).toHaveLength(0);
    expect((await h.admin.query("SELECT stage FROM work_items WHERE id = $1", [t.workItemId])).rows[0].stage).toBe("spec_ready");
  });

  it("a replay of the step finds its run and reads no head again", async () => {
    const t = await atSpecReady(true);
    const approval = randomUUID();
    await startBuildForItem(h.runWriterPool, t.accountId, t.workItemId, approval, t.world, { planeBase });
    let reads = 0;
    const out = await startBuildForItem(h.runWriterPool, t.accountId, t.workItemId, approval, t.world, { planeBase: { defaultHead: async () => (reads++, BASE) } });
    expect(out).toMatchObject({ status: "started" });
    expect(reads).toBe(0);
  });
});

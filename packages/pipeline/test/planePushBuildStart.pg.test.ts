import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedAccount, seedRepo } from "./build/helpers/seed.js";
import { startBuildForItem } from "../src/advance/build.js";
import { branchNameOk } from "@fulcrumaxe/runner-protocol/planePush";
import type { AdvanceRunOutcome, AdvanceRunPorts, AdvanceRunRequest, AdvanceRunStart } from "../src/advance/runPorts.js";

/**
 * D#598 P1f-1 [pg]: starting a build writes the item's public-change record on a paired repo, and nothing on an unpaired one. The ports are
 * a small world that behaves like the worker's: a step key names one run.
 */
const h = pgHarness();

class World implements AdvanceRunPorts {
  private readonly byStep = new Map<string, string>();
  constructor(
    private readonly accountId: string,
    private readonly workItemId: string,
  ) {}
  async startRun(req: AdvanceRunRequest): Promise<AdvanceRunStart> {
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
    const out = await startBuildForItem(h.runWriterPool, t.accountId, t.workItemId, randomUUID(), t.world);
    expect(out).toMatchObject({ status: "started" });
    const rows = await rowsOf(t.workItemId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ code_repo: "acme/widgets-public", state: "building" });
    expect(rows[0].pairing_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].branch).toBe(`fx/p-${rows[0].id}`);
    expect(branchNameOk(rows[0].branch)).toBe(true);
    // Build again after a failure: the same run key replay finds the row, a fresh approval re-stamps the same row.
    await h.admin.query("UPDATE work_items SET stage = 'needs_human' WHERE id = $1", [t.workItemId]);
    await startBuildForItem(h.runWriterPool, t.accountId, t.workItemId, randomUUID(), t.world);
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
    await startBuildForItem(h.runWriterPool, t.accountId, t.workItemId, approval, t.world);
    await h.admin.query("UPDATE plane_pushes SET state = 'scanning' WHERE work_item_id = $1", [t.workItemId]);
    await startBuildForItem(h.runWriterPool, t.accountId, t.workItemId, approval, t.world);
    expect((await rowsOf(t.workItemId))[0]).toMatchObject({ state: "scanning" });
  });
});

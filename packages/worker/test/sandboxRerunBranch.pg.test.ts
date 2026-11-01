import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { insertAgentRun, recordBuildBranch, writeRunStatus, type CancelResult, type ExecutionRun, type ExecutionTargetRegistry, type StartAgentRunInput } from "@fx/runner";
import { RUNNER_RUN_BRANCH } from "@fulcrumaxe/runner-protocol";
import { sandboxRunBranch } from "@fx/core/src/work-items/buildIdentity.js";
import { SANDBOX_RERUN_BRANCH_SCHEME } from "@fx/pipeline";
import { startBuildForItem } from "@fx/pipeline/testing/build";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { nonChildUuid } from "@fx/db/test/helpers/branchIds.js";
import { createAdvanceModule } from "../src/advance.js";
import type { RunStarter } from "../src/preview.js";
import type { SeatResult } from "../src/seat.js";

/**
 * [pg] SANDBOX-RERUN-BRANCH-a, criteria 1 to 3 and 12: a sandbox Build again pushes a branch of its own, `fx/<run id>-g1`, and nothing forced; a first build keeps the item's fixed name; one step
 * names one branch; the branch is recorded once, in the run's create transaction. Real Postgres, the real build step with its real step key (`advanceBuild`), the real worker start (`advanceStartRun`),
 * and the real run insert with its create-transaction hook. The only fake is the starter's launch, which does what the platform's starter does with the input (a keyed insert that honours `runId`).
 * What it cannot show is a sandbox actually running the prompt's `git push`.
 */
describe("sandbox rerun branch [pg]", { timeout: 120_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });

  const SEAT: SeatResult = {
    ok: true,
    seat: {
      repoId: "unused",
      product: "team",
      roleCard: "card",
      model: "haiku-4.5",
      capUsd: 5,
      spend: { plan: "starter", purpose: "run", trigger: "foreground", estimateModelUsd: 5, estimateComputeUsd: 0.5, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 5 },
      limits: { maxRunMs: 30 * 60_000, maxTurns: 100, maxModelCalls: 300, meteringSilenceMs: 15 * 60_000 },
      timeoutMs: 40 * 60_000,
      maxExtensions: 3,
    } as never,
  };
  const registry = { sandbox: { cancel: async (_run: ExecutionRun): Promise<CancelResult> => ({ settled_usd: 0, released_usd: 0 }) } } as unknown as ExecutionTargetRegistry;
  let nextNumber = 9800;
  let nextDiscussion = 980;

  function module(opts: { mode?: string; race?: boolean } = {}) {
    const started: StartAgentRunInput[] = [];
    let raced = false;
    const starter: RunStarter = {
      async start(input) {
        started.push(input);
        if (opts.race && !raced) {
          // A racing replay of the same step: another caller's start wins between this caller's look for its run and its start. The winner chose its own id, so its branch is `fx/<its id>-g1`.
          raced = true;
          const { id: winner } = await insertAgentRun(writerPool, {
            id: randomUUID(), accountId: input.accountId, workItemId: input.workItemId, role: "executor", runtime: "production", executionMode: "sandbox", dispatchRepoId: input.repoId, dispatchPrNumber: input.pr ?? null, idempotency: input.idempotency,
            inCreateTransaction: async (client, runId) => void (await recordBuildBranch(client, input.accountId, runId, sandboxRunBranch(runId))),
          });
          await writeRunStatus(writerPool, { accountId: input.accountId, runId: winner, from: "pending", to: "running" });
        }
        const known = await admin.query<{ run_id: string }>("SELECT run_id FROM agent_run_idempotency_keys WHERE account_id = $1 AND idempotency_key = $2", [input.accountId, input.idempotency!.key]);
        if (known.rows[0]) return { runId: known.rows[0].run_id };
        const mode = opts.mode ?? "sandbox";
        const { id } = await insertAgentRun(writerPool, {
          id: input.runId ?? randomUUID(),
          accountId: input.accountId,
          workItemId: input.workItemId,
          ...(input.specVersionId ? { specVersionId: input.specVersionId } : {}),
          role: "executor",
          runtime: mode === "sandbox" ? "production" : "runner",
          executionMode: mode,
          dispatchRepoId: input.repoId,
          dispatchPrNumber: input.pr ?? null,
          idempotency: input.idempotency,
          inCreateTransaction: input.inCreateTransaction,
        });
        await writeRunStatus(writerPool, { accountId: input.accountId, runId: id, from: "pending", to: "running" });
        return { runId: id };
      },
    };
    const m = createAdvanceModule(writerPool, { starter, resolveRunSeat: vi.fn(async () => SEAT), startAdvance: async () => undefined, triage: null, registry, build: startBuildForItem });
    return { module: m, started };
  }

  async function setup(o: { mode?: string } = {}) {
    const a: SeedRefs = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets', execution_mode = $2 WHERE id = $1", [a.repoId, o.mode ?? "sandbox"]);
    await admin.query("UPDATE account_members SET role = 'owner' WHERE account_id = $1 AND user_id = $2", [a.accountId, a.userId]);
    const w = randomUUID();
    const n = nextNumber++;
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'issue', 'internal', 'spec_ready', $4)", [w, a.accountId, a.repoId, n]);
    const d = randomUUID();
    await admin.query("INSERT INTO discussions (id, account_id, number, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, $2, $3, 'small', 'T', $4, 'internal', 'user')", [d, a.accountId, nextDiscussion++, w]);
    await admin.query("UPDATE work_items SET discussion_id = $1 WHERE id = $2", [d, w]);
    await admin.query(
      "INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, frontmatter, created_by_kind) VALUES ($1, $2, 1, 'spec', encode(sha256(convert_to('spec', 'UTF8')), 'hex'), $3::jsonb, 'system')",
      [a.accountId, w, JSON.stringify({ acceptance_files: ["src/a.ts"] })],
    );
    return { a, w, n, who: { accountId: a.accountId, userId: a.userId, workItemId: w, haltEpoch: 0 } };
  }

  const build = async (t: Awaited<ReturnType<typeof setup>>, m: ReturnType<typeof module>, approval = randomUUID()) => {
    const out = await m.module.advanceBuild(t.who, approval);
    expect(out).toMatchObject({ status: "started" });
    return { out: out as { runId: string; branch: string }, input: m.started[m.started.length - 1]! };
  };
  const failBuild = async (t: Awaited<ReturnType<typeof setup>>, runId: string) => {
    await admin.query("UPDATE agent_runs SET status = 'failed', ended_at = now() WHERE id = $1", [runId]);
    await admin.query("UPDATE work_items SET stage = 'needs_human' WHERE id = $1", [t.w]);
  };
  const recordsOf = async (runId: string): Promise<string[]> => (await admin.query("SELECT payload->>'branch' AS b FROM run_events WHERE run_id = $1 AND kind = 'build.branch' ORDER BY seq", [runId])).rows.map((r) => r.b);

  it("criterion 12: the scheme constant is 1, the version the rule below is written for (change both together)", () => {
    expect(SANDBOX_RERUN_BRANCH_SCHEME).toBe(1);
  });

  it("criterion 1 and 3: a first build keeps fx/issue-<n> and records it; Build again pushes fx/<its run id>-g1 with no force, and records exactly that", async () => {
    const t = await setup();
    const m = module();
    const first = await build(t, m);
    const fixed = `fx/issue-${t.n}`;
    expect(first.out.branch).toBe(fixed);
    expect(first.input.prompt).toContain(`git checkout -b ${fixed}`);
    expect(first.input.prompt).toContain(`git push origin ${fixed}`);
    expect(await recordsOf(first.out.runId)).toEqual([fixed]);

    await failBuild(t, first.out.runId);
    const again = await build(t, m);
    const { runId, branch } = again.out;
    expect(runId).not.toBe(first.out.runId);
    expect(branch).toBe(`fx/${runId}-g1`);
    expect(RUNNER_RUN_BRANCH.test(branch)).toBe(true);
    expect(again.input.runId).toBe(runId);
    expect(again.input.prompt).toContain(`git checkout -b ${branch}`);
    expect(again.input.prompt).toContain(`git push origin ${branch}`);
    expect(again.input.prompt).not.toMatch(/--force|checkout -B|earlier attempt at this issue may have left/);
    expect(again.input.prompt).not.toContain(fixed);
    expect(await recordsOf(runId)).toEqual([branch]);
    expect(await recordsOf(first.out.runId)).toEqual([fixed]);
  });

  it("criterion 2: two calls of the same step start one run and name one branch; a different attempt (needs a person, build again) names a different branch", async () => {
    const t = await setup();
    const m = module();
    const first = await build(t, m);
    await failBuild(t, first.out.runId);
    const approval = randomUUID();
    const a = await build(t, m, approval);
    const replay = await build(t, m, approval);
    expect(replay.out).toEqual(a.out);
    expect((await admin.query("SELECT 1 FROM agent_runs WHERE work_item_id = $1", [t.w])).rowCount).toBe(2);
    expect(await recordsOf(a.out.runId)).toEqual([a.out.branch]);
    await failBuild(t, a.out.runId);
    const b = await build(t, m);
    expect(new Set([first.out.branch, a.out.branch, b.out.branch]).size).toBe(3);
    expect(b.out.branch).toBe(`fx/${b.out.runId}-g1`);
  });

  it("criterion 3: the record is written once; a second write adds no row, and a branch that is not the run's own or the item's fixed name is refused", async () => {
    const t = await setup();
    const m = module();
    const { out } = await build(t, m);
    const before = await recordsOf(out.runId);
    expect(await recordBuildBranch(admin, t.a.accountId, out.runId, out.branch)).toBe(false);
    expect(await recordBuildBranch(admin, t.a.accountId, out.runId, `fx/issue-${t.n}`)).toBe(false);
    expect(await recordsOf(out.runId)).toEqual(before);
    await expect(recordBuildBranch(admin, t.a.accountId, out.runId, `fx/${nonChildUuid()}-g1`)).rejects.toThrow(/not a build branch/);
    await expect(recordBuildBranch(admin, t.a.accountId, out.runId, "main")).rejects.toThrow(/not a build branch/);
  });

  /**
   * A GitHub that enforces what the real one does for a branch the earlier attempt left: a push that is not a fast-forward of the ref is refused (the run's commit is new work, not a descendant),
   * and so is a delete of the original. The push lines of a prompt are run against it as the sandbox would send them.
   */
  function fakeRefs(original: string) {
    const refs = new Map<string, string>([[original, "sha-run-1"]]);
    const log: string[] = [];
    return {
      refs,
      log,
      run(command: string, newCommit: string): "ok" | "non_fast_forward" {
        const m = /push( --force)? origin (\S+)/.exec(command);
        if (!m) throw new Error(`not a push: ${command}`);
        const force = m[1];
        const branch = m[2]!;
        log.push(`${force ? "FORCE " : ""}push ${branch}`);
        if (refs.has(branch)) return "non_fast_forward";
        refs.set(branch, newCommit);
        return "ok";
      },
      remove(branch: string): "refused" | "ok" {
        log.push(`delete ${branch}`);
        if (branch === original) return "refused";
        return refs.delete(branch) ? "ok" : "refused";
      },
    };
  }

  it("real contract: the rebuild's prompt pushes only a new ref, plainly; against a GitHub that refuses non-fast-forward updates and deletes of the original, the original is untouched and the old forced push is refused", async () => {
    const t = await setup();
    const m = module();
    const first = await build(t, m);
    await failBuild(t, first.out.runId);
    const again = await build(t, m);
    const github = fakeRefs(first.out.branch);
    const pushes = again.input.prompt.match(/push[^\n(]*/g)?.filter((l) => /\borigin\b/.test(l)) ?? [];
    expect(pushes).toHaveLength(1);
    expect(github.run(pushes[0]!, "sha-run-2")).toBe("ok");
    expect(github.refs.get(first.out.branch)).toBe("sha-run-1");
    expect(github.refs.get(again.out.branch)).toBe("sha-run-2");
    // What the prompt used to say for a rebuild is refused by this GitHub, and the original cannot be deleted from here.
    expect(github.run(`push --force origin ${first.out.branch}`, "sha-run-2")).toBe("non_fast_forward");
    expect(github.remove(first.out.branch)).toBe("refused");
    expect(github.refs.get(first.out.branch)).toBe("sha-run-1");
    expect(github.log).toEqual([`push ${again.out.branch}`, `FORCE push ${first.out.branch}`, `delete ${first.out.branch}`]);
  });

  it("a racing replay of one step: the loser's call returns the winner's run and the winner's branch, not the branch named after its own random id", async () => {
    const t = await setup();
    const m = module({ race: true });
    const first = await build(t, module());
    await failBuild(t, first.out.runId);
    const again = await build(t, m);
    const input = again.input;
    const winnerRun = again.out.runId;
    expect(input.runId).toBeDefined();
    expect(winnerRun).not.toBe(input.runId); // the keyed start gave the winner's run, not the id this call chose
    expect(again.out.branch).toBe(`fx/${winnerRun}-g1`);
    expect(again.out.branch).not.toBe(`fx/${input.runId}-g1`);
    expect(await recordsOf(winnerRun)).toEqual([again.out.branch]);
    expect((await admin.query("SELECT 1 FROM agent_runs WHERE work_item_id = $1", [t.w])).rowCount).toBe(2);
  });

  it("a runner build names no run branch and records nothing: its branch is its own", async () => {
    const t = await setup({ mode: "runner_local" });
    const m = module({ mode: "runner_local" });
    const { out, input } = await build(t, m);
    expect(out.branch).toBe(`fx/issue-${t.n}`);
    expect(input.runId).toBeUndefined();
    expect(await recordsOf(out.runId)).toEqual([]);
  });
});

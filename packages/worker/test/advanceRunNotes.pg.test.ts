import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { insertAgentRun, writeRunStatus, type CancelResult, type ExecutionRun, type ExecutionTargetRegistry, type StartAgentRunInput } from "@fx/runner";
import { startBuildForItem } from "@fx/pipeline";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { createCorrection, decideCorrection, getCorrection, type CorrectionCtx } from "@fx/core/src/corrections/index.js";
import { correctionReasonCode, renderRunNotes } from "@fx/core/src/corrections/driver.js";
import { createAdvanceModule, type AdvanceModuleDeps } from "../src/advance.js";
import type { RunStarter } from "../src/preview.js";
import type { SeatResult } from "../src/seat.js";

/**
 * D#597 CC-3 [pg]: the driver attaches accepted run notes at the build and fix boundaries, through the worker's real step keys, its real
 * idempotency table and its real driver-event store. Only the model starter is a fake, and it behaves like the real one where it matters:
 * a key names one run, and the run row is made by the same insert the platform uses.
 */
describe("advance: run notes at run boundaries [pg]", { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool, appPool]) await p.end();
  });
  afterEach(() => vi.restoreAllMocks());

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
  const HEAD = "a".repeat(40);
  const MARK = "ZEBRA-MARKER-7f3a";
  const registry = { sandbox: { cancel: async (_run: ExecutionRun): Promise<CancelResult> => ({ settled_usd: 0, released_usd: 0 }) } } as unknown as ExecutionTargetRegistry;
  let nextNumber = 9100;
  let nextDiscussion = 900;

  /** Makes the run row the way the platform does, keyed: a key that already names a run answers that run. */
  async function keyedRun(input: StartAgentRunInput, parent?: string): Promise<{ id: string; status: string }> {
    const known = await admin.query<{ run_id: string }>("SELECT run_id FROM agent_run_idempotency_keys WHERE account_id = $1 AND idempotency_key = $2", [input.accountId, input.idempotency!.key]);
    if (known.rows[0]) return { id: known.rows[0].run_id, status: "running" };
    const { id } = await insertAgentRun(writerPool, {
      id: randomUUID(),
      accountId: input.accountId,
      workItemId: input.workItemId,
      ...(parent ? { parentRunId: parent } : {}),
      role: "executor",
      runtime: "production",
      executionMode: "sandbox",
      dispatchRepoId: input.repoId,
      dispatchPrNumber: input.pr ?? null,
      idempotency: input.idempotency,
    });
    await writeRunStatus(writerPool, { accountId: input.accountId, runId: id, from: "pending", to: "running" });
    return { id, status: "running" };
  }

  function module() {
    const prompts: string[] = [];
    const starter: RunStarter = {
      async start(input) {
        prompts.push(input.prompt);
        return { runId: (await keyedRun(input)).id };
      },
    };
    const deps: AdvanceModuleDeps = {
      starter,
      resolveRunSeat: vi.fn(async () => SEAT),
      startAdvance: async () => undefined,
      triage: null,
      registry,
      build: startBuildForItem,
      review: {
        load: vi.fn(),
        recordRound: vi.fn(),
        resume: vi.fn(async (_pool: Pool, _registry: ExecutionTargetRegistry, input: StartAgentRunInput) => {
          prompts.push(input.prompt);
          return keyedRun(input, input.parentRunId ?? undefined);
        }),
        mergeGate: vi.fn(),
      } as never,
    };
    return { module: createAdvanceModule(writerPool, deps), prompts };
  }

  async function setup() {
    const a: SeedRefs = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [a.repoId]);
    await admin.query("UPDATE account_members SET role = 'owner' WHERE account_id = $1 AND user_id = $2", [a.accountId, a.userId]);
    const w = randomUUID();
    const n = nextNumber++;
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'issue', 'internal', 'spec_ready', $4)", [w, a.accountId, a.repoId, n]);
    const d = randomUUID();
    await admin.query("INSERT INTO discussions (id, account_id, number, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, $2, $3, 'feature', 't', $4, 'internal', 'user')", [d, a.accountId, nextDiscussion++, w]);
    await admin.query("UPDATE work_items SET discussion_id = $1 WHERE id = $2", [d, w]);
    await admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, 'spec', encode(sha256(convert_to('spec', 'UTF8')), 'hex'), 'system')", [a.accountId, w]);
    const ctx: CorrectionCtx = { pool: appPool, principal: { accountId: a.accountId, userId: a.userId } };
    const note = async (body: string) => {
      const c = await createCorrection(ctx, { workItemId: w, kind: "run_note", body });
      await decideCorrection(ctx, { id: c.id, to: "accepted", via: "workspace" });
      return c.id;
    };
    return { a, w, n, ctx, note, who: { accountId: a.accountId, userId: a.userId, workItemId: w, haltEpoch: 0 } };
  }
  const applied = async (t: Awaited<ReturnType<typeof setup>>, id: string) => getCorrection(t.ctx, id);
  const events = async (w: string) => (await admin.query<{ kind: string; code: string | null; reasons: string[]; run_id: string | null }>("SELECT kind, code, reasons, run_id FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'correction_applied'", [w])).rows;
  const executorRuns = async (w: string) => (await admin.query("SELECT 1 FROM agent_runs WHERE work_item_id = $1 AND role = 'executor'", [w])).rowCount;

  it("the build carries an accepted note, the fix round carries the one accepted while the build ran, and neither the events nor any log line holds the note text", async () => {
    const logged: string[] = [];
    for (const m of ["info", "warn", "error", "log"] as const) vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    const t = await setup();
    const m = module();
    const first = await t.note(`start with the tests ${MARK}`);
    const approval = randomUUID();
    const built = await m.module.advanceBuild(t.who, approval, 1);
    expect(built).toMatchObject({ status: "started" });
    const buildRun = built.runId!;
    expect(m.prompts[0]).toContain(renderRunNotes([{ id: first, body: `start with the tests ${MARK}` }]));
    expect(await applied(t, first)).toMatchObject({ status: "applied", appliedRunId: buildRun });
    expect(await events(t.w)).toEqual([{ kind: "correction_applied", code: null, reasons: [correctionReasonCode(first)], run_id: buildRun }]);

    // A note accepted while the build runs: not on the running build (a replay of its step leaves it alone) ...
    const late = await t.note(`mind the lockfile ${MARK}`);
    const replay = await m.module.advanceBuild(t.who, approval, 1);
    expect(replay).toMatchObject({ status: "started", runId: buildRun });
    expect(await executorRuns(t.w)).toBe(1);
    expect((await applied(t, late)).status).toBe("accepted");
    expect(await events(t.w)).toHaveLength(1);

    // ... but on the next run, the fix round that resumes the build's session.
    await writeRunStatus(writerPool, { accountId: t.a.accountId, runId: buildRun, from: "running", to: "succeeded", result: { sessionId: "cc-1", envelope: { verdict: "done" } } });
    await admin.query("UPDATE work_items SET stage = 'pr_opened' WHERE id = $1", [t.w]);
    const req = { issue: t.n, headSha: HEAD, prompt: "FIX IT", round: 1, actionId: randomUUID(), reviewer: "code" as const, failingRunId: randomUUID() };
    const fix = await m.module.advanceStartFix(t.who, req);
    expect(fix.ok).toBe(true);
    const fixRun = (fix as { runId: string }).runId;
    expect(fixRun).not.toBe(buildRun);
    expect(m.prompts.at(-1)).toContain("FIX IT");
    expect(m.prompts.at(-1)).toContain(renderRunNotes([{ id: late, body: `mind the lockfile ${MARK}` }]));
    expect(await applied(t, late)).toMatchObject({ status: "applied", appliedRunId: fixRun });
    expect((await events(t.w)).map((e) => e.run_id).sort()).toEqual([buildRun, fixRun].sort());

    // A replay of the fix round, after yet another note, finds the same run and stamps nothing new.
    const later = await t.note("one more");
    const again = await m.module.advanceStartFix(t.who, req);
    expect(again).toEqual({ ok: true, runId: fixRun });
    expect(await executorRuns(t.w)).toBe(2);
    expect((await applied(t, later)).status).toBe("accepted");
    expect(await events(t.w)).toHaveLength(2);

    // The fixed vocabulary: no driver event row and no log line of the driver holds a note's text.
    const rows = JSON.stringify((await admin.query("SELECT * FROM work_item_driver_events WHERE work_item_id = $1", [t.w])).rows);
    expect(rows).not.toContain(MARK);
    const driverLines = logged.filter((l) => l.includes('"advance.') || l.startsWith("{"));
    expect(driverLines.length).toBeGreaterThan(0);
    for (const line of logged) expect(line).not.toContain(MARK);
  });

  it("a fix round with no accepted note keeps the old key and the old prompt", async () => {
    const t = await setup();
    const m = module();
    const built = await m.module.advanceBuild(t.who, randomUUID(), 1);
    await writeRunStatus(writerPool, { accountId: t.a.accountId, runId: built.runId!, from: "running", to: "succeeded", result: { sessionId: "cc-1", envelope: { verdict: "done" } } });
    await admin.query("UPDATE work_items SET stage = 'pr_opened' WHERE id = $1", [t.w]);
    const req = { issue: t.n, headSha: HEAD, prompt: "FIX IT", round: 1, actionId: randomUUID(), reviewer: "code" as const, failingRunId: randomUUID() };
    const fix = await m.module.advanceStartFix(t.who, req);
    expect(fix.ok).toBe(true);
    expect(m.prompts.at(-1)).toBe("FIX IT");
    const key = (await admin.query<{ idempotency_key: string }>("SELECT idempotency_key FROM agent_run_idempotency_keys WHERE run_id = $1", [(fix as { runId: string }).runId])).rows[0]!.idempotency_key;
    expect(key).toBe(`advance:${t.w}:fix:${HEAD}:${req.actionId}`);
    expect(await events(t.w)).toEqual([]);
  });
});

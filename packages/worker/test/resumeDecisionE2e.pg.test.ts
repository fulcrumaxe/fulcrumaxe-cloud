import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CATALOGUE } from "@fx/decisions";
import { createPool } from "@fx/db/src/pool.js";
import { answerAsk } from "@fx/core/src/decisions/answer.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertAgentRun, sandboxInventory, sandboxNameFor, writeRunStatus, type SandboxPort } from "@fx/runner";
import { createAdvanceModule, type AdvanceFacade, type AdvanceStartArgs } from "../src/advance.js";
import { buildDecisionSnapshot, writeDecisionSnapshot } from "../src/decisionSnapshot.js";
import { createDecisionIntake } from "../src/decisionIntake.js";
import type { RunStarter } from "../src/preview.js";
import type { SeatResult } from "../src/seat.js";
import { createResumeModule } from "../src/resumeDecision.js";

/**
 * [pg] D#7 DP11c (DP-C9 section 5 criterion 4, C11, C15): the end-to-end resume on real machinery, and the checks that make "no handle lingers" and "the sibling
 * is untouched" able to fail.
 *   - The park is #320's: a succeeded executor run whose envelope asks (`decision_request`), read by the real decision intake on the receipt login.
 *   - The runs are started by the real keyed start (`advanceStartRun`: halt epoch, exclusivity per item, seat, parent link, idempotency key), with a starter that
 *     writes real run rows and the run's start prompt, and opens and stops sandboxes on a fake PROVIDER the way an executor run does.
 *   - "No sandbox handle lingers" is read from the real sandbox inventory (`sandboxInventory` over that provider's list, joined by the database to the run rows),
 *     before the answer and after the resume. It is not read from a set the fake fills.
 *   - "The sibling is untouched" compares the sibling run's whole row, its idempotency keys and its events before and after the resume.
 */
const INVOKER_LOGIN = "fx_resume_e2e_invoker_test";
const CLASS3 = CATALOGUE.find((e) => e.class === "human_in_the_loop")!.id;
const OPTIONS = [
  { id: "keep", label: "Keep the current shape" },
  { id: "split", label: "Split it in two" },
];
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
const PROMPT_MARK = "E2E-START-PROMPT-MARK";

describe("resume_decision end to end on real start, intake and sandbox inventory [pg]", { timeout: 120_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let receiptPool: Pool;
  let runnerPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${INVOKER_LOGIN}') THEN CREATE ROLE ${INVOKER_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${INVOKER_LOGIN}`);
    const u = new URL(process.env.WORKER_DATABASE_URL_APP_USER!);
    u.username = INVOKER_LOGIN;
    u.password = "";
    receiptPool = createPool(u.toString());
    runnerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, receiptPool, runnerPool]) await p.end();
  });

  /** A fake sandbox PROVIDER: the names it holds and whether each is running. Only what `sandboxInventory` lists. */
  function provider() {
    const estate = new Map<string, "running" | "stopped">();
    const port = {
      async listSandboxes(opts: { prefix: string; cursor?: string }) {
        return { sandboxes: [...estate].filter(([name]) => name.startsWith(opts.prefix)).map(([name, status]) => ({ name, status })), next: null };
      },
    } as unknown as SandboxPort;
    return { estate, port };
  }

  interface Harness {
    advance: AdvanceFacade;
    estate: Map<string, "running" | "stopped">;
    inventory: (accountId: string) => Promise<{ live: number; stopped_executor: number } | undefined>;
    follows: AdvanceStartArgs[];
    resume: ReturnType<typeof createResumeModule>;
    /** Starts an executor run the way the build does, through the real keyed start, and returns its id. */
    build: (a: SeedRefs, itemId: string, ghNumber: number) => Promise<{ runId: string; sandbox: string }>;
    /** The run ends the way an executor run does: succeeded with an envelope, and its sandbox stops. */
    end: (a: SeedRefs, runId: string, sandbox: string, envelope: Record<string, unknown>, opts?: { leakHandle?: boolean }) => Promise<void>;
  }
  function harness(): Harness {
    const { estate, port } = provider();
    const follows: AdvanceStartArgs[] = [];
    const starter: RunStarter = {
      async start(input) {
        const held = await admin.query<{ run_id: string }>("SELECT run_id FROM agent_run_idempotency_keys WHERE account_id = $1 AND idempotency_key = $2", [input.accountId, input.idempotency!.key]);
        if (held.rows[0]) return { runId: held.rows[0].run_id };
        const id = randomUUID();
        const sandbox = sandboxNameFor({ role: "executor", accountId: input.accountId, repoId: input.repoId, pr: input.pr!, runId: id });
        await insertAgentRun(runnerPool, {
          id,
          accountId: input.accountId,
          workItemId: input.workItemId,
          parentRunId: input.parentRunId ?? null,
          role: "executor",
          runtime: "production",
          executionMode: "sandbox",
          dispatchRepoId: input.repoId,
          dispatchPrNumber: input.pr ?? null,
          idempotency: input.idempotency,
          startPrompt: input.prompt,
          inCreateTransaction: async (client, runId) => {
            await writeDecisionSnapshot(client, runId, buildDecisionSnapshot({ role: "executor", dials: new Map(), declared: [CLASS3] }));
          },
        });
        await admin.query("ALTER TABLE agent_runs DISABLE TRIGGER USER");
        try {
          await admin.query("UPDATE agent_runs SET sandbox_name = $2 WHERE id = $1", [id, sandbox]);
        } finally {
          await admin.query("ALTER TABLE agent_runs ENABLE TRIGGER USER");
        }
        await writeRunStatus(runnerPool, { accountId: input.accountId, runId: id, from: "pending", to: "running" });
        estate.set(sandbox, "running");
        return { runId: id };
      },
    };
    const advance = createAdvanceModule(runnerPool, { starter, resolveRunSeat: async () => SEAT, startAdvance: async () => undefined, triage: null, decisionIntake: null }) as AdvanceFacade;
    const resume = createResumeModule(runnerPool, {
      startRun: advance.advanceStartRun,
      startFix: advance.advanceStartFix,
      startAdvance: async (args) => void follows.push(args),
    });
    return {
      advance,
      estate,
      follows,
      resume,
      inventory: async (accountId) => {
        await sandboxInventory({ pool: runnerPool, port, log: () => undefined }, { now: Date.now() });
        return (await admin.query<{ live: number; stopped_executor: number }>("SELECT live, stopped_executor FROM sandbox_inventory WHERE account_id = $1", [accountId])).rows[0];
      },
      build: async (a, itemId, ghNumber) => {
        const out = await advance.advanceStartRun({ accountId: a.accountId, workItemId: itemId, step: "build", role: "executor", prompt: `${PROMPT_MARK} for ${itemId}`, clone: true, pr: ghNumber, exclusive: true, haltEpoch: 0 });
        if (!out.ok) throw new Error(`build start refused: ${out.reason}`);
        const sandbox = (await admin.query<{ sandbox_name: string }>("SELECT sandbox_name FROM agent_runs WHERE id = $1", [out.runId])).rows[0]!.sandbox_name;
        return { runId: out.runId, sandbox };
      },
      end: async (a, runId, sandbox, envelope, opts = {}) => {
        await writeRunStatus(runnerPool, { accountId: a.accountId, runId, from: "running", to: "succeeded", result: { sessionId: `cc-${runId.slice(0, 8)}`, envelope } });
        if (opts.leakHandle !== true) estate.set(sandbox, "stopped");
      },
    };
  }

  async function newItem(a: SeedRefs, ghNumber: number): Promise<string> {
    const id = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'issue', 'internal', 'in_progress', $4)", [id, a.accountId, a.repoId, ghNumber]);
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [a.repoId]);
    return id;
  }

  /** Everything that could change about a run: its row, its keys and its events. */
  async function fingerprint(runId: string): Promise<string> {
    const row = (await admin.query("SELECT to_jsonb(r) - 'updated_at' AS j FROM agent_runs r WHERE r.id = $1", [runId])).rows[0].j;
    const keys = (await admin.query("SELECT idempotency_key, run_id, request_hash FROM agent_run_idempotency_keys WHERE run_id = $1 ORDER BY idempotency_key", [runId])).rows;
    const events = (await admin.query("SELECT seq, kind, payload FROM run_events WHERE run_id = $1 ORDER BY seq", [runId])).rows;
    return JSON.stringify({ row, keys, events });
  }

  /** The parked state, reached the real way: a running build ends succeeded with a decision_request in its envelope, and the real intake parks it. */
  async function park(h: Harness, a: SeedRefs, itemId: string, ghNumber: number, opts: { leakHandle?: boolean } = {}) {
    const run = await h.build(a, itemId, ghNumber);
    await h.end(a, run.runId, run.sandbox, { verdict: "done", decision_request: { type: "d1", options: OPTIONS, proposed: "keep", rationale: "Smaller diff, same behaviour." } }, opts);
    const intake = createDecisionIntake({ runnerPool, receiptPool, declared: () => [CLASS3] });
    expect(await intake({ accountId: a.accountId, workItemId: itemId, haltEpoch: 0, runId: run.runId })).toBe("parked");
    const ask = (await admin.query<{ id: string; state: string }>("SELECT id, state FROM decision_asks WHERE run_id = $1", [run.runId])).rows[0]!;
    expect(ask.state).toBe("open");
    return { ...run, askId: ask.id };
  }
  const answer = (a: SeedRefs, askId: string, choice: string) => answerAsk({ pool: receiptPool, principal: { accountId: a.accountId, userId: a.userId } }, { askId, choice });
  async function claimed(askId: string): Promise<string> {
    const r = (await admin.query("SELECT id FROM run_action_requests WHERE kind = 'resume_decision' AND target_id = $1", [askId])).rows[0];
    await admin.query("UPDATE run_action_requests SET state = 'claimed', claimed_until = now() + interval '5 minutes', attempts = attempts + 1 WHERE id = $1", [r.id]);
    return r.id;
  }

  it("a branch parked by a real ask while a sibling keeps running: the answer resumes it as a NEW run linked to the parked one, the sibling is not touched, and no handle lingers", async () => {
    const a = await seedAccount(admin, randomUUID());
    const h = harness();
    const parkedItem = await newItem(a, 41);
    const siblingItem = await newItem(a, 42);
    const sibling = await h.build(a, siblingItem, 42);
    const parked = await park(h, a, parkedItem, 41);

    // While it is parked: the parked run's sandbox is stopped, the sibling's is live, and that is all the provider holds for the account.
    expect(h.estate.get(parked.sandbox)).toBe("stopped");
    expect(h.estate.get(sibling.sandbox)).toBe("running");
    expect(await h.inventory(a.accountId)).toMatchObject({ live: 1, stopped_executor: 1 });

    const siblingBefore = await fingerprint(sibling.runId);
    const parkedBefore = await fingerprint(parked.runId);
    await answer(a, parked.askId, "split");
    const actionId = await claimed(parked.askId);
    const out = await h.resume.performResumeDecision(actionId);
    expect(out).toMatchObject({ result: "done", outcome: { work_item_id: parkedItem, cause: "decision_resolved" } });
    const resumedId = (out as unknown as { outcome: { run_id: string } }).outcome.run_id;

    // A NEW run, linked to the parked one, keyed to the ask, carrying the parked prompt and the resume context; the parked run stays ended exactly as it was.
    expect(resumedId).not.toBe(parked.runId);
    const resumed = (await admin.query("SELECT id, status, parent_run_id, work_item_id, role, dispatch_pr_number FROM agent_runs WHERE id = $1", [resumedId])).rows[0];
    expect(resumed).toMatchObject({ status: "running", parent_run_id: parked.runId, work_item_id: parkedItem, role: "executor", dispatch_pr_number: "41" });
    const key = (await admin.query("SELECT idempotency_key FROM agent_run_idempotency_keys WHERE run_id = $1", [resumedId])).rows[0].idempotency_key;
    expect(key).toBe(`advance:${parkedItem}:resume:${parked.askId}`);
    const prompt = (await admin.query("SELECT payload->>'prompt' AS p FROM run_events WHERE run_id = $1 AND kind = 'run.input'", [resumedId])).rows[0].p as string;
    expect(prompt.startsWith(`${PROMPT_MARK} for ${parkedItem}`)).toBe(true);
    expect(prompt).toContain("cause: decision_resolved\noption: split");
    expect(await fingerprint(parked.runId)).toBe(parkedBefore);

    // The sibling: its row, its keys and its events are byte for byte what they were.
    expect(await fingerprint(sibling.runId)).toBe(siblingBefore);
    // No handle lingers: the provider holds exactly one running sandbox per live run (the sibling's and the resumed run's), and nothing stopped is left behind
    // (the resumed run continues the parked run's own sandbox name; a second sandbox, or a leftover one, would show here).
    expect(await h.inventory(a.accountId)).toMatchObject({ live: 2, stopped_executor: 0 });
    expect(h.follows).toEqual([expect.objectContaining({ workItemId: parkedItem, resumeRunId: resumedId, actionId })]);
    // Performing it again resumes nothing more.
    expect(await h.resume.performResumeDecision(actionId)).toEqual(out);
    expect((await admin.query("SELECT count(*)::int AS n FROM agent_runs WHERE work_item_id = $1", [parkedItem])).rows[0].n).toBe(2);
  });

  it("the same with deny gives decision_denied", async () => {
    const a = await seedAccount(admin, randomUUID());
    const h = harness();
    const item = await newItem(a, 51);
    const parked = await park(h, a, item, 51);
    await answer(a, parked.askId, "deny");
    const out = await h.resume.performResumeDecision(await claimed(parked.askId));
    expect(out).toMatchObject({ result: "done", outcome: { cause: "decision_denied" } });
    const resumedId = (out as unknown as { outcome: { run_id: string } }).outcome.run_id;
    const prompt = (await admin.query("SELECT payload->>'prompt' AS p FROM run_events WHERE run_id = $1 AND kind = 'run.input'", [resumedId])).rows[0].p as string;
    expect(prompt).toContain("cause: decision_denied");
    expect(prompt).not.toContain("option:");
  });

  describe("the checks can fail", () => {
    it("a handle left open while the branch is parked shows in the inventory before the answer", async () => {
      const a = await seedAccount(admin, randomUUID());
      const h = harness();
      const sibling = await h.build(a, await newItem(a, 61), 61);
      const parked = await park(h, a, await newItem(a, 62), 62, { leakHandle: true });
      expect(h.estate.get(parked.sandbox)).toBe("running");
      // the parked branch would be holding a sandbox: two live, nothing stopped. The assertion the other test makes (live 1, stopped 1) would be red.
      expect(await h.inventory(a.accountId)).toMatchObject({ live: 2, stopped_executor: 0 });
      expect(h.estate.get(sibling.sandbox)).toBe("running");
    });

    it("a sibling that the resume changed shows in the fingerprint", async () => {
      const a = await seedAccount(admin, randomUUID());
      const h = harness();
      const sibling = await h.build(a, await newItem(a, 71), 71);
      const before = await fingerprint(sibling.runId);
      await h.end(a, sibling.runId, sibling.sandbox, { verdict: "done" });
      expect(await fingerprint(sibling.runId)).not.toBe(before);
    });

    it("a second sandbox for the resumed run (another pull request number) shows in the inventory as a stopped sandbox left behind", async () => {
      const a = await seedAccount(admin, randomUUID());
      const h = harness();
      const item = await newItem(a, 81);
      const parked = await park(h, a, item, 81);
      await answer(a, parked.askId, "keep");
      // what a resume that named the wrong pull request would do: start its run under another number
      await h.advance.advanceStartRun({ accountId: a.accountId, workItemId: item, step: "resume:wrong", role: "executor", prompt: "x", clone: true, pr: 82, exclusive: true, haltEpoch: 0, parentRunId: parked.runId });
      expect(await h.inventory(a.accountId)).toMatchObject({ live: 1, stopped_executor: 1 });
    });
  });
});

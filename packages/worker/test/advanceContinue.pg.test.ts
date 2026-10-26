import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { recordStage } from "@fx/core/src/work-items/recordStage.js";
import { MAX_CONTINUATIONS_PER_WORK_ITEM } from "@fx/core/src/run-limits/limits.js";
import { SandboxTarget, WorkItemHaltedError, startAgentRun, writeRunStatus, type ExecutionTargetRegistry, type StartAgentRunInput } from "@fx/runner";
import { REFUSED_BY_CODES, continueAfterLimit } from "@fx/pipeline";
import { createSandboxTargetHarness } from "../../runner/test/helpers/sandboxTargetFakes.js";
import { ADVANCE_CONTINUE_CODES, CONTINUE_LOOP_CEILING, advanceContinue, type AdvanceContinueDeps } from "../src/advanceContinue.js";
import { createSeatResolver } from "../src/seat.js";

/**
 * [pg] D#2 H14c-3-3b-2 (C88 R1, R5, R7): the advance workflow's continue step over real Postgres, with the real library and a real sandbox target over the SDK fake.
 * Each guard has a test that goes red without it (the PR body lists the hand mutations that were run).
 */
describe("advanceContinue [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let deps: AdvanceContinueDeps;
  let started: string[];
  /** How many times the real library was reached through the default `continueAfter`. */
  let libCalls = 0;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });

  const resolve = () => createSeatResolver({ pool: writerPool });
  const watched = (): ExecutionTargetRegistry => {
    const target = new SandboxTarget(createSandboxTargetHarness(writerPool).deps);
    started = [];
    return {
      sandbox: new Proxy(target, {
        get(t, k) {
          if (k === "resume") return (run: { id?: string }, sid: string | null) => (started.push("resume"), t.resume(run as never, sid));
          if (k === "dispatch") return (run: unknown) => (started.push("dispatch"), t.dispatch(run as never));
          const v = (t as unknown as Record<string | symbol, unknown>)[k];
          return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
        },
      }),
    };
  };
  /** A registry that fails the test if anything is dispatched through it. */
  const untouched = (): ExecutionTargetRegistry => new Proxy({} as ExecutionTargetRegistry, { get: () => { throw new Error("the registry must not be touched"); } });

  interface Fx {
    a: SeedRefs;
    registry: ExecutionTargetRegistry;
    /** The runs the seed already made for the item. */
    base: number;
  }
  async function item(over: { maxResumes?: number; autoResume?: boolean; stage?: string } = {}): Promise<Fx> {
    const a = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE accounts SET model_budget_usd_month = 500 WHERE id = $1", [a.accountId]);
    await admin.query("UPDATE work_items SET gh_number = 7 WHERE id = $1", [a.workItemId]);
    if (over.maxResumes !== undefined || over.autoResume !== undefined) {
      await admin.query("INSERT INTO run_limits (account_id, role, auto_resume, max_resumes) VALUES ($1, 'executor', $2, $3)", [a.accountId, over.autoResume ?? true, over.maxResumes ?? 2]);
    }
    await withTenant(writerPool, a.accountId, async (c) => {
      for (const toStage of ["spec_ready", "in_progress"] as const) await recordStage(c, { workItemId: a.workItemId, toStage, at: new Date(), source: "control_plane", sourceRef: `seed-${toStage}` });
    });
    if (over.stage && over.stage !== "in_progress") await admin.query("UPDATE work_items SET stage = $2 WHERE id = $1", [a.workItemId, over.stage]);
    libCalls = 0;
    deps = { pool: writerPool, registry: watched(), resolveRunSeat: resolve(), continueAfter: (...a) => (libCalls++, continueAfterLimit(...a)) };
    const base = Number((await admin.query("SELECT count(*) AS n FROM agent_runs WHERE work_item_id = $1", [a.workItemId])).rows[0].n);
    return { a, registry: deps.registry!, base };
  }

  /** A real executor run (or continuation of `parent`) that has ended at a limit. */
  async function endedReal(f: Fx, o: { status?: "timed_out" | "killed_spend"; checkpoint?: boolean; abortReason?: "per_run_cap" | "monthly_budget"; parent?: string } = {}): Promise<string> {
    const status = o.status ?? "timed_out";
    let id: string;
    if (o.parent) {
      const out = await advanceContinue(deps, f.a.accountId, f.a.workItemId, o.parent);
      if (out.code !== "continued" || !out.runId) throw new Error(`test setup: expected a continuation, got ${out.code}`);
      id = out.runId;
    } else {
      const r = await resolve()({ accountId: f.a.accountId, role: "executor", workItemId: f.a.workItemId });
      if (!r.ok) throw new Error(`seat refused: ${r.reason}`);
      const input: StartAgentRunInput = { ...r.seat, accountId: f.a.accountId, repoId: f.a.repoId, workItemId: f.a.workItemId, role: "executor", product: "team", pr: 7, prompt: "implement" };
      const s = await startAgentRun(writerPool, f.registry, input);
      if (s.status !== "running") throw new Error("test setup: not running");
      id = s.id;
      started = []; // the first dispatch is the setup's; what the tests watch is what the step does
    }
    await writeRunStatus(writerPool, {
      accountId: f.a.accountId, runId: id, from: "running", to: status, result: { sessionId: "cc-owned" },
      ...(o.checkpoint === false ? {} : { checkpoint: { kind: status === "killed_spend" ? "per_run_usd" : "run_time", ccSessionId: "cc-forged", meteredUsd: 1, extensionsUsed: 0 } }),
      ...(status === "killed_spend" ? { abortReason: o.abortReason ?? "per_run_cap" } : {}),
    });
    return id;
  }
  const run = (f: Fx, runId: string, over: Partial<AdvanceContinueDeps> = {}) => advanceContinue({ ...deps, ...over }, f.a.accountId, f.a.workItemId, runId);
  const children = async (parent: string) => Number((await admin.query("SELECT count(*) AS n FROM agent_runs WHERE parent_run_id = $1", [parent])).rows[0].n);
  /** Runs of the item that the test made (the seed's own run is not counted). */
  const runsOf = async (f: Fx) => Number((await admin.query("SELECT count(*) AS n FROM agent_runs WHERE work_item_id = $1", [f.a.workItemId])).rows[0].n) - f.base;
  const stageOf = async (f: Fx) => (await admin.query("SELECT stage FROM work_items WHERE id = $1", [f.a.workItemId])).rows[0].stage as string;

  it("the loop ceiling the workflow repeats is the shared constant, and the codes are the fixed list", () => {
    expect(CONTINUE_LOOP_CEILING).toBe(MAX_CONTINUATIONS_PER_WORK_ITEM);
    expect([...ADVANCE_CONTINUE_CODES]).toEqual(["continued", "duplicate", "parked", "work_item_closed", "waiting_on_answer", "busy", "halted", "today"]);
  });

  describe("continues", () => {
    it("a timed_out executor with a checkpoint and auto_resume on starts one child that resumes its session, under the parent", async () => {
      const f = await item();
      const ended = await endedReal(f);
      const out = await run(f, ended);
      expect(out).toMatchObject({ code: "continued", parkedAs: null });
      expect(out.runId).toMatch(/^[0-9a-f-]{36}$/);
      expect(await children(ended)).toBe(1);
      expect((await admin.query("SELECT parent_run_id, role, status FROM agent_runs WHERE id = $1", [out.runId])).rows[0]).toEqual({ parent_run_id: ended, role: "executor", status: "running" });
      expect(started).toEqual(["resume"]);
      expect(await stageOf(f)).toBe("in_progress");
    });

    it("D#7 DP4b-3b: the continuation child has a decision snapshot of its own from the dials now, and a prompt that offers exactly its keys; a read that fails starts nothing", async () => {
      const f = await item();
      const ended = await endedReal(f);
      // The customer turns the first decision to "ask" after the ended run started.
      await admin.query("INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, preset, version, changed_by) VALUES ($1, $2, 'nonbreaking_refactor_approach', 'ask', NULL, 1, $3)", [f.a.accountId, f.a.repoId, f.a.userId]);
      // A pool whose dial read fails: the step answers today's path and the library is never reached.
      const failing = new Proxy(writerPool, {
        get(target, prop, receiver) {
          if (prop !== "connect") return Reflect.get(target, prop, receiver);
          return async () => {
            const client = (await target.connect()) as PoolClient;
            const original = client.query;
            const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
            const release = client.release.bind(client);
            (client as unknown as { release: unknown }).release = (...args: unknown[]) => {
              (client as unknown as { query: unknown }).query = original;
              (client as unknown as { release: unknown }).release = release;
              return (release as (...a: unknown[]) => void)(...args);
            };
            (client as unknown as { query: unknown }).query = (...args: unknown[]) => {
              const text = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string } | undefined)?.text ?? "";
              return text.includes("decision_settings") ? Promise.reject(new Error("dial store unavailable")) : query(...args);
            };
            return client;
          };
        },
      }) as Pool;
      expect((await run(f, ended, { pool: failing })).code).toBe("today");
      expect(libCalls).toBe(0);
      expect(await children(ended)).toBe(0);

      let sent: StartAgentRunInput | undefined;
      const out = await run(f, ended, { continueAfter: (...a) => ((sent = a[2].resumeInput as StartAgentRunInput), continueAfterLimit(...a)) });
      expect(out.code).toBe("continued");
      const snaps = (await admin.query("SELECT account_id, payload FROM run_events WHERE run_id = $1 AND kind = 'decision.snapshot'", [out.runId])).rows;
      expect(snaps).toHaveLength(1);
      expect(snaps[0].account_id).toBe(f.a.accountId);
      expect(snaps[0].payload.entries[0]).toEqual({ key: "d1", decision_type: "nonbreaking_refactor_approach", disposition: "ask", dial_version: 1 });
      expect((await admin.query("SELECT count(*)::int AS n FROM run_events WHERE run_id = $1 AND kind = 'decision.snapshot'", [ended])).rows[0].n).toBe(0);
      const prompt = sent!.prompt;
      expect(prompt.startsWith("Your previous run of this task stopped at a run limit.")).toBe(true);
      expect(prompt).toContain('- d1: "How to restructure code without changing what it does" -> stop and ask');
      expect(prompt.split("DECISIONS YOU MAY MEET IN THIS WORK")).toHaveLength(2);
    });

    it("a per-run-cap spend kill with its checkpoint is continued too", async () => {
      const f = await item();
      const out = await run(f, await endedReal(f, { status: "killed_spend" }));
      expect(out.code).toBe("continued");
    });
  });

  describe("idempotent: a replayed step never starts a second continuation (R7)", () => {
    it("the same ended run twice: one child, one reservation, the same run id both times", async () => {
      const f = await item();
      const ended = await endedReal(f);
      const first = await run(f, ended);
      const reservations = async () => Number((await admin.query("SELECT count(*) AS n FROM spend_reservations WHERE account_id = $1", [f.a.accountId])).rows[0].n);
      const before = await reservations();
      const again = await run(f, ended);
      const third = await run(f, ended);
      expect(first.code).toBe("continued");
      expect(again).toEqual({ code: "duplicate", runId: first.runId, parkedAs: null });
      expect(third).toEqual(again);
      expect(await children(ended)).toBe(1);
      expect(await reservations()).toBe(before);
      expect(started).toEqual(["resume"]);
    });

    it("a step run again from the top after the child row was written (the replay finds it before it decides anything)", async () => {
      const f = await item();
      const ended = await endedReal(f);
      const first = await run(f, ended);
      let libraryCalls = 0;
      const again = await run(f, ended, { continueAfter: async () => (libraryCalls++, { outcome: "not_applicable" }) });
      expect(again).toMatchObject({ code: "duplicate", runId: first.runId });
      expect(libraryCalls).toBe(0);
    });

    it("a child made between the step's first look and the library's answer (a racing replay) is answered, not started again", async () => {
      const f = await item();
      const ended = await endedReal(f);
      let racing: Awaited<ReturnType<typeof run>> | undefined;
      const out = await run(f, ended, {
        // the other pass wins the race inside the library's window, and the library reports the duplicate
        continueAfter: async () => {
          racing = await run(f, ended);
          return { outcome: "duplicate" };
        },
      });
      expect(racing?.code).toBe("continued");
      expect(out).toEqual({ code: "duplicate", runId: racing?.runId, parkedAs: null });
      expect(await children(ended)).toBe(1);
    });

    it("an error after the child started does not hide it: the catch looks for the child", async () => {
      const f = await item();
      const ended = await endedReal(f);
      let racing: Awaited<ReturnType<typeof run>> | undefined;
      const names: string[] = [];
      const out = await run(f, ended, {
        logError: (n) => names.push(n),
        // the child is made, then the pass throws before it can answer
        continueAfter: async () => {
          racing = await run(f, ended);
          throw new TypeError("boom with private text");
        },
      });
      expect(names).toEqual(["TypeError"]);
      expect(out).toEqual({ code: "duplicate", runId: racing?.runId, parkedAs: null });
      expect(await children(ended)).toBe(1);
    });
  });

  describe("caps resumes strictly, whatever the workflow remembers (max_resumes across restarts)", () => {
    it("max_resumes 1: the first end continues, the child's end parks max_resumes, and a fresh call for either never starts another", async () => {
      const f = await item({ maxResumes: 1 });
      const first = await endedReal(f);
      const child = await endedReal(f, { parent: first });
      const out = await run(f, child);
      expect(out).toEqual({ code: "parked", runId: null, parkedAs: "max_resumes" });
      expect(await children(child)).toBe(0);
      expect(await stageOf(f)).toBe("needs_human");
      // "a restarted workflow" is just another call: the count is the stored runs, so it parks again and starts nothing
      const restarted = await run(f, child);
      expect(restarted).toEqual({ code: "parked", runId: null, parkedAs: "max_resumes" });
      expect(await children(child)).toBe(0);
      expect(await runsOf(f)).toBe(2);
    });

    it("max_resumes 0 never continues", async () => {
      const f = await item({ maxResumes: 0 });
      const out = await run(f, await endedReal(f));
      expect(out).toEqual({ code: "parked", runId: null, parkedAs: "max_resumes" });
      expect(await runsOf(f)).toBe(1);
    });

    it("max_resumes 5 (the most a plan allows): five automatic continuations, then the sixth end parks max_resumes", async () => {
      const f = await item({ maxResumes: 5 });
      let last = await endedReal(f);
      for (let i = 0; i < 5; i++) last = await endedReal(f, { parent: last });
      expect(await runsOf(f)).toBe(6);
      expect(await run(f, last)).toEqual({ code: "parked", runId: null, parkedAs: "max_resumes" });
      expect(await runsOf(f)).toBe(6);
    });

    it("auto_resume off parks auto_resume_off and records the move to Needs a person", async () => {
      const f = await item({ autoResume: false });
      const out = await run(f, await endedReal(f));
      expect(out).toEqual({ code: "parked", runId: null, parkedAs: "auto_resume_off" });
      expect(await stageOf(f)).toBe("needs_human");
      expect(await runsOf(f)).toBe(1);
    });
  });

  describe("spend kills", () => {
    it("a monthly-budget kill parks monthly_budget_reached and starts nothing", async () => {
      const f = await item();
      const out = await run(f, await endedReal(f, { status: "killed_spend", checkpoint: false, abortReason: "monthly_budget" }));
      expect(out).toEqual({ code: "parked", runId: null, parkedAs: "monthly_budget_reached" });
      expect(await runsOf(f)).toBe(1);
    });

    it("a spend kill with no stored cause (an older row) parks spend, never continues", async () => {
      const f = await item();
      const ended = await endedReal(f, { status: "killed_spend" });
      await admin.query("UPDATE run_events SET payload = payload - 'abortReason' WHERE run_id = $1 AND kind = 'run.status_changed'", [ended]);
      expect(await run(f, ended)).toEqual({ code: "parked", runId: null, parkedAs: "spend" });
      expect(await runsOf(f)).toBe(1);
    });

    it("a replay after a monthly-budget park (item already in Needs a person, no child) answers the recorded park", async () => {
      const f = await item();
      const ended = await endedReal(f, { status: "killed_spend", checkpoint: false, abortReason: "monthly_budget" });
      await run(f, ended);
      expect(await run(f, ended)).toEqual({ code: "parked", runId: null, parkedAs: "monthly_budget_reached" });
    });
  });

  describe("fails closed: an unknown state or a missing fact never continues", () => {
    const notContinued = async (f: Fx, runId: string, over: Partial<AdvanceContinueDeps> = {}) => {
      const before = await runsOf(f);
      const out = await run(f, runId, over);
      expect(await runsOf(f)).toBe(before);
      expect(started).toEqual([]);
      // Nothing that is not a continuation candidate may even reach the library (a second line of defence must not be the only one).
      if (!over.continueAfter) expect(libCalls).toBe(0);
      return out;
    };

    it("a run that did not end at a limit (running, failed, succeeded, cancelled) is today", async () => {
      const f = await item();
      const ended = await endedReal(f);
      for (const status of ["running", "failed", "succeeded", "cancelled", "pending"]) {
        await admin.query("UPDATE agent_runs SET status = $2 WHERE id = $1", [ended, status]);
        expect(await notContinued(f, ended)).toEqual({ code: "today", runId: null, parkedAs: null });
      }
    });

    it("a missing run, a malformed id and another account's run are today", async () => {
      const f = await item();
      const other = await item();
      const theirs = await endedReal(other);
      deps = { ...deps, registry: untouched() };
      expect((await run(f, randomUUID())).code).toBe("today");
      expect((await run(f, "not-a-uuid")).code).toBe("today");
      expect((await run(f, theirs)).code).toBe("today"); // tenant-scoped read
      expect((await advanceContinue(deps, f.a.accountId, "nope", theirs)).code).toBe("today");
    });

    it("a run of another work item, or one that is not the executor's, is today", async () => {
      const f = await item();
      const g = await item();
      const gEnded = await endedReal(g);
      deps = { ...deps, registry: untouched() };
      expect((await advanceContinue(deps, g.a.accountId, f.a.workItemId, gEnded)).code).toBe("today");
      const reviewer = randomUUID();
      await admin.query(
        `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, cc_session_id, backend) VALUES ($1, $2, $3, 'code-reviewer', 'production', 'timed_out', 'sandbox', $4, 'cc-owned', 'claude')`,
        [reviewer, f.a.accountId, f.a.workItemId, f.a.repoId],
      );
      await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'checkpoint', '{"reason":"limit","kind":"run_time"}')`, [f.a.accountId, reviewer]);
      expect((await run(f, reviewer)).code).toBe("today");
      expect(await children(reviewer)).toBe(0);
      expect(libCalls).toBe(0);
    });

    it("only the item's newest executor run is continued: an older ended run is today (CARRY-25)", async () => {
      const f = await item();
      const first = await endedReal(f);
      await admin.query("UPDATE agent_runs SET parent_run_id = NULL WHERE id = $1", [first]);
      const second = randomUUID();
      await admin.query(
        `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, cc_session_id, backend) VALUES ($1, $2, $3, 'executor', 'production', 'running', 'sandbox', $4, 'cc-owned', 'claude')`,
        [second, f.a.accountId, f.a.workItemId, f.a.repoId],
      );
      expect((await run(f, first)).code).toBe("today");
      expect(await children(first)).toBe(0);
      expect(libCalls).toBe(0);
    });

    it("a closed item is work_item_closed and starts nothing; an unknown or missing stage is today", async () => {
      for (const stage of ["merged", "closed_unmerged", "closed"]) {
        const f = await item();
        const ended = await endedReal(f);
        await admin.query("UPDATE work_items SET stage = $2 WHERE id = $1", [f.a.workItemId, stage]);
        expect(await notContinued(f, ended)).toEqual({ code: "work_item_closed", runId: null, parkedAs: null });
      }
      for (const stage of ["triaged", "discussing", "spec_ready"]) {
        const f = await item();
        const ended = await endedReal(f);
        await admin.query("UPDATE work_items SET stage = $2 WHERE id = $1", [f.a.workItemId, stage]);
        expect((await notContinued(f, ended)).code).toBe("today");
      }
    });

    it("an item already in Needs a person with no recorded park is today", async () => {
      const f = await item();
      const ended = await endedReal(f);
      await withTenant(writerPool, f.a.accountId, (c) => recordStage(c, { workItemId: f.a.workItemId, toStage: "needs_human", at: new Date(), source: "control_plane", sourceRef: "manual" }));
      expect((await notContinued(f, ended)).code).toBe("today");
    });

    it("no registry, a library that throws, one that answers something unknown, and one that answers not_applicable are all today and name the error only", async () => {
      const f = await item();
      const ended = await endedReal(f);
      expect((await notContinued(f, ended, { registry: null })).code).toBe("today");
      const names: string[] = [];
      expect((await notContinued(f, ended, { logError: (n) => names.push(n), continueAfter: async () => { throw new RangeError("private text: account 123"); } })).code).toBe("today");
      expect(names).toEqual(["RangeError"]);
      expect((await notContinued(f, ended, { continueAfter: (async () => ({ outcome: "something_new" })) as never })).code).toBe("today");
      expect((await notContinued(f, ended, { continueAfter: async () => ({ outcome: "not_applicable" }) })).code).toBe("today");
      expect((await notContinued(f, ended, { continueAfter: async () => ({ outcome: "refused", reason: "no_spec_version" }) })).code).toBe("today");
    });

    it("a parked answer with a refused_by this code does not know is today, not a park", async () => {
      const f = await item();
      const ended = await endedReal(f);
      expect((await notContinued(f, ended, { continueAfter: (async () => ({ outcome: "parked", reason: "run_limit_reached", refusedBy: "platform_budget" })) as never })).code).toBe("today");
    });

    it("a seat refusal starts nothing and is today", async () => {
      const f = await item();
      const ended = await endedReal(f);
      expect((await notContinued(f, ended, { resolveRunSeat: async () => ({ ok: false, reason: "no_model" }) })).code).toBe("today");
    });

    it("a halt raised while the child is made is halted", async () => {
      const f = await item();
      const ended = await endedReal(f);
      const out = await notContinued(f, ended, { continueAfter: async () => { throw new WorkItemHaltedError(); } });
      expect(out.code).toBe("halted");
    });

    it("busy from the library is busy and starts nothing", async () => {
      const f = await item();
      const ended = await endedReal(f);
      expect((await notContinued(f, ended, { continueAfter: async () => ({ outcome: "busy" }) })).code).toBe("busy");
    });

    it("every park the library can name maps to a fixed word that is not a platform-budget code", () => {
      expect([...REFUSED_BY_CODES].sort()).toEqual(["auto_resume_off", "foreign_session", "max_resumes", "silence_twice", "spend", "work_item_ceiling"]);
      for (const code of [...REFUSED_BY_CODES, "monthly_budget_reached"]) expect(code).not.toMatch(/platform|hosting/);
    });
  });

  describe("a decision ask fronts the continuation (R5)", () => {
    async function ask(f: Fx, runId: string, state: string): Promise<void> {
      await admin.query(
        `INSERT INTO decision_asks (account_id, repo_id, work_item_id, run_id, decision_type, options, proposed, rationale, input_trust_classes, answer_due_at, timeout_outcome, state)
         VALUES ($1, $2, $3, $4, 'run_extension', '[{"id":"continue","label":"c"},{"id":"stop","label":"s"}]'::jsonb, 'continue', 'r', '[]'::jsonb, now() + interval '1 day', 'stop_and_flag', $5)`,
        [f.a.accountId, f.a.repoId, f.a.workItemId, runId, state],
      );
    }
    it("an open or overdue ask on the ended run is waiting_on_answer and nothing starts", async () => {
      for (const state of ["open", "overdue"]) {
        const f = await item();
        const ended = await endedReal(f);
        await ask(f, ended, state);
        const out = await run(f, ended);
        expect(out).toEqual({ code: "waiting_on_answer", runId: null, parkedAs: null });
        expect(await children(ended)).toBe(0);
        expect(started).toEqual([]);
      }
    });
    it("an answered ask, or one on another run, does not block", async () => {
      const f = await item();
      const ended = await endedReal(f);
      await ask(f, ended, "withdrawn");
      await ask(f, f.a.runId, "open"); // an open ask on another run of the item
      expect((await run(f, ended)).code).toBe("continued");
    });
  });

  describe("the run-extension dial's seam (H14c-5c-3 wires it; nothing does here)", () => {
    it("absent: nothing changes. allow continues, defer waits for a person, anything else is today", async () => {
      const f = await item();
      const e1 = await endedReal(f);
      expect((await run(f, e1, { gate: async () => "defer" })).code).toBe("waiting_on_answer");
      expect((await run(f, e1, { gate: (async () => "maybe") as never })).code).toBe("today");
      expect((await run(f, e1, { gate: async () => { throw new Error("x"); } })).code).toBe("today");
      expect(await children(e1)).toBe(0);
      expect((await run(f, e1, { gate: async () => "allow" })).code).toBe("continued");
    });
  });
});

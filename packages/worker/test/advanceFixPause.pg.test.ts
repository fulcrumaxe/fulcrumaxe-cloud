import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { insertAgentRun, writeRunStatus, type CancelResult, type ExecutionRun, type ExecutionTargetRegistry, type StartAgentRunInput } from "@fx/runner";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { RESERVATION_DENIAL_PAUSES } from "@fx/pipeline";
import { createAdvanceModule, type AdvanceModuleDeps, type AdvanceReviewDeps } from "../src/advance.js";
import type { RunStarter } from "../src/preview.js";
import type { SeatResult } from "../src/seat.js";

/**
 * D#483 S5-k1d [pg]: the worker side of a fix round and of the reviewer runs under a spending limit. A fix round a limit denied answers the limit's own denial (so the
 * driver can wait), writes no refusal fact for it, and each later ask is a new attempt with its own key; a replay of a denied key is the denial again, never a start.
 * The reviewer lookup returns the runs that really started for one head and round, and never a refused one. Real rows and real keys throughout; the only fake is the
 * pipeline's resume, which behaves as the real one does at admit (a keyed run row, then `refused_spend` with the admit's reason).
 */
describe("advance: fix rounds and reviewer runs under a spending limit [pg]", { timeout: 60_000 }, () => {
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
  const HEAD = "a".repeat(40);
  const OTHER = "b".repeat(40);
  let nextNumber = 9100;
  let nextDiscussion = 900;
  const registry = { sandbox: { cancel: async (_run: ExecutionRun): Promise<CancelResult> => ({ settled_usd: 0, released_usd: 0 }) } } as unknown as ExecutionTargetRegistry;

  /** A resume that behaves like the pipeline's at admit: a keyed run row, then (when told to) `refused_spend` with the admit's reason recorded on the move. */
  function resumeWith(over: { deny?: string | null } = {}) {
    const inputs: StartAgentRunInput[] = [];
    const fn = vi.fn(async (_pool: Pool, _registry: ExecutionTargetRegistry, input: StartAgentRunInput) => {
      inputs.push(input);
      const { id } = await insertAgentRun(writerPool, {
        id: randomUUID(),
        accountId: input.accountId,
        workItemId: input.workItemId,
        parentRunId: input.parentRunId,
        role: "executor",
        runtime: "production",
        executionMode: "sandbox",
        dispatchRepoId: input.repoId,
        dispatchPrNumber: input.pr ?? null,
        idempotency: input.idempotency,
      });
      if (over.deny !== undefined) {
        await writeRunStatus(writerPool, { accountId: input.accountId, runId: id, from: "pending", to: "refused_spend", ...(over.deny !== null ? { failureReason: over.deny } : {}) });
        return over.deny === null ? { id, status: "refused_spend" } : { id, status: "refused_spend", reason: over.deny };
      }
      await writeRunStatus(writerPool, { accountId: input.accountId, runId: id, from: "pending", to: "running" });
      return { id, status: "running" };
    });
    return { fn, inputs };
  }
  function module(resume: ReturnType<typeof resumeWith>["fn"]) {
    const review: AdvanceReviewDeps = {
      load: vi.fn(async () => ({ ok: true as const, ctx: { workItemId: "x", stage: "pr_opened", repoId: "r", owner: "acme", name: "widgets", issue: 7, branch: "fx/issue-7", tier: "feature", specVersion: 1, debaterEnabled: false } })),
      recordRound: vi.fn(async (_p, _r, input) => ({ decision: "all_passed", round: 0, recorded: input.verdicts.map((v: { role: string; runId: string; verdict: string }) => ({ ...v, outcome: "passed" })) })),
      resume,
      mergeGate: vi.fn(async () => ({ outcome: "merged", headSha: HEAD, reasons: [], status: "posted" })),
    };
    const starter: RunStarter = { async start() { return { runId: randomUUID() }; } };
    const deps: AdvanceModuleDeps = { starter, resolveRunSeat: vi.fn(async () => SEAT), startAdvance: async () => undefined, triage: null, registry, review, fixHeads: { privateHead: async () => HEAD, syncBase: async () => ({ kind: "up_to_date", baseSha: "f".repeat(40), baseRef: "main", stacked: false }) } };
    return createAdvanceModule(writerPool, deps);
  }

  async function item(a: SeedRefs, stage = "changes_requested") {
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [a.repoId]);
    const id = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'issue', 'internal', $4, $5)", [id, a.accountId, a.repoId, stage, nextNumber++]);
    const discussion = randomUUID();
    await admin.query("INSERT INTO discussions (id, account_id, number, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, $2, $3, 'feature', 't', $4, 'internal', 'user')", [discussion, a.accountId, nextDiscussion++, id]);
    await admin.query("UPDATE work_items SET discussion_id = $1 WHERE id = $2", [discussion, id]);
    await admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, 'spec', encode(sha256(convert_to('spec', 'UTF8')), 'hex'), 'system')", [a.accountId, id]);
    const spec = (await admin.query<{ id: string }>("SELECT id FROM spec_versions WHERE work_item_id = $1", [id])).rows[0]!.id;
    const { id: buildId } = await insertAgentRun(writerPool, { id: randomUUID(), accountId: a.accountId, workItemId: id, specVersionId: spec, role: "executor", runtime: "production", executionMode: "sandbox", dispatchRepoId: a.repoId, dispatchPrNumber: nextNumber - 1 });
    await writeRunStatus(writerPool, { accountId: a.accountId, runId: buildId, from: "pending", to: "running" });
    await writeRunStatus(writerPool, { accountId: a.accountId, runId: buildId, from: "running", to: "succeeded", result: { sessionId: "cc-session-1", envelope: { verdict: "done" } } });
    return id;
  }
  const who = (a: SeedRefs, workItemId: string) => ({ accountId: a.accountId, userId: a.userId, workItemId, haltEpoch: 0 });
  const numberOf = async (id: string) => Number((await admin.query<{ gh_number: string }>("SELECT gh_number FROM work_items WHERE id = $1", [id])).rows[0]!.gh_number);
  const events = async (id: string) => (await admin.query<{ kind: string; code: string | null }>("SELECT kind, code FROM work_item_driver_events WHERE work_item_id = $1 ORDER BY seq", [id])).rows;
  const fixRequest = async (w: string, over: Record<string, unknown> = {}) => { const issue = await numberOf(w); return { issue, headSha: HEAD, prompt: "fix it", round: 1, actionId: randomUUID(), reviewer: "code" as const, failingRunId: randomUUID(), pr: { number: 41, branch: `fx/issue-${issue}` }, ...over }; };

  describe("the fix round start", () => {
    it.each(Object.keys(RESERVATION_DENIAL_PAUSES))("S5k1d-1: a %s denial answers that denial (the web step names the pause), moves nothing and writes no refusal fact", async (denial) => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, "pr_opened");
      const out = await module(resumeWith({ deny: denial }).fn).advanceStartFix(who(a, w), await fixRequest(w));
      expect(out).toEqual({ ok: false, reason: denial });
      expect((await events(w)).map((e) => e.kind)).not.toContain("fix_round_refused");
      expect((await events(w)).map((e) => e.kind)).not.toContain("fix_round_started");
      const run = await admin.query("SELECT status FROM agent_runs WHERE work_item_id = $1 AND role = 'executor' ORDER BY created_at DESC LIMIT 1", [w]);
      expect(run.rows[0].status).toBe("refused_spend");
    });

    it("S5k1d-6: a denial that is not a spending limit ends as it ends today: the code `refused_spend` and one refusal fact", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      for (const deny of ["account_not_active", null]) {
        const out = await module(resumeWith({ deny }).fn).advanceStartFix(who(a, w), await fixRequest(w));
        expect(out).toEqual({ ok: false, reason: "refused_spend" });
      }
      expect((await events(w)).filter((e) => e.kind === "fix_round_refused").map((e) => e.code)).toEqual(["refused_spend", "refused_spend"]);
    });

    it("S5k1d-2: each ask after a denial is a new attempt with its own key (`:s<n>` after the retry `:r<n>`), and the denied key is never replayed as a start", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      const denied = resumeWith({ deny: "model_budget_exceeded" });
      const req = await fixRequest(w);
      const m = module(denied.fn);
      expect(await m.advanceStartFix(who(a, w), req)).toEqual({ ok: false, reason: "model_budget_exceeded" });
      // The same ask again (a crashed step replayed): the denial again, not a started run on the refused one.
      expect(await m.advanceStartFix(who(a, w), req)).toEqual({ ok: false, reason: "model_budget_exceeded" });
      expect(denied.fn).toHaveBeenCalledTimes(1);
      // The next ask is attempt 1: another key, a real start now that the limit is raised.
      const ok = resumeWith();
      const started = await module(ok.fn).advanceStartFix(who(a, w), { ...req, spendAttempt: 1 });
      expect(started.ok).toBe(true);
      expect(ok.inputs[0]!.idempotency!.key).toBe(`advance:${w}:fix:${HEAD}:${req.actionId}:s1`);
    });

    it("S5k1d-2: a re-review retry and an attempt are different suffixes and never collide: `:r1`, `:s1` and `:r1:s1` are three keys", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      const req = await fixRequest(w, { round: 2 });
      const keys: string[] = [];
      for (const extra of [{ retry: 1 }, { spendAttempt: 1 }, { retry: 1, spendAttempt: 1 }]) {
        const r = resumeWith();
        const out = await module(r.fn).advanceStartFix(who(a, w), { ...req, ...extra });
        expect(out.ok, JSON.stringify(extra)).toBe(true);
        keys.push(r.inputs[0]!.idempotency!.key);
        // The run ends so the next start is not "already running".
        await writeRunStatus(writerPool, { accountId: a.accountId, runId: (out as { runId: string }).runId, from: "running", to: "succeeded", result: { sessionId: "cc-session-2", envelope: { summary: "x" } } });
      }
      expect(keys).toEqual([`advance:${w}:fix:${HEAD}:${req.actionId}:r1`, `advance:${w}:fix:${HEAD}:${req.actionId}:s1`, `advance:${w}:fix:${HEAD}:${req.actionId}:r1:s1`]);
      expect(new Set(keys).size).toBe(3);
    });

    it("an attempt number that is not a whole number in range is refused before anything is written", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      const r = resumeWith();
      for (const bad of [-1, 1.5, 100_001, Number.NaN]) expect(await module(r.fn).advanceStartFix(who(a, w), { ...(await fixRequest(w)), spendAttempt: bad })).toEqual({ ok: false, reason: "invalid_input" });
      expect(r.fn).not.toHaveBeenCalled();
    });

    it("the web-side denial list is the pipeline's: every denial the pipeline names as a pause is one the worker passes through", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      for (const denial of Object.keys(RESERVATION_DENIAL_PAUSES)) {
        const out = await module(resumeWith({ deny: denial }).fn).advanceStartFix(who(a, w), await fixRequest(w));
        expect(out).toEqual({ ok: false, reason: denial });
      }
    });
  });

  describe("advanceReviewRuns", () => {
    async function runWithKey(a: SeedRefs, w: string, key: string, status: string, role = "code-reviewer", at?: string): Promise<string> {
      const run = randomUUID();
      await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, $4, 'production', $5)", [run, a.accountId, w, role, status]);
      await admin.query("INSERT INTO agent_run_idempotency_keys (account_id, idempotency_key, run_id, request_hash, created_at) VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()))", [a.accountId, key, run, "0".repeat(64), at ?? null]);
      return run;
    }
    const lookup = (a: SeedRefs, w: string, headSha: string, rereview: number) => module(resumeWith().fn).advanceReviewRuns(who(a, w), { headSha, rereview });

    it("S5k1d-2: returns the runs that really started for the head and round, one per role, and never a refused one", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, "pr_opened");
      const code = await runWithKey(a, w, `advance:${w}:review:${HEAD}:code-reviewer`, "succeeded");
      await runWithKey(a, w, `advance:${w}:review:${HEAD}:acceptance-tester`, "refused_spend", "acceptance-tester");
      await runWithKey(a, w, `advance:${w}:review:${HEAD}:acceptance-tester:s1`, "refused_spend", "acceptance-tester");
      const sec = await runWithKey(a, w, `advance:${w}:review:${HEAD}:security-reviewer:s2`, "running", "security-reviewer");
      const out = await lookup(a, w, HEAD, 0);
      expect(out.sort((x, y) => x.role.localeCompare(y.role))).toMatchObject([
        { role: "code-reviewer", runId: code, attempt: 0 },
        { role: "security-reviewer", runId: sec, attempt: 2 },
      ]);
    });

    it("the head and the re-review round are exact: another head's runs and another round's runs are not returned", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, "pr_opened");
      await runWithKey(a, w, `advance:${w}:review:${OTHER}:code-reviewer`, "succeeded");
      const rr1 = await runWithKey(a, w, `advance:${w}:review:${HEAD}:code-reviewer:rr1`, "succeeded");
      expect(await lookup(a, w, HEAD, 0)).toEqual([]);
      expect(await lookup(a, w, HEAD, 1)).toMatchObject([{ role: "code-reviewer", runId: rr1, attempt: 0 }]);
      expect(await lookup(a, w, HEAD, 2)).toEqual([]);
    });

    it("a re-review round's attempt and a placement generation read through: `:rr1:s3:p1` is the round-1 reviewer", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, "pr_opened");
      const run = await runWithKey(a, w, `advance:${w}:review:${HEAD}:code-reviewer:rr1:s3:p1`, "succeeded");
      expect(await lookup(a, w, HEAD, 1)).toMatchObject([{ role: "code-reviewer", runId: run, attempt: 3 }]);
      expect(await lookup(a, w, HEAD, 0)).toEqual([]);
    });

    it("the newest run of a role wins", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, "pr_opened");
      await runWithKey(a, w, `advance:${w}:review:${HEAD}:code-reviewer`, "succeeded", "code-reviewer", "2026-01-01T00:00:00Z");
      const later = await runWithKey(a, w, `advance:${w}:review:${HEAD}:code-reviewer:s1`, "succeeded", "code-reviewer", "2026-01-02T00:00:00Z");
      expect(await lookup(a, w, HEAD, 0)).toMatchObject([{ role: "code-reviewer", runId: later, attempt: 1 }]);
    });

    it("the attempt is the highest of ALL the role's keys, refused ones included, so a re-run after a run with no verdict never reuses a key", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, "pr_opened");
      const failed = await runWithKey(a, w, `advance:${w}:review:${HEAD}:code-reviewer`, "failed", "code-reviewer", "2026-01-01T00:00:00Z");
      await runWithKey(a, w, `advance:${w}:review:${HEAD}:code-reviewer:s2`, "refused_spend", "code-reviewer", "2026-01-02T00:00:00Z");
      expect(await lookup(a, w, HEAD, 0)).toMatchObject([{ role: "code-reviewer", runId: failed, attempt: 2 }]);
    });

    it("another item's runs and another account's runs are never returned, and malformed input answers nothing", async () => {
      const a = await seedAccount(admin, randomUUID());
      const b = await seedAccount(admin, randomUUID());
      const w = await item(a, "pr_opened");
      const w2 = await item(a, "pr_opened");
      const wb = await item(b, "pr_opened");
      await runWithKey(a, w2, `advance:${w2}:review:${HEAD}:code-reviewer`, "succeeded");
      await runWithKey(b, wb, `advance:${wb}:review:${HEAD}:code-reviewer`, "succeeded");
      expect(await lookup(a, w, HEAD, 0)).toEqual([]);
      // Account A asking about B's item: the tenant context hides B's rows.
      expect(await lookup(a, wb, HEAD, 0)).toEqual([]);
      for (const bad of ["", "zz", "A".repeat(40), `${HEAD}%`]) expect(await lookup(a, w, bad, 0)).toEqual([]);
      for (const bad of [-1, 1.5, 101]) expect(await lookup(a, w, HEAD, bad)).toEqual([]);
    });

    describe("advanceDeltaRuns (MQ3-b-2b)", () => {
      const delta = (a: SeedRefs, w: string, headSha: string) => module(resumeWith().fn).advanceDeltaRuns(who(a, w), { headSha });

      it("returns one run per role for the merge commit, the newest attempt speaking for the role, and says whether the run can still be used", async () => {
        const a = await seedAccount(admin, randomUUID());
        const w = await item(a, "pr_opened");
        await runWithKey(a, w, `advance:${w}:delta:${HEAD}:code-reviewer`, "failed", "code-reviewer", "2026-01-01T00:00:00Z");
        const retry = await runWithKey(a, w, `advance:${w}:delta:${HEAD}:code-reviewer:s1`, "running", "code-reviewer", "2026-01-02T00:00:00Z");
        const cancelled = await runWithKey(a, w, `advance:${w}:delta:${HEAD}:debater`, "cancelled", "debater");
        const refused = await runWithKey(a, w, `advance:${w}:delta:${HEAD}:security-reviewer`, "refused_spend", "security-reviewer");
        const out = (await delta(a, w, HEAD)).sort((x, y) => x.role.localeCompare(y.role));
        expect(out).toEqual([
          { role: "code-reviewer", runId: retry, attempt: 1, reusable: true },
          { role: "debater", runId: cancelled, attempt: 0, reusable: false },
          { role: "security-reviewer", runId: refused, attempt: 0, reusable: false },
        ]);
      });

      it("the head is exact, a full-review key for the same head is not a delta run, and keys that do not parse are skipped", async () => {
        const a = await seedAccount(admin, randomUUID());
        const w = await item(a, "pr_opened");
        await runWithKey(a, w, `advance:${w}:delta:${OTHER}:code-reviewer`, "succeeded");
        await runWithKey(a, w, `advance:${w}:review:${HEAD}:code-reviewer`, "succeeded");
        await runWithKey(a, w, `advance:${w}:delta:${HEAD}:code-reviewer:rr1`, "succeeded");
        expect(await delta(a, w, HEAD)).toEqual([]);
      });

      it("another item's and another account's runs are never returned, and malformed input answers nothing", async () => {
        const a = await seedAccount(admin, randomUUID());
        const b = await seedAccount(admin, randomUUID());
        const w = await item(a, "pr_opened");
        const w2 = await item(a, "pr_opened");
        const wb = await item(b, "pr_opened");
        await runWithKey(a, w2, `advance:${w2}:delta:${HEAD}:code-reviewer`, "succeeded");
        await runWithKey(b, wb, `advance:${wb}:delta:${HEAD}:code-reviewer`, "succeeded");
        expect(await delta(a, w, HEAD)).toEqual([]);
        expect(await delta(a, wb, HEAD)).toEqual([]);
        for (const bad of ["", "zz", "A".repeat(40), `${HEAD}%`]) expect(await delta(a, w, bad)).toEqual([]);
      });
    });

    describe("noVerdictEnds (the re-run bound's count, from stored runs)", () => {
      const ends = async (a: SeedRefs, w: string, role = "code-reviewer") => (await lookup(a, w, HEAD, 0)).find((r) => r.role === role)?.noVerdictEnds;
      const escalate = (a: SeedRefs, w: string, key: string) =>
        admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, reasons, dedupe_key) VALUES ($1, $2, 'escalated', 'reviewer_no_verdict', '{code_reviewer,agent_failed}'::text[], $3)", [a.accountId, w, key]);

      it("counts the role's terminal runs that left no verdict (failed, cancelled, timed out, or succeeded without a verdict key) on the head, across re-review rounds, and not a verdict, a live run or a spending-limit refusal", async () => {
        const a = await seedAccount(admin, randomUUID());
        const w = await item(a, "pr_opened");
        await runWithKey(a, w, `advance:${w}:review:${HEAD}:code-reviewer`, "failed", "code-reviewer", "2026-01-01T00:00:00Z");
        await runWithKey(a, w, `advance:${w}:review:${HEAD}:code-reviewer:s1`, "cancelled", "code-reviewer", "2026-01-02T00:00:00Z");
        await runWithKey(a, w, `advance:${w}:review:${HEAD}:code-reviewer:rr1`, "timed_out", "code-reviewer", "2026-01-03T00:00:00Z");
        await runWithKey(a, w, `advance:${w}:review:${HEAD}:code-reviewer:s2`, "refused_spend", "code-reviewer", "2026-01-04T00:00:00Z");
        const withVerdict = await runWithKey(a, w, `advance:${w}:review:${HEAD}:code-reviewer:s3`, "succeeded", "code-reviewer", "2026-01-05T00:00:00Z");
        await admin.query("UPDATE agent_runs SET envelope = $2::jsonb WHERE id = $1", [withVerdict, JSON.stringify({ verdict: "pass" })]);
        await runWithKey(a, w, `advance:${w}:review:${HEAD}:code-reviewer:s4`, "running", "code-reviewer", "2026-01-06T00:00:00Z");
        await runWithKey(a, w, `advance:${w}:review:${OTHER}:code-reviewer`, "failed", "code-reviewer", "2026-01-01T00:00:00Z");
        expect(await ends(a, w)).toBe(3);
        await runWithKey(a, w, `advance:${w}:review:${HEAD}:acceptance-tester`, "failed", "acceptance-tester");
        expect(await ends(a, w, "acceptance-tester")).toBe(1);
        expect(await ends(a, w)).toBe(3);
      });

      it("counts only runs asked after the item's newest reviewer_no_verdict escalation: a person's Approve starts the count again, and a spend-pause resume (no escalation) does not", async () => {
        const a = await seedAccount(admin, randomUUID());
        const w = await item(a, "pr_opened");
        await runWithKey(a, w, `advance:${w}:review:${HEAD}:code-reviewer`, "failed", "code-reviewer", "2026-01-01T00:00:00Z");
        await runWithKey(a, w, `advance:${w}:review:${HEAD}:code-reviewer:s1`, "failed", "code-reviewer", "2026-01-02T00:00:00Z");
        expect(await ends(a, w)).toBe(2);
        await escalate(a, w, "e1");
        // The escalation event is created now, after both runs: the count restarts from here.
        expect(await ends(a, w)).toBe(0);
        await runWithKey(a, w, `advance:${w}:review:${HEAD}:code-reviewer:s2`, "failed", "code-reviewer");
        expect(await ends(a, w)).toBe(1);
        // Another cause of escalation does not move the boundary.
        await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, dedupe_key) VALUES ($1, $2, 'escalated', 'reviewer_fail', 'e2')", [a.accountId, w]);
        expect(await ends(a, w)).toBe(1);
      });
    });
  });
});

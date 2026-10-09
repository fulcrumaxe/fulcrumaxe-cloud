import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configureErrorReporter } from "@fx/telemetry";
import {
  IdempotencyKeyTakenError,
  SandboxTarget,
  buildExecutionRun,
  createInMemoryHookChannel,
  startAgentRun,
  type ExecutionTarget,
  type ExecutionTargetRegistry,
  type NormalizedEvent,
  type StartAgentRunInput,
} from "@fx/runner";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import {
  PreviewUnavailableError,
  PREVIEW_COMPUTE_CAP_USD as CORE_COMPUTE_CAP,
  PREVIEW_DAILY_COMPUTE_CAP_USD as CORE_DAILY_CAP,
  PREVIEW_MODEL_CAP_USD as CORE_MODEL_CAP,
  getPreview,
  requestPreview,
} from "../../core/src/onboarding/index.js";
import { createRecordingRunActionSignal } from "../../core/src/runActions/index.js";
import { buildPreviewPrompt } from "../../pipeline/src/preview/prompt.js";
import { parsePreviewResult } from "../../pipeline/src/preview/result.js";
import { performerFor, type RunActionsWorker } from "../../pipeline/src/runActions/dispatcher.js";
import { createSandboxTargetHarness } from "../../runner/test/helpers/sandboxTargetFakes.js";
import {
  PREVIEW_COMPUTE_CAP_USD,
  PREVIEW_DAILY_COMPUTE_CAP_USD,
  PREVIEW_MODEL_CAP_USD,
  PREVIEW_ROLE,
  PREVIEW_SEAT_REFUSALS,
  PREVIEW_VOID_REASONS,
  PreviewLinkLostError,
  createPreviewModule,
  type PreviewSeatConfig,
  type PreviewSeatSource,
  type RunStarter,
} from "../src/preview.js";
import { createRunActionFacade } from "../src/runActions.js";
import { createRunStarter } from "../src/starter.js";
import { takeDailyLock } from "../src/preview.js";
import { PREVIEW_WORKDIR } from "@fx/runner";
import { eventually, runStarterContract, type RunStarterWorld } from "./support/runStarterContract.js";
import { previewSeatContract, expectedSandboxTimeoutMs } from "./support/previewSeatContract.js";
import { seedPreviewTarget } from "./support/previewTarget.js";

/**
 * D#2 H17c-2b [pg]: the start_preview performer against the real definers, with the run starter
 * and the seat source as test stand-ins. The atomicity tests use the REAL startAgentRun (and its
 * R-ATOMIC `inCreateTransaction` seam) over a stub execution target.
 */
describe("onboarding preview performer [pg]", { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  const facade = () => createRunActionFacade(writerPool, {} as ExecutionTargetRegistry);

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
  // The day cap counts every preview compute reservation in any state, so each test starts from none.
  beforeEach(async () => {
    await admin.query("DELETE FROM spend_reservations WHERE purpose = 'preview'");
  });

  // ---- stand-ins -------------------------------------------------------------------------------

  const SEAT: PreviewSeatConfig = {
    repoId: "",
    product: "team",
    roleCard: "preview role card",
    model: "haiku-4.5",
    capUsd: 20,
    spend: { plan: "starter", purpose: "preview", trigger: "foreground", estimateModelUsd: 20, estimateComputeUsd: 0.5, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 20 },
    limits: { maxRunMs: 9 * 60_000, maxTurns: 100, maxModelCalls: 300, meteringSilenceMs: 15 * 60_000 },
    timeoutMs: expectedSandboxTimeoutMs(9 * 60_000, 0),
  };
  /** S1 stand-in: the preview shape 3-2d-2's resolveRunSeat must match (CT-1 pins it). */
  const fakeSeats: PreviewSeatSource = {
    async previewSeat(accountId, repoId) {
      const { rows } = await admin.query(
        "SELECT i.app_kind FROM repos r JOIN installations i ON i.account_id = r.account_id AND i.id = r.installation_id WHERE r.id = $1 AND r.account_id = $2",
        [repoId, accountId],
      );
      if (!rows[0]) return { ok: false, reason: "no_repo" };
      if (rows[0].app_kind !== "team_readonly") return { ok: false, reason: "installation_not_writable" };
      return { ok: true, seat: { ...SEAT, repoId } };
    },
  };

  /** A starter that records its input and honours the seam the way a real one must: the link runs in a create transaction. */
  function recordingStarter(compute = 0, delayMs = 0) {
    const calls: StartAgentRunInput[] = [];
    const starter: RunStarter = {
      async start(input) {
        calls.push(input);
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        const runId = randomUUID();
        await withTenant(writerPool, input.accountId, (c) => input.inCreateTransaction!(c, runId));
        if (compute > 0) {
          await admin.query("INSERT INTO spend_reservations (account_id, usd_reserved, state, budget, purpose) VALUES ($1, $2, 'open', 'foreground_compute', 'preview')", [input.accountId, compute]);
        }
        return { runId };
      },
    };
    return { starter, calls };
  }

  /** A starter on the REAL startAgentRun over a stub target; `beforeCreate` runs first, `onAdmit` runs after the create committed. */
  function realStarter(hooks: { beforeCreate?: (input: StartAgentRunInput) => Promise<void>; onAdmit?: () => Promise<void> } = {}) {
    const target: ExecutionTarget = {
      runtime: "production",
      admit: async () => {
        await hooks.onAdmit?.();
        return { admitted: false, reason: "stub" };
      },
      cancel: async () => {},
      finalize: async () => {},
      dispatch: async () => ({ hookToken: "t" }),
      resume: async () => ({ hookToken: "t" }),
    } as unknown as ExecutionTarget;
    const starter: RunStarter = {
      async start(input) {
        await hooks.beforeCreate?.(input);
        const started = await startAgentRun(writerPool, { sandbox: target }, input);
        return { runId: started.id, ...(started.status === "refused_spend" ? { refused: "refused_spend" as const } : {}) };
      },
    };
    return starter;
  }

  const ready = (starter: RunStarter | null, seats: PreviewSeatSource | null = fakeSeats) => createPreviewModule(writerPool, { seats, starter, promptFor: buildPreviewPrompt });

  // ---- worlds ----------------------------------------------------------------------------------

  async function account(): Promise<SeedRefs> {
    const a = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE model_connections SET status = 'ok' WHERE account_id = $1", [a.accountId]);
    return a;
  }
  /** A requested preview whose action is claimed, ready for the performer. */
  async function requested(available: () => boolean = () => true, ghOwner?: string) {
    const a = await account();
    const t = await seedPreviewTarget(admin, a, "team_readonly", ghOwner);
    const r = await requestPreview(
      { pool: appPool, principal: { accountId: a.accountId, userId: a.userId } },
      { repoId: t.repoId, confirmModelCapUsd: 20 },
      { signal: createRecordingRunActionSignal(), available },
    );
    const claimed = await facade().claimRunAction(r.actionId, 600);
    expect(claimed?.kind).toBe("start_preview");
    return { a, t, ...r };
  }
  const previewRow = async (id: string) => (await admin.query("SELECT state, run_id, started_at, void_reason FROM onboarding_previews WHERE id = $1", [id])).rows[0];
  /** Runs dispatched for the account's preview repos (the seed's own baseline run is not one). */
  const runCount = async (accountId: string) =>
    Number((await admin.query("SELECT count(*) AS n FROM agent_runs WHERE account_id = $1 AND dispatch_repo_id IS NOT NULL", [accountId])).rows[0].n);
  const claimCount = async (accountId: string, key: string) =>
    Number((await admin.query("SELECT count(*) AS n FROM agent_run_idempotency_keys WHERE account_id = $1 AND idempotency_key = $2", [accountId, key])).rows[0].n);

  /** Preview compute already reserved today, as a row removed again afterwards. */
  async function withDailyUsage<T>(usd: number, body: () => Promise<T>): Promise<T> {
    const a = await seedAccount(admin, randomUUID());
    const { rows } = await admin.query(
      "INSERT INTO spend_reservations (account_id, usd_reserved, state, budget, purpose) VALUES ($1, $2, 'open', 'foreground_compute', 'preview') RETURNING id",
      [a.accountId, usd],
    );
    try {
      return await body();
    } finally {
      await admin.query("DELETE FROM spend_reservations WHERE id = $1", [rows[0].id]);
    }
  }

  // ---- the performer ---------------------------------------------------------------------------

  it("the constants equal core's (the worker cannot import core, so they are pinned here)", () => {
    expect([PREVIEW_MODEL_CAP_USD, PREVIEW_COMPUTE_CAP_USD, PREVIEW_DAILY_COMPUTE_CAP_USD]).toEqual([CORE_MODEL_CAP, CORE_COMPUTE_CAP, CORE_DAILY_CAP]);
  });

  it("not ready: the request is refused before anything is written", async () => {
    const m = ready(null, null);
    expect(m.previewReady()).toBe(false);
    expect(ready(recordingStarter().starter, null).previewReady()).toBe(false);
    expect(createPreviewModule(writerPool, { seats: fakeSeats, starter: recordingStarter().starter, promptFor: null }).previewReady()).toBe(false);
    expect(ready(recordingStarter().starter).previewReady()).toBe(true);
    const a = await account();
    const t = await seedPreviewTarget(admin, a);
    await expect(
      requestPreview({ pool: appPool, principal: { accountId: a.accountId, userId: a.userId } }, { repoId: t.repoId, confirmModelCapUsd: 20 }, { signal: createRecordingRunActionSignal(), available: m.previewReady }),
    ).rejects.toBeInstanceOf(PreviewUnavailableError);
    const n = await admin.query(
      "SELECT (SELECT count(*)::int FROM onboarding_previews WHERE account_id = $1) p, (SELECT count(*)::int FROM run_action_requests WHERE account_id = $1) q",
      [a.accountId],
    );
    expect(n.rows[0]).toEqual({ p: 0, q: 0 });
  });

  it("not ready: a start_preview claimed anyway settles refused, voids its preview, starts nothing, and leaves the customer's one preview unused", async () => {
    const { a, t, previewId, actionId } = await requested();
    const { starter, calls } = recordingStarter();
    const out = await ready(starter, null).performStartPreview(actionId);
    expect(out).toEqual({ result: "refused", errorCode: "preview_unavailable" });
    expect(await previewRow(previewId)).toMatchObject({ state: "void", run_id: null, started_at: null, void_reason: "preview_unavailable" });
    expect(calls).toHaveLength(0);
    expect(await runCount(a.accountId)).toBe(0);
    expect((await admin.query("SELECT count(*)::int AS n FROM spend_reservations WHERE account_id = $1 AND purpose = 'preview'", [a.accountId])).rows[0].n).toBe(0);
    // The one allowed preview is still available: a new request for the same installer is accepted.
    const again = await requestPreview(
      { pool: appPool, principal: { accountId: a.accountId, userId: a.userId } },
      { repoId: t.repoId, confirmModelCapUsd: 20 },
      { signal: createRecordingRunActionSignal(), available: () => true },
    );
    expect(again.replayed).toBe(false);
  });

  it("starts the run with the preview's caps, role and idempotency key, links it, and a replay starts nothing", async () => {
    const { a, previewId, actionId } = await requested(undefined, "acme-corp");
    const { starter, calls } = recordingStarter();
    const m = ready(starter);
    const out = await m.performStartPreview(actionId);
    expect(calls).toHaveLength(1);
    const input = calls[0]!;
    expect(input).toMatchObject({
      accountId: a.accountId,
      role: PREVIEW_ROLE,
      product: "team",
      capUsd: 20,
      model: "haiku-4.5",
      roleCard: "preview role card",
      timeoutMs: expectedSandboxTimeoutMs(9 * 60_000, 0),
      limits: SEAT.limits,
      idempotency: { key: `run-action:${actionId}`, requestHash: createHash("sha256").update(`start_preview:${previewId}`).digest("hex") },
    });
    expect(input.spend.purpose).toBe("preview");
    expect(input.spend.estimateComputeUsd).toBeLessThanOrEqual(1);
    expect(input.workItemId ?? null).toBeNull();
    expect(input.prompt).toContain("acme-corp/widgets");
    // The runner clones the repository into the workdir before the agent starts, and the prompt sends the agent there.
    expect(input.cloneRepo).toEqual({ owner: "acme-corp", name: "widgets" });
    expect(input.workdir).toBe(PREVIEW_WORKDIR);
    expect(input.prompt).toContain(PREVIEW_WORKDIR);
    const row = await previewRow(previewId);
    expect(row).toMatchObject({ state: "running", void_reason: null });
    expect(out).toEqual({ result: "done", outcome: { preview_id: previewId, run_id: row.run_id } });
    expect(row.started_at).not.toBeNull();

    expect(await m.performStartPreview(actionId)).toEqual(out);
    expect(calls).toHaveLength(1);
  });

  // ---- the operator subscription: no model key of its own, and an audit row saying which path ran ---------------

  const modeRows = async (accountId: string) =>
    (await admin.query("SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'onboarding_preview.model_mode'", [accountId])).rows;

  it("operator subscription: a started preview leaves one audit row naming the mode, with ids and the enum only", async () => {
    for (const [isOperator, mode] of [[true, "operator_subscription"], [false, "customer_key"]] as const) {
      const { a, previewId, actionId } = await requested();
      const { starter } = recordingStarter();
      const m = createPreviewModule(writerPool, { seats: fakeSeats, starter, promptFor: buildPreviewPrompt, isOperatorAccount: () => isOperator });
      const out = await m.performStartPreview(actionId);
      const row = await previewRow(previewId);
      expect(out).toEqual({ result: "done", outcome: { preview_id: previewId, run_id: row.run_id } });
      expect(await modeRows(a.accountId)).toEqual([{ actor: "system:onboarding_preview", payload: { preview_id: previewId, run_id: row.run_id, mode } }]);
      // A replay starts nothing and writes no second row.
      await m.performStartPreview(actionId);
      expect(await modeRows(a.accountId)).toHaveLength(1);
    }
  });

  it("operator subscription: only the account the module is told about is recorded as an operator", async () => {
    const { a, actionId } = await requested();
    const other = randomUUID();
    const { starter } = recordingStarter();
    await createPreviewModule(writerPool, { seats: fakeSeats, starter, promptFor: buildPreviewPrompt, isOperatorAccount: (id) => id === other }).performStartPreview(actionId);
    expect((await modeRows(a.accountId))[0]!.payload.mode).toBe("customer_key");
  });

  it("onboarding_preview_record_mode: refuses an unknown mode and a preview that is not running, and writes nothing", async () => {
    const { a, previewId } = await requested();
    const record = (id: string, mode: string) => withTenant(writerPool, a.accountId, (c) => c.query("SELECT onboarding_preview_record_mode($1::uuid, $2::text)", [id, mode]));
    await expect(record(previewId, "operator_subscription")).rejects.toMatchObject({ code: "P0002" }); // still 'requested'
    await expect(record(previewId, "customer_gateway")).rejects.toMatchObject({ code: "22023" });
    await expect(record(previewId, "")).rejects.toMatchObject({ code: "22023" });
    await expect(record(randomUUID(), "customer_key")).rejects.toMatchObject({ code: "P0002" });
    expect(await modeRows(a.accountId)).toEqual([]);
  });

  it("onboarding_preview_record_mode: is not callable by a tenant login", async () => {
    const { a, previewId } = await requested();
    await expect(withTenant(appPool, a.accountId, (c) => c.query("SELECT onboarding_preview_record_mode($1::uuid, 'operator_subscription')", [previewId]))).rejects.toMatchObject({ code: "42501" });
  });

  it("operator subscription: the request needs no model connection for an operator account, and still needs one for everyone else", async () => {
    for (const [operator, outcome] of [[true, "accepted"], [false, "no_model_key"]] as const) {
      const a = await seedAccount(admin, randomUUID());
      await admin.query("DELETE FROM model_connections WHERE account_id = $1", [a.accountId]);
      const t = await seedPreviewTarget(admin, a);
      const attempt = requestPreview(
        { pool: appPool, principal: { accountId: a.accountId, userId: a.userId } },
        { repoId: t.repoId, confirmModelCapUsd: 20 },
        { signal: createRecordingRunActionSignal(), available: () => true, isOperatorAccount: () => operator },
      );
      if (outcome === "accepted") expect((await attempt).replayed).toBe(false);
      else await expect(attempt).rejects.toThrow(/no working model connection/);
    }
  });

  it("a seat refusal settles refused with the seat's reason and voids; a seat that breaks the caps is refused too", async () => {
    const one = await requested();
    const { starter, calls } = recordingStarter();
    const refusing: PreviewSeatSource = { previewSeat: async () => ({ ok: false, reason: "no_model" }) };
    expect(await ready(starter, refusing).performStartPreview(one.actionId)).toEqual({ result: "refused", errorCode: "no_model" });
    expect(await previewRow(one.previewId)).toMatchObject({ state: "void", void_reason: "no_model" });

    const two = await requested();
    const greedy: PreviewSeatSource = { previewSeat: async (_a, repoId) => ({ ok: true, seat: { ...SEAT, repoId, spend: { ...SEAT.spend, estimateComputeUsd: 2 } } }) };
    expect(await ready(starter, greedy).performStartPreview(two.actionId)).toEqual({ result: "refused", errorCode: "seat_over_cap" });
    expect(await previewRow(two.previewId)).toMatchObject({ state: "void", void_reason: "seat_over_cap" });
    const three = await requested();
    const notPreview: PreviewSeatSource = { previewSeat: async (_a, repoId) => ({ ok: true, seat: { ...SEAT, repoId, spend: { ...SEAT.spend, purpose: "run" } } }) };
    expect(await ready(starter, notPreview).performStartPreview(three.actionId)).toEqual({ result: "refused", errorCode: "seat_over_cap" });
    expect(calls).toHaveLength(0);
  });

  it("D#6 C29: a preview for a runner_local repo is refused preview_runner_local before any run, reservation or cap read; the preview is voided and no row is added", async () => {
    const { starter, calls } = recordingStarter();
    const { a, t, previewId, actionId } = await requested();
    await admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [t.repoId]);
    const rows = async () => ({
      runs: Number((await admin.query("SELECT count(*) AS n FROM agent_runs WHERE account_id = $1", [a.accountId])).rows[0].n),
      previews: Number((await admin.query("SELECT count(*) AS n FROM onboarding_previews WHERE account_id = $1", [a.accountId])).rows[0].n),
      reservations: Number((await admin.query("SELECT count(*) AS n FROM spend_reservations WHERE account_id = $1", [a.accountId])).rows[0].n),
    });
    const before = await rows();
    expect(await ready(starter).performStartPreview(actionId)).toEqual({ result: "refused", errorCode: "preview_runner_local" });
    expect(calls).toHaveLength(0);
    expect(await rows()).toEqual(before);
    expect(await previewRow(previewId)).toMatchObject({ state: "void", run_id: null, void_reason: "preview_runner_local" });
    // The control: the same repo on the sandbox starts, so the refusal above is the mode and nothing else.
    await admin.query("UPDATE repos SET execution_mode = 'sandbox' WHERE id = $1", [t.repoId]);
    const again = await requested();
    expect(await ready(recordingStarter().starter).performStartPreview(again.actionId)).toMatchObject({ result: "done" });
  });

  it("void_reason is written only from the closed list: the list is pinned, every seat refusal is recorded as itself, anything else as seat_refused", async () => {
    expect([...PREVIEW_VOID_REASONS].sort()).toEqual(
      [
        "account_not_found", "installation_not_writable", "limits_exceed_sandbox", "model_budget_unset", "no_card", "no_installation", "no_model", "no_repo",
        "precheck_failed", "preview_capacity", "preview_runner_local", "preview_unavailable", "seat_over_cap", "seat_refused", "spend_refused", "start_failed", "unknown_role",
      ].sort(),
    );
    // Every reason the module can write is in the list: each literal handed to voidAndRefuse/voidPreview, plus the seat enum.
    const source = readFileSync(new URL("../src/preview.ts", import.meta.url), "utf8");
    const literals = [...source.matchAll(/(?:voidAndRefuse|voidPreview\(client, preview\.id,)\s*\(?\s*"([a-z_]+)"/g)].map((m) => m[1]);
    expect(literals.length).toBeGreaterThanOrEqual(5);
    for (const reason of [...literals, ...PREVIEW_SEAT_REFUSALS]) expect(PREVIEW_VOID_REASONS as readonly string[]).toContain(reason);
    // No other write to void_reason exists.
    expect([...source.matchAll(/void_reason = /g)]).toHaveLength(1);
    const { starter } = recordingStarter();
    for (const reason of [...PREVIEW_SEAT_REFUSALS, "some free text", "x".repeat(200), "Not_Lower", "preview_capacity"]) {
      const { previewId, actionId } = await requested();
      const seats: PreviewSeatSource = { previewSeat: async () => ({ ok: false, reason }) };
      const expected = (PREVIEW_SEAT_REFUSALS as readonly string[]).includes(reason) ? reason : "seat_refused";
      expect(await ready(starter, seats).performStartPreview(actionId)).toEqual({ result: "refused", errorCode: expected });
      expect((await previewRow(previewId)).void_reason).toBe(expected);
    }
  });

  it("the day's preview compute cap is checked under the lock: at the cap the action is refused and voided", async () => {
    const { previewId, actionId } = await requested();
    const { starter, calls } = recordingStarter();
    await withDailyUsage(PREVIEW_DAILY_COMPUTE_CAP_USD, async () => {
      expect(await ready(starter).performStartPreview(actionId)).toEqual({ result: "refused", errorCode: "preview_capacity" });
    });
    expect(await previewRow(previewId)).toMatchObject({ state: "void", void_reason: "preview_capacity" });
    expect(calls).toHaveLength(0);
  });

  it("the day cap counts a reservation in any state (a released or settled preview compute row still counts)", async () => {
    const { actionId } = await requested();
    const a = await seedAccount(admin, randomUUID());
    await admin.query("INSERT INTO spend_reservations (account_id, usd_reserved, state, budget, purpose) VALUES ($1, $2, 'released', 'foreground_compute', 'preview')", [a.accountId, PREVIEW_DAILY_COMPUTE_CAP_USD]);
    expect(await ready(recordingStarter().starter).performStartPreview(actionId)).toEqual({ result: "refused", errorCode: "preview_capacity" });
  });

  it("race: two claimed actions near the day's cap, only one starts", async () => {
    const x = await requested();
    const y = await requested();
    const { starter, calls } = recordingStarter(1, 80);
    const m = ready(starter);
    await withDailyUsage(PREVIEW_DAILY_COMPUTE_CAP_USD - 1, async () => {
      const outs = await Promise.all([m.performStartPreview(x.actionId), m.performStartPreview(y.actionId)]);
      expect(outs.map((o) => o.result).sort()).toEqual(["done", "refused"]);
      expect(outs.filter((o) => o.result === "refused")).toEqual([{ result: "refused", errorCode: "preview_capacity" }]);
    });
    expect(calls).toHaveLength(1);
    const states = [await previewRow(x.previewId), await previewRow(y.previewId)].map((r) => r.state).sort();
    expect(states).toEqual(["running", "void"]);
  });

  it("a launch that is still stalled after admit holds nobody: another account's preview is decided at once, and still sees the stalled run's reservation against the cap", async () => {
    const x = await requested();
    const y = await requested();
    const z = await requested();
    const w = await requested();
    let gate!: () => void;
    let gate2!: () => void;
    const stalled = new Promise<void>((resolve) => (gate = resolve));
    const stalled2 = new Promise<void>((resolve) => (gate2 = resolve));
    const fast = recordingStarter(0).starter;
    let enteredStall = false;
    let lockHeldInTx = false;
    let lockGoneAfterAdmit = false;
    let inStall = false;
    // X reserves its compute, lets go of the cap (afterAdmit), then its launch stalls. W stalls the same way, with no reservation.
    const starter: RunStarter = {
      async start(input) {
        if (input.accountId === x.a.accountId) {
          const runId = randomUUID();
          await withTenant(writerPool, input.accountId, (c) => input.inCreateTransaction!(c, runId));
          await admin.query("INSERT INTO spend_reservations (account_id, usd_reserved, state, budget, purpose) VALUES ($1, 1, 'open', 'foreground_compute', 'preview')", [input.accountId]);
          // While the day-cap lock is held it is an advisory TRANSACTION lock on a connection that is inside a transaction
          // (a pooler in transaction mode keeps one backend for that), and it is gone once the run is admitted.
          const held = () => admin.query("SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.locktype = 'advisory' AND l.granted AND a.state LIKE 'idle in transaction%'");
          lockHeldInTx = (await held()).rows[0].n > 0;
          input.afterAdmit?.();
          await eventually(async () => (await held()).rows[0].n, (n) => n === 0);
          lockGoneAfterAdmit = (await held()).rows[0].n === 0;
          enteredStall = true;
          await stalled;
          return { runId };
        }
        if (input.accountId === w.a.accountId) {
          input.afterAdmit?.();
          inStall = true;
          await stalled2;
        }
        return fast.start(input);
      },
    };
    const m = ready(starter);
    const timeout = (ms: number) => new Promise<string>((r) => setTimeout(() => r("blocked"), ms));
    try {
      await withDailyUsage(PREVIEW_DAILY_COMPUTE_CAP_USD - 1, async () => {
        const first = m.performStartPreview(x.actionId);
        await eventually(async () => enteredStall, (v) => v);
        // X is stalled. Y is decided without waiting for it, and X's reservation already counts: the day is full.
        const out = await Promise.race([m.performStartPreview(y.actionId), timeout(8_000)]);
        expect(out).toEqual({ result: "refused", errorCode: "preview_capacity" });
        expect(lockHeldInTx).toBe(true);
        expect(lockGoneAfterAdmit).toBe(true);
        gate();
        expect(await first).toMatchObject({ result: "done" });
      });
      // With room under the cap, a different account's start also goes through while another launch is stalled.
      const slow = m.performStartPreview(w.actionId);
      await eventually(async () => inStall, (v) => v);
      const other = await Promise.race([m.performStartPreview(z.actionId), timeout(8_000)]);
      expect(other).toMatchObject({ result: "done" });
      gate2();
      await slow;
    } finally {
      gate();
      gate2();
    }
  });

  it("takeDailyLock: BEGIN then the transaction lock on one client, COMMIT on that same client, once; ROLLBACK and a destroyed client when the lock fails", async () => {
    const log: string[] = [];
    const clientOf = (name: string, failOn?: string) => ({
      query: async (sql: string) => {
        log.push(`${name}:${sql.split("(")[0]!.trim()}`);
        if (failOn && sql.startsWith(failOn)) throw new Error("boom");
        return { rows: [] };
      },
      release: (err?: Error) => void log.push(`${name}:release${err ? ":destroyed" : ""}`),
    });
    const poolOf = (c: ReturnType<typeof clientOf>) => ({ connect: async () => c }) as unknown as Pool;
    const lock = await takeDailyLock(poolOf(clientOf("a")));
    await lock.release();
    await lock.release();
    expect(log).toEqual(["a:BEGIN", "a:SELECT pg_advisory_xact_lock", "a:COMMIT", "a:release"]);
    log.length = 0;
    await expect(takeDailyLock(poolOf(clientOf("b", "SELECT pg_advisory_xact_lock")))).rejects.toThrow("boom");
    expect(log).toEqual(["b:BEGIN", "b:SELECT pg_advisory_xact_lock", "b:ROLLBACK", "b:release:destroyed"]);
    log.length = 0;
    const bad = await takeDailyLock(poolOf(clientOf("c", "COMMIT")));
    await bad.release();
    expect(log).toEqual(["c:BEGIN", "c:SELECT pg_advisory_xact_lock", "c:COMMIT", "c:release:destroyed"]);
  });

  it("an action that is not a live start_preview lease is refused by the database, not performed", async () => {
    const { actionId } = await requested();
    await facade().settleRunAction(actionId, { state: "failed", errorCode: "x" });
    await expect(ready(recordingStarter().starter).performStartPreview(actionId)).rejects.toMatchObject({ name: "RunActionRefusedError" });
    await expect(ready(recordingStarter().starter).performStartPreview("not-a-uuid")).rejects.toMatchObject({ name: "RunActionInputError" });
  });

  // ---- R-ATOMIC: the link commits with the run, or neither does -----------------------------------

  it("atomic: the run row, its idempotency claim and the preview's link commit together, before admit (so before any sandbox)", async () => {
    const { a, previewId, actionId } = await requested();
    const key = `run-action:${actionId}`;
    let atAdmit: Record<string, unknown> | undefined;
    const starter = realStarter({
      onAdmit: async () => {
        const row = await previewRow(previewId);
        atAdmit = { ...row, claims: await claimCount(a.accountId, key), runs: await runCount(a.accountId) };
      },
    });
    const out = await ready(starter).performStartPreview(actionId);
    // The stub target refuses at admit, so the preview ends void (H17c-2c); the link was there at admit all the same.
    expect(out).toEqual({ result: "refused", errorCode: "spend_refused" });
    const runId = atAdmit!.run_id as string;
    expect(atAdmit).toMatchObject({ state: "running", claims: 1, runs: 1 });
    expect(runId).toEqual(expect.any(String));
    expect(await previewRow(previewId)).toMatchObject({ state: "void", run_id: runId });
    // The run the preview points at is the one the claim names.
    expect((await admin.query("SELECT run_id FROM agent_run_idempotency_keys WHERE account_id = $1 AND idempotency_key = $2", [a.accountId, key])).rows[0].run_id).toBe(runId);
  });

  it("atomic: when the link cannot be made, the run is not created either (no run row, no claim, nothing started)", async () => {
    const { a, previewId, actionId } = await requested();
    const key = `run-action:${actionId}`;
    // The preview moves on after the performer has validated it and before the run's create transaction links it.
    const starter = realStarter({
      beforeCreate: async () => {
        await admin.query("UPDATE onboarding_previews SET state = 'void', void_reason = 'seat_refused' WHERE id = $1", [previewId]);
      },
    });
    await expect(ready(starter).performStartPreview(actionId)).rejects.toBeInstanceOf(PreviewLinkLostError);
    expect(await runCount(a.accountId)).toBe(0);
    expect(await claimCount(a.accountId, key)).toBe(0);
    expect(await previewRow(previewId)).toMatchObject({ state: "void", run_id: null, void_reason: "seat_refused" });
  });

  it("a starter that does not pass the seam through never reports a started preview", async () => {
    const { previewId, actionId } = await requested();
    const dropsSeam: RunStarter = { start: async () => ({ runId: randomUUID() }) };
    await expect(ready(dropsSeam).performStartPreview(actionId)).rejects.toBeInstanceOf(PreviewLinkLostError);
    expect(await previewRow(previewId)).toMatchObject({ state: "requested", run_id: null });
  });

  it("a run refused at admit (nothing spent) voids the preview, keeps the run link, refuses the action, and frees the customer's one slot", async () => {
    const { a, t, previewId, actionId } = await requested();
    const out = await ready(realStarter()).performStartPreview(actionId);
    expect(out).toEqual({ result: "refused", errorCode: "spend_refused" });
    const row = await previewRow(previewId);
    expect(row).toMatchObject({ state: "void", void_reason: "spend_refused" });
    expect(row.run_id).not.toBeNull();
    expect(row.started_at).not.toBeNull();
    expect((await admin.query("SELECT status FROM agent_runs WHERE id = $1", [row.run_id])).rows[0].status).toBe("refused_spend");
    // A replay repeats the refusal and starts nothing; a new request for the same installer is admitted.
    expect(await ready(realStarter()).performStartPreview(actionId)).toEqual({ result: "refused", errorCode: "spend_refused" });
    const again = await requestPreview(
      { pool: appPool, principal: { accountId: a.accountId, userId: a.userId } },
      { repoId: t.repoId, confirmModelCapUsd: 20 },
      { signal: createRecordingRunActionSignal(), available: () => true },
    );
    expect(again.replayed).toBe(false);
  });

  it("a starter that reports no refusal leaves the preview running (only a refused_spend run is voided)", async () => {
    const { previewId, actionId } = await requested();
    const out = await ready(recordingStarter().starter).performStartPreview(actionId);
    expect(out.result).toBe("done");
    expect(await previewRow(previewId)).toMatchObject({ state: "running", void_reason: null });
  });

  // ---- H17c-2c: a seat or cap read that throws, and a void that fails ------------------------------

  /** The runner pool with one statement made to fail: `match` picks it, `times` limits how often. */
  function failingPool(match: RegExp, times = 1): Pool {
    let left = times;
    return {
      query: (...args: unknown[]) => (writerPool.query as (...a: unknown[]) => Promise<unknown>)(...args),
      connect: async () => {
        const c = await writerPool.connect();
        const q = c.query.bind(c) as (...a: unknown[]) => Promise<unknown>;
        (c as unknown as { query: unknown }).query = (...a: unknown[]) => {
          if (typeof a[0] === "string" && match.test(a[0]) && left > 0) {
            left -= 1;
            return Promise.reject(new Error("injected failure"));
          }
          return q(...a);
        };
        return c;
      },
    } as unknown as Pool;
  }

  it("a seat source that throws voids the preview (precheck_failed), rethrows, and frees the slot", async () => {
    const { a, t, previewId, actionId } = await requested();
    const boom = new Error("seat source down");
    const throwingSeats: PreviewSeatSource = { previewSeat: async () => Promise.reject(boom) };
    const { starter, calls } = recordingStarter();
    await expect(ready(starter, throwingSeats).performStartPreview(actionId)).rejects.toBe(boom);
    expect(await previewRow(previewId)).toMatchObject({ state: "void", run_id: null, void_reason: "precheck_failed" });
    expect(calls).toHaveLength(0);
    const again = await requestPreview(
      { pool: appPool, principal: { accountId: a.accountId, userId: a.userId } },
      { repoId: t.repoId, confirmModelCapUsd: 20 },
      { signal: createRecordingRunActionSignal(), available: () => true },
    );
    expect(again.replayed).toBe(false);
  });

  it("a day-cap read that throws voids the preview too", async () => {
    const { previewId, actionId } = await requested();
    const m = createPreviewModule(failingPool(/preview_daily_compute_usd/), { seats: fakeSeats, starter: recordingStarter().starter, promptFor: buildPreviewPrompt });
    await expect(m.performStartPreview(actionId)).rejects.toThrow("injected failure");
    expect(await previewRow(previewId)).toMatchObject({ state: "void", void_reason: "precheck_failed" });
  });

  it("a database error while voiding for a missing repo name is not swallowed (the void is not retried on the same transaction)", async () => {
    const { previewId, actionId } = await requested();
    // promptFor throws for this repo, as for a name that is not a GitHub name; the first void write fails once.
    const m = createPreviewModule(failingPool(/UPDATE onboarding_previews SET state = 'void'/), {
      seats: fakeSeats,
      starter: recordingStarter().starter,
      promptFor: () => {
        throw new Error("not a github name");
      },
    });
    await expect(m.performStartPreview(actionId)).rejects.toThrow("injected failure");
    // Rolled back with the failed void: still requested, so the action can be retried.
    expect(await previewRow(previewId)).toMatchObject({ state: "requested", run_id: null });
  });

  describe("a failure at the cap read, the seat or the start is reported once, by stage, with no message text", () => {
    const canary = "h1d-canary-plainword";
    async function reported(run: () => Promise<unknown>): Promise<string[]> {
      const lines: string[] = [];
      configureErrorReporter({ service: "worker", write: (line) => void lines.push(line) });
      try {
        await run().catch(() => undefined);
      } finally {
        configureErrorReporter({ service: "app" });
      }
      return lines;
    }
    function expectOnly(lines: string[], stage: string) {
      expect(lines).toHaveLength(1);
      const out = lines.join("\n");
      expect(out).toContain(stage);
      for (const other of ["preview.cap_read", "preview.seat", "preview.start"]) if (other !== stage) expect(out).not.toContain(other);
      for (const leak of ["h1d-canary", "plainword", "octo", "github.com"]) expect(out).not.toContain(leak);
    }

    it("cap read", async () => {
      const { actionId } = await requested();
      const m = createPreviewModule(failingPool(/preview_daily_compute_usd/), { seats: fakeSeats, starter: recordingStarter().starter, promptFor: buildPreviewPrompt });
      expectOnly(await reported(() => m.performStartPreview(actionId)), "preview.cap_read");
    });

    it("seat", async () => {
      const { actionId } = await requested();
      const seats: PreviewSeatSource = { previewSeat: async () => Promise.reject(new Error(`seat down ${canary} github.com/octo/repo`)) };
      expectOnly(await reported(() => ready(recordingStarter().starter, seats).performStartPreview(actionId)), "preview.seat");
    });

    it("start", async () => {
      const { actionId } = await requested();
      const starter: RunStarter = { start: async () => Promise.reject(new Error(`start down ${canary} github.com/octo/repo`)) };
      expectOnly(await reported(() => ready(starter).performStartPreview(actionId)), "preview.start");
    });
  });

  it("a prompt builder that throws voids the preview as no_repo, and the report carries the stage only, never the planted token", async () => {
    const { previewId, actionId } = await requested();
    const lines: string[] = [];
    configureErrorReporter({ service: "worker", write: (line) => void lines.push(line) });
    try {
      const m = createPreviewModule(writerPool, {
        seats: fakeSeats,
        starter: recordingStarter().starter,
        promptFor: () => {
          throw new Error("not a github name: h1d-canary-plainword at github.com/octo/repo");
        },
      });
      expect(await m.performStartPreview(actionId)).toEqual({ result: "refused", errorCode: "no_repo" });
    } finally {
      configureErrorReporter({ service: "app" });
    }
    expect(await previewRow(previewId)).toMatchObject({ state: "void", void_reason: "no_repo" });
    const out = lines.join("\n");
    expect(out).toContain("preview.prompt");
    for (const leak of ["h1d-canary", "plainword", "octo", "github.com"]) expect(out).not.toContain(leak);
  });

  // ---- A6: refuse, void or throw all void the preview -------------------------------------------

  it("a start() that throws before any run exists voids the preview with start_failed, rethrows, and leaves the customer's one preview unused", async () => {
    const { a, t, previewId, actionId } = await requested();
    const boom = new Error("sandbox provider down");
    const throwing: RunStarter = {
      start: async () => {
        throw boom;
      },
    };
    await expect(ready(throwing).performStartPreview(actionId)).rejects.toBe(boom);
    expect(await previewRow(previewId)).toMatchObject({ state: "void", run_id: null, started_at: null, void_reason: "start_failed" });
    expect(await runCount(a.accountId)).toBe(0);
    // A retry of the same action is refused, not performed.
    expect(await ready(recordingStarter().starter).performStartPreview(actionId)).toEqual({ result: "refused", errorCode: "preview_not_requested" });
    const again = await requestPreview(
      { pool: appPool, principal: { accountId: a.accountId, userId: a.userId } },
      { repoId: t.repoId, confirmModelCapUsd: 20 },
      { signal: createRecordingRunActionSignal(), available: () => true },
    );
    expect(again.replayed).toBe(false);
  });

  it("a start() that throws after its create committed leaves the linked preview alone (it cannot be voided: a run exists)", async () => {
    const { previewId, actionId } = await requested();
    const boom = new Error("dispatch failed");
    const lateThrow: RunStarter = {
      async start(input) {
        await withTenant(writerPool, input.accountId, (c) => input.inCreateTransaction!(c, randomUUID()));
        throw boom;
      },
    };
    await expect(ready(lateThrow).performStartPreview(actionId)).rejects.toBe(boom);
    expect(await previewRow(previewId)).toMatchObject({ state: "running", void_reason: null });
  });

  // ---- the contract suites, against the stand-ins ------------------------------------------------

  previewSeatContract("the test fake", fakeSeats, () => admin);

  const FIXTURE_ENVELOPE = {
    issues: [{ number: 7, title: "Crash on empty input", category: "bug", expected_model_usd: 2.5 }],
    sample_spec: { issue_number: 7, body: "## Spec\nFix the crash." },
  };

  /** S2 stand-in built from the real startAgentRun and SandboxTarget over the SDK fake, with an in-process hook channel. */
  function realStarterWorld(production = false): RunStarterWorld {
    const gates = new Map<string, () => void>();
    const finalizeErrors: unknown[] = [];
    const channel = createInMemoryHookChannel();
    const result: NormalizedEvent = { runId: "r", role: PREVIEW_ROLE, seq: 2, type: "result", ts: new Date().toISOString(), costUsd: 0.4, agentOutput: FIXTURE_ENVELOPE };
    const harness = createSandboxTargetHarness(writerPool, [result]);
    const real = harness.deps.sandboxPort;
    // The sandbox's hook fires when the test says so, not as soon as the fake runtime finishes.
    const sandboxPort = {
      ...real,
      startDetached: (handle: Parameters<typeof real.startDetached>[0], o: Parameters<typeof real.startDetached>[1]) => {
        const started = real.startDetached(handle, o);
        const gate = new Promise<void>((resolve) => gates.set(o.runId, resolve));
        return { ...started, hookFired: gate.then(() => started.hookFired) };
      },
    };
    const target = new SandboxTarget({ ...harness.deps, sandboxPort, hooks: channel.resumeSink });
    const registry: ExecutionTargetRegistry = { sandbox: target };
    const claimed = (accountId: string, key: string) =>
      withTenant(writerPool, accountId, async (c) => (await c.query("SELECT run_id FROM agent_run_idempotency_keys WHERE account_id = $1 AND idempotency_key = $2", [accountId, key])).rows[0]?.run_id as string | undefined);
    const standIn: RunStarter = {
      async start(input) {
        const existing = await claimed(input.accountId, input.idempotency!.key);
        if (existing) return { runId: existing };
        try {
          const started = await startAgentRun(writerPool, registry, input);
          if (started.status === "running") {
            // Recorded, not left to become an unhandled rejection: the contract asserts this list is empty.
            void channel.waitPort
              .wait(started.hookToken)
              .then((report) => target.finalize(buildExecutionRun(started.id, input), report))
              .catch((err: unknown) => void finalizeErrors.push(err));
          }
          return { runId: started.id };
        } catch (err) {
          if (!(err instanceof IdempotencyKeyTakenError)) throw err;
          return { runId: (await claimed(input.accountId, input.idempotency!.key))! };
        }
      },
    };
    // The production starter over the same registry; its follower is the in-process hook channel finalizing the run.
    const productionStarter = createRunStarter({
      pool: writerPool,
      registry,
      queued: "refuse",
      follow: async ({ runId, accountId, hookToken }) => {
        void channel.waitPort
          .wait(hookToken)
          .then((report) => target.finalize({ id: runId, accountId, role: PREVIEW_ROLE, product: "team", roleCard: "", prompt: "", model: "", capUsd: 0, spend: { plan: "starter" } }, report))
          .catch((err: unknown) => void finalizeErrors.push(err));
      },
    });
    const starter = production ? productionStarter : standIn;
    return {
      starter,
      admin,
      finalizeErrors: () => finalizeErrors,
      async newInput(key) {
        const a = await account();
        const t = await seedPreviewTarget(admin, a);
        return { ...SEAT, accountId: a.accountId, repoId: t.repoId, role: PREVIEW_ROLE, prompt: "p", spend: { ...SEAT.spend }, idempotency: { key, requestHash: createHash("sha256").update(key).digest("hex") } };
      },
      async fireHook(runId) {
        gates.get(runId)!();
      },
    };
  }
  let world: RunStarterWorld | undefined;
  runStarterContract("real startAgentRun + SandboxTarget over the SDK fake", () => (world ??= realStarterWorld()));
  // H14c-3-3a: the same contract, against the production starter.
  let productionWorld: RunStarterWorld | undefined;
  runStarterContract("the production createRunStarter over the SDK fake", () => (productionWorld ??= realStarterWorld(true)));

  // ---- end to end over the fakes -----------------------------------------------------------------

  it("request -> claim -> performStartPreview -> the run starter -> the hook fires -> getPreview returns the projected result", async () => {
    const w = (world ??= realStarterWorld());
    const m = ready(w.starter);
    const { a, previewId, actionId } = await requested(m.previewReady);
    const ctx = { pool: appPool, principal: { accountId: a.accountId, userId: a.userId } };

    const out = await performerFor("start_preview")!(m as unknown as RunActionsWorker, actionId);
    if (out.result !== "done") throw new Error(`expected done, got ${out.errorCode}`);
    const runId = out.outcome.run_id as string;
    await facade().settleRunAction(actionId, { state: "done", outcome: out.outcome });
    expect(await getPreview(ctx, previewId, { projectResult: parsePreviewResult })).toMatchObject({ state: "running", result: null, finished_at: null });

    await w.fireHook(runId);
    const done = await eventually(
      () => getPreview(ctx, previewId, { projectResult: parsePreviewResult }),
      (v) => v.state === "finished" || w.finalizeErrors().length > 0,
    );
    expect(w.finalizeErrors()).toEqual([]);
    expect(done).toMatchObject({ state: "finished", run_status: "succeeded", void_reason: null });
    expect(done.finished_at).not.toBeNull();
    expect(done.result).toEqual(FIXTURE_ENVELOPE);
    // The run it started is the preview's and cost the preview purpose, never a run purpose.
    expect((await admin.query("SELECT DISTINCT purpose FROM spend_reservations WHERE run_id = $1", [runId])).rows).toEqual([{ purpose: "preview" }]);
  });

  it("H14c-3-3a: a performer replay after start() returned starts no second run and no second follower", async () => {
    const follows: unknown[] = [];
    const harness = createSandboxTargetHarness(writerPool, []);
    const registry: ExecutionTargetRegistry = { sandbox: new SandboxTarget(harness.deps) };
    const m = ready(createRunStarter({ pool: writerPool, registry, queued: "refuse", follow: async (args) => void follows.push(args) }));
    const { a, previewId, actionId } = await requested(m.previewReady);
    const first = await m.performStartPreview(actionId);
    expect(first).toMatchObject({ result: "done" });
    expect(await m.performStartPreview(actionId)).toEqual(first);
    expect(follows).toHaveLength(1);
    expect(await runCount(a.accountId)).toBe(1);
    expect(await previewRow(previewId)).toMatchObject({ state: "running" });
  });
});

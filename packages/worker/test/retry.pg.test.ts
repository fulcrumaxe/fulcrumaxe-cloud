import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLAUDE_CLI_VERSION, QueuedRunNotSupportedError, insertAgentRun, writeRunStatus, type ExecutionRun, type ExecutionTarget, type ExecutionTargetRegistry, type SdkCreateParams, type SdkSandbox } from "@fx/runner";
import { createFakeModelConnectionPort } from "../../runner/test/helpers/sandboxTargetFakes.js";
import { sdkSessionStubs } from "../../runner/test/helpers/sdkSession.js";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { checkRetryAuthor, type IssueAuthorLookup } from "../../core/src/runActions/index.js";
import type { PerformResult } from "../src/runActions.js";
import { buildWorker } from "../src/compositionRoot.js";
import { createRunActionFacade } from "../src/runActions.js";
import { AuthorCheckUnavailableError, createRetryModule, type RetrySeatConfig, type RetrySeatSource } from "../src/retry.js";
import { retrySeatContract } from "./support/retrySeatContract.js";

/** D#31 API-6b-2 [pg]: the retry performer against the real definers, with a stub execution target and a stand-in seat. */
describe("retry_run performer [pg]", { timeout: 60_000 }, () => {
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

  // ---- stand-ins -------------------------------------------------------------------------------

  const seatFor = (repoId: string, model = "haiku-4.5"): RetrySeatConfig => ({
    repoId,
    product: "team",
    roleCard: "role card",
    model,
    capUsd: 5,
    spend: { plan: "starter", purpose: "run", trigger: "foreground", estimateModelUsd: 5, estimateComputeUsd: 0.5, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 5 },
    limits: { maxRunMs: 30 * 60_000, maxTurns: 100, maxModelCalls: 300, meteringSilenceMs: 15 * 60_000 },
    timeoutMs: 40 * 60_000,
    maxExtensions: 3,
  });
  /** The seat stand-in, as 3-2d-2's resolveRunSeat must answer: the account's work item must exist. */
  function fakeSeats(model = "haiku-4.5") {
    const calls: Array<{ accountId: string; role: string; workItemId: string }> = [];
    const seats: RetrySeatSource = {
      async retrySeat(input) {
        calls.push(input);
        const { rows } = await admin.query("SELECT repo_id FROM work_items WHERE id = $1 AND account_id = $2", [input.workItemId, input.accountId]);
        return rows[0] ? { ok: true, seat: seatFor(rows[0].repo_id, model) } : { ok: false, reason: "account_not_found" };
      },
    };
    return { seats, calls };
  }
  /** A stub sandbox target that records what it was handed. */
  function stubTarget(over: { admit?: ExecutionTarget["admit"]; dispatch?: ExecutionTarget["dispatch"] } = {}) {
    const admitted: ExecutionRun[] = [];
    const cancelled: string[] = [];
    const target = {
      runtime: "production",
      admit: over.admit ?? (async (run: ExecutionRun) => (admitted.push(run), { admitted: true })),
      cancel: async (run: ExecutionRun) => (cancelled.push(run.id), { settled_usd: 0, released_usd: 0 }),
      finalize: async () => {},
      dispatch: over.dispatch ?? (async () => ({ hookToken: "t" })),
      resume: async () => ({ hookToken: "t" }),
    } as unknown as ExecutionTarget;
    return { registry: { sandbox: target } as ExecutionTargetRegistry, admitted, cancelled };
  }
  const noCheck = () => null;
  const module = (target: ReturnType<typeof stubTarget>, seats: RetrySeatSource | null, authorCheck = noCheck) => createRetryModule(writerPool, target.registry, { seats, authorCheck });

  // ---- worlds ----------------------------------------------------------------------------------

  const PROMPT = "fix the flaky test in widgets";
  let nextNumber = 500;
  /** A work item; `external` ones have a GitHub issue coordinate in repo acme/widgets. */
  async function item(a: SeedRefs, o: { provenance?: "internal" | "external"; parent?: string } = {}): Promise<{ id: string; ghNumber: number }> {
    const id = randomUUID();
    const ghNumber = nextNumber++;
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, parent_id, gh_number) VALUES ($1, $2, $3, 'issue', $4, $5, $6)", [id, a.accountId, a.repoId, o.provenance ?? "internal", o.parent ?? null, ghNumber]);
    return { id, ghNumber };
  }
  /** A run that ended in `status`, started with a prompt (so its run.input row exists unless `prompt` is undefined). */
  async function run(a: SeedRefs, workItemId: string | null, status = "failed", prompt: string | null = PROMPT, role = "executor", pr?: number): Promise<string> {
    const { id } = await insertAgentRun(writerPool, { id: randomUUID(), accountId: a.accountId, workItemId, role, runtime: "production", executionMode: "sandbox", dispatchRepoId: a.repoId, dispatchPrNumber: pr, startPrompt: prompt ?? undefined });
    if (status === "pending") return id;
    await writeRunStatus(writerPool, { accountId: a.accountId, runId: id, from: "pending", to: "running" });
    if (status !== "running") await writeRunStatus(writerPool, { accountId: a.accountId, runId: id, from: "running", to: status as "failed" });
    return id;
  }
  /** A claimed retry_run action for a run, requested by the session member through the real definer. */
  async function action(a: SeedRefs, runId: string): Promise<string> {
    const row = await withTenant(appPool, a.accountId, a.userId, undefined, async (c) => (await c.query("SELECT * FROM run_action_request('retry_run', $1, NULL, $2)", [runId, "h".repeat(64)])).rows[0]);
    expect(await createRunActionFacade(writerPool, {} as ExecutionTargetRegistry).claimRunAction(row.action_id, 600)).not.toBeNull();
    return row.action_id;
  }
  const count = async (a: SeedRefs, sql: string) => Number((await admin.query(`SELECT count(*) AS n FROM ${sql}`, [a.accountId])).rows[0].n);
  const runsOf = (a: SeedRefs, itemId: string) => count(a, `agent_runs WHERE account_id = $1 AND work_item_id = '${itemId}'`);
  const openReservations = (a: SeedRefs) => count(a, "spend_reservations s WHERE s.account_id = $1 AND s.state = 'open' AND s.run_id IN (SELECT id FROM agent_runs WHERE parent_run_id IS NOT NULL)");
  const retried = (a: SeedRefs) => count(a, "agent_runs WHERE account_id = $1 AND parent_run_id IS NOT NULL");
  const keyRows = (a: SeedRefs, id: string) => count(a, `agent_run_idempotency_keys WHERE account_id = $1 AND idempotency_key = 'run-action:${id}'`);
  const external = (a: SeedRefs) => admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [a.repoId]);
  const runIdOf = (out: PerformResult): string => (out as unknown as { outcome: { run_id: string } }).outcome.run_id;
  const by = (login: string, permission: "write" | "read") => ({ status: "found" as const, login, permission });

  // ---- K3 / K5 / K8: the start -----------------------------------------------------------------

  it("starts one run: same role and work item, the failed run as parent, the retained prompt, keyed on the action; a failed run escalates one tier", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await item(a);
    const failed = await run(a, w.id, "failed");
    const id = await action(a, failed);
    const t = stubTarget();
    const out = await module(t, fakeSeats().seats).performRetryRun(id);
    expect(out).toMatchObject({ result: "done", outcome: { model: "sonnet-5", escalated_from_model: "haiku-4.5" } });
    const runId = runIdOf(out);
    expect(t.admitted).toHaveLength(1);
    expect(t.admitted[0]).toMatchObject({ id: runId, role: "executor", workItemId: w.id, parentRunId: failed, prompt: PROMPT, model: "sonnet-5" });
    expect((await admin.query("SELECT parent_run_id, status FROM agent_runs WHERE id = $1", [runId])).rows[0]).toEqual({ parent_run_id: failed, status: "running" });
    expect(await keyRows(a, id)).toBe(1);
  });

  it("D#6 R3a: a retry the target queues for a runner is cancelled, not reported as started; nothing is left to be claimed and the action's key is free again", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await item(a);
    const failed = await run(a, w.id, "failed");
    const id = await action(a, failed);
    const t = stubTarget({ dispatch: async () => ({ queued: true }) });
    await expect(module(t, fakeSeats().seats).performRetryRun(id)).rejects.toThrow(QueuedRunNotSupportedError);
    expect((await admin.query("SELECT status FROM agent_runs WHERE account_id = $1 AND parent_run_id = $2", [a.accountId, failed])).rows).toEqual([{ status: "cancelled" }]);
    expect(await keyRows(a, id)).toBe(0);
  });

  it.each(["killed_spend", "succeeded", "cancelled"])("a %s run is retried on the seat's own model: no escalation", async (status) => {
    const a = await seedAccount(admin, randomUUID());
    const w = await item(a);
    const t = stubTarget();
    const out = await module(t, fakeSeats("sonnet-5").seats).performRetryRun(await action(a, await run(a, w.id, status)));
    expect(out).toMatchObject({ result: "done", outcome: { model: "sonnet-5", escalated_from_model: null } });
    expect(t.admitted[0]!.model).toBe("sonnet-5");
  });

  describe("D#6 C12 A5: a run that expired in a runner's queue is retried on the same model", () => {
    /** A run that ended `timed_out`, with the reason its status change recorded. */
    async function timedOut(a: SeedRefs, workItemId: string, failureReason?: string): Promise<string> {
      const id = await run(a, workItemId, "running");
      await writeRunStatus(writerPool, { accountId: a.accountId, runId: id, from: "running", to: "timed_out", ...(failureReason ? { failureReason } : {}) });
      return id;
    }

    it("queue_ttl: no escalation, the seat's model is kept and the answer says nothing was escalated", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      const t = stubTarget();
      const out = await module(t, fakeSeats("haiku-4.5").seats).performRetryRun(await action(a, await timedOut(a, w.id, "queue_ttl")));
      expect(out).toMatchObject({ result: "done", outcome: { model: "haiku-4.5", escalated_from_model: null } });
      expect(t.admitted[0]!.model).toBe("haiku-4.5");
    });

    it.each([undefined, "agent_start_timeout", "internal_error"])("a timeout for another reason (%s) still escalates one tier", async (reason) => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      const t = stubTarget();
      const out = await module(t, fakeSeats("haiku-4.5").seats).performRetryRun(await action(a, await timedOut(a, w.id, reason)));
      expect(out).toMatchObject({ result: "done", outcome: { model: "sonnet-5", escalated_from_model: "haiku-4.5" } });
    });

    it("the reason is read from this run's own move to timed_out, not from another run's", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      await timedOut(a, w.id, "queue_ttl"); // an earlier run of the same item
      const t = stubTarget();
      const out = await module(t, fakeSeats("haiku-4.5").seats).performRetryRun(await action(a, await timedOut(a, w.id, "agent_start_timeout")));
      expect(out).toMatchObject({ result: "done", outcome: { model: "sonnet-5", escalated_from_model: "haiku-4.5" } });
    });
  });

  it("(a) two kicks of one action return the same run: one run row, one admit", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await item(a);
    const id = await action(a, await run(a, w.id));
    const t = stubTarget();
    const m = module(t, fakeSeats().seats);
    const first = await m.performRetryRun(id);
    // The replay answers with the original outcome, model facts included.
    expect(first).toMatchObject({ result: "done", outcome: { model: "sonnet-5", escalated_from_model: "haiku-4.5" } });
    expect(await m.performRetryRun(id)).toEqual(first);
    expect(await runsOf(a, w.id)).toBe(2);
    expect(t.admitted).toHaveLength(1);
  });

  it("(b) a kick and a sweep at the same moment start one run, one reservation attempt, one sandbox", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await item(a);
    const id = await action(a, await run(a, w.id));
    const t = stubTarget({ admit: async () => (await new Promise((r) => setTimeout(r, 100)), { admitted: true }) });
    const m = module(t, fakeSeats().seats);
    const [x, y] = await Promise.all([m.performRetryRun(id), m.performRetryRun(id)]);
    expect(x).toMatchObject({ result: "done" });
    expect(runIdOf(y!)).toBe(runIdOf(x!));
    expect(await runsOf(a, w.id)).toBe(2);
    expect(await openReservations(a)).toBe(0);
  });

  it("(c) a crash after the start (the answer lost, the new run already over) still answers with the same run and starts nothing", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await item(a);
    const id = await action(a, await run(a, w.id));
    const t = stubTarget();
    const firstOut = await module(t, fakeSeats().seats).performRetryRun(id);
    const first = runIdOf(firstOut);
    await writeRunStatus(writerPool, { accountId: a.accountId, runId: first, from: "running", to: "failed" });
    const again = createRetryModule(writerPool, stubTarget().registry, { seats: fakeSeats().seats, authorCheck: noCheck });
    expect(await again.performRetryRun(id)).toEqual(firstOut);
    expect(await runsOf(a, w.id)).toBe(2);
  });

  it("an H05 denial refuses with the DenyReason and the run ends refused_spend; a seat refusal refuses with the seat's enum (an unknown one as seat_refused); neither starts a sandbox", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await item(a);
    const denied = stubTarget({ admit: async () => ({ admitted: false, reason: "model_budget_exceeded" }) as never });
    const deniedAction = await action(a, await run(a, w.id));
    const denial = { result: "refused", errorCode: "model_budget_exceeded" };
    expect(await module(denied, fakeSeats().seats).performRetryRun(deniedAction)).toEqual(denial);
    // A replay answers with the ORIGINAL reason, not a generic refused_spend, and starts nothing.
    expect(await module(denied, fakeSeats().seats).performRetryRun(deniedAction)).toEqual(denial);
    expect((await admin.query("SELECT status FROM agent_runs WHERE work_item_id = $1 AND parent_run_id IS NOT NULL", [w.id])).rows).toEqual([{ status: "refused_spend" }]);
    expect(denied.admitted).toHaveLength(0);
    const before = await runsOf(a, w.id);
    const t = stubTarget();
    for (const [reason, code] of [["no_model", "no_model"], ["a secret reason", "seat_refused"]] as const) {
      const seats: RetrySeatSource = { retrySeat: async () => ({ ok: false, reason }) };
      expect(await module(t, seats).performRetryRun(await action(a, await run(a, w.id)))).toEqual({ result: "refused", errorCode: code });
    }
    expect(await runsOf(a, w.id)).toBe(before + 2);
    expect(t.admitted).toHaveLength(0);
  });

  it.each([
    ["admit throws", { admit: async () => { throw new Error("boom"); } }],
    ["dispatch throws", { dispatch: async () => { throw new Error("boom"); } }],
  ])("R-NO: %s leaves no open reservation, the new run terminal, its claim released, and the action to retry", async (_name, over) => {
    const a = await seedAccount(admin, randomUUID());
    const w = await item(a);
    const id = await action(a, await run(a, w.id));
    const t = stubTarget(over as never);
    await expect(module(t, fakeSeats().seats).performRetryRun(id)).rejects.toBeDefined();
    const started = (await admin.query("SELECT status FROM agent_runs WHERE work_item_id = $1 AND parent_run_id IS NOT NULL", [w.id])).rows;
    expect(started).toHaveLength(1);
    expect(["cancelled", "failed"]).toContain(started[0].status);
    expect(await openReservations(a)).toBe(0);
    expect(await keyRows(a, id)).toBe(0);
  });

  // ---- K6 / K7: who may be retried -------------------------------------------------------------

  /** A worker built the production way, with the check handed in as ports.authorCheck. With `withSeats` false it has NO retrySeats override, so its seat is the resolver's. */
  async function built(provider: () => { lookup: IssueAuthorLookup; allowlist: string[] } | null, withSeats = true) {
    const seats = fakeSeats();
    const created: SdkCreateParams[] = [];
    const sandbox = (name: string) =>
      ({
        name,
        runCommand: async (p: { args?: string[] }) => ({
          async *logs() {
            if (p.args?.[2] === "fx-pin") yield { stream: "stdout", data: `${CLAUDE_CLI_VERSION}\n` };
          },
          wait: async () => ({ exitCode: 0 }),
          kill: async () => undefined,
        }),
        writeFiles: async () => undefined,
        updateNetworkPolicy: async () => undefined,
        extendTimeout: async () => undefined,
        stop: async () => undefined,
        delete: async () => undefined,
        ...sdkSessionStubs(),
      }) as unknown as SdkSandbox;
    const worker = await buildWorker({
      env: { FX_GH_FORWARD_SUFFIX: "fixture.test", FX_GH_FORWARD_HOST: "gh-proxy.fixture.test" },
      vercel: { teamId: "t", projectId: "p", getToken: async () => "tok" },
      ports: { decryptTenantKey: async () => "k", modelConnection: createFakeModelConnectionPort(), connectionStatus: { markBroken: async () => {} }, hooks: { resume: async () => {} }, authorCheck: provider },
      lookup: async () => [{ address: "140.82.112.3", family: 4 }],
      sdk: { create: async (params) => (created.push(params), sandbox(params.name)), get: async (params) => sandbox(params.name) },
      createPools: async () => ({ runnerPool: writerPool, platformOpsPool: writerPool, close: async () => {} }),
      retrySeats: withSeats ? seats.seats : undefined,
    });
    return { worker, seats, created };
  }

  it("production default (12): a worker built with NO retrySeats takes its seat from resolveRunSeat, so its refusal is the resolver's own enum and nothing starts", async () => {
    const a = await seedAccount(admin, randomUUID()); // no model budget: the resolver refuses model_budget_unset
    const w = await item(a);
    const { worker, seats, created } = await built(() => null, false);
    expect(await worker.performRetryRun(await action(a, await run(a, w.id)))).toEqual({ result: "refused", errorCode: "model_budget_unset" });
    expect(await retried(a)).toBe(0);
    expect(seats.calls).toHaveLength(0);
    expect(created).toHaveLength(0);
  });

  it("production default (12): ... and with a budget the retry is seated by the resolver, reserves, and reaches the sandbox start", async () => {
    const a = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE accounts SET model_budget_usd_month = 500 WHERE id = $1", [a.accountId]);
    const w = await item(a);
    const { worker, seats, created } = await built(() => null, false);
    const failed = await run(a, w.id, "failed", PROMPT, "code-reviewer"); // an executor's sandbox is named for its PR; a reviewer's is not
    const out = await worker.performRetryRun(await action(a, failed));
    expect(out).toMatchObject({ result: "done" });
    expect(seats.calls).toHaveLength(0);
    expect(await retried(a)).toBe(1);
    expect(await openReservations(a)).toBe(2); // the model hold and the compute hold of the resolver's spend facts
    expect(created).toHaveLength(1);
  });

  it("a retried run carries the seat's own extension count (not a default, not reduced)", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await item(a);
    const t = stubTarget();
    expect(await module(t, fakeSeats().seats).performRetryRun(await action(a, await run(a, w.id)))).toMatchObject({ result: "done" });
    expect(t.admitted).toHaveLength(1);
    expect(t.admitted[0]!.maxExtensions).toBe(3);
  });

  it.each(["0", "-1", "abc", "1e3", " 7", "9007199254740993"])("a dispatch PR number of %s is refused run_not_retryable, before any seat or start, and no run is created", async (bad) => {
    const a = await seedAccount(admin, randomUUID());
    const w = await item(a);
    const failed = await run(a, w.id);
    const id = await action(a, failed);
    // The column is a bigint, so most of these cannot be stored; the reader's answer is what the module sees.
    const reading = {
      query: (...args: unknown[]) => (writerPool.query as (...a: unknown[]) => unknown)(...args),
      connect: async () => {
        const client = await writerPool.connect();
        const query = client.query.bind(client) as (...args: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
        const original = client.query;
        const release = client.release.bind(client);
        (client as { release: unknown }).release = (...r: unknown[]) => {
          (client as { query: unknown }).query = original; // the pooled client goes back as it was
          (client as { release: unknown }).release = release;
          return (release as (...a: unknown[]) => void)(...r);
        };
        (client as { query: unknown }).query = async (...args: unknown[]) => {
          const result = await query(...args);
          if (/dispatch_pr_number/.test(String((args[0] as { text?: string } | undefined)?.text ?? args[0])) && result.rows[0]) result.rows[0].dispatch_pr_number = bad;
          return result;
        };
        return client;
      },
    } as unknown as Pool;
    const t = stubTarget();
    const seats = fakeSeats();
    expect(await createRetryModule(reading, t.registry, { seats: seats.seats, authorCheck: noCheck }).performRetryRun(id)).toEqual({ result: "refused", errorCode: "run_not_retryable" });
    expect(seats.calls).toHaveLength(0);
    expect(t.admitted).toHaveLength(0);
    expect(await retried(a)).toBe(0);
  });

  it("production default: an EXECUTOR run with a dispatch PR number (a bigint, a string from the driver) retries through dispatch, in the PR's sandbox", async () => {
    const a = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE accounts SET model_budget_usd_month = 500 WHERE id = $1", [a.accountId]);
    const w = await item(a);
    const { worker, created } = await built(() => null, false);
    const failed = await run(a, w.id, "failed", PROMPT, "executor", 7);
    expect((await admin.query("SELECT dispatch_pr_number FROM agent_runs WHERE id = $1", [failed])).rows[0].dispatch_pr_number).toBe("7"); // the driver's shape
    expect(await worker.performRetryRun(await action(a, failed))).toMatchObject({ result: "done" });
    expect(created.map((c) => c.name)).toEqual([expect.stringMatching(/^ex-.*-7$/)]);
    expect(await retried(a)).toBe(1);
  });

  it("CWE-362: an attempt that fails before its own claim cancels nothing of a racing performer's live run", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await item(a);
    const id = await action(a, await run(a, w.id));
    const b = stubTarget();
    // A's seat call is the gap between its claim lookup and its start: B performs completely inside it.
    const racing: RetrySeatSource = {
      retrySeat: async (input) => {
        await module(b, fakeSeats().seats).performRetryRun(id);
        return fakeSeats().seats.retrySeat(input);
      },
    };
    // A's registry has no sandbox target, so its start fails before it creates or claims anything.
    const failing = createRetryModule(writerPool, {} as ExecutionTargetRegistry, { seats: racing, authorCheck: noCheck });
    await expect(failing.performRetryRun(id)).rejects.toBeDefined();
    expect((await admin.query("SELECT status FROM agent_runs WHERE work_item_id = $1 AND parent_run_id IS NOT NULL", [w.id])).rows).toEqual([{ status: "running" }]);
    expect(await keyRows(a, id)).toBe(1);
    expect(b.cancelled).toEqual([]);
  });

  it("the author loses write between the route and the perform: refused untrusted_author, no run, no reservation, no sandbox", async () => {
    const a = await seedAccount(admin, randomUUID());
    await external(a);
    const w = await item(a, { provenance: "external" });
    const failed = await run(a, w.id);
    let permission: "write" | "read" = "write";
    const lookup: IssueAuthorLookup = async () => by("octo", permission);
    const { worker, seats } = await built(() => ({ lookup, allowlist: [] }));
    expect(await checkRetryAuthor({ pool: appPool, accountId: a.accountId, userId: a.userId, workItemId: w.id, lookup: worker.authorCheck()!.lookup, allowlist: [] })).toBe("trusted");
    permission = "read";
    const id = await action(a, failed);
    expect(await worker.performRetryRun(id)).toEqual({ result: "refused", errorCode: "untrusted_author" });
    expect(await runsOf(a, w.id)).toBe(1);
    expect(await openReservations(a)).toBe(0);
    expect(await keyRows(a, id)).toBe(0);
    expect(seats.calls).toHaveLength(0);
  });

  it("an author check that cannot answer throws AuthorCheckUnavailableError (no provider, or a GitHub error): zero runs and no seat call", async () => {
    const a = await seedAccount(admin, randomUUID());
    await external(a);
    const w = await item(a, { provenance: "external" });
    const failed = await run(a, w.id);
    const none = await built(() => null);
    await expect(none.worker.performRetryRun(await action(a, await run(a, w.id)))).rejects.toBeInstanceOf(AuthorCheckUnavailableError);
    const broken = await built(() => ({ lookup: async () => { throw new Error("github 502"); }, allowlist: [] }));
    const id = await action(a, failed);
    await expect(broken.worker.performRetryRun(id)).rejects.toBeInstanceOf(AuthorCheckUnavailableError);
    expect(await retried(a)).toBe(0);
    expect(broken.seats.calls).toHaveLength(0);
  });

  it("the cap reaches the worker (4 external items: unavailable, ZERO lookup calls); an internal chain is trusted with ZERO lookup calls and starts the run", async () => {
    const a = await seedAccount(admin, randomUUID());
    await external(a);
    let leaf = await item(a, { provenance: "external" });
    for (let i = 0; i < 3; i++) leaf = await item(a, { provenance: "external", parent: leaf.id });
    const calls: unknown[] = [];
    const provider = () => ({ lookup: async (r: unknown) => (calls.push(r), by("octo", "write")), allowlist: [] });
    const capped = await built(provider);
    await expect(capped.worker.performRetryRun(await action(a, await run(a, leaf.id)))).rejects.toBeInstanceOf(AuthorCheckUnavailableError);
    const internal = await item(a);
    const t = stubTarget();
    const out = await createRetryModule(writerPool, t.registry, { seats: fakeSeats().seats, authorCheck: provider }).performRetryRun(await action(a, await run(a, internal.id)));
    expect(out).toMatchObject({ result: "done" });
    expect(calls).toEqual([]);
  });

  it("K7: a run whose work item was deleted after it ran (SET NULL), still holding its run.input, is refused with no author check, no seat call and no run", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await item(a, { provenance: "external" });
    const failed = await run(a, w.id);
    await admin.query("DELETE FROM work_items WHERE id = $1", [w.id]);
    expect((await admin.query("SELECT work_item_id FROM agent_runs WHERE id = $1", [failed])).rows[0].work_item_id).toBeNull();
    expect(Number((await admin.query("SELECT count(*) AS n FROM run_events WHERE run_id = $1 AND kind = 'run.input'", [failed])).rows[0].n)).toBe(1);
    let checked = 0;
    const seats = fakeSeats();
    const t = stubTarget();
    const out = await module(t, seats.seats, () => (checked++, null)).performRetryRun(await action(a, failed));
    expect(out).toEqual({ result: "refused", errorCode: "run_not_retryable" });
    expect([checked, seats.calls.length, t.admitted.length]).toEqual([0, 0, 0]);
    expect(await retried(a)).toBe(0);
  });

  // ---- K2 / K4: the cheap refusals -------------------------------------------------------------

  it("refuses a live run, a run with no retained prompt (none, or hash only), no seat source, and a token principal, each starting nothing", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await item(a);
    const t = stubTarget();
    const m = module(t, fakeSeats().seats);
    expect(await m.performRetryRun(await action(a, await run(a, w.id, "running")))).toEqual({ result: "refused", errorCode: "run_not_retryable" });
    expect(await m.performRetryRun(await action(a, await run(a, w.id, "failed", null)))).toEqual({ result: "refused", errorCode: "prompt_not_retained" });
    expect(await m.performRetryRun(await action(a, await run(a, w.id, "failed", "x".repeat(48 * 1024 + 1))))).toEqual({ result: "refused", errorCode: "prompt_not_retained" });
    expect(await module(t, null).performRetryRun(await action(a, await run(a, w.id)))).toEqual({ result: "refused", errorCode: "retry_unavailable" });
    const { rows } = await admin.query(
      `INSERT INTO run_action_requests (account_id, kind, target_id, requested_by, principal_kind, request_hash, state, attempts, claimed_until)
       VALUES ($1, 'retry_run', $2, 'token:x', 'token', $3, 'claimed', 1, now() + interval '1 minute') RETURNING id`,
      [a.accountId, await run(a, w.id), "h".repeat(64)],
    );
    expect(await m.performRetryRun(rows[0].id)).toEqual({ result: "refused", errorCode: "principal_not_authorised" });
    expect(t.admitted).toHaveLength(0);
  });

  // ---- RETRY-ONCE: a run is retried at most once ----------------------------------------------

  type ChildEnd = "pending" | "running" | "paused" | "started_failed" | "refused_spend" | "dispatch_failed" | "cancelled";
  /** A child of `parent` under `role`, ended the way `end` says. The three never-started ends go pending -> terminal. */
  async function child(a: SeedRefs, workItemId: string, parent: string, end: ChildEnd, role = "executor"): Promise<string> {
    const { id } = await insertAgentRun(writerPool, { id: randomUUID(), accountId: a.accountId, workItemId, parentRunId: parent, role, runtime: "production", executionMode: "sandbox", dispatchRepoId: a.repoId });
    const move = (from: string, to: string, failureReason?: string) => writeRunStatus(writerPool, { accountId: a.accountId, runId: id, from: from as "pending", to: to as "failed", failureReason });
    if (end === "running" || end === "started_failed") await move("pending", "running");
    if (end === "paused") await move("pending", "paused");
    if (end === "started_failed") await move("running", "failed");
    if (end === "refused_spend") await move("pending", "refused_spend", "model_budget_exceeded");
    if (end === "dispatch_failed") await move("pending", "failed", "internal_error");
    if (end === "cancelled") await move("pending", "cancelled");
    return id;
  }
  const refusedNotRetryable = { result: "refused", errorCode: "run_not_retryable" };

  it.each(["pending", "running", "paused", "started_failed"] as const)("C1/C4: a same-role child that is %s (live, or started) refuses run_not_retryable before the seat, with no second run", async (end) => {
    const a = await seedAccount(admin, randomUUID());
    const w = await item(a);
    const failed = await run(a, w.id);
    await child(a, w.id, failed, end);
    const seats = fakeSeats();
    const t = stubTarget();
    expect(await module(t, seats.seats).performRetryRun(await action(a, failed))).toEqual(refusedNotRetryable);
    expect([seats.calls.length, t.admitted.length, await retried(a)]).toEqual([0, 0, 1]);
  });

  it("C4: a started continuation of the target blocks the retry", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await item(a);
    const failed = await run(a, w.id, "succeeded");
    await child(a, w.id, failed, "started_failed");
    expect(await module(stubTarget(), fakeSeats().seats).performRetryRun(await action(a, failed))).toEqual(refusedNotRetryable);
  });

  it.each(["refused_spend", "dispatch_failed", "cancelled"] as const)("C2: a same-role child that was %s and never started does not block the retry", async (end) => {
    const a = await seedAccount(admin, randomUUID());
    const w = await item(a);
    const failed = await run(a, w.id);
    await child(a, w.id, failed, end);
    const out = await module(stubTarget(), fakeSeats().seats).performRetryRun(await action(a, failed));
    expect(out).toMatchObject({ result: "done" });
    expect(await retried(a)).toBe(2);
  });

  it("C3: children of other roles (planning-panel seats), live or started, do not block the retry", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await item(a);
    const failed = await run(a, w.id);
    await child(a, w.id, failed, "running", "reviewer");
    await child(a, w.id, failed, "started_failed", "architect");
    expect(await module(stubTarget(), fakeSeats().seats).performRetryRun(await action(a, failed))).toMatchObject({ result: "done" });
  });

  /** Two actions on one run, both past the pre-check: B waits at its seat call until A has run to the end of its start (and, for "failed", its run is over). */
  async function raced(winnerEnds: "failed" | "live") {
    const a = await seedAccount(admin, randomUUID());
    const w = await item(a);
    const failed = await run(a, w.id);
    const second = await action(a, failed);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let atBarrier!: () => void;
    const arrived = new Promise<void>((r) => (atBarrier = r));
    // B passes its pre-check, then waits at its seat call until A has started AND finished its run.
    const held: RetrySeatSource = { retrySeat: async (input) => (atBarrier(), await gate, fakeSeats().seats.retrySeat(input)) };
    const b = module(stubTarget(), held).performRetryRun(second);
    await arrived;
    // B is past its pre-check and its lease read. Its row is finished so a second action can be requested (one live action per run).
    await admin.query("UPDATE run_action_requests SET state = 'done', claimed_until = NULL, finished_at = now() WHERE id = $1", [second]);
    const first = await action(a, failed);
    const aOut =await module(stubTarget(), fakeSeats().seats).performRetryRun(first);
    expect(aOut).toMatchObject({ result: "done" });
    if (winnerEnds === "failed") await writeRunStatus(writerPool, { accountId: a.accountId, runId: runIdOf(aOut), from: "running", to: "failed" });
    release();
    expect(await b).toEqual(refusedNotRetryable);
    expect(await retried(a)).toBe(1);
    expect(await keyRows(a, second)).toBe(0);
  }

  it("C5: two actions on one run that both pass the pre-check start exactly one child (the first one's already over); the other ends run_not_retryable", () => raced("failed"));

  it("C5: the same race while the first child is still live: the insert hits the one-live-child index and the loser ends run_not_retryable, not 'database unavailable'", () => raced("live"));

  retrySeatContract("the test fake", fakeSeats().seats, () => admin);
});

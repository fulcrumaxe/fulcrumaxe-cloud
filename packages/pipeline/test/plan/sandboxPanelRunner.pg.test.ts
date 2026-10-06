import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SandboxTarget,
  createFakeSandbox,
  createInMemoryHookChannel,
  createTestConnectionStatusPort,
  loadGithubForwardConfig,
  type AgentRuntime,
  type ExecutionTargetRegistry,
  type NormalizedEvent,
  type SandboxPort,
} from "@fx/runner";
import { pgHarness } from "../helpers/pgHarness.js";
import { seedAccount, seedRepo, seedWorkItem } from "../build/helpers/seed.js";
import { runPanel, type PanelSeatRequest } from "../../src/plan/panel.js";
import { checkPanelRunnerContract } from "../../src/plan/runnerContract.js";
import {
  createSandboxPanelRunner,
  IdempotencyKeyMismatchError,
  PanelSeatAbortedError,
  PanelSeatFailedError,
} from "../../src/plan/sandboxPanelRunner.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { discussingItem } from "./helpers/panelFixtures.js";

/**
 * D#2 H14c-4 (C41 section 4, H14c-PANEL-1/2) against real Postgres and
 * H09's real `SandboxTarget` over the fake sandbox port. Zero model tokens.
 */
const h = pgHarness();

interface World {
  registry: ExecutionTargetRegistry;
  hookWait: ReturnType<typeof createInMemoryHookChannel>["waitPort"];
  starts: string[];
  stops: string[];
  /** Roles whose sandbox never finishes. */
  hangRoles: Set<string>;
  /** When set, `createSandbox` waits for this promise (an abort "during start"). */
  gate: { wait: Promise<void> | null; entered: () => void };
}

function world(): World {
  const starts: string[] = [];
  const stops: string[] = [];
  const hangRoles = new Set<string>();
  const gate: World["gate"] = { wait: null, entered: () => {} };
  const runtime: AgentRuntime = {
    async start(opts) {
      const event: NormalizedEvent = {
        runId: opts.runId,
        role: opts.role,
        seq: 1,
        type: "result",
        ts: new Date().toISOString(),
        agentOutput: { comment: `${opts.role} agrees` },
      };
      await opts.onEvent(event);
      return { handle: { runId: opts.runId } };
    },
    async stop() {},
    async resume(handle) {
      return { handle };
    },
  };
  const fake = createFakeSandbox(runtime);
  const port: SandboxPort = {
    ...fake.port,
    async createSandbox(opts) {
      gate.entered();
      if (gate.wait) await gate.wait;
      return fake.port.createSandbox(opts);
    },
    startDetached(handle, opts) {
      starts.push(opts.runId);
      if (hangRoles.has(opts.role)) return { handle, hookFired: new Promise(() => {}) };
      return fake.port.startDetached(handle, opts);
    },
    async stop(handle) {
      stops.push(handle.sandboxName);
      return fake.port.stop(handle);
    },
  };
  const channel = createInMemoryHookChannel();
  const target = new SandboxTarget({
    pool: h.runWriterPool,
    sandboxPort: port,
    decryptTenantKey: async () => "fake-plaintext-key-never-real",
    githubForward: loadGithubForwardConfig({ FX_GH_FORWARD_SUFFIX: "fixture.test", FX_GH_FORWARD_HOST: "gh-proxy.fixture.test" }),
    lookup: async () => [{ address: "140.82.112.3", family: 4 }],
    hooks: channel.resumeSink,
    // These tests script the old order by hand (the runner waits for the hook, then finalizes); HARNESS-FINALIZE-TRUE moves them to the production order.
    finalizeBeforeResume: false,
    modelConnection: {
      async get() {
        return {
          provider: "ai_gateway",
          encryptedKey: { ciphertext: new Uint8Array([1]), nonce: new Uint8Array([2]), wrappedDek: new Uint8Array([3]), kekVersion: 1 },
          connectionId: "00000000-0000-4000-8000-0000000000c1",
        };
      },
    },
    connectionStatus: createTestConnectionStatusPort(),
  });
  return { registry: { sandbox: target }, hookWait: channel.waitPort, starts, stops, hangRoles, gate };
}

async function tenant(): Promise<{ accountId: string; repoId: string }> {
  const accountId = randomUUID();
  const repoId = randomUUID();
  await seedAccount(h.admin, accountId);
  await seedRepo(h.admin, accountId, repoId);
  return { accountId, repoId };
}

function runnerFor(
  w: World,
  accountId: string,
  repoId: string,
  over: { hookWait?: World["hookWait"]; refuseSpend?: boolean } = {},
) {
  return createSandboxPanelRunner({
    pool: h.runWriterPool,
    accountId,
    registry: w.registry,
    hookWait: over.hookWait ?? w.hookWait,
    pollMs: 10,
    resolveSeat: () => ({
      repoId,
      product: "team",
      roleCard: "fixture role card",
      model: "haiku-4.5",
      capUsd: 5,
      // A monthly model budget below the estimate makes admit refuse the spend: no sandbox is ever started.
      spend: over.refuseSpend
        ? { plan: "starter", estimateComputeUsd: 1, trigger: "foreground", estimateModelUsd: 5, monthlyModelBudgetUsd: 1 }
        : { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" },
    }),
  });
}

/** Calls the release definer as `pool`'s login inside `accountId`'s tenant. */
const release = (accountId: string, key: string, pool = h.runWriterPool): Promise<boolean> =>
  withTenant(pool, accountId, async (client) => {
    const { rows } = await client.query<{ released: boolean }>(
      `SELECT agent_run_release_idempotency_key($1::uuid, $2::text) AS released`,
      [accountId, key],
    );
    return rows[0]!.released;
  });

const request = (workItemId: string, key: string, role = "security-expert"): PanelSeatRequest =>
  ({ workItemId, discussionId: "d-1", role, round: 1, prompt: "say something", idempotencyKey: key }) as PanelSeatRequest;

const rows = async (accountId: string, workItemId?: string): Promise<number> =>
  (await h.admin.query(`SELECT 1 FROM agent_runs WHERE account_id = $1 AND ($2::uuid IS NULL OR work_item_id = $2)`, [accountId, workItemId ?? null])).rowCount ?? 0;
const openReservations = async (accountId: string): Promise<number> =>
  (await h.admin.query(`SELECT 1 FROM spend_reservations WHERE account_id = $1 AND state = 'open'`, [accountId])).rowCount ?? 0;
const statusOf = async (accountId: string): Promise<string[]> =>
  (await h.admin.query<{ status: string }>(`SELECT status FROM agent_runs WHERE account_id = $1 ORDER BY created_at`, [accountId])).rows.map((r) => r.status);
const keyRows = async (accountId: string): Promise<number> =>
  (await h.admin.query(`SELECT 1 FROM agent_run_idempotency_keys WHERE account_id = $1`, [accountId])).rowCount ?? 0;

describe("H14c-PANEL-1: one key, one run, one sandbox start", () => {
  it("passes the shared contract helper: sequential and five concurrent calls, and a different key", async () => {
    const { accountId, repoId } = await tenant();
    const w = world();
    const items = new Map<string, string>();
    const wiFor = async (key: string): Promise<string> => {
      if (!items.has(key)) {
        const id = randomUUID();
        await seedWorkItem(h.admin, accountId, id, repoId);
        items.set(key, id);
      }
      return items.get(key)!;
    };
    // Every key gets its own work item so its rows can be counted; a request is built synchronously,
    // so the work items are created up front for the keys the helper will use.
    const prefix = `contract:${randomUUID()}`;
    for (const k of ["sequential", "concurrent", "other", "aborted"]) await wiFor(`${prefix}:${k}`);
    const violations = await checkPanelRunnerContract(runnerFor(w, accountId, repoId), {
      keyPrefix: prefix,
      request: (key) => request(items.get(key)!, key),
      startedRuns: async (key) => rows(accountId, items.get(key)),
    });
    expect(violations).toEqual([]);
    // Every sandbox start belongs to a row that exists: no start without a row, no row without a start.
    expect(w.starts.length).toBe(await rows(accountId));
    expect(new Set(w.starts).size).toBe(w.starts.length);
    expect(await openReservations(accountId)).toBe(0);
  });

  it("returns the finished run's envelope on replay and does not start anything", async () => {
    const { accountId, repoId } = await tenant();
    const w = world();
    const wi = randomUUID();
    await seedWorkItem(h.admin, accountId, wi, repoId);
    const runner = runnerFor(w, accountId, repoId);
    const live = new AbortController().signal;
    const first = await runner.runSeat(request(wi, "k"), live);
    const again = await runner.runSeat(request(wi, "k"), live);
    expect(again).toEqual(first);
    expect(first.agentOutput).toEqual({ comment: "security-expert agrees" });
    expect(w.starts).toHaveLength(1);
  });

  it("the database refuses a second claim on one key, whatever the caller does", async () => {
    const { accountId, repoId } = await tenant();
    const w = world();
    const wi = randomUUID();
    await seedWorkItem(h.admin, accountId, wi, repoId);
    await runnerFor(w, accountId, repoId).runSeat(request(wi, "k"), new AbortController().signal);
    const run = (await h.admin.query<{ id: string }>(`SELECT id FROM agent_runs WHERE account_id = $1`, [accountId])).rows[0]!.id;
    await expect(
      h.admin.query(
        `INSERT INTO agent_run_idempotency_keys (account_id, idempotency_key, run_id, request_hash) VALUES ($1, 'k', $2, $3)`,
        [accountId, run, "0".repeat(64)],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("a key from account A never returns account B's run, and B may use the same key text", async () => {
    const a = await tenant();
    const b = await tenant();
    const w = world();
    const wiA = randomUUID();
    const wiB = randomUUID();
    await seedWorkItem(h.admin, a.accountId, wiA, a.repoId);
    await seedWorkItem(h.admin, b.accountId, wiB, b.repoId);
    const live = new AbortController().signal;
    const runA = await runnerFor(w, a.accountId, a.repoId).runSeat(request(wiA, "shared-key"), live);
    const runB = await runnerFor(w, b.accountId, b.repoId).runSeat(request(wiB, "shared-key"), live);
    expect(runB.agentRunId).not.toBe(runA.agentRunId);
    const owner = await h.admin.query<{ account_id: string }>(`SELECT account_id FROM agent_runs WHERE id = $1`, [runB.agentRunId]);
    expect(owner.rows[0]!.account_id).toBe(b.accountId);
    expect(w.starts).toHaveLength(2);
  });

  it("refuses a key reused for a different seat instead of handing back that seat's run", async () => {
    const { accountId, repoId } = await tenant();
    const w = world();
    const wi = randomUUID();
    await seedWorkItem(h.admin, accountId, wi, repoId);
    const runner = runnerFor(w, accountId, repoId);
    const live = new AbortController().signal;
    await runner.runSeat(request(wi, "k", "security-expert"), live);
    await expect(runner.runSeat(request(wi, "k", "cost-analyst"), live)).rejects.toBeInstanceOf(IdempotencyKeyMismatchError);
    expect(w.starts).toHaveLength(1);
  });

  it("a run that started and then failed keeps its key: a replay follows it and never starts a second sandbox", async () => {
    const { accountId, repoId } = await tenant();
    const w = world();
    const wi = randomUUID();
    await seedWorkItem(h.admin, accountId, wi, repoId);
    const broken = runnerFor(w, accountId, repoId, {
      hookWait: {
        wait: async () => {
          throw new Error("hook channel down");
        },
      },
    });
    await expect(broken.runSeat(request(wi, "k"), new AbortController().signal)).rejects.toThrow("hook channel down");
    expect(await keyRows(accountId)).toBe(1);
    expect(await openReservations(accountId)).toBe(0);
    const replay = runnerFor(w, accountId, repoId).runSeat(request(wi, "k"), new AbortController().signal);
    await expect(replay).rejects.toBeInstanceOf(PanelSeatFailedError);
    await expect(replay).rejects.toMatchObject({ runStatus: "cancelled" });
    expect(w.starts).toHaveLength(1);
    expect(await statusOf(accountId)).toEqual(["cancelled"]);
  });

  it("a start that never reached a sandbox releases its key: the seat can be retried", async () => {
    const { accountId, repoId } = await tenant();
    const w = world();
    const wi = randomUUID();
    await seedWorkItem(h.admin, accountId, wi, repoId);
    const refused = runnerFor(w, accountId, repoId, { refuseSpend: true }).runSeat(request(wi, "k"), new AbortController().signal);
    await expect(refused).rejects.toMatchObject({ runStatus: "refused_spend" });
    expect(w.starts).toHaveLength(0);
    expect(await keyRows(accountId)).toBe(0);
    const retry = await runnerFor(w, accountId, repoId).runSeat(request(wi, "k"), new AbortController().signal);
    expect(retry.agentOutput).toEqual({ comment: "security-expert agrees" });
    expect(w.starts).toHaveLength(1);
    expect(await statusOf(accountId)).toEqual(["refused_spend", "succeeded"]);
  });

  it("a seat cancelled at its deadline, then the step replayed, starts exactly one sandbox", async () => {
    const { accountId, repoId } = await tenant();
    const w = world();
    w.hangRoles.add("security-expert");
    const wi = randomUUID();
    await seedWorkItem(h.admin, accountId, wi, repoId);
    const deadline = new AbortController();
    const first = runnerFor(w, accountId, repoId).runSeat(request(wi, "k"), deadline.signal).catch((e: unknown) => e);
    while (w.starts.length === 0) await new Promise((r) => setTimeout(r, 5));
    deadline.abort();
    expect(await first).toBeInstanceOf(PanelSeatAbortedError);
    // The replay gets its own short leash so a second (hanging) sandbox cannot wedge the test.
    const leash = new AbortController();
    const timer = setTimeout(() => leash.abort(), 400);
    const replay = await runnerFor(w, accountId, repoId).runSeat(request(wi, "k"), leash.signal).catch((e: unknown) => e);
    clearTimeout(timer);
    expect(replay).toBeInstanceOf(PanelSeatFailedError);
    expect(replay).toMatchObject({ runStatus: "cancelled" });
    expect(w.starts).toHaveLength(1);
    expect(await statusOf(accountId)).toEqual(["cancelled"]);
    expect(await keyRows(accountId)).toBe(1);
    expect(await openReservations(accountId)).toBe(0);
  });
});

describe("H14c-PANEL-3: the claim table is not writable by app_user, and is tenant-bound", () => {
  it("a pure app_user login cannot delete or update a claim, even one in its own tenant", async () => {
    const { accountId, repoId } = await tenant();
    const w = world();
    w.hangRoles.add("security-expert");
    const wi = randomUUID();
    await seedWorkItem(h.admin, accountId, wi, repoId);
    const c = new AbortController();
    const seat = runnerFor(w, accountId, repoId).runSeat(request(wi, "k"), c.signal).catch((e: unknown) => e);
    while (w.starts.length === 0) await new Promise((r) => setTimeout(r, 5));
    for (const pool of [h.pureAppUserPool, h.runWriterPool]) {
      await expect(
        withTenant(pool, accountId, (client) => client.query(`DELETE FROM agent_run_idempotency_keys WHERE account_id = $1`, [accountId])),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        withTenant(pool, accountId, (client) =>
          client.query(`UPDATE agent_run_idempotency_keys SET request_hash = $2 WHERE account_id = $1`, [accountId, "1".repeat(64)]),
        ),
      ).rejects.toMatchObject({ code: "42501" });
    }
    expect(await keyRows(accountId)).toBe(1);
    c.abort();
    await seat;
  });

  it("the release function refuses a claim whose run started and releases one whose run never did", async () => {
    const { accountId, repoId } = await tenant();
    const w = world();
    w.hangRoles.add("security-expert");
    const wi = randomUUID();
    await seedWorkItem(h.admin, accountId, wi, repoId);
    const c = new AbortController();
    const seat = runnerFor(w, accountId, repoId).runSeat(request(wi, "started"), c.signal).catch((e: unknown) => e);
    while (w.starts.length === 0) await new Promise((r) => setTimeout(r, 5));
    expect(await release(accountId, "started")).toBe(false); // running
    c.abort();
    await seat;
    expect(await release(accountId, "started")).toBe(false); // cancelled, but it ran
    expect(await keyRows(accountId)).toBe(1);
    expect(await release(accountId, "no-such-key")).toBe(false);

    // A claim on a run that only ever reached a terminal status without running is released.
    const wi2 = randomUUID();
    await seedWorkItem(h.admin, accountId, wi2, repoId);
    const never = randomUUID();
    await h.admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'security-expert', 'production', 'pending')`,
      [never, accountId, wi2],
    );
    await h.admin.query(`UPDATE agent_runs SET status = 'refused_spend' WHERE id = $1`, [never]);
    await h.admin.query(
      `INSERT INTO agent_run_idempotency_keys (account_id, idempotency_key, run_id, request_hash) VALUES ($1, 'never', $2, $3)`,
      [accountId, never, "0".repeat(64)],
    );
    expect(await release(accountId, "never")).toBe(true);
    expect(await keyRows(accountId)).toBe(1);
  });

  it("the release function is executable only through the writer login and only in the caller's tenant", async () => {
    const a = await tenant();
    const b = await tenant();
    await expect(release(a.accountId, "k", h.pureAppUserPool)).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenant(h.runWriterPool, a.accountId, (client) =>
        client.query(`SELECT agent_run_release_idempotency_key($1::uuid, 'k')`, [b.accountId]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("account A cannot claim account B's run, and the error does not say whether that run exists", async () => {
    const a = await tenant();
    const b = await tenant();
    const w = world();
    const wiB = randomUUID();
    await seedWorkItem(h.admin, b.accountId, wiB, b.repoId);
    await runnerFor(w, b.accountId, b.repoId).runSeat(request(wiB, "b-key"), new AbortController().signal);
    const runB = (await h.admin.query<{ id: string }>(`SELECT id FROM agent_runs WHERE account_id = $1`, [b.accountId])).rows[0]!.id;
    const claim = (accountId: string, key: string, runId: string) =>
      h.admin
        .query(
          `INSERT INTO agent_run_idempotency_keys (account_id, idempotency_key, run_id, request_hash) VALUES ($1, $2, $3, $4)`,
          [accountId, key, runId, "0".repeat(64)],
        )
        .then(() => "inserted")
        .catch((e: { code: string }) => e.code);
    // B's run already holds a claim in B; A names it anyway. Same code as a run that exists nowhere.
    expect(await claim(a.accountId, "steal", runB)).toBe("23503");
    expect(await claim(a.accountId, "ghost", randomUUID())).toBe("23503");
    // A run in B with no claim of its own is refused the same way.
    const wiB2 = randomUUID();
    await seedWorkItem(h.admin, b.accountId, wiB2, b.repoId);
    const unclaimed = randomUUID();
    await h.admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'security-expert', 'production', 'pending')`,
      [unclaimed, b.accountId, wiB2],
    );
    expect(await claim(a.accountId, "steal2", unclaimed)).toBe("23503");
    expect(await keyRows(a.accountId)).toBe(0);
  });
});

describe("H14c-PANEL-2: abort stops the sandbox and closes the reservation", () => {
  it("abort while the seat runs: sandbox stopped, run cancelled, reservation closed, the run keeps its key", async () => {
    const { accountId, repoId } = await tenant();
    const w = world();
    w.hangRoles.add("security-expert");
    const wi = randomUUID();
    await seedWorkItem(h.admin, accountId, wi, repoId);
    const c = new AbortController();
    const seat = runnerFor(w, accountId, repoId).runSeat(request(wi, "k"), c.signal);
    const settled = seat.catch((e: unknown) => e);
    while (w.starts.length === 0) await new Promise((r) => setTimeout(r, 5));
    c.abort();
    expect(await settled).toBeInstanceOf(PanelSeatAbortedError);
    expect(w.stops.length).toBeGreaterThanOrEqual(1);
    expect(await statusOf(accountId)).toEqual(["cancelled"]);
    expect(await openReservations(accountId)).toBe(0);
    expect(await keyRows(accountId)).toBe(1);
  });

  it("abort before start: nothing claimed, nothing reserved, no sandbox", async () => {
    const { accountId, repoId } = await tenant();
    const w = world();
    const c = new AbortController();
    c.abort();
    await expect(runnerFor(w, accountId, repoId).runSeat(request(randomUUID(), "k"), c.signal)).rejects.toBeInstanceOf(PanelSeatAbortedError);
    expect(await rows(accountId)).toBe(0);
    expect(await keyRows(accountId)).toBe(0);
    expect(await openReservations(accountId)).toBe(0);
    expect(w.starts).toHaveLength(0);
  });

  it("abort during start: the run that start produced is cancelled and its reservation closed", async () => {
    const { accountId, repoId } = await tenant();
    const w = world();
    const wi = randomUUID();
    await seedWorkItem(h.admin, accountId, wi, repoId);
    let open!: () => void;
    w.gate.wait = new Promise<void>((r) => (open = r));
    const entered = new Promise<void>((r) => (w.gate.entered = r));
    const c = new AbortController();
    const settled = runnerFor(w, accountId, repoId).runSeat(request(wi, "k"), c.signal).catch((e: unknown) => e);
    await entered;
    c.abort();
    open();
    expect(await settled).toBeInstanceOf(PanelSeatAbortedError);
    expect(await statusOf(accountId)).toEqual(["cancelled"]);
    expect(await openReservations(accountId)).toBe(0);
    expect(await keyRows(accountId)).toBe(1);
  });

  it("abort after finish: nothing left to stop, spend already settled, the finished run keeps its key", async () => {
    const { accountId, repoId } = await tenant();
    const w = world();
    const wi = randomUUID();
    await seedWorkItem(h.admin, accountId, wi, repoId);
    const runner = runnerFor(w, accountId, repoId);
    const finished = await runner.runSeat(request(wi, "k"), new AbortController().signal);
    const late = new AbortController();
    late.abort();
    // The run is done; a replay under an aborted signal rejects before touching it.
    await expect(runner.runSeat(request(wi, "k"), late.signal)).rejects.toBeInstanceOf(PanelSeatAbortedError);
    expect(await statusOf(accountId)).toEqual(["succeeded"]);
    expect(await openReservations(accountId)).toBe(0);
    const replay = await runner.runSeat(request(wi, "k"), new AbortController().signal);
    expect(replay.agentRunId).toBe(finished.agentRunId);
  });

  it("a seat that outlives the round deadline is stopped, and no signed comment is written for it", async () => {
    const { accountId, repoId } = await tenant();
    const w = world();
    w.hangRoles.add("security-expert");
    const { workItemId, discussionId } = await discussingItem(h.runWriterPool, accountId, {
      title: "Rotate the credentials store",
      body: "the secret token",
      category: "critical",
    });
    const out = await runPanel(
      { pool: h.runWriterPool, accountId, runner: runnerFor(w, accountId, repoId), timeoutMs: 400 },
      { workItemId },
    );
    if (out.status !== "completed") throw new Error("panel did not complete");
    expect(out.missingRoles).toEqual(["security-expert"]);
    expect(out.round1.find((s) => s.role === "security-expert")).toEqual({ role: "security-expert", status: "missing", reason: "timed_out" });
    const signed = await h.admin.query<{ role: string }>(
      `SELECT role FROM discussion_comments WHERE discussion_id = $1 AND system_signed = true ORDER BY role`,
      [discussionId],
    );
    expect(signed.rows.map((r) => r.role)).toEqual(["cost-analyst", "technical-architect"]);
    // Cleanup runs after the seat's rejection; give it a moment to land.
    for (let i = 0; i < 100 && (await openReservations(accountId)) > 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(await openReservations(accountId)).toBe(0);
    expect(w.stops.length).toBeGreaterThanOrEqual(1);
    const hung = await h.admin.query<{ status: string }>(`SELECT status FROM agent_runs WHERE account_id = $1 AND role = 'security-expert'`, [accountId]);
    expect(hung.rows.map((r) => r.status)).toEqual(["cancelled"]);
  });
});

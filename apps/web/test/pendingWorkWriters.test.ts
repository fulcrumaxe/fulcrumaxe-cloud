import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { emitDomainEvent } from "@fx/core/src/domain-events/emit";
import { requestRunAction } from "@fx/core/src/runActions/request";
import { createRecordingRunActionSignal } from "@fx/core/src/runActions/signal";
import { setPendingHooks, type SweepName } from "@fx/core/src/pendingWork";
import { CLAIM_LEASE_SECONDS, claimBody, settleBody, type RunActionsWorker } from "@fx/pipeline";

/**
 * D#454 H3c: every writer that enqueues work for a sweep leaves its marker (and only the writers do). The sweeps
 * skip a tick that has no marker, so a writer that forgot would add up to the 30-minute backstop of latency. The
 * runner's compute-settle writer is covered next to its Postgres test (packages/runner/test/computeSettle.pg.test.ts).
 */
const NOW = 1_800_000_000_000;
const entries = new Map<string, number>();
const kicks: SweepName[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  setPendingHooks({
    store: {
      get: async (key) => entries.get(key) ?? null,
      set: async (key, value) => void entries.set(key, value),
      delete: async (key) => void entries.delete(key),
    },
    kick: (name) => void kicks.push(name),
  });
});
afterEach(() => {
  setPendingHooks(null);
  entries.clear();
  kicks.length = 0;
  vi.useRealTimers();
});

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("api-sweep writer: emitDomainEvent", () => {
  it("marks api-sweep and asks for an early sweep", async () => {
    const client = { query: vi.fn(async () => ({ rows: [{ id: "evt_1" }] })) } as unknown as PoolClient;
    await emitDomainEvent(client, { type: "pr.opened", accountId: "a", payload: {} });
    await flush();
    expect(entries.get("pending:api-sweep")).toBe(NOW);
    expect(kicks).toEqual(["api-sweep"]);
  });

  it("the event is still returned when the marker store is down", async () => {
    setPendingHooks({ store: { get: async () => { throw new Error("down"); }, set: async () => { throw new Error("down"); }, delete: async () => {} }, kick: () => { throw new Error("down"); } });
    const client = { query: vi.fn(async () => ({ rows: [{ id: "evt_2" }] })) } as unknown as PoolClient;
    await expect(emitDomainEvent(client, { type: "pr.opened", accountId: "a", payload: {} })).resolves.toEqual({ id: "evt_2" });
  });
});

describe("run-action-sweep writers", () => {
  const ACCOUNT = "11111111-1111-4111-8111-111111111111";
  const USER = "22222222-2222-4222-8222-222222222222";
  const pool = (replayed: boolean): Pool =>
    ({
      connect: async () => ({
        query: async (sql: string) => (sql.includes("run_action_request(") ? { rows: [{ action_id: "act-1", state: "accepted", replayed }] } : { rows: [] }),
        release: () => {},
      }),
    }) as unknown as Pool;

  it("a new request marks the sweep after its commit, and a replayed one does not", async () => {
    const signal = createRecordingRunActionSignal();
    await requestRunAction({ pool: pool(false), principal: { accountId: ACCOUNT, userId: USER } }, { kind: "cancel_run", targetId: "t", requestHash: "h" }, { signal });
    await flush();
    expect(entries.get("pending:run-action-sweep")).toBe(NOW);
    expect(signal.sent).toHaveLength(1); // the immediate kick is unchanged

    entries.clear();
    await requestRunAction({ pool: pool(true), principal: { accountId: ACCOUNT, userId: USER } }, { kind: "cancel_run", targetId: "t", requestHash: "h" }, { signal });
    await flush();
    expect(entries.size).toBe(0);
  });

  const worker = (over: Partial<RunActionsWorker> = {}): RunActionsWorker => ({ claimRunAction: vi.fn(async () => ({ id: "act-1", kind: "cancel_run", attempts: 1 })), settleRunAction: vi.fn(async () => {}), ...over }) as unknown as RunActionsWorker;

  it("a claim marks the moment its lease runs out, so a worker that dies holding it is not forgotten", async () => {
    await claimBody(worker(), "act-1");
    await flush();
    expect(entries.get("pending:run-action-sweep")).toBe(NOW + (CLAIM_LEASE_SECONDS + 5) * 1000);
  });

  it("a lost claim (a duplicate kick) marks nothing", async () => {
    await claimBody(worker({ claimRunAction: vi.fn(async () => null) }), "act-1");
    await flush();
    expect(entries.size).toBe(0);
  });

  it("a retry marks the time it becomes due; a finished action marks nothing", async () => {
    await settleBody(worker(), { id: "act-1", kind: "cancel_run", attempts: 2 }, { result: "error", errorCode: "perform_failed" });
    await flush();
    expect(entries.get("pending:run-action-sweep")).toBe(NOW + 2 ** 2 * 5 * 1000);

    entries.clear();
    await settleBody(worker(), { id: "act-1", kind: "cancel_run", attempts: 2 }, { result: "done", outcome: {} } as never);
    await flush();
    expect(entries.size).toBe(0);
  });

  it("a page of progress marks the sweep for now", async () => {
    await settleBody(worker(), { id: "act-1", kind: "cancel_work_item", attempts: 1 }, { result: "done", outcome: { remaining: true } } as never);
    await flush();
    expect(entries.get("pending:run-action-sweep")).toBe(NOW);
  });
});

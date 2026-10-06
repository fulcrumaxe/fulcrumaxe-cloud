import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateWorkerOptions, Worker } from "@fx/worker";
import type { PerformResult, RunActionsWorker, SettleInput } from "@fx/pipeline";
import { getWorker, setWorkerWiringForTests, workerConfigured } from "../lib/worker";
import { claimStep, performStep, runActionWorkflow, settleStep } from "./runAction";

/**
 * D#2 H14c-3b go-live tests (both provider states). The directives are plain strings outside
 * the Workflow builder, so the wrapper runs here as ordinary async functions over the real
 * lib/worker.ts wiring with a FAKE createWorker injected.
 */
const ID = "11111111-1111-4111-8111-111111111111";
const OPTIONS = {} as unknown as CreateWorkerOptions;

function fakeWorker() {
  const settles: Array<[string, SettleInput]> = [];
  const worker = {
    claimRunAction: vi.fn(async () => ({ id: ID, kind: "cancel_run", attempts: 1 })),
    settleRunAction: vi.fn(async (id: string, input: SettleInput) => void settles.push([id, input])),
    performCancelRun: vi.fn(async (): Promise<PerformResult> => ({ result: "done", outcome: { status: "cancelled", settled_usd: 0, released_usd: 1 } })),
    performCancelWorkItem: vi.fn(),
    listDueRunActions: vi.fn(),
    purgeRunActions: vi.fn(),
  } as unknown as RunActionsWorker;
  return { worker, settles };
}

afterEach(() => setWorkerWiringForTests());

describe("provider returns null (this PR's production state)", () => {
  it("there is no worker, createWorker is never called, and the workflow ends at the claim with nothing performed", async () => {
    const createWorker = vi.fn();
    setWorkerWiringForTests({ createWorker });
    expect(workerConfigured()).toBe(false);
    expect(await getWorker()).toBeNull();
    expect(await runActionWorkflow(ID)).toBeNull();
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("the default wiring (nothing injected) is null too", async () => {
    setWorkerWiringForTests();
    expect(workerConfigured()).toBe(false);
    expect(await getWorker()).toBeNull();
  });
});

describe("provider returns options, with a fake createWorker", () => {
  it("the workflow drives the facade end to end: claim (300 s lease), perform with the id only, settle done", async () => {
    const { worker, settles } = fakeWorker();
    const createWorker = vi.fn(async () => worker as unknown as Worker);
    setWorkerWiringForTests({ provider: () => OPTIONS, createWorker });
    expect(workerConfigured()).toBe(true);

    expect(await runActionWorkflow(ID)).toEqual({ id: ID, state: "done" });

    expect(createWorker).toHaveBeenCalledWith(OPTIONS);
    expect(worker.claimRunAction).toHaveBeenCalledWith(ID, 300);
    expect(worker.performCancelRun).toHaveBeenCalledWith(ID);
    expect(settles).toEqual([[ID, { state: "done", outcome: { status: "cancelled", settled_usd: 0, released_usd: 1 } }]]);
  });

  it("a duplicate kick (claim null) ends the workflow without a perform or a settle", async () => {
    const { worker, settles } = fakeWorker();
    (worker.claimRunAction as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    setWorkerWiringForTests({ provider: () => OPTIONS, createWorker: async () => worker as unknown as Worker });
    expect(await runActionWorkflow(ID)).toBeNull();
    expect(worker.performCancelRun).not.toHaveBeenCalled();
    expect(settles).toEqual([]);
  });
});

describe("a page of progress claims again at once", () => {
  /** A work-item worker whose first `pages` performs report `remaining`, then one finishes. Counts claims. */
  function pagingWorker(pages: number) {
    const { worker, settles } = fakeWorker();
    let performs = 0;
    (worker.claimRunAction as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ id: ID, kind: "cancel_work_item", attempts: 1 }));
    (worker.performCancelWorkItem as ReturnType<typeof vi.fn>).mockImplementation(
      async (): Promise<PerformResult> => (++performs <= pages ? { result: "done", outcome: { runs_cancelled: 100, remaining: true } } : { result: "done", outcome: { runs_cancelled: 5, stage: "needs_human" } }),
    );
    setWorkerWiringForTests({ provider: () => OPTIONS, createWorker: async () => worker as unknown as Worker });
    return { worker, settles };
  }

  it("three progress pages then the last: four claims in one workflow run, three progress settles, the result is the final settle", async () => {
    const { worker, settles } = pagingWorker(3);
    expect(await runActionWorkflow(ID)).toEqual({ id: ID, state: "done" });
    expect(worker.claimRunAction).toHaveBeenCalledTimes(4);
    expect(settles.map(([, input]) => input)).toEqual([
      { state: "accepted", progress: true },
      { state: "accepted", progress: true },
      { state: "accepted", progress: true },
      { state: "done", outcome: { runs_cancelled: 5, stage: "needs_human" } },
    ]);
  });

  it("stops after 20 claims in one workflow run and leaves the action to the sweep", async () => {
    const { worker, settles } = pagingWorker(1000);
    expect(await runActionWorkflow(ID)).toEqual({ id: ID, state: "accepted", progress: true });
    expect(worker.claimRunAction).toHaveBeenCalledTimes(20);
    expect(settles).toHaveLength(20);
  });

  it("a claim that comes back null after a progress page ends the workflow (someone else holds the lease)", async () => {
    const { worker } = pagingWorker(5);
    (worker.claimRunAction as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: ID, kind: "cancel_work_item", attempts: 1 }).mockResolvedValueOnce(null);
    expect(await runActionWorkflow(ID)).toEqual({ id: ID, state: "accepted", progress: true });
    expect(worker.claimRunAction).toHaveBeenCalledTimes(2);
  });

  it("a thrown perform is not progress: the workflow ends after that settle", async () => {
    const { worker } = pagingWorker(0);
    (worker.performCancelWorkItem as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    expect(await runActionWorkflow(ID)).toEqual({ id: ID, state: "accepted" });
    expect(worker.claimRunAction).toHaveBeenCalledTimes(1);
  });
});

describe("A3: the workflow and every step take and return plain JSON", () => {
  const roundTrips = (v: unknown) => {
    expect(JSON.parse(JSON.stringify(v))).toEqual(v);
    expect(structuredClone(v)).toEqual(v);
  };

  it("runActionWorkflow takes one string; each step's arguments and results round-trip through JSON and structuredClone", async () => {
    const { worker } = fakeWorker();
    setWorkerWiringForTests({ provider: () => OPTIONS, createWorker: async () => worker as unknown as Worker });
    expect(runActionWorkflow.length).toBe(1);
    expect(claimStep.length).toBe(1);
    expect(performStep.length).toBe(1);
    expect(settleStep.length).toBe(2);

    roundTrips([ID]);
    const claimed = await claimStep(ID);
    roundTrips(claimed);
    roundTrips([claimed]);
    const outcome = await performStep(claimed!);
    roundTrips(outcome);
    roundTrips([claimed, outcome]);
    const settled = await settleStep(claimed!, outcome);
    roundTrips(settled);
    roundTrips(await runActionWorkflow(ID));
  });
});

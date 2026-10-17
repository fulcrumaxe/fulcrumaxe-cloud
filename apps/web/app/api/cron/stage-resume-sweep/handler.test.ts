import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { markWorkPending, setPendingHooks } from "@fx/core/src/pendingWork";
import { registeredStages } from "@fx/pipeline";
import { makeRegion, storeOf, type FakeRegion } from "../../../../test/support/runtimeCacheFake";
import { stageResumeSweepHandler, type StageResumeSweepHandlerDeps } from "./handler";

/** D#483 S5-k1b: the cron's route layer behind the pending-work marker, no database (the sweep's own cases are packages/worker/test/stageResume.pg.test.ts). */
const SECRET = "test-cron-secret";
const NONE = { stages: 1, listed: 0, refreshed: 0, resumed: 0, skipped: 0, failed: 0, nextDueAt: null as number | null };
const KEY = "pending:stage-resume-sweep";
const clock = { value: Date.parse("2026-10-16T12:00:00Z") };
let region: FakeRegion;

function setup(sweep: (entries: unknown) => Promise<typeof NONE> = async () => NONE, over: Partial<StageResumeSweepHandlerDeps> = {}) {
  const sweepParkedStages = vi.fn(sweep);
  const getWorker = vi.fn(async (): Promise<{ sweepParkedStages: typeof sweepParkedStages } | null> => ({ sweepParkedStages }));
  const log = vi.fn();
  return { sweepParkedStages, getWorker, log, deps: { cronSecret: SECRET, getWorker: getWorker as StageResumeSweepHandlerDeps["getWorker"], log, now: () => clock.value, ...over } satisfies StageResumeSweepHandlerDeps };
}
const req = (authorization: string | null) => new NextRequest("https://example.test/api/cron/stage-resume-sweep", { method: "GET", headers: authorization === null ? {} : { authorization } });
const marker = (): number | null => {
  const e = region.entries.get(KEY);
  return e ? (JSON.parse(e.json) as number) : null;
};

beforeEach(() => {
  region = makeRegion(clock);
  setPendingHooks({ store: storeOf(region) });
  region.entries.set("lastrun:stage-resume-sweep", { json: JSON.stringify(clock.value), expiresAt: clock.value + 3_600_000 });
});
afterEach(() => setPendingHooks(null));

describe("GET /api/cron/stage-resume-sweep", () => {
  it.each([
    ["no header", null, SECRET],
    ["a wrong secret", "Bearer nope", SECRET],
    ["a customer API token", "Bearer fxat_notarealcronsecretatall000000000000000", SECRET],
    ["an unset secret", "Bearer ", ""],
  ])("401s with %s and builds no worker", async (_n, header, secret) => {
    const s = setup(undefined, { cronSecret: secret });
    expect((await stageResumeSweepHandler(req(header), s.deps)).status).toBe(401);
    expect(s.getWorker).not.toHaveBeenCalled();
  });

  it("an idle platform (no marker) builds no worker and opens no connection", async () => {
    const s = setup();
    const res = await stageResumeSweepHandler(req(`Bearer ${SECRET}`), s.deps);
    expect(await res.json()).toEqual({ skipped: true, reason: "no_pending_work" });
    expect(s.getWorker).not.toHaveBeenCalled();
  });

  it("a pause the worker recorded wakes it: the sweep gets the pipeline's registry (build, classify, the Spec, the re-spec, the review, the fix round and the panel) and the marker moves to the next pass while items stay parked", async () => {
    await markWorkPending("stage-resume-sweep", { since: clock.value });
    const next = clock.value + 15 * 60_000;
    const s = setup(async () => ({ ...NONE, listed: 2, refreshed: 2, nextDueAt: next }));
    const res = await stageResumeSweepHandler(req(`Bearer ${SECRET}`), s.deps);
    expect(await res.json()).toMatchObject({ configured: true, listed: 2, refreshed: 2 });
    const passed = s.sweepParkedStages.mock.calls[0]![0] as Array<{ stage: string }>;
    expect(passed.map((e) => e.stage)).toEqual(["build", "classify", "spec", "respec", "review", "fix_round", "panel"]);
    expect(passed.map((e) => e.stage)).toEqual(registeredStages().map((e) => e.stage));
    expect(marker()).toBe(next);
  });

  it("when nothing is parked any more the marker is cleared (once its grace has passed)", async () => {
    await markWorkPending("stage-resume-sweep", { since: clock.value - 120_000 });
    const s = setup();
    await stageResumeSweepHandler(req(`Bearer ${SECRET}`), s.deps);
    expect(marker()).toBeNull();
  });

  it("an unconfigured worker is reported, not an error", async () => {
    await markWorkPending("stage-resume-sweep", { since: clock.value });
    const s = setup();
    s.getWorker.mockResolvedValueOnce(null);
    const res = await stageResumeSweepHandler(req(`Bearer ${SECRET}`), s.deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false });
  });
});

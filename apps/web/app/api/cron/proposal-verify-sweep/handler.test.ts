import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { markWorkPending, setPendingHooks } from "@fx/core/src/pendingWork";
import type { ProposalVerifyCounts } from "@fx/worker";
import { makeRegion, storeOf, type FakeRegion } from "../../../../test/support/runtimeCacheFake";
import { PROPOSAL_VERIFY_PASS_MS, proposalVerifySweepHandler, type ProposalVerifySweepHandlerDeps } from "./handler";

/**
 * D#483 S4-b2b: the claim verifier cron's route layer behind the pending-work marker, no database. The sweep's own cases (the lock, both daily
 * limits, the e2e run) are packages/worker/test/proposalVerify.pg.test.ts.
 */
const SECRET = "test-cron-secret";
const NONE: ProposalVerifyCounts = { listed: 0, started: 0, waiting: 0, recorded: 0, daily_limit: 0, daily_cap: 0, skipped: 0, failed: 0 };
const KEY = "pending:proposal-verify-sweep";
const clock = { value: Date.parse("2026-10-22T12:00:00Z") };
let region: FakeRegion;

function setup(sweep: () => Promise<ProposalVerifyCounts> = async () => NONE, over: Partial<ProposalVerifySweepHandlerDeps> = {}) {
  const sweepProposalVerification = vi.fn(sweep);
  const getWorker = vi.fn(async (): Promise<{ sweepProposalVerification: typeof sweepProposalVerification } | null> => ({ sweepProposalVerification }));
  const log = vi.fn();
  return { sweepProposalVerification, getWorker, log, deps: { cronSecret: SECRET, getWorker, log, now: () => clock.value, ...over } satisfies ProposalVerifySweepHandlerDeps };
}
const req = (authorization: string | null, method = "GET") =>
  new NextRequest("https://example.test/api/cron/proposal-verify-sweep", { method, headers: authorization === null ? {} : { authorization } });
const marker = (): number | null => {
  const e = region.entries.get(KEY);
  return e ? (JSON.parse(e.json) as number) : null;
};

beforeEach(() => {
  region = makeRegion(clock);
  setPendingHooks({ store: storeOf(region) });
  region.entries.set("lastrun:proposal-verify-sweep", { json: JSON.stringify(clock.value), expiresAt: clock.value + 3_600_000 });
});
afterEach(() => setPendingHooks(null));

describe("GET /api/cron/proposal-verify-sweep", () => {
  it.each([
    ["no header", null, SECRET],
    ["a wrong secret", "Bearer nope", SECRET],
    ["the secret without the Bearer scheme", SECRET, SECRET],
    ["a customer API token", "Bearer fxat_notarealcronsecretatall000000000000000", SECRET],
    ["an unset secret", "Bearer ", ""],
  ])("401s with %s, builds no worker and runs no sweep, even with work pending", async (_n, header, secret) => {
    await markWorkPending("proposal-verify-sweep", { since: clock.value });
    const s = setup(undefined, { cronSecret: secret });
    const res = await proposalVerifySweepHandler(req(header), s.deps);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
    expect(s.getWorker).not.toHaveBeenCalled();
    expect(s.sweepProposalVerification).not.toHaveBeenCalled();
  });

  it("an idle platform (no marker, backstop not due) builds no worker and opens no connection", async () => {
    const s = setup();
    const res = await proposalVerifySweepHandler(req(`Bearer ${SECRET}`), s.deps);
    expect(await res.json()).toEqual({ skipped: true, reason: "no_pending_work" });
    expect(s.getWorker).not.toHaveBeenCalled();
  });

  it("one authenticated tick runs exactly one pass and returns its counts; proposals still waiting keep the marker on the next pass", async () => {
    await markWorkPending("proposal-verify-sweep", { since: clock.value });
    const s = setup(async () => ({ ...NONE, listed: 3, started: 2, daily_limit: 1 }));
    const res = await proposalVerifySweepHandler(req(`Bearer ${SECRET}`), s.deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: true, ...NONE, listed: 3, started: 2, daily_limit: 1 });
    expect(s.sweepProposalVerification).toHaveBeenCalledTimes(1);
    expect(marker()).toBe(clock.value + PROPOSAL_VERIFY_PASS_MS);
  });

  it("a pass that found another holding the lock reports it and is not an error", async () => {
    await markWorkPending("proposal-verify-sweep", { since: clock.value });
    const s = setup(async () => ({ ...NONE, idle: "busy" }));
    const res = await proposalVerifySweepHandler(req(`Bearer ${SECRET}`), s.deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ configured: true, idle: "busy", started: 0 });
  });

  it("when nothing is waiting any more the marker is cleared (once its grace has passed)", async () => {
    await markWorkPending("proposal-verify-sweep", { since: clock.value - 120_000 });
    const s = setup();
    await proposalVerifySweepHandler(req(`Bearer ${SECRET}`), s.deps);
    expect(marker()).toBeNull();
  });

  it("an unconfigured worker is reported, not an error", async () => {
    await markWorkPending("proposal-verify-sweep", { since: clock.value });
    const s = setup();
    s.getWorker.mockResolvedValueOnce(null);
    const res = await proposalVerifySweepHandler(req(`Bearer ${SECRET}`), s.deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false });
  });
});

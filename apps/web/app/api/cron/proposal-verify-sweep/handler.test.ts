import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { markWorkPending, setPendingHooks } from "@fx/core/src/pendingWork";
import type { AutoStartCounts, DiscoveryDrainCounts, ProposalVerifyCounts } from "@fx/worker";
import { makeRegion, storeOf, type FakeRegion } from "../../../../test/support/runtimeCacheFake";
import { PROPOSAL_VERIFY_PASS_MS, proposalVerifySweepHandler, type ProposalVerifySweepHandlerDeps } from "./handler";

/**
 * D#483 S4-b2b: the claim verifier cron's route layer behind the pending-work marker, no database. The sweep's own cases (the lock, both daily
 * limits, the e2e run) are packages/worker/test/proposalVerify.pg.test.ts.
 */
const SECRET = "test-cron-secret";
const NONE: ProposalVerifyCounts = { listed: 0, started: 0, waiting: 0, recorded: 0, daily_limit: 0, daily_cap: 0, skipped: 0, failed: 0 };
const AUTO_NONE: AutoStartCounts = { listed: 0, started: 0, asked: 0, held_by_rule: 0, no_room: 0, not_ready: 0, replayed: 0, failed: 0 };
const DRAIN_NONE: DiscoveryDrainCounts = { accounts: 0, succeeded: 0, skipped: 0, failed: 0, errors: 0, more: false };
const KEY = "pending:proposal-verify-sweep";
const clock = { value: Date.parse("2026-10-22T12:00:00Z") };
let region: FakeRegion;

function setup(sweep: () => Promise<ProposalVerifyCounts> = async () => NONE, over: Partial<ProposalVerifySweepHandlerDeps> = {}, auto: () => Promise<AutoStartCounts> = async () => AUTO_NONE, drain: () => Promise<DiscoveryDrainCounts> = async () => DRAIN_NONE) {
  const sweepDiscoveryQueue = vi.fn(drain);
  const sweepProposalVerification = vi.fn(sweep);
  const sweepAutoStart = vi.fn(auto);
  const getWorker = vi.fn(async (): Promise<{ sweepDiscoveryQueue: typeof sweepDiscoveryQueue; sweepProposalVerification: typeof sweepProposalVerification; sweepAutoStart: typeof sweepAutoStart } | null> => ({ sweepDiscoveryQueue, sweepProposalVerification, sweepAutoStart }));
  const log = vi.fn();
  return { sweepDiscoveryQueue, sweepProposalVerification, sweepAutoStart, getWorker, log, deps: { cronSecret: SECRET, getWorker, log, now: () => clock.value, ...over } satisfies ProposalVerifySweepHandlerDeps };
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
    expect(await res.json()).toEqual({ configured: true, ...NONE, listed: 3, started: 2, daily_limit: 1, discovery: DRAIN_NONE, auto_start: AUTO_NONE });
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

  it("S5-b1a-2: the auto-start pass runs once after the check pass; proposals the weekly limit has no room for wait for its renewal, not for the next 15 minutes", async () => {
    await markWorkPending("proposal-verify-sweep", { since: clock.value });
    const renewsAt = "2026-10-26T00:00:00.000Z";
    const s = setup(async () => NONE, {}, async () => ({ ...AUTO_NONE, listed: 2, no_room: 2, renews_at: renewsAt }));
    const res = await proposalVerifySweepHandler(req(`Bearer ${SECRET}`), s.deps);
    expect(await res.json()).toMatchObject({ configured: true, auto_start: { no_room: 2, renews_at: renewsAt } });
    expect(s.sweepAutoStart).toHaveBeenCalledTimes(1);
    expect(marker()).toBe(Date.parse(renewsAt));
  });

  it("S5-b1a-2: a pass that started something keeps the next pass coming; a fault in the auto-start pass never hides the check pass's counts", async () => {
    await markWorkPending("proposal-verify-sweep", { since: clock.value });
    const started = setup(async () => NONE, {}, async () => ({ ...AUTO_NONE, listed: 1, started: 1 }));
    await proposalVerifySweepHandler(req(`Bearer ${SECRET}`), started.deps);
    expect(marker()).toBe(clock.value + PROPOSAL_VERIFY_PASS_MS);
    await markWorkPending("proposal-verify-sweep", { since: clock.value });
    const broken = setup(async () => ({ ...NONE, listed: 1 }), {}, async () => { throw new Error("boom"); });
    const res = await proposalVerifySweepHandler(req(`Bearer ${SECRET}`), broken.deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ configured: true, listed: 1, auto_start: null });
    expect(JSON.stringify(broken.log.mock.calls)).not.toContain("boom");
  });

  it("S5-b2c-1: a child the pass launched, or could not gate, keeps the next pass coming just as a proposal does; a held child does not", async () => {
    const CHILD_NONE = { listed: 1, started: 0, asked: 0, held_by_rule: 1, no_room: 0, not_ready: 0, replayed: 0, failed: 0, held: { waiting_on_planned_pr: 1 } };
    for (const children of [{ ...CHILD_NONE, started: 1 }, { ...CHILD_NONE, failed: 1 }]) {
      await markWorkPending("proposal-verify-sweep", { since: clock.value });
      const s = setup(async () => NONE, {}, async () => ({ ...AUTO_NONE, children }));
      await proposalVerifySweepHandler(req(`Bearer ${SECRET}`), s.deps);
      expect(marker()).toBe(clock.value + PROPOSAL_VERIFY_PASS_MS);
    }
    await markWorkPending("proposal-verify-sweep", { since: clock.value });
    const held = setup(async () => NONE, {}, async () => ({ ...AUTO_NONE, children: CHILD_NONE }));
    await proposalVerifySweepHandler(req(`Bearer ${SECRET}`), held.deps);
    expect(marker()).not.toBe(clock.value + PROPOSAL_VERIFY_PASS_MS);
  });

  it("an unconfigured worker is reported, not an error", async () => {
    await markWorkPending("proposal-verify-sweep", { since: clock.value });
    const s = setup();
    s.getWorker.mockResolvedValueOnce(null);
    const res = await proposalVerifySweepHandler(req(`Bearer ${SECRET}`), s.deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false });
  });

  // D#483 S4-c2: the discovery drain is the tick's first pass.
  it("drains the discovery queue before the verifier pass, reports its counts, and keeps the next pass coming when its time budget left accounts", async () => {
    await markWorkPending("proposal-verify-sweep", { since: clock.value });
    const order: string[] = [];
    const s = setup(
      async () => (order.push("verify"), NONE),
      {},
      async () => AUTO_NONE,
      async () => (order.push("drain"), { ...DRAIN_NONE, accounts: 3, succeeded: 3, more: true }),
    );
    const body = await (await proposalVerifySweepHandler(req(`Bearer ${SECRET}`), s.deps)).json();
    expect(order).toEqual(["drain", "verify"]);
    expect(body).toMatchObject({ configured: true, discovery: { accounts: 3, succeeded: 3, more: true } });
    expect(marker()).toBe(clock.value + PROPOSAL_VERIFY_PASS_MS);
  });

  it("a fault in the drain is logged by name only, never hides the verifier's counts, and starts no extra pass", async () => {
    await markWorkPending("proposal-verify-sweep", { since: clock.value });
    const s = setup(async () => ({ ...NONE, listed: 2, started: 2 }), {}, async () => AUTO_NONE, async () => Promise.reject(new TypeError("postgres://u:secret@host/db")));
    const body = await (await proposalVerifySweepHandler(req(`Bearer ${SECRET}`), s.deps)).json();
    expect(body).toMatchObject({ configured: true, listed: 2, started: 2, discovery: null });
    expect(s.log).toHaveBeenCalledWith("proposal verify sweep: discovery drain failed (TypeError)");
    expect(JSON.stringify(s.log.mock.calls)).not.toContain("secret");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPendingHooks, type PendingHooks, type SweepName } from "@fx/core/src/pendingWork";
import {
  VERIFY_SWEEP_KICK_BODY,
  VERIFY_SWEEP_KICK_HEADER,
  apiSweepKickKey,
  createVerifySweepKicker,
  verifySweepKickHeader,
  verifySweepKickKey,
  verifySweepKickerFromEnv,
  verifyVerifySweepKick,
} from "@fx/webhooks";
import { wakeVerifyStage } from "@fx/core/src/verify/wake";
import { proposalVerifySweepHandler, proposalVerifySweepKickHandler, type ProposalVerifySweepHandlerDeps } from "../app/api/cron/proposal-verify-sweep/handler";
import type { ProposalVerifySweepWorker } from "../lib/worker";
import { NextRequest } from "next/server";

/**
 * D#749: the verify stage's wake points push instead of waiting for the 15-minute tick. Each wake point marks the proposal-verify sweep pending AND kicks it;
 * a kick runs one pass whatever the marker says; a kick while a pass runs does nothing; the end of a run that is not a post-merge tester's wakes nothing.
 */
const NOW = 1_800_000_000_000;
const SECRET = "cron-secret-for-the-verify-wake-test";
const entries = new Map<string, number>();
const kicks: SweepName[] = [];

function install(extra: Partial<PendingHooks> = {}): void {
  setPendingHooks({
    store: { get: async (key) => entries.get(key) ?? null, set: async (key, value) => void entries.set(key, value), delete: async (key) => void entries.delete(key) },
    kick: (name) => void kicks.push(name),
    ...extra,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  install();
});
afterEach(() => {
  setPendingHooks(null);
  entries.clear();
  kicks.length = 0;
  vi.useRealTimers();
});

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("wakeVerifyStage", () => {
  it("marks the proposal-verify sweep pending and kicks it", async () => {
    wakeVerifyStage();
    await flush();
    expect(entries.get("pending:proposal-verify-sweep")).toBe(NOW);
    expect(kicks).toEqual(["proposal-verify-sweep"]);
  });

  it("a store or kick that throws never reaches the caller", () => {
    setPendingHooks({ store: { get: async () => { throw new Error("down"); }, set: async () => { throw new Error("down"); }, delete: async () => {} }, kick: () => { throw new Error("down"); } });
    expect(() => wakeVerifyStage()).not.toThrow();
  });
});

describe("the kick sender", () => {
  it("posts the fixed body signed with the derived key, never the cron secret", async () => {
    const sent: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const kicker = createVerifySweepKicker({
      url: "https://example.test/api/cron/proposal-verify-sweep",
      secret: verifySweepKickKey(SECRET),
      sleep: async () => {},
      now: () => NOW,
      fetchImpl: (async (url: string, init: RequestInit) => {
        sent.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
        return new Response(null, { status: 202 });
      }) as unknown as typeof fetch,
    });
    await kicker.kick();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toBe(VERIFY_SWEEP_KICK_BODY);
    expect(sent[0]!.headers[VERIFY_SWEEP_KICK_HEADER]).toBe(verifySweepKickHeader(verifySweepKickKey(SECRET), Math.floor(NOW / 1000)));
    expect(JSON.stringify(sent)).not.toContain(SECRET);
  });

  it("the kicker built from the environment signs with the derived key, which the handler's check accepts (and never the raw cron secret)", async () => {
    const calls: Array<{ url: string; header: string; body: string }> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string, init: RequestInit) => {
      calls.push({ url, header: (init.headers as Record<string, string>)[VERIFY_SWEEP_KICK_HEADER]!, body: String(init.body) });
      return new Response(null, { status: 202 });
    }) as never);
    try {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
      vi.setSystemTime(NOW);
      const kicker = verifySweepKickerFromEnv({ RUN_ACTION_KICK_URL: "https://x.test/api/internal/run-actions/kick", CRON_SECRET: SECRET })!;
      const sent = kicker.kick();
      await vi.advanceTimersByTimeAsync(5000);
      await sent;
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("https://x.test/api/cron/proposal-verify-sweep");
      const now = Math.floor(NOW / 1000);
      expect(verifyVerifySweepKick(calls[0]!.header, calls[0]!.body, verifySweepKickKey(SECRET), now)).toBe(true);
      expect(verifyVerifySweepKick(calls[0]!.header, calls[0]!.body, SECRET, now)).toBe(false);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("sends nothing without an https kick URL and the cron secret", () => {
    expect(verifySweepKickerFromEnv({ CRON_SECRET: SECRET })).toBeNull();
    expect(verifySweepKickerFromEnv({ RUN_ACTION_KICK_URL: "http://x.test", CRON_SECRET: SECRET })).toBeNull();
    expect(verifySweepKickerFromEnv({ RUN_ACTION_KICK_URL: "https://x.test" })).toBeNull();
    expect(verifySweepKickerFromEnv({ RUN_ACTION_KICK_URL: "https://x.test", CRON_SECRET: SECRET })).not.toBeNull();
  });

  it("a failed send is reported and swallowed", async () => {
    const reports: string[] = [];
    const kicker = createVerifySweepKicker({ url: "https://x.test/", secret: "k", sleep: async () => {}, fetchImpl: (async () => { throw new Error("refused"); }) as unknown as typeof fetch, reportError: (_e, stage) => void reports.push(stage) });
    await expect(kicker.kick()).resolves.toBeUndefined();
    expect(reports).toEqual(["verify_sweep_kick.send"]);
  });
});

describe("the kick handler", () => {
  const worker = (verify: () => Promise<{ active: number }>): ProposalVerifySweepWorker =>
    ({
      sweepDiscoverySchedule: async () => ({ more: false }),
      sweepDiscoveryQueue: async () => ({ more: false }),
      sweepProposalVerification: async () => ({ listed: 0 }),
      sweepDocsCodeAnalysis: async () => ({ listed: 0 }),
      sweepVerifyStage: verify,
      sweepAutoStart: async () => ({ started: 0, failed: 0 }),
    }) as unknown as ProposalVerifySweepWorker;

  const kickRequest = (header: string | null, body = VERIFY_SWEEP_KICK_BODY): Request =>
    new Request("https://example.test/api/cron/proposal-verify-sweep", { method: "POST", headers: header === null ? {} : { [VERIFY_SWEEP_KICK_HEADER]: header }, body });
  const goodHeader = (): string => verifySweepKickHeader(verifySweepKickKey(SECRET), Math.floor(NOW / 1000));

  function deps(verify: () => Promise<{ active: number }>) {
    const scheduled: Array<Promise<unknown>> = [];
    const getWorker = vi.fn(async () => worker(verify));
    const base: ProposalVerifySweepHandlerDeps & { schedule(work: Promise<unknown>): void; nowSeconds(): number } = {
      cronSecret: SECRET,
      getWorker,
      log: () => {},
      now: () => NOW,
      schedule: (work) => void scheduled.push(work),
      nowSeconds: () => Math.floor(NOW / 1000),
    };
    return { base, scheduled, getWorker };
  }

  it("a bad, missing, stale, wrong-body or other-sweep signature is a bare 401 and builds no worker", async () => {
    const { base, scheduled, getWorker } = deps(async () => ({ active: 0 }));
    const stale = verifySweepKickHeader(verifySweepKickKey(SECRET), Math.floor(NOW / 1000) - 3600);
    const apiKey = verifySweepKickHeader(apiSweepKickKey(SECRET), Math.floor(NOW / 1000));
    for (const req of [kickRequest(null), kickRequest("t=1,sig=" + "0".repeat(64)), kickRequest(stale), kickRequest(apiKey), kickRequest(goodHeader(), '{"kick":"api-sweep"}')]) {
      const res = await proposalVerifySweepKickHandler(req, base);
      expect(res.status).toBe(401);
    }
    expect(scheduled).toHaveLength(0);
    expect(getWorker).not.toHaveBeenCalled();
  });

  it("refuses a signature made with the cron secret itself rather than the key derived from it", async () => {
    const { base, scheduled, getWorker } = deps(async () => ({ active: 0 }));
    const raw = verifySweepKickHeader(SECRET, Math.floor(NOW / 1000));
    expect((await proposalVerifySweepKickHandler(kickRequest(raw), base)).status).toBe(401);
    expect(scheduled).toHaveLength(0);
    expect(getWorker).not.toHaveBeenCalled();
  });

  it("an unset cron secret fails closed", async () => {
    const { base, getWorker } = deps(async () => ({ active: 0 }));
    const res = await proposalVerifySweepKickHandler(kickRequest(goodHeader()), { ...base, cronSecret: "" });
    expect(res.status).toBe(401);
    expect(getWorker).not.toHaveBeenCalled();
  });

  it("a valid kick answers 202 at once and runs one pass with no marker set", async () => {
    const verify = vi.fn(async () => ({ active: 0 }));
    const { base, scheduled } = deps(verify);
    entries.set("lastrun:proposal-verify-sweep", NOW); // connected a moment ago and nothing is pending: the gate alone would skip a tick now
    const skipped = await proposalVerifySweepHandler(new NextRequest("https://example.test/api/cron/proposal-verify-sweep", { headers: { authorization: `Bearer ${SECRET}` } }), base);
    expect(await skipped.json()).toEqual({ skipped: true, reason: "no_pending_work" });
    expect(verify).not.toHaveBeenCalled();
    const res = await proposalVerifySweepKickHandler(kickRequest(goodHeader()), base);
    expect(res.status).toBe(202);
    expect(verify).not.toHaveBeenCalled(); // the pass runs after the response, not inside it
    await Promise.all(scheduled);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("a kick while a pass runs is a no-op (busy): one pass, both answered 202", async () => {
    let release: () => void = () => {};
    const verify = vi.fn(() => new Promise<{ active: number }>((resolve) => { release = () => resolve({ active: 0 }); }));
    const { base, scheduled } = deps(verify);
    expect((await proposalVerifySweepKickHandler(kickRequest(goodHeader()), base)).status).toBe(202);
    await flush();
    expect((await proposalVerifySweepKickHandler(kickRequest(goodHeader()), base)).status).toBe(202);
    expect(scheduled).toHaveLength(1);
    await flush();
    expect(verify).toHaveBeenCalledTimes(1);
    release();
    await Promise.all(scheduled);
    // The guard is released afterwards: the next kick runs a pass again.
    const next = vi.fn(async () => ({ active: 0 }));
    const again = deps(next);
    await proposalVerifySweepKickHandler(kickRequest(goodHeader()), again.base);
    await Promise.all(again.scheduled);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("a pass that throws is logged by name only, never reaches the response, and frees the guard", async () => {
    const logs: string[] = [];
    const { base, scheduled } = deps(async () => ({ active: 0 }));
    const failing = { ...base, log: (l: string) => void logs.push(l), getWorker: async () => { throw new TypeError("secret detail"); } };
    expect((await proposalVerifySweepKickHandler(kickRequest(goodHeader()), failing)).status).toBe(202);
    await Promise.all(scheduled);
    expect(logs.join("\n")).toContain("TypeError");
    expect(logs.join("\n")).not.toContain("secret detail");
    const ok = deps(async () => ({ active: 0 }));
    await proposalVerifySweepKickHandler(kickRequest(goodHeader()), ok.base);
    expect(ok.scheduled).toHaveLength(1);
    await Promise.all(ok.scheduled);
  });

  it("the plain GET cron tick still runs when a marker is set", async () => {
    const verify = vi.fn(async () => ({ active: 0 }));
    const { base } = deps(verify);
    const get = () => proposalVerifySweepHandler(new NextRequest("https://example.test/api/cron/proposal-verify-sweep", { headers: { authorization: `Bearer ${SECRET}` } }), base);
    entries.set("pending:proposal-verify-sweep", NOW - 1000);
    entries.set("lastrun:proposal-verify-sweep", NOW); // recently connected, so only the marker can open the gate
    const ran = await get();
    expect(ran.status).toBe(200);
  });
});

/**
 * D#6 C43-3: the shared state of a runner that holds several jobs. The count of jobs in hand (what self-update asks), the keyed queue and
 * single flight the mirror and the dev shell use, and the job ledger with real files: claims from overlapping jobs, an expiry sweep
 * between them, and a restart that must still know every id.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileLedger, type FileLedger } from "../../src/daemon/ledger.js";
import { createJobsInHand } from "../../src/daemon/jobsInHand.js";
import { singleFlight, withKeyLock } from "../../src/daemon/keyedLock.js";
import { createAutoUpdate, type Updater } from "../../src/update/updater.js";
import { ledgerOptions } from "../helpers/ledgerOptions.js";

const gate = (): { promise: Promise<void>; open: () => void } => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("jobs in hand", () => {
  it("hasLease stays true until both of two overlapping jobs end, and a failed job is counted out", async () => {
    const jobs = createJobsInHand();
    const hasLease = (): boolean => jobs.any();
    const first = gate();
    const second = gate();
    expect(hasLease()).toBe(false);
    const a = jobs.track(() => first.promise);
    const b = jobs.track(() => second.promise);
    expect(jobs.count()).toBe(2);
    first.open();
    await a;
    expect(jobs.count()).toBe(1);
    expect(hasLease()).toBe(true); // the first job to finish must not clear the answer
    second.open();
    await b;
    expect(hasLease()).toBe(false);
    await expect(jobs.track(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(jobs.count()).toBe(0);
  });

  it("self-update does nothing while any job is in hand and acts again when the last one ends", async () => {
    const jobs = createJobsInHand();
    let looked = 0;
    // The tick returns before it reads any update state when a job is in hand; a stand-in that records the first read shows which side it took.
    const updater = {
      get dir(): string {
        looked += 1;
        throw new Error("update state read");
      },
    } as unknown as Updater;
    const auto = createAutoUpdate({ updater, hasLease: () => jobs.any(), now: () => new Date() });
    const first = gate();
    const second = gate();
    const a = jobs.track(() => first.promise);
    const b = jobs.track(() => second.promise);
    first.open();
    await a;
    expect(await auto.tick()).toEqual({ kind: "none" });
    expect(looked).toBe(0);
    second.open();
    await b;
    await expect(auto.tick()).rejects.toThrow("update state read");
    expect(looked).toBe(1);
  });
});

describe("the keyed queue", () => {
  it("runs calls on one key one after the other in call order, and calls on other keys beside them", async () => {
    const log: string[] = [];
    const hold = gate();
    const a1 = withKeyLock("k", async () => {
      log.push("a1 start");
      await hold.promise;
      log.push("a1 end");
    });
    const a2 = withKeyLock("k", async () => {
      log.push("a2 start");
    });
    const other = withKeyLock("other", async () => {
      log.push("other");
    });
    await other;
    await tick();
    expect(log).toEqual(["a1 start", "other"]);
    hold.open();
    await Promise.all([a1, a2]);
    expect(log).toEqual(["a1 start", "other", "a1 end", "a2 start"]);
  });

  it("a failing call passes its error on and does not hold up the next", async () => {
    const failing = withKeyLock("f", () => Promise.reject(new Error("no")));
    const next = withKeyLock("f", async () => "ran");
    await expect(failing).rejects.toThrow("no");
    await expect(next).resolves.toBe("ran");
  });

  it("single flight runs once for callers that arrive while it runs, and again for one that arrives after", async () => {
    let runs = 0;
    const hold = gate();
    const work = async (): Promise<number> => {
      runs += 1;
      await hold.promise;
      return runs;
    };
    const first = singleFlight("s", work);
    const second = singleFlight("s", work);
    hold.open();
    expect(await first).toEqual({ value: 1, shared: false });
    expect(await second).toEqual({ value: 1, shared: true });
    expect(await singleFlight("s", async () => 2)).toEqual({ value: 2, shared: false });
    expect(runs).toBe(1);
  });
});

describe("the job ledger under overlapping jobs", () => {
  const ids = Array.from({ length: 6 }, (_, n) => `0000000${n}-0000-4000-8000-00000000000${n}`);
  let dir: string;
  let file: string;
  let open: FileLedger[];
  let nowMs: number;
  const now = (): Date => new Date(nowMs);
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "fxr-ledger-conc-"));
    file = path.join(dir, "state", "jobs.json");
    open = [];
    nowMs = Date.parse("2026-10-10T10:00:00Z");
  });
  afterEach(() => {
    for (const ledger of open) ledger.close();
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });
  const ledgerAt = (): FileLedger => {
    const ledger = createFileLedger(file, ledgerOptions(now));
    open.push(ledger);
    return ledger;
  };
  const inFile = (): string[] => Object.keys(JSON.parse(readFileSync(file, "utf8")) as object).sort();

  it("claims from jobs that interleave, with an expiry sweep between them, keep every live record and drop only the expired", async () => {
    const ledger = ledgerAt();
    const soon = new Date(nowMs + 60_000).toISOString();
    const later = new Date(nowMs + 3_600_000).toISOString();
    const hold = gate();
    // Job one claims, then waits (its job runs); job two claims while it waits; job three claims after the first one's id has expired.
    const one = (async () => {
      expect(ledger.claim(ids[0]!, soon)).toBe(true);
      await hold.promise;
      expect(ledger.claim(ids[1]!, later)).toBe(false);
      expect(ledger.claim(ids[2]!, later)).toBe(false);
    })();
    const two = (async () => {
      await tick();
      expect(ledger.claim(ids[1]!, later)).toBe(true);
      expect(inFile()).toEqual([ids[0]!, ids[1]!].sort());
    })();
    await two;
    expect(ledger.claim(ids[0]!, soon)).toBe(false); // a replay of job one's signed job while it runs is refused
    nowMs += 120_000; // the first id is now past its life: the next claim sweeps it
    expect(ledger.claim(ids[2]!, later)).toBe(true);
    expect(inFile()).toEqual([ids[1]!, ids[2]!].sort());
    hold.open();
    await one;
    expect(ledger.claim(ids[1]!, later)).toBe(false);
    expect(ledger.claim(ids[2]!, later)).toBe(false);
  });

  it("many claims from many overlapping jobs all land in the file, once each, and a restart knows every one", async () => {
    const ledger = ledgerAt();
    const results = await Promise.all(
      ids.map(async (id, n) => {
        for (let i = 0; i < n; i++) await tick();
        return [ledger.claim(id, new Date(nowMs + 3_600_000).toISOString()), ledger.claim(id)] as const;
      }),
    );
    expect(results.every(([first, again]) => first && !again)).toBe(true);
    expect(inFile()).toEqual([...ids].sort());
    ledger.close();
    const restarted = ledgerAt();
    for (const id of ids) expect(restarted.claim(id)).toBe(false);
    expect(restarted.claim(ids[3]!)).toBe(false);
  });
});

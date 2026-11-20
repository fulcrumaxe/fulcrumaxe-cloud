import { describe, expect, it } from "vitest";
import { ClaimMessage, HOST_LOAD_MAX_MB, MACHINE_ONBOARDING_MIN_PROTOCOL } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient } from "../../src/daemon/client.js";
import { HOST_LOAD_MIN_INTERVAL_SECONDS, createHostLoadReporter } from "../../src/daemon/hostLoad.js";
import type { ResourceReading } from "../../src/daemon/resources.js";
import { generateRunnerKey } from "../../src/keys.js";

const T0 = Date.UTC(2026, 10, 20, 12);
const GB = 1024 * 1024 * 1024;
const reading = (over: Partial<ResourceReading> = {}): ResourceReading => ({ totalMemBytes: 16 * GB, availMemBytes: 9 * GB, load1: 0, cores: 8, freeDiskBytes: 200 * GB, ...over });

function reporter(read: () => ResourceReading, setups: () => number = () => 1) {
  let now = T0;
  const r = createHostLoadReporter({ probe: { read }, setupsRunning: setups, now: () => new Date(now) });
  return { r, at: (ms: number) => void (now = T0 + ms) };
}

/** D#845 ON-1b: the runner sends the machine's load as three whole numbers, at most once a minute, and counts a send only once the cloud answered 200. */
describe("host load reporter", () => {
  it("reports memory and disk in whole megabytes (rounded down) and the setup count, nothing else", () => {
    const { r } = reporter(() => reading({ availMemBytes: 9 * GB + 1_500_000, freeDiskBytes: 200 * GB + 5 }));
    const next = r.next();
    expect(next?.load).toEqual({ mem_avail_mb: 9 * 1024 + 1, disk_free_mb: 200 * 1024, setups_running: 1 });
    expect(Object.keys(next!.load).sort()).toEqual(["disk_free_mb", "mem_avail_mb", "setups_running"]);
  });

  it("sends nothing again within the interval after a commit, and again at exactly the interval", () => {
    const { r, at } = reporter(() => reading());
    r.next()!.commit();
    for (const ms of [1, 30_000, HOST_LOAD_MIN_INTERVAL_SECONDS * 1000 - 1]) {
      at(ms);
      expect(r.next(), `${ms} ms`).toBeUndefined();
    }
    at(HOST_LOAD_MIN_INTERVAL_SECONDS * 1000);
    expect(r.next()).toBeDefined();
  });

  it("an uncommitted block is offered again at once", () => {
    const { r } = reporter(() => reading());
    expect(r.next()).toBeDefined();
    expect(r.next()).toBeDefined();
  });

  it("sends nothing when the disk cannot be read, a reading throws, or a number is not finite", () => {
    expect(reporter(() => reading({ freeDiskBytes: undefined })).r.next()).toBeUndefined();
    expect(reporter(() => { throw new Error("boom"); }).r.next()).toBeUndefined();
    expect(reporter(() => reading(), () => { throw new Error("boom"); }).r.next()).toBeUndefined();
    expect(reporter(() => reading({ availMemBytes: Number.NaN })).r.next()).toBeUndefined();
    expect(reporter(() => reading({ freeDiskBytes: Number.POSITIVE_INFINITY })).r.next()).toBeUndefined();
  });

  it("clamps an enormous disk to the protocol's cap, floors a negative reading at zero, and refuses a setup count over the cap", () => {
    expect(reporter(() => reading({ freeDiskBytes: 1e30 })).r.next()?.load.disk_free_mb).toBe(HOST_LOAD_MAX_MB);
    expect(reporter(() => reading({ availMemBytes: -5 })).r.next()?.load.mem_avail_mb).toBe(0);
    expect(reporter(() => reading(), () => 1001).r.next()).toBeUndefined();
    expect(reporter(() => reading(), () => 1.5).r.next()).toBeUndefined();
  });
});

describe("the claim carries the host load", () => {
  function claimWith(opts: { protocolVersion?: number; status?: number; withReporter?: boolean }) {
    const seen: unknown[] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(opts.status === 429 ? { retry_after: 4 } : { retry_after: 60 }), { status: opts.status ?? 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const hostLoad = createHostLoadReporter({ probe: { read: () => reading() }, setupsRunning: () => 0, now: () => new Date(T0) });
    const client = createRunnerClient({ origin: "https://cloud.example.test", key: generateRunnerKey(), now: () => new Date(T0), fetchFn, ...(opts.withReporter === false ? {} : { hostLoad }), ...(opts.protocolVersion === undefined ? {} : { protocolVersion: opts.protocolVersion }) });
    return { client, seen };
  }
  const LOAD = { host_load: { mem_avail_mb: 9216, disk_free_mb: 204800, setups_running: 0 } };

  it("an ordinary claim carries the block once, then leaves it off within the interval", async () => {
    const { client, seen } = claimWith({});
    await client.claim();
    await client.claim();
    expect(seen).toEqual([LOAD, {}]);
    expect(ClaimMessage.safeParse(seen[0]).success).toBe(true);
  });

  it("a claim the cloud did not accept (429) does not count as sent", async () => {
    const { client, seen } = claimWith({ status: 429 });
    await client.claim();
    await client.claim();
    expect(seen).toEqual([LOAD, LOAD]);
  });

  it("a status poll sends no block and does not use up its send", async () => {
    const { client, seen } = claimWith({});
    await client.claim("bwrap_missing");
    await client.claim();
    expect(seen).toEqual([{ sandbox_unavailable: "bwrap_missing" }, LOAD]);
  });

  it("a runner that declared protocol 21, or has no reporter (it did not advertise project_setup_v1), sends nothing", async () => {
    const old = claimWith({ protocolVersion: MACHINE_ONBOARDING_MIN_PROTOCOL - 1 });
    await old.client.claim();
    expect(old.seen).toEqual([{}]);
    const none = claimWith({ withReporter: false });
    await none.client.claim();
    expect(none.seen).toEqual([{}]);
  });
});

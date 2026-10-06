import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import {
  API_SWEEP_KICK_BODY,
  API_SWEEP_KICK_HEADER,
  KICK_COOLDOWN_MS,
  KICK_DELAY_MS,
  apiSweepKickerFromEnv,
  apiSweepKickKey,
  createApiSweepKicker,
  type SweepSummary,
} from "@fx/webhooks";
import { apiSweepKickHandler } from "../app/api/cron/api-sweep/handler";

/**
 * D#454 H3c: the api-sweep kick sender talking to the kick handler over a real HTTP connection (Node's fetch and
 * http server, not a hand-called stub), the way a writer's process reaches the sweep route. TLS is the platform's:
 * the production URL is https and the sender refuses redirects; this local hop is plain http (a gap the PR names).
 */
const CRON_SECRET = "cron-secret-for-the-kick-test";
const KEY = apiSweepKickKey(CRON_SECRET);
const SUMMARY: SweepSummary = { fanOut: { eventsProcessed: 1, deliveriesCreated: 1 }, sent: { claimed: 0, succeeded: 0, failed: 0, dead: 0 }, disabledEndpoints: [], purged: {} };

let server: Server;
let url: string;
let swept = 0;
const statuses: number[] = [];
const scheduled: Array<Promise<unknown>> = [];
const received: Array<{ method: string; contentType: string | undefined; header: string | undefined; body: string }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      received.push({ method: req.method ?? "", contentType: req.headers["content-type"], header: req.headers[API_SWEEP_KICK_HEADER] as string | undefined, body });
      const request = new Request(url, { method: req.method, headers: { [API_SWEEP_KICK_HEADER]: String(req.headers[API_SWEEP_KICK_HEADER] ?? "") }, body });
      void apiSweepKickHandler(
        request,
        { cronSecret: CRON_SECRET, schedule: (work) => scheduled.push(work), sweepDeps: () => ({ cronSecret: "", platformOpsPool: {} as never, sender: { send: async () => ({ ok: true, statusCode: 200 }) } }) },
        async () => {
          swept += 1;
          return SUMMARY;
        },
        async () => null,
      ).then((r) => {
        statuses.push(r.status);
        res.writeHead(r.status).end();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/cron/api-sweep`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
afterEach(() => {
  received.length = 0;
  statuses.length = 0;
  scheduled.length = 0;
  swept = 0;
});

describe("the api-sweep kick over a real connection", () => {
  it("is accepted with the right secret: a POST with the fixed body and a fresh signature gets a 202", async () => {
    const sleep = vi.fn(async () => {});
    const kicker = createApiSweepKicker({ url, secret: KEY, sleep });
    await kicker.kick();
    expect(sleep).toHaveBeenCalledWith(KICK_DELAY_MS); // waits for the enqueuing transaction to commit
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ method: "POST", contentType: "application/json", body: API_SWEEP_KICK_BODY });
    expect(received[0]!.header).toMatch(/^t=\d+,sig=[0-9a-f]{64}$/);
    expect(statuses).toEqual([202]);
    await Promise.all(scheduled);
    expect(swept).toBe(1); // and the sweep ran: the kick is what starts it, with no marker involved
  });

  it("is refused (a bare 401, nothing scheduled) with the wrong secret, and the sender swallows the refusal", async () => {
    const kicker = createApiSweepKicker({ url, secret: "wrong", sleep: async () => {} });
    await expect(kicker.kick()).resolves.toBeUndefined();
    expect(received).toHaveLength(1);
    expect(statuses).toEqual([401]);
    expect(scheduled).toHaveLength(0);
    expect(swept).toBe(0);
  });

  it("sends at most one kick per cooldown per process", async () => {
    let now = 1_800_000_000_000;
    const kicker = createApiSweepKicker({ url, secret: KEY, sleep: async () => {}, now: () => now });
    await kicker.kick();
    await kicker.kick();
    expect(received).toHaveLength(1);
    now += KICK_COOLDOWN_MS;
    await kicker.kick();
    expect(received).toHaveLength(2);
  });

  it("does not follow a redirect (a protected deployment answers with one) and never throws", async () => {
    const redirector = createServer((_req, res) => res.writeHead(307, { location: "https://elsewhere.invalid/" }).end());
    await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve));
    const target = `http://127.0.0.1:${(redirector.address() as AddressInfo).port}/api/cron/api-sweep`;
    await expect(createApiSweepKicker({ url: target, secret: KEY, sleep: async () => {} }).kick()).resolves.toBeUndefined();
    await new Promise<void>((resolve) => redirector.close(() => resolve()));
  });

  it("an unreachable origin is swallowed too, and reported once with a fixed stage", async () => {
    const reportError = vi.fn();
    await expect(createApiSweepKicker({ url: "http://127.0.0.1:1/api/cron/api-sweep", secret: KEY, sleep: async () => {}, reportError }).kick()).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), "api_sweep_kick.send");
  });

  it("a malformed kick URL is reported as a setting mistake and gives no kicker", () => {
    const reportError = vi.fn();
    expect(apiSweepKickerFromEnv({ RUN_ACTION_KICK_URL: "not a url", CRON_SECRET }, reportError)).toBeNull();
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), "api_sweep_kick.config");
  });
});

describe("apiSweepKickerFromEnv", () => {
  const KICK_URL = "https://x.test/api/internal/run-actions/kick";

  it("needs the run-action kick URL (https) and the cron secret, and nothing else", () => {
    expect(apiSweepKickerFromEnv({})).toBeNull();
    expect(apiSweepKickerFromEnv({ RUN_ACTION_KICK_URL: KICK_URL })).toBeNull();
    expect(apiSweepKickerFromEnv({ CRON_SECRET: CRON_SECRET })).toBeNull();
    expect(apiSweepKickerFromEnv({ RUN_ACTION_KICK_URL: "not a url", CRON_SECRET })).toBeNull();
    expect(apiSweepKickerFromEnv({ RUN_ACTION_KICK_URL: "http://x.test/api/internal/run-actions/kick", CRON_SECRET })).toBeNull(); // never over plain http
    expect(apiSweepKickerFromEnv({ RUN_ACTION_KICK_URL: KICK_URL, CRON_SECRET })).not.toBeNull();
  });

  it("calls the sweep route on the kick URL's origin, and the cron secret itself never leaves the process", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
      return new Response(null, { status: 202 });
    }) as never);
    try {
      const kicker = apiSweepKickerFromEnv({ RUN_ACTION_KICK_URL: KICK_URL, CRON_SECRET })!;
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      const sent = kicker.kick();
      await vi.advanceTimersByTimeAsync(KICK_DELAY_MS);
      await sent;
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("https://x.test/api/cron/api-sweep");
      expect(JSON.stringify(calls[0])).not.toContain(CRON_SECRET);
      expect(calls[0]!.headers[API_SWEEP_KICK_HEADER]).toMatch(/^t=\d+,sig=[0-9a-f]{64}$/);
    } finally {
      vi.useRealTimers();
      fetchSpy.mockRestore();
    }
  });

  it("derives a different key from different cron secrets, and none from an empty one", () => {
    expect(apiSweepKickKey("a")).not.toBe(apiSweepKickKey("b"));
    expect(apiSweepKickKey("a")).not.toBe("a");
    expect(apiSweepKickKey("")).toBe("");
  });
});

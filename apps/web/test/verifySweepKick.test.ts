import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  KICK_COOLDOWN_MS,
  KICK_DELAY_MS,
  VERIFY_SWEEP_KICK_BODY,
  VERIFY_SWEEP_KICK_HEADER,
  createVerifySweepKicker,
  verifySweepKickKey,
} from "@fx/webhooks";
import { proposalVerifySweepKickHandler, type ProposalVerifySweepKickDeps } from "../app/api/cron/proposal-verify-sweep/handler";
import type { ProposalVerifySweepWorker } from "../lib/worker";

/**
 * The verify-sweep kick sender talking to the kick handler over a real HTTP connection (Node's fetch and an http server, not a hand-called stub), the way a
 * writer's process reaches the sweep route. TLS is the platform's: the production URL is https and the sender refuses redirects; this local hop is plain
 * http (a gap the PR names). Modelled on apiSweepKick.test.ts.
 */
const CRON_SECRET = "cron-secret-for-the-verify-kick-test";
const KEY = verifySweepKickKey(CRON_SECRET);

let server: Server;
let url: string;
let verified = 0;
const statuses: number[] = [];
const scheduled: Array<Promise<unknown>> = [];
const received: Array<{ method: string; contentType: string | undefined; header: string | undefined; body: string }> = [];

const worker = {
  sweepDiscoverySchedule: async () => ({ more: false }),
  sweepDiscoveryQueue: async () => ({ more: false }),
  sweepProposalVerification: async () => ({ listed: 0 }),
  sweepDocsCodeAnalysis: async () => ({ listed: 0 }),
  sweepVerifyStage: async () => {
    verified += 1;
    return { active: 0 };
  },
  sweepAutoStart: async () => ({ started: 0, failed: 0 }),
} as unknown as ProposalVerifySweepWorker;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      received.push({ method: req.method ?? "", contentType: req.headers["content-type"], header: req.headers[VERIFY_SWEEP_KICK_HEADER] as string | undefined, body });
      const request = new Request(url, { method: req.method, headers: { [VERIFY_SWEEP_KICK_HEADER]: String(req.headers[VERIFY_SWEEP_KICK_HEADER] ?? "") }, body });
      const deps: ProposalVerifySweepKickDeps = { cronSecret: CRON_SECRET, getWorker: async () => worker, log: () => {}, schedule: (work) => void scheduled.push(work) };
      void proposalVerifySweepKickHandler(request, deps).then((r) => {
        statuses.push(r.status);
        res.writeHead(r.status).end();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/cron/proposal-verify-sweep`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
afterEach(() => {
  received.length = 0;
  statuses.length = 0;
  scheduled.length = 0;
  verified = 0;
});

describe("the verify-sweep kick over a real connection", () => {
  it("is accepted with the right key: a POST with the fixed body and a fresh signature gets a 202 and the pass runs", async () => {
    const sleep = vi.fn(async () => {});
    await createVerifySweepKicker({ url, secret: KEY, sleep }).kick();
    expect(sleep).toHaveBeenCalledWith(KICK_DELAY_MS); // waits for the writing transaction to commit
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ method: "POST", contentType: "application/json", body: VERIFY_SWEEP_KICK_BODY });
    expect(received[0]!.header).toMatch(/^t=\d+,sig=[0-9a-f]{64}$/);
    expect(statuses).toEqual([202]);
    await Promise.all(scheduled);
    expect(verified).toBe(1); // the kick is what starts the pass, with no marker involved
  });

  it("is refused (a bare 401, nothing scheduled) with the wrong key, and the sender swallows the refusal", async () => {
    await expect(createVerifySweepKicker({ url, secret: "wrong", sleep: async () => {} }).kick()).resolves.toBeUndefined();
    expect(received).toHaveLength(1);
    expect(statuses).toEqual([401]);
    expect(scheduled).toHaveLength(0);
    expect(verified).toBe(0);
  });

  it("sends at most one kick per cooldown per process", async () => {
    let now = 1_800_000_000_000;
    const kicker = createVerifySweepKicker({ url, secret: KEY, sleep: async () => {}, now: () => now });
    await kicker.kick();
    await kicker.kick();
    expect(received).toHaveLength(1);
    now += KICK_COOLDOWN_MS;
    await kicker.kick();
    expect(received).toHaveLength(2);
    await Promise.all(scheduled);
  });

  it("does not follow a redirect (a protected deployment answers with one), never throws, and reports it", async () => {
    let followed = 0;
    const elsewhere = createServer((_req, res) => {
      followed += 1;
      res.writeHead(200).end();
    });
    await new Promise<void>((resolve) => elsewhere.listen(0, "127.0.0.1", resolve));
    const redirector = createServer((_req, res) => res.writeHead(307, { location: `http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}/` }).end());
    await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve));
    const target = `http://127.0.0.1:${(redirector.address() as AddressInfo).port}/api/cron/proposal-verify-sweep`;
    const reportError = vi.fn();
    await expect(createVerifySweepKicker({ url: target, secret: KEY, sleep: async () => {}, reportError }).kick()).resolves.toBeUndefined();
    expect(followed).toBe(0); // the signed request never reaches the redirect target
    expect(reportError).toHaveBeenCalledTimes(1);
    await new Promise<void>((resolve) => redirector.close(() => resolve()));
    await new Promise<void>((resolve) => elsewhere.close(() => resolve()));
  });

  it("an unreachable origin is swallowed too, and reported once with a fixed stage", async () => {
    const reportError = vi.fn();
    await expect(createVerifySweepKicker({ url: "http://127.0.0.1:1/api/cron/proposal-verify-sweep", secret: KEY, sleep: async () => {}, reportError }).kick()).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), "verify_sweep_kick.send");
  });
});

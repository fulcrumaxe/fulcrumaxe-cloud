import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaimReply, DoneReply, EventsReply, HeartbeatReply, SeqNotIncreasingReply, StopReply, signRequest, type LocalOnlyEvent } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient, type RunnerClient } from "../../src/daemon/client.js";
import { generateRunnerKey, type RunnerKey } from "../../src/keys.js";
import { signedJob } from "../helpers/signedJob.js";
import { retryBody, startStrictRunnerCloud, stopBody, type StrictRunnerCloud } from "../helpers/strictRunnerCloud.js";

let cloud: StrictRunnerCloud;
let key: RunnerKey;
let client: RunnerClient;

beforeEach(async () => {
  cloud = await startStrictRunnerCloud();
  key = generateRunnerKey();
  cloud.trust(key.publicJwk);
  client = createRunnerClient({ origin: cloud.origin, key, now: () => new Date(), fetchFn: fetch });
});
afterEach(() => cloud.close());

const event = (seq: number): LocalOnlyEvent => ({ seq, ts: "2026-10-08T12:00:00.000Z", type: "tool_use", tool_name: "Read" });
/** Claims one job so the run exists on the strict cloud, and returns its claim. */
async function claimOne() {
  cloud.enqueue(signedJob());
  const claimed = await client.claim();
  if (claimed.kind !== "claimed") throw new Error("expected a claim");
  return claimed;
}

describe("the strict fake cloud itself refuses what the protocol does not allow", () => {
  async function raw(path: string, body: unknown, over: { method?: string; signKey?: RunnerKey } = {}) {
    const text = JSON.stringify(body);
    const url = `${cloud.origin}${path}`;
    const headers = signRequest({ method: "POST", url, body: text, privateKey: (over.signKey ?? key).privateKey, keyid: (over.signKey ?? key).jkt, nonce: `n${Math.random().toString(36).slice(2)}abcdefgh`, created: Math.floor(Date.now() / 1000) });
    return fetch(url, { method: over.method ?? "POST", headers: { "content-type": "application/json", ...headers }, ...(over.method === "GET" ? {} : { body: text }) });
  }
  it("an unlisted key in any message is 400, and a signature from an unregistered key is 401", async () => {
    const run = (await claimOne()).runId;
    expect((await raw("/api/runner/claim", { extra: 1 })).status).toBe(400);
    expect((await raw("/api/runner/heartbeat", { run_id: run, lease_generation: 1, extra: 1 })).status).toBe(400);
    expect((await raw("/api/runner/heartbeat", { run_id: run, lease_generation: 1 }, { signKey: generateRunnerKey() })).status).toBe(401);
    expect((await raw("/api/runner/other", {})).status).toBe(404);
  });
  it("a reused nonce on claim is 409", async () => {
    const text = "{}";
    const url = `${cloud.origin}/api/runner/claim`;
    const headers = signRequest({ method: "POST", url, body: text, privateKey: key.privateKey, keyid: key.jkt, nonce: "x".repeat(22), created: Math.floor(Date.now() / 1000) });
    const send = () => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: text });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(409);
  });
});

describe("claim", () => {
  it("an empty queue is idle with the cloud's retry_after, and sends an empty body", async () => {
    expect(await client.claim()).toEqual({ kind: "idle", retryAfter: 60 });
    expect(cloud.seen[0]).toMatchObject({ path: "/api/runner/claim", body: {} });
  });

  it("a queued job comes back as the signed job, its run id and the lease generation", async () => {
    const signed = signedJob();
    cloud.enqueue(signed);
    expect(await client.claim()).toEqual({ kind: "claimed", signedJob: signed, runId: signed.job.run_id, leaseGeneration: 1 });
  });

  it("a second claim of the same run (after a lease was lost) has the next generation", async () => {
    const signed = signedJob();
    cloud.enqueue(signed);
    cloud.enqueue(signed);
    expect(await client.claim()).toMatchObject({ leaseGeneration: 1 });
    expect(await client.claim()).toMatchObject({ leaseGeneration: 2 });
  });

  it("429 with retry_after is rate_limited", async () => {
    cloud.force.claim.push({ status: 429, body: { retry_after: 3 } });
    expect(await client.claim()).toEqual({ kind: "rate_limited", retryAfter: 3 });
  });

  it("refuses a claim whose run_id is not the signed job's, with nothing to run", async () => {
    const signed = signedJob();
    const reply = { signed_job: signed, run_id: "11111111-1111-4111-8111-111111111111", lease_generation: 1 };
    expect(ClaimReply.safeParse(reply).success).toBe(false);
    cloud.force.claim.push({ status: 200, body: reply });
    expect(await client.claim()).toEqual({ kind: "error", status: 200, code: "invalid_reply" });
  });

  it("refuses replies the schemas do not describe: an extra key, a missing generation, a 429 with an error body, not JSON", async () => {
    const signed = signedJob();
    for (const forced of [
      { status: 200, body: { signed_job: signed, run_id: signed.job.run_id, lease_generation: 1, token: "x" } },
      { status: 200, body: { signed_job: signed, run_id: signed.job.run_id } },
      { status: 200, body: { retry_after: 60, run_id: signed.job.run_id } },
      { status: 200, body: { retry_after: 0 } },
      { status: 429, body: { retry_after: 99 } },
      { status: 200, body: "nope" },
    ]) {
      cloud.force.claim.push(forced);
      expect(await client.claim(), JSON.stringify(forced.body).slice(0, 40)).toMatchObject({ kind: "error", code: "invalid_reply" });
    }
  });

  it("reports the server's short error word and the status, and 0 when the cloud cannot be reached", async () => {
    cloud.force.claim.push({ status: 401, body: { error: { code: "unauthorized", message: "x" } } });
    expect(await client.claim()).toEqual({ kind: "error", status: 401, code: "unauthorized" });
    const down = createRunnerClient({ origin: "http://127.0.0.1:1", key, now: () => new Date(), fetchFn: fetch });
    expect(await down.claim()).toEqual({ kind: "error", status: 0 });
  });
});

describe("heartbeat", () => {
  it("a held run is ok with the lease end; the body is exactly run_id and lease_generation", async () => {
    const { runId, leaseGeneration } = await claimOne();
    const reply = await client.heartbeat(runId, leaseGeneration);
    expect(reply.kind).toBe("ok");
    expect(HeartbeatReply.safeParse({ continue: true, lease_expires_at: (reply as { leaseExpiresAt: string }).leaseExpiresAt }).success).toBe(true);
    expect(cloud.seen.at(-1)).toMatchObject({ path: "/api/runner/heartbeat", body: { run_id: runId, lease_generation: leaseGeneration } });
  });

  it("the generation is sent back as claimed: a stale one is a stop", async () => {
    const { runId, leaseGeneration } = await claimOne();
    expect(await client.heartbeat(runId, leaseGeneration + 1)).toEqual({ kind: "stop", reason: "stale_generation" });
  });

  it("each stop reason comes back as the stop", async () => {
    const { runId, leaseGeneration } = await claimOne();
    for (const reason of ["lease_expired", "run_terminal", "wall_clock_limit"] as const) {
      cloud.force.heartbeat.push(stopBody(reason));
      expect(await client.heartbeat(runId, leaseGeneration)).toEqual({ kind: "stop", reason });
    }
  });

  it("a reply that fits no schema is an error: an unknown stop reason, or continue:true with no lease end", async () => {
    const { runId, leaseGeneration } = await claimOne();
    cloud.force.heartbeat.push({ status: 409, body: { continue: false, reason: "because" } });
    expect(await client.heartbeat(runId, leaseGeneration)).toMatchObject({ kind: "error", code: "invalid_reply" });
    cloud.force.heartbeat.push({ status: 200, body: { continue: true } });
    expect(await client.heartbeat(runId, leaseGeneration)).toMatchObject({ kind: "error", code: "invalid_reply" });
    expect(StopReply.safeParse({ continue: false, reason: "because" }).success).toBe(false);
  });
});

describe("events", () => {
  it("a batch is accepted and counted; the path names the run", async () => {
    const { runId, leaseGeneration } = await claimOne();
    const reply = await client.events(runId, leaseGeneration, [event(0), event(1)]);
    expect(reply).toMatchObject({ kind: "ok", accepted: 2, duplicates: 0 });
    expect(cloud.seen.at(-1)?.path).toBe(`/api/runner/runs/${runId}/events`);
    expect(EventsReply.safeParse({ continue: true, accepted: 2, duplicates: 0, lease_expires_at: (reply as { leaseExpiresAt: string }).leaseExpiresAt }).success).toBe(true);
  });

  it("a batch at or below the last accepted number is seq_not_increasing with that number, and nothing is stored", async () => {
    const { runId, leaseGeneration } = await claimOne();
    await client.events(runId, leaseGeneration, [event(0), event(1), event(2)]);
    expect(await client.events(runId, leaseGeneration, [event(2), event(3)])).toEqual({ kind: "seq_not_increasing", lastAcceptedSeq: 2 });
    expect(cloud.runs.get(runId)?.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(SeqNotIncreasingReply.safeParse({ continue: true, error: "seq_not_increasing", last_accepted_seq: 2 }).success).toBe(true);
  });

  it("a stop on events is a stop", async () => {
    const { runId, leaseGeneration } = await claimOne();
    cloud.stopRun(runId, "run_terminal");
    expect(await client.events(runId, leaseGeneration, [event(0)])).toEqual({ kind: "stop", reason: "run_terminal" });
  });
});

describe("done", () => {
  it("carries the session id and the envelope; the cloud's verdict comes back", async () => {
    const { runId, leaseGeneration } = await claimOne();
    const reply = await client.done({ runId, leaseGeneration, sessionId: "sess-1", agentOutput: { verdict: "pass" } });
    expect(reply).toEqual({ kind: "done", outcome: "succeeded", failureReason: null, prNumber: 7 });
    expect(cloud.seen.at(-1)).toMatchObject({ path: `/api/runner/runs/${runId}/done`, body: { run_id: runId, lease_generation: leaseGeneration, session_id: "sess-1", agentOutput: { verdict: "pass" } } });
    expect(DoneReply.safeParse({ continue: false, outcome: "succeeded", failure_reason: null, pr_number: 7 }).success).toBe(true);
  });

  it("a repeat done replays the stored outcome", async () => {
    const { runId, leaseGeneration } = await claimOne();
    const first = await client.done({ runId, leaseGeneration });
    expect(await client.done({ runId, leaseGeneration })).toEqual(first);
  });

  it("an envelope the protocol refuses (too deep) is left out and the done still goes", async () => {
    const { runId, leaseGeneration } = await claimOne();
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) deep = { deeper: deep };
    expect(await client.done({ runId, leaseGeneration, agentOutput: deep })).toMatchObject({ kind: "done" });
    expect(cloud.seen.at(-1)?.body).toEqual({ run_id: runId, lease_generation: leaseGeneration });
  });

  it("503 {retry_after} is a retry; 503 with an error body is an error, not a retry", async () => {
    const { runId, leaseGeneration } = await claimOne();
    cloud.githubDown = 1;
    expect(await client.done({ runId, leaseGeneration })).toEqual({ kind: "retry", retryAfter: 15 });
    cloud.force.done.push({ status: 503, body: { error: { code: "not_configured", message: "x" } } });
    expect(await client.done({ runId, leaseGeneration })).toEqual({ kind: "error", status: 503, code: "not_configured" });
    cloud.force.done.push(retryBody(30));
    expect(await client.done({ runId, leaseGeneration })).toEqual({ kind: "retry", retryAfter: 30 });
  });
});

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLAIM_REPLY_ENVELOPE_BYTES, ClaimReply, MAX_CLAIM_REPLY_BYTES } from "@fulcrumaxe/runner-protocol";
import { replyCapFor } from "../../src/cloud.js";
import { createRunnerClient, type RunnerClient } from "../../src/daemon/client.js";
import { generateRunnerKey, type RunnerKey } from "../../src/keys.js";
import { largestSignedJob } from "../helpers/largestJob.js";
import { signedJob } from "../helpers/signedJob.js";
import { startStrictRunnerCloud, type StrictRunnerCloud } from "../helpers/strictRunnerCloud.js";

/** D#6 RUNNER-REPLY-CAP: a claim reply carries the whole signed job, so the runner must read as much as the schema lets a job hold, and no more. */
const OLD_CAP = 64 * 1024;

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

describe("a claim reply is read up to the largest job the schema allows", () => {
  it("claims the largest valid job whole, over HTTP, and the bound holds it with room to spare", async () => {
    const signed = largestSignedJob();
    const size = Buffer.byteLength(JSON.stringify(ClaimReply.parse({ signed_job: signed, run_id: signed.job.run_id, lease_generation: 2_147_483_647 })), "utf8");
    // The real maximum, for the PR to quote.
    console.log(`largest valid claim reply: ${size} bytes; read cap: ${MAX_CLAIM_REPLY_BYTES} bytes; old cap: ${OLD_CAP} bytes`);
    expect(size).toBeGreaterThan(OLD_CAP * 8);
    expect(size).toBeLessThanOrEqual(MAX_CLAIM_REPLY_BYTES);
    // The fixed-shape fields are well inside the envelope headroom, so the bound is not just barely enough.
    expect(MAX_CLAIM_REPLY_BYTES - size).toBeGreaterThan(32 * 1024);

    cloud.enqueue(signed);
    expect(await client.claim()).toEqual({ kind: "claimed", signedJob: signed, runId: signed.job.run_id, leaseGeneration: 1 });
  });

  it("claims a job whose Spec alone is past the old cap (the case a Spec author could hit)", async () => {
    const text = "a".repeat(100 * 1024);
    const signed = signedJob({ spec: { discussion: 1, version: 1, sha256: "0".repeat(64), text } });
    cloud.enqueue(signed);
    expect(await client.claim()).toMatchObject({ kind: "claimed", runId: signed.job.run_id });
  });

  it("still refuses a reply bigger than any valid job could be: the cap is hard, not unbounded", async () => {
    // A valid idle reply behind whitespace that fills the whole cap: read to the end it would parse, cut at the cap it does not.
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(`${" ".repeat(MAX_CLAIM_REPLY_BYTES)}{"retry_after":60}`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const loose = createRunnerClient({ origin: `http://127.0.0.1:${port}`, key, now: () => new Date(), fetchFn: fetch });
      expect(await loose.claim()).toEqual({ kind: "error", status: 200, code: "invalid_reply" });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("leaves envelope room for the fixed-shape fields: more than a plain reply, many times over", () => {
    const plain = signedJob();
    const plainSize = Buffer.byteLength(JSON.stringify(ClaimReply.parse({ signed_job: plain, run_id: plain.job.run_id, lease_generation: 1 })), "utf8");
    expect(CLAIM_REPLY_ENVELOPE_BYTES).toBeGreaterThanOrEqual(plainSize * 16);
  });

  it("keeps the small cap for every route that is not the claim", () => {
    expect(replyCapFor("/api/runner/claim")).toBe(MAX_CLAIM_REPLY_BYTES);
    for (const path of ["/api/runner/hello", "/api/runner/heartbeat", "/api/runner/runs/x/events", "/api/runner/runs/x/done", "/api/runner/wake"]) {
      expect(replyCapFor(path), path).toBe(OLD_CAP);
    }
  });
});

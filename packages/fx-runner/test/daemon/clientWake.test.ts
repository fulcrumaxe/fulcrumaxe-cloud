import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURRENT_PROTOCOL_VERSION, HelloMessage, signRequest, type HelloMessage as HelloMessageType } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient, type RunnerClient } from "../../src/daemon/client.js";
import { generateRunnerKey, type RunnerKey } from "../../src/keys.js";
import { RUNNER_BUILD_CAPABILITIES } from "../../src/version.js";
import { signedJob } from "../helpers/signedJob.js";
import { startStrictRunnerCloud, type StrictRunnerCloud } from "../helpers/strictRunnerCloud.js";

/** D#6 RUNNER-WAKE: the client's half of the wake contract, over real HTTP against the strict fake. */
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

const hello: HelloMessageType = { protocol_version: CURRENT_PROTOCOL_VERSION, binary_version: "1.0.0", model_auth_present: false, isolation: "host_sandbox", capabilities: RUNNER_BUILD_CAPABILITIES };
const hellos = () => cloud.seen.filter((s) => s.path === "/api/runner/hello").map((s) => HelloMessage.parse(s.body));

describe("hello", () => {
  it("advertises wake_v1 and brings back the grant a wake-enabled cloud sends", async () => {
    cloud.wake.enabled = true;
    const reply = await client.hello(hello);
    expect(reply).toMatchObject({ kind: "ok", wake: { poll_s: 20, transport: "poll" } });
    expect(hellos()[0]!.capabilities).toContain("wake_v1");
  });

  it("an older cloud that refuses wake_v1 is asked again without it, and the runner carries on with no grant", async () => {
    cloud.wake.oldCloud = true;
    cloud.wake.enabled = true;
    expect(await client.hello(hello)).toEqual({ kind: "ok", dropped: ["plane_merge_queue_v1", "memory_limit_v1", "plane_merge_v1", "wake_v1"] });
    const sent = hellos();
    // Four steps: the newest capability goes first, and wake_v1 only when the others do not help.
    expect(sent).toHaveLength(5);
    expect(sent[0]!.capabilities).toEqual(["proposal_verifier", "wake_v1", "plane_merge_v1", "memory_limit_v1", "plane_merge_queue_v1"]);
    expect(sent[1]!.capabilities).toEqual(["proposal_verifier", "wake_v1", "plane_merge_v1", "memory_limit_v1"]);
    expect(sent[2]!.capabilities).toEqual(["proposal_verifier", "wake_v1", "plane_merge_v1"]);
    expect(sent[3]!.capabilities).toEqual(["proposal_verifier", "wake_v1"]);
    expect(sent[4]!.capabilities).toEqual(["proposal_verifier"]);
    // Claims work as before: idle with the cloud's retry_after, and no grant.
    expect(await client.claim()).toEqual({ kind: "idle", retryAfter: 60 });
  });

  it("a cloud that knows wake_v1 but not plane_merge_v1 keeps its wake grant: only plane_merge_v1 is dropped, in one retry", async () => {
    const sentCaps: string[][] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const caps = (JSON.parse(String(init.body)) as { capabilities?: string[] }).capabilities ?? [];
      sentCaps.push(caps);
      if (caps.includes("plane_merge_v1")) return new Response(JSON.stringify({ error: { code: "invalid_message", message: "x" } }), { status: 400, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ protocol_version: 1, wake: { token: `${"a".repeat(32)}.${"b".repeat(43)}`, poll_s: 20, transport: "poll" } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const middle = createRunnerClient({ origin: "https://cloud.example.test", key, now: () => new Date(), fetchFn });
    const reply = await middle.hello(hello);
    expect(sentCaps).toEqual([["proposal_verifier", "wake_v1", "plane_merge_v1", "memory_limit_v1", "plane_merge_queue_v1"], ["proposal_verifier", "wake_v1", "plane_merge_v1", "memory_limit_v1"], ["proposal_verifier", "wake_v1", "plane_merge_v1"], ["proposal_verifier", "wake_v1"]]);
    expect(reply).toMatchObject({ kind: "ok", wake: { poll_s: 20 }, dropped: ["plane_merge_queue_v1", "memory_limit_v1", "plane_merge_v1"] });
  });

  // D#6 CARD-OOM-CAUSE-WORDS: the capability is how the runner learns whether the cloud's strict parse knows `memory_limit_bytes`.
  it("a cloud that knows every capability but memory_limit_v1 and plane_merge_queue_v1 keeps the rest, in two retries, and the reply says both were dropped", async () => {
    const sentCaps: string[][] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const caps = (JSON.parse(String(init.body)) as { capabilities?: string[] }).capabilities ?? [];
      sentCaps.push(caps);
      if (caps.includes("memory_limit_v1")) return new Response(JSON.stringify({ error: { code: "invalid_message", message: "x" } }), { status: 400, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ protocol_version: 1, wake: { token: `${"a".repeat(32)}.${"b".repeat(43)}`, poll_s: 20, transport: "poll" } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const reply = await createRunnerClient({ origin: "https://cloud.example.test", key, now: () => new Date(), fetchFn }).hello(hello);
    expect(sentCaps).toEqual([["proposal_verifier", "wake_v1", "plane_merge_v1", "memory_limit_v1", "plane_merge_queue_v1"], ["proposal_verifier", "wake_v1", "plane_merge_v1", "memory_limit_v1"], ["proposal_verifier", "wake_v1", "plane_merge_v1"]]);
    expect(reply).toMatchObject({ kind: "ok", wake: { poll_s: 20 }, dropped: ["plane_merge_queue_v1", "memory_limit_v1"] });
  });

  // D#694 B7-1: the newest capability is dropped alone first, so a cloud that knows the others keeps them.
  it("a cloud that knows every capability but plane_merge_queue_v1 keeps the rest, in one retry, and the reply says the queue capability was dropped", async () => {
    const sentCaps: string[][] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const caps = (JSON.parse(String(init.body)) as { capabilities?: string[] }).capabilities ?? [];
      sentCaps.push(caps);
      if (caps.includes("plane_merge_queue_v1")) return new Response(JSON.stringify({ error: { code: "invalid_message", message: "x" } }), { status: 400, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ protocol_version: 1 }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const reply = await createRunnerClient({ origin: "https://cloud.example.test", key, now: () => new Date(), fetchFn }).hello(hello);
    expect(sentCaps).toEqual([["proposal_verifier", "wake_v1", "plane_merge_v1", "memory_limit_v1", "plane_merge_queue_v1"], ["proposal_verifier", "wake_v1", "plane_merge_v1", "memory_limit_v1"]]);
    expect(reply).toMatchObject({ kind: "ok", dropped: ["plane_merge_queue_v1"] });
  });

  it("a cloud that keeps memory_limit_v1 drops nothing: the reply has no dropped list", async () => {
    const reply = await client.hello(hello);
    expect(reply).toEqual({ kind: "ok" });
    expect(hellos()[0]!.capabilities).toContain("memory_limit_v1");
  });

  it("a hello refused for another reason is not retried", async () => {
    cloud.force.hello.push({ status: 404, body: { error: { code: "not_found", message: "not_found" } } });
    expect(await client.hello(hello)).toEqual({ kind: "error", status: 404, code: "not_found" });
    expect(hellos()).toHaveLength(1);
  });

  it("a cloud with no wake key sends no grant", async () => {
    expect(await client.hello(hello)).toEqual({ kind: "ok" });
  });
});

describe("claim", () => {
  it("idle and claimed replies carry a fresh grant once the hello asked for one", async () => {
    cloud.wake.enabled = true;
    const first = await client.hello(hello);
    const idle = await client.claim();
    expect(idle).toMatchObject({ kind: "idle", retryAfter: 60, wake: { poll_s: 20 } });
    cloud.enqueue(signedJob());
    const claimed = await client.claim();
    expect(claimed).toMatchObject({ kind: "claimed", wake: { poll_s: 20 } });
    const tokens = [first, idle, claimed].map((r) => (r as { wake: { token: string } }).wake.token);
    expect(new Set(tokens).size).toBe(3);
  });
});

describe("wake", () => {
  async function token(): Promise<string> {
    cloud.wake.enabled = true;
    const reply = await client.hello(hello);
    if (reply.kind !== "ok" || reply.wake === undefined) throw new Error("expected a grant");
    return reply.wake.token;
  }

  it("is a signed GET with the bearer token and Accept: application/json, answered {epoch, due_at}", async () => {
    const t = await token();
    cloud.wake.epoch = 1_792_756_800_000;
    cloud.wake.dueAt = null;
    expect(await client.wake(t)).toEqual({ kind: "wake", epoch: 1_792_756_800_000, dueAt: null });
    cloud.wake.dueAt = 1_792_756_900_000;
    expect(await client.wake(t)).toEqual({ kind: "wake", epoch: 1_792_756_800_000, dueAt: 1_792_756_900_000 });
    expect(cloud.seen.filter((s) => s.path === "/api/runner/wake")).toHaveLength(2);
  });

  it("a failing route, a token the cloud never minted, and an unreachable cloud are errors, never a wake", async () => {
    const t = await token();
    cloud.wake.failNext = 1;
    expect(await client.wake(t)).toEqual({ kind: "error", status: 503, code: "unavailable" });
    expect(await client.wake(`x.${"c".repeat(43)}`)).toEqual({ kind: "error", status: 401, code: "unauthorized" });
    const gone = createRunnerClient({ origin: "http://127.0.0.1:1", key, now: () => new Date(), fetchFn: fetch });
    expect(await gone.wake(t)).toEqual({ kind: "error", status: 0 });
  });

  it("a reply with anything but exactly the two numbers is invalid_reply", async () => {
    const t = await token();
    const odd = createRunnerClient({
      origin: cloud.origin,
      key,
      now: () => new Date(),
      fetchFn: (async () => new Response(JSON.stringify({ epoch: 1, due_at: null, run_id: "x" }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
    });
    expect(await odd.wake(t)).toEqual({ kind: "error", status: 200, code: "invalid_reply" });
  });

  it("the strict fake refuses what the wake contract does not allow: POST, another Accept, no token, an unsigned request", async () => {
    const t = await token();
    const url = `${cloud.origin}/api/runner/wake`;
    const signed = (method: string) => signRequest({ method, url, body: "", privateKey: key.privateKey, keyid: key.jkt, nonce: `n${Math.random().toString(36).slice(2)}abcdefgh`, created: Math.floor(Date.now() / 1000) });
    expect((await fetch(url, { method: "POST", headers: { ...signed("POST"), accept: "application/json", authorization: `Bearer ${t}` } })).status).toBe(405);
    expect((await fetch(url, { headers: { ...signed("GET"), accept: "text/event-stream", authorization: `Bearer ${t}` } })).status).toBe(406);
    expect((await fetch(url, { headers: { ...signed("GET"), accept: "application/json" } })).status).toBe(401);
    expect((await fetch(url, { headers: { accept: "application/json", authorization: `Bearer ${t}` } })).status).toBe(401);
    const stranger = generateRunnerKey();
    const foreign = signRequest({ method: "GET", url, body: "", privateKey: stranger.privateKey, keyid: stranger.jkt, nonce: "nforeignabcdefgh", created: Math.floor(Date.now() / 1000) });
    expect((await fetch(url, { headers: { ...foreign, accept: "application/json", authorization: `Bearer ${t}` } })).status).toBe(401);
  });
});

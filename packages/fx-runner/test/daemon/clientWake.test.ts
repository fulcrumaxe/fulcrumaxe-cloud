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
    expect(await client.hello(hello)).toEqual({ kind: "ok" });
    const sent = hellos();
    expect(sent).toHaveLength(2);
    expect(sent[0]!.capabilities).toEqual(["proposal_verifier", "wake_v1"]);
    expect(sent[1]!.capabilities).toEqual(["proposal_verifier"]);
    // Claims work as before: idle with the cloud's retry_after, and no grant.
    expect(await client.claim()).toEqual({ kind: "idle", retryAfter: 60 });
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

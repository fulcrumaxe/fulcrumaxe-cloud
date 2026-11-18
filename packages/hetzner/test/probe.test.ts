import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHetznerClient, createHetznerCredentialProbe, type HetznerTokenProbe } from "../src/index.js";
import { newWorld, startStrictHetzner, type FakeWorld, type StrictHetzner } from "./helpers/strictHetzner.js";

/** Generated per run, never a literal: a test token is random text of the right shape, not a value in the source. */
const fresh = (): string => randomBytes(32).toString("hex");
const TOKEN = fresh();
const READ_ONLY = fresh();
let fake: StrictHetzner;
let world: FakeWorld;
const prevEnv = process.env.NODE_ENV;
beforeAll(() => { process.env.NODE_ENV = "test"; });
afterAll(() => { process.env.NODE_ENV = prevEnv; });
beforeEach(async () => { world = newWorld([TOKEN, READ_ONLY]); world.readOnlyTokens = new Set([READ_ONLY]); fake = await startStrictHetzner(world); });
afterEach(async () => { await fake.close(); });

const probe = (): HetznerTokenProbe =>
  createHetznerCredentialProbe({ maxRetries: 0, timeoutMs: 2000, sleep: async () => undefined, now: () => world.clock.t, testTarget: { lookup: fake.lookup, port: fake.port, ca: fake.ca } });

describe("Hetzner credential probe", () => {
  it("reads, makes and deletes one fx-probe key, and counts the servers that do not carry our label", async () => {
    const c = createHetznerClient({ token: TOKEN, maxRetries: 0, testTarget: { lookup: fake.lookup, port: fake.port, ca: fake.ca } });
    await c.createServer({ name: "ours", serverType: "cx22", location: "fsn1", image: "ubuntu-24.04", idempotencyKey: "a1", labels: { "fx-managed": "1" } });
    await c.createServer({ name: "foreign-1", serverType: "cx22", location: "fsn1", image: "ubuntu-24.04", idempotencyKey: "a2" });
    await c.createServer({ name: "foreign-2", serverType: "cx22", location: "fsn1", image: "ubuntu-24.04", idempotencyKey: "a3", labels: { "fx-managed": "0" } });
    expect(world.servers).toHaveLength(3);
    world.requests.length = 0;
    const result = await probe().check(TOKEN);
    expect(result).toEqual({ verdict: "ok", unlabelledServers: 2 });
    const writes = world.requests.filter((r) => r.method !== "GET");
    expect(writes.map((r) => `${r.method} ${r.path.replace(/\d+$/, "<id>")}`)).toEqual(["POST /v1/ssh_keys", "DELETE /v1/ssh_keys/<id>"]);
    expect(JSON.parse(writes[0]!.body)).toMatchObject({ name: expect.stringMatching(/^fx-probe-[0-9a-f-]{36}$/), public_key: expect.stringMatching(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI/) });
    expect(world.sshKeys).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("the probe key carries the fx-probe=1 label, so a key a failed cleanup leaves behind can be found and removed by a later sweep", async () => {
    world.failNext.push({ method: "DELETE", status: 403, code: "forbidden" }, { method: "DELETE", status: 403, code: "forbidden" });
    expect(await probe().check(TOKEN)).toEqual({ verdict: "unreachable" });
    expect(world.sshKeys).toHaveLength(1);
    expect(world.sshKeys[0]).toMatchObject({ name: expect.stringMatching(/^fx-probe-/), labels: { "fx-probe": "1" } });
    expect(JSON.parse(world.requests.find((r) => r.method === "POST")!.body).labels).toEqual({ "fx-probe": "1" });
  });

  it("a 403 on the read itself is token_invalid (a token that cannot even read is no use), and nothing is written", async () => {
    world.failNext.push({ method: "GET", status: 403, code: "forbidden" });
    expect(await probe().check(TOKEN)).toEqual({ verdict: "invalid" });
    expect(world.requests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  it("an unknown token is invalid and nothing is written", async () => {
    expect(await probe().check("x".repeat(64))).toEqual({ verdict: "invalid" });
    expect(world.requests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  it("a token that cannot write is read_only, and leaves no key behind", async () => {
    expect(await probe().check(READ_ONLY)).toEqual({ verdict: "read_only" });
    expect(world.sshKeys).toEqual([]);
  });

  it("a key that was made but cannot be deleted is unreachable (a delete is a write too)", async () => {
    world.failNext.push({ method: "DELETE", status: 403, code: "forbidden" }, { method: "DELETE", status: 403, code: "forbidden" });
    expect(await probe().check(TOKEN)).toEqual({ verdict: "unreachable" });
  });

  it("an answer we cannot rely on is unreachable, never ok", async () => {
    world.failNext.push({ drop: true });
    expect(await probe().check(TOKEN)).toEqual({ verdict: "unreachable" });
    world.failNext.push({ status: 500, code: "server_error" });
    expect(await probe().check(TOKEN)).toEqual({ verdict: "unreachable" });
  });
});

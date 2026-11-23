import https from "node:https";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FAKE_LIMITS, HetznerError, createHetznerClient, emptyFakeState, fakeProviderAllowed, fakeProviderInProduction, handleFake } from "../src/index.js";
import { generateSelfSignedCert } from "../../webhooks/test/helpers/selfSignedCert.js";

/** D#845 MC-13a: the gates, and the REAL client (real TLS, real parse, real error handling) against the staging fake's handler served over a local TLS socket. */
const TOKEN = "fxtest-SENTINEL-token-0123456789abcdef";
const prevEnv = process.env.NODE_ENV;
beforeAll(() => { process.env.NODE_ENV = "test"; });
afterAll(() => { process.env.NODE_ENV = prevEnv; });
afterEach(() => vi.unstubAllEnvs());

describe("the three production refusals", () => {
  it("allows the fake only for FX_MACHINE_PROVIDER_FAKE=1 with FX_DEPLOY_KIND=staging", () => {
    expect(fakeProviderAllowed({ FX_MACHINE_PROVIDER_FAKE: "1", FX_DEPLOY_KIND: "staging" })).toBe(true);
    // Staging runs as the platform's production deployment, so that alone must not block it.
    expect(fakeProviderAllowed({ FX_MACHINE_PROVIDER_FAKE: "1", FX_DEPLOY_KIND: "staging", VERCEL_ENV: "production" })).toBe(true);
    for (const env of [{}, { FX_MACHINE_PROVIDER_FAKE: "1" }, { FX_DEPLOY_KIND: "staging" }, { FX_MACHINE_PROVIDER_FAKE: "true", FX_DEPLOY_KIND: "staging" }, { FX_MACHINE_PROVIDER_FAKE: "1", FX_DEPLOY_KIND: "production" }, { FX_MACHINE_PROVIDER_FAKE: "1", FX_DEPLOY_KIND: "local" }, { FX_MACHINE_PROVIDER_FAKE: "1", FX_DEPLOY_KIND: "Staging" }]) expect(fakeProviderAllowed(env)).toBe(false);
  });

  it("refuses the client's base-URL override unless staging opted in", () => {
    const make = () => createHetznerClient({ token: TOKEN, fakeBaseUrl: "https://staging.example/api/_fake/hetzner" });
    expect(make).toThrow(HetznerError);
    vi.stubEnv("FX_MACHINE_PROVIDER_FAKE", "1");
    expect(make).toThrow(/refused/);
    vi.stubEnv("FX_DEPLOY_KIND", "production");
    expect(make).toThrow(/refused/);
    vi.stubEnv("FX_DEPLOY_KIND", "staging");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(make).not.toThrow();
    for (const url of ["http://staging.example/x", "https://u:p@staging.example/x", "not a url"]) expect(() => createHetznerClient({ token: TOKEN, fakeBaseUrl: url })).toThrow(HetznerError);
  });

  it("names the switch on any deployment that is not staging, an unset kind included (the health code reads this)", () => {
    for (const env of [{ FX_DEPLOY_KIND: "production" }, { FX_DEPLOY_KIND: "local" }, {}, { VERCEL_ENV: "production" }]) {
      expect(fakeProviderInProduction({ ...env, FX_MACHINE_PROVIDER_FAKE: "1" })).toBe(true);
      expect(fakeProviderInProduction({ ...env, FX_MACHINE_PROVIDER_FAKE: "0" })).toBe(true);
      expect(fakeProviderInProduction(env)).toBe(false);
    }
    expect(fakeProviderInProduction({ FX_DEPLOY_KIND: "staging", FX_MACHINE_PROVIDER_FAKE: "1", VERCEL_ENV: "production" })).toBe(false);
  });
});

describe("the real client against the fake", () => {
  const state = emptyFakeState();
  let server: https.Server;
  let ca: string;
  let port: number;
  const requests: string[] = [];
  beforeAll(async () => {
    const { certPem, keyPem } = generateSelfSignedCert("api.hetzner.cloud", 1, { dnsNames: ["api.hetzner.cloud"] });
    ca = certPem;
    server = https.createServer({ cert: certPem, key: keyPem }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        requests.push(`${req.method} ${req.url}`);
        const raw = Buffer.concat(chunks).toString("utf8");
        const r = handleFake(state, req.method ?? "GET", new URL(req.url ?? "/", "https://x.invalid"), raw ? JSON.parse(raw) : {}, req.headers.authorization ?? null);
        res.writeHead(r.status, r.body === undefined ? {} : { "content-type": "application/json" });
        res.end(r.body === undefined ? undefined : JSON.stringify(r.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }));
  const client = (token = TOKEN) => createHetznerClient({ token, timeoutMs: 3000, maxRetries: 0, sleep: async () => undefined, testTarget: { lookup: async () => [{ address: "127.0.0.1", family: 4 }], port, ca } });
  const thrown = async (p: Promise<unknown>): Promise<HetznerError> => { try { await p; } catch (e) { if (e instanceof HetznerError) return e; throw e; } throw new Error("did not throw"); };
  const create = (key: string, name = `srv-${key}`) => ({ name, serverType: "cx22", location: "fsn1", image: "ubuntu-24.04", labels: { team: "a" }, idempotencyKey: key });

  it("reads the catalogue and prices as decimal strings", async () => {
    const c = client();
    expect((await c.listLocations()).map((l) => l.name)).toEqual(["fsn1", "nbg1"]);
    expect((await c.listServerTypes())[0]!.prices[0]).toMatchObject({ location: "fsn1", monthlyNet: "3.7900" });
    expect((await c.getPricing()).currency).toBe("EUR");
  });

  it("creates, lists by label, polls actions, and deletes a server; a firewall is created and deleted", async () => {
    const c = client();
    const fw = await c.createFirewall({ name: "fw-1", labels: { team: "a" }, rules: [{ direction: "in", protocol: "tcp", port: "22", sourceIps: ["0.0.0.0/0"] }] });
    const made = await c.createServer({ ...create("k1"), firewalls: [fw.id] });
    expect(made).toMatchObject({ reused: false, server: { name: "srv-k1", status: "initializing", ipv4: "203.0.113.7" } });
    expect(JSON.stringify(made)).not.toContain("SECRET");
    expect((await c.listServers({ labelSelector: "fx-create-key=k1" })).map((s) => s.id)).toEqual([made.server.id]);
    expect(await c.listServers({ labelSelector: "team=b" })).toEqual([]);
    expect((await c.createServer({ ...create("k1"), firewalls: [fw.id] })).reused).toBe(true);
    expect((await c.waitForAction(made.action!.id, { intervalMs: 0 })).status).toBe("success");
    expect((await c.getActions([made.action!.id]))[0]!.id).toBe(made.action!.id);
    expect(await thrown(c.deleteFirewall(fw.id))).toMatchObject({ code: "unavailable", extra: { status: 422, hetznerCode: "resource_in_use" } });
    expect((await c.deleteServer(made.server.id))!.command).toBe("delete_server");
    expect(await c.deleteServer(made.server.id)).toBeNull();
    expect(await c.deleteFirewall(fw.id)).toBe(true);
    expect(await c.deleteFirewall(fw.id)).toBe(false);
  });

  it("takes a snapshot through two action polls, then deletes the image", async () => {
    const c = client();
    const { server: s } = await c.createServer(create("k2"));
    const snap = await c.createSnapshot(s.id, { description: "park", idempotencyKey: "p1" });
    expect(snap.image.status).toBe("creating");
    await c.waitForAction(snap.action!.id, { intervalMs: 0 });
    expect((await c.getImage(snap.image.id)).status).toBe("available");
    expect(await c.deleteImage(snap.image.id)).toBe(true);
    await c.deleteServer(s.id);
  });

  it("starts a server initializing and shows it running on the next poll; keeps ssh keys", async () => {
    const c = client();
    const { server: s } = await c.createServer(create("k6"));
    expect((await c.getServer(s.id)).status).toBe("initializing");
    expect((await c.getServer(s.id)).status).toBe("running");
    await c.waitForServer(s.id, "running", { intervalMs: 0 });
    const key = await c.createSshKey({ name: "k", publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKEKEYFAKEKEY test", labels: { team: "a" } });
    expect((await c.listSshKeys({ fingerprint: key.fingerprint })).map((k) => k.id)).toEqual([key.id]);
    expect(await thrown(c.createSshKey({ name: "k2", publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKEKEYFAKEKEY test" }))).toMatchObject({ code: "uniqueness_error" });
    expect(await c.deleteSshKey(key.id)).toBe(true);
    expect(await c.deleteSshKey(key.id)).toBe(false);
    await c.deleteServer(s.id);
  });

  it("answers Hetzner's error shapes: 404, 409 uniqueness_error, 422 invalid_input, 401", async () => {
    const c = client();
    expect(await thrown(c.getServer(987654))).toMatchObject({ code: "not_found", extra: { status: 404 } });
    await c.createServer(create("k3", "taken"));
    expect(await thrown(c.createServer(create("k4", "taken")))).toMatchObject({ code: "uniqueness_error", extra: { status: 409 } });
    expect(await thrown(c.createServer({ ...create("k5"), image: 424242 }))).toMatchObject({ code: "invalid_input", extra: { status: 422 } });
    expect(await thrown(client("a".repeat(64)).verifyToken())).toMatchObject({ code: "unauthorized", extra: { status: 401 } });
    expect(JSON.stringify(state)).not.toContain(TOKEN);
  });
});

describe("the fake is bounded", () => {
  const AUTH = "Bearer fxtest-token-0123456789";
  const call = (st: ReturnType<typeof emptyFakeState>, method: string, path: string, body: Record<string, unknown> = {}) => handleFake(st, method, new URL(path, "https://x.invalid"), body, AUTH);
  const code = (r: { body?: unknown }) => (r.body as { error: { code: string } }).error.code;

  it("answers 403 resource_limit_exceeded past the cap of servers, firewalls, images and ssh keys", () => {
    const st = emptyFakeState();
    for (let i = 0; i < FAKE_LIMITS.servers; i++) expect(call(st, "POST", "/v1/servers", { name: `s${i}`, server_type: "cx22", location: "fsn1", image: "ubuntu-24.04" }).status).toBe(201);
    expect(call(st, "POST", "/v1/servers", { name: "over", server_type: "cx22", location: "fsn1", image: "ubuntu-24.04" })).toMatchObject({ status: 403 });
    for (let i = 0; i < FAKE_LIMITS.firewalls; i++) expect(call(st, "POST", "/v1/firewalls", { name: `f${i}`, rules: [] }).status).toBe(201);
    expect(code(call(st, "POST", "/v1/firewalls", { name: "over", rules: [] }))).toBe("resource_limit_exceeded");
    const sid = (st.servers[0] as { id: number }).id;
    for (let i = 0; i < FAKE_LIMITS.images; i++) expect(call(st, "POST", `/v1/servers/${sid}/actions/create_image`, { type: "snapshot" }).status).toBe(201);
    expect(code(call(st, "POST", `/v1/servers/${sid}/actions/create_image`, { type: "snapshot" }))).toBe("resource_limit_exceeded");
    for (let i = 0; i < FAKE_LIMITS.sshKeys; i++) expect(call(st, "POST", "/v1/ssh_keys", { name: `k${i}`, public_key: `ssh-ed25519 key-number-${String(i).padStart(8, "0")}` }).status).toBe(201);
    expect(code(call(st, "POST", "/v1/ssh_keys", { name: "over", public_key: "ssh-ed25519 one-more-key-value" }))).toBe("resource_limit_exceeded");
    // Reads still work when everything is full, and deleting frees a slot.
    expect(call(st, "GET", "/v1/firewalls?per_page=50").status).toBe(200);
    expect(call(st, "DELETE", `/v1/firewalls/${(st.firewalls[0] as { id: number }).id}`).status).toBe(204);
    expect(call(st, "POST", "/v1/firewalls", { name: "again", rules: [] }).status).toBe(201);
  });

  it("validates firewall labels like server labels, caps the rule count, and drops an image's poll entry with the image", () => {
    const st = emptyFakeState();
    expect(code(call(st, "POST", "/v1/firewalls", { name: "f", rules: [], labels: { "bad key": "x" } }))).toBe("invalid_input");
    expect(code(call(st, "POST", "/v1/firewalls", { name: "f", rules: Array.from({ length: FAKE_LIMITS.rules + 1 }, () => ({})) }))).toBe("invalid_input");
    expect(call(st, "POST", "/v1/firewalls", { name: "f", rules: Array.from({ length: FAKE_LIMITS.rules }, () => ({})) }).status).toBe(201);
    const sid = (call(st, "POST", "/v1/servers", { name: "s", server_type: "cx22", location: "fsn1", image: "ubuntu-24.04" }).body as { server: { id: number } }).server.id;
    const made = call(st, "POST", `/v1/servers/${sid}/actions/create_image`, { type: "snapshot" }).body as { image: { id: number }; action: { id: number } };
    call(st, "GET", `/v1/actions/${made.action.id}`);
    call(st, "GET", `/v1/actions/${made.action.id}`);
    expect(Object.keys(st.polls)).toHaveLength(1);
    expect(call(st, "DELETE", `/v1/images/${made.image.id}`).status).toBe(204);
    expect(st.polls).toEqual({});
  });
});

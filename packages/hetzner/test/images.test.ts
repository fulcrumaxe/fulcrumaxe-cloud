import https from "node:https";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WAIT_MAX_MS } from "../src/client.js";
import { CREATE_KEY_LABEL, HetznerError, MachineProviderError, createHetznerClient, createHetznerProvider, toMachineProviderError, type HetznerOptions } from "../src/index.js";
import { parseImage } from "../src/parse.js";
import { newWorld, startStrictHetzner, type FakeWorld, type StrictHetzner } from "./helpers/strictHetzner.js";

const TOKEN = "fxtest-SENTINEL-token-0123456789abcdef";
const SENTINEL = "SENTINEL-user-data-7f3a91";
let fake: StrictHetzner;
let world: FakeWorld;
const prevEnv = process.env.NODE_ENV;
beforeAll(() => { process.env.NODE_ENV = "test"; });
afterAll(() => { process.env.NODE_ENV = prevEnv; });
beforeEach(async () => { world = newWorld([TOKEN]); fake = await startStrictHetzner(world); sleeps.length = 0; });
afterEach(async () => { await fake.close(); });

const sleeps: number[] = [];
const options = (o: Partial<HetznerOptions> = {}): HetznerOptions => ({
  token: TOKEN, maxRetries: 2, timeoutMs: 2000, sleep: async (ms) => { sleeps.push(ms); world.clock.t += ms; }, now: () => world.clock.t,
  testTarget: { lookup: fake.lookup, port: fake.port, ca: fake.ca }, ...o,
});
const make = (o: Partial<HetznerOptions> = {}) => createHetznerClient(options(o));
const thrown = async (p: Promise<unknown>): Promise<HetznerError> => { try { await p; } catch (e) { if (e instanceof HetznerError) return e; throw e; } throw new Error("did not throw"); };
const newServer = async (c = make(), key = "srv") => (await c.createServer({ name: `box-${key}`, serverType: "cx22", location: "fsn1", image: "ubuntu-24.04", idempotencyKey: key })).server;
const snap = (key = "park-1") => ({ idempotencyKey: key, keyLabel: "fx-park-id", description: "park snapshot", labels: { "fx-server-id": "s1" } });
const writes = (path: RegExp) => world.requests.filter((r) => r.method === "POST" && path.test(r.path));
const ready = (id: number, size = 1.5) => { const im = world.images.find((x) => x.id === id)!; im.status = "available"; im.image_size = size; };

/** A raw request to the fake, so a field the client would never send can be sent. */
const raw = (method: string, path: string, body?: unknown) =>
  new Promise<{ status: number; json: { error?: { code?: string } } }>((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request({ host: "127.0.0.1", servername: "api.hetzner.cloud", port: fake.port, ca: fake.ca, path: `/v1${path}`, method, headers: { Authorization: `Bearer ${TOKEN}`, ...(data ? { "Content-Type": "application/json" } : {}) } }, (res) => {
      const c: Buffer[] = [];
      res.on("data", (x: Buffer) => c.push(x));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: c.length ? JSON.parse(Buffer.concat(c).toString("utf8")) : {} }));
    });
    req.on("error", reject);
    req.end(data);
  });

/** Ambiguous endings of a write, aimed at the POST: it landed (the answer was lost) or it did not. */
const endings: Array<[string, { method: "POST"; after: "hang" | "drop" | "500" }, { method: "POST"; hang: true } | { method: "POST"; drop: true } | { method: "POST"; status: number; code: string }]> = [
  ["a timeout", { method: "POST", after: "hang" }, { method: "POST", hang: true }], ["a reset after the request was sent", { method: "POST", after: "drop" }, { method: "POST", drop: true }], ["a 5xx", { method: "POST", after: "500" }, { method: "POST", status: 500, code: "server_error" }],
];

describe("createSnapshot", () => {
  it("sends create_image with type snapshot, the description and the labels, stamping the key label (P-1)", async () => {
    const c = make();
    const server = await newServer(c);
    const r = await c.createSnapshot(server.id, snap());
    expect(r).toMatchObject({ reused: false, image: { status: "creating", type: "snapshot", imageSize: null, createdFromId: server.id, description: "park snapshot", labels: { "fx-park-id": "park-1", "fx-server-id": "s1" } }, action: { command: "create_image", status: "running" } });
    const w = writes(/create_image/);
    expect(w).toHaveLength(1);
    expect(w[0]!.path).toBe(`/v1/servers/${server.id}/actions/create_image`);
    expect(w[0]!.headers["user-agent"]).toBe("fulcrumaxe-cloud/0.1.0");
    expect(JSON.parse(w[0]!.body)).toEqual({ type: "snapshot", description: "park snapshot", labels: { "fx-park-id": "park-1", "fx-server-id": "s1" } });
  });

  it("defaults the key label to fx-create-key, and refuses a bad key or key label before any request", async () => {
    const c = make();
    const server = await newServer(c);
    await c.createSnapshot(server.id, { idempotencyKey: "k1", description: "d" });
    expect(world.images[0]!.labels).toEqual({ [CREATE_KEY_LABEL]: "k1" });
    const n = world.requests.length;
    expect((await thrown(c.createSnapshot(server.id, { idempotencyKey: "bad key!", description: "d" }))).code).toBe("invalid_input");
    expect((await thrown(c.createSnapshot(server.id, { idempotencyKey: "k2", keyLabel: "bad key", description: "d" }))).code).toBe("invalid_input");
    expect(world.requests.length).toBe(n);
  });

  it("a repeat with the same key finds the first snapshot and sends nothing (the create-key lookup)", async () => {
    const c = make();
    const server = await newServer(c);
    const first = await c.createSnapshot(server.id, snap());
    const again = await c.createSnapshot(server.id, snap());
    expect(again).toMatchObject({ reused: true, action: null, image: { id: first.image.id } });
    expect(writes(/create_image/)).toHaveLength(1);
    expect(world.images).toHaveLength(1);
  });

  it("refuses a snapshot that carries the key but is not the one asked for, and never sends", async () => {
    const c = make();
    const server = await newServer(c);
    await c.createSnapshot(server.id, snap());
    world.images[0]!.description = "someone else's";
    expect(await thrown(c.createSnapshot(server.id, snap()))).toMatchObject({ code: "uniqueness_error", extra: { reason: "create_key_mismatch" } });
    world.images[0]!.description = "park snapshot";
    world.images.push({ ...world.images[0]!, id: 777 });
    expect(await thrown(c.createSnapshot(server.id, snap()))).toMatchObject({ extra: { reason: "create_key_ambiguous" } });
    expect(writes(/create_image/)).toHaveLength(1);
  });

  it("is not_found for a server that is not there", async () => {
    expect(await thrown(make().createSnapshot(424242, snap()))).toMatchObject({ code: "not_found", status: 404 });
  });

  it("retries a 429 (a refused request did nothing) and then lands once", async () => {
    const c = make();
    const server = await newServer(c);
    world.failNext.push({ method: "POST", status: 429, code: "rate_limit_exceeded" });
    const r = await c.createSnapshot(server.id, snap());
    expect(r.reused).toBe(false);
    expect(writes(/create_image/)).toHaveLength(2);
    expect(world.images).toHaveLength(1);
  });

  /** P-4: each ambiguous ending, with the first write landed (at most 1 write, found by label) and not landed (at most 2). */
  describe.each(endings)("after %s", (_n, landed, lost) => {
    it("finds the snapshot by its label when the write landed: one write", async () => {
      const c = make({ timeoutMs: 300 });
      const server = await newServer(c);
      world.failNext.push(landed);
      const r = await c.createSnapshot(server.id, snap());
      expect(r).toMatchObject({ reused: true, action: null });
      expect(writes(/create_image/)).toHaveLength(1);
      expect(world.images).toHaveLength(1);
    });
    it("sends once more only when the lookup finds nothing: at most two writes, one snapshot", async () => {
      const c = make({ timeoutMs: 300 });
      const server = await newServer(c);
      world.failNext.push(lost);
      const r = await c.createSnapshot(server.id, snap());
      expect(r.reused).toBe(false);
      expect(writes(/create_image/)).toHaveLength(2);
      expect(world.images).toHaveLength(1);
    });
    it("gives up after that one retry: never a third write", async () => {
      const c = make({ timeoutMs: 300, maxRetries: 5 });
      const server = await newServer(c);
      world.failNext.push(lost, lost, lost);
      await thrown(c.createSnapshot(server.id, snap()));
      expect(writes(/create_image/)).toHaveLength(2);
      expect(world.images).toHaveLength(0);
    });
  });
});

describe("waitForAction", () => {
  it("polls to success with growing waits, and the image is then available with a size (status moves creating, then available)", async () => {
    world.imageSteps = 3;
    const c = make();
    const server = await newServer(c);
    const { image, action } = await c.createSnapshot(server.id, snap());
    expect(image.status).toBe("creating");
    expect((await c.getImage(image.id))).toMatchObject({ status: "creating", imageSize: null });
    const done = await c.waitForAction(action!.id, { intervalMs: 1000 });
    expect(done.status).toBe("success");
    expect(sleeps).toEqual([1000, 1500]);
    expect(await c.getImage(image.id)).toMatchObject({ status: "available", imageSize: 1.5 });
  });

  it("is unavailable with reason action_timeout when the action never finishes, within the bound", async () => {
    world.imageStuck = true;
    const c = make();
    const server = await newServer(c);
    const { action } = await c.createSnapshot(server.id, snap());
    const e = await thrown(c.waitForAction(action!.id, { timeoutMs: 60_000, intervalMs: 5000 }));
    expect(e).toMatchObject({ code: "unavailable", extra: { reason: "action_timeout" } });
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThan(60_000 + 15_000);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(15_000);
  });

  it("is unavailable with reason action_failed on an error action, without Hetzner's words", async () => {
    world.imageActionError = true;
    const c = make();
    const server = await newServer(c);
    const { action } = await c.createSnapshot(server.id, snap());
    const e = await thrown(c.waitForAction(action!.id));
    expect(e).toMatchObject({ code: "unavailable", extra: { reason: "action_failed" } });
    expect(e.message).not.toMatch(/Action failed|action_failed_code/);
  });
});

describe("listImages, getImage, deleteImage", () => {
  const seed = (labels: Record<string, string>, type = "snapshot") => { world.images.push({ id: 9000 + world.images.length, status: "available", type, image_size: 2, created: "2026-01-01T00:00:00+00:00", labels, bound_to: null, description: "d", protection: { delete: false } }); };

  it("lists snapshots by selector: =, !=, a bare key; and only the snapshot type", async () => {
    seed({ a: "1", b: "x" }); seed({ a: "2" }); seed({ b: "y" }); seed({ a: "1" }, "system");
    const c = make();
    const ids = async (labelSelector?: string) => (await c.listImages(labelSelector ? { labelSelector } : {})).map((i) => i.id);
    expect(await ids()).toEqual([9000, 9001, 9002]);
    expect(await ids("a=1")).toEqual([9000]);
    expect(await ids("a!=1")).toEqual([9001, 9002]);
    expect(await ids("b")).toEqual([9000, 9002]);
    expect(await ids("a=1,b=x")).toEqual([9000]);
    expect(await ids("a=none")).toEqual([]);
  });

  it("reads every page at 50 a page, and refuses a list longer than 20 pages", async () => {
    for (let i = 0; i < 120; i++) seed({ n: String(i) });
    const c = make();
    expect(await c.listImages()).toHaveLength(120);
    const pages = world.requests.filter((r) => r.path.startsWith("/v1/images?"));
    expect(pages).toHaveLength(3);
    for (const p of pages) expect(p.path).toContain("per_page=50");
    world.requests.length = 0;
    for (let i = 120; i < 1001; i++) seed({ n: String(i) });
    expect(await thrown(c.listImages())).toMatchObject({ code: "unavailable", message: expect.stringMatching(/longer than we read/) });
    expect(world.requests.filter((r) => r.path.startsWith("/v1/images?"))).toHaveLength(20);
  });

  it("gets an image, and a missing one is not_found", async () => {
    seed({ a: "1" });
    const c = make();
    expect(await c.getImage(9000)).toMatchObject({ id: 9000, status: "available", imageSize: 2 });
    expect(await thrown(c.getImage(1))).toMatchObject({ code: "not_found", status: 404 });
  });

  it("deletes idempotently: true once, then false for a missing image (P-3)", async () => {
    seed({ a: "1" });
    const c = make();
    expect(await c.deleteImage(9000)).toBe(true);
    expect(world.images).toHaveLength(0);
    expect(await c.deleteImage(9000)).toBe(false);
    expect(await c.deleteImage(4)).toBe(false);
  });

  it("refuses a locked image (423) as an error, not as success, and does not retry it", async () => {
    const c = make();
    const server = await newServer(c);
    const { image } = await c.createSnapshot(server.id, snap()); // still creating: the real API locks it
    const e = await thrown(c.deleteImage(image.id));
    expect(e).toMatchObject({ code: "locked", status: 423 });
    expect(world.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
    expect(world.images).toHaveLength(1);
    ready(image.id);
    world.images[0]!.locked = true;
    expect(await thrown(c.deleteImage(image.id))).toMatchObject({ code: "locked" });
  });

  it("refuses a bad id before any request", async () => {
    const c = make();
    const n = world.requests.length;
    expect((await thrown(c.getImage(0))).code).toBe("invalid_input");
    expect((await thrown(c.deleteImage(1.5))).code).toBe("invalid_input");
    expect(world.requests.length).toBe(n);
  });
});

describe("create a server from an image id", () => {
  const input = (key: string, imageId: number) => ({ name: `from-${key}`, serverType: "cx22", location: "fsn1", imageId, idempotencyKey: key, userData: `#cloud-config\n# ${SENTINEL}\n`, sshKeys: [31, 32], labels: { owner: "acct1" } });
  const base = async () => {
    const c = make({ timeoutMs: 300 });
    const s = await newServer(c);
    const { image } = await c.createSnapshot(s.id, snap());
    ready(image.id);
    return { c, imageId: image.id };
  };

  it("sends the image as a number and the SSH key ids as numbers, and keeps the create-key label", async () => {
    const { c, imageId } = await base();
    const r = await c.createServerFromImage(input("up1", imageId));
    expect(r).toMatchObject({ reused: false, server: { name: "from-up1", labels: { owner: "acct1", [CREATE_KEY_LABEL]: "up1" } } });
    const body = JSON.parse(writes(/^\/v1\/servers$/).at(-1)!.body);
    expect(body.image).toBe(imageId);
    expect(body.ssh_keys).toEqual([31, 32]);
  });

  it("adopts the server a first call made, by its create key (one server)", async () => {
    const { c, imageId } = await base();
    const first = await c.createServerFromImage(input("up2", imageId));
    const again = await c.createServerFromImage(input("up2", imageId));
    expect(again).toMatchObject({ reused: true, action: null, server: { id: first.server.id } });
    expect(world.servers.filter((s) => s.name === "from-up2")).toHaveLength(1);
  });

  it("is refused for an unknown image id, and for one that is not yet available", async () => {
    const { c } = await base();
    expect(await thrown(c.createServerFromImage(input("up3", 31337)))).toMatchObject({ code: "invalid_input", status: 422 });
    const s = world.servers[0]!;
    const { image } = await c.createSnapshot(s.id as number, snap("park-2"));
    expect(await thrown(c.createServerFromImage(input("up4", image.id)))).toMatchObject({ code: "invalid_input", status: 422 });
    expect(world.servers.filter((x) => String(x.name).startsWith("from-"))).toHaveLength(0);
  });

  it("drops root_password from the create response made from an image (P-6)", async () => {
    const { c, imageId } = await base();
    const r = await c.createServerFromImage(input("up5", imageId));
    expect(JSON.stringify(r)).not.toContain("fake-root-password-SECRET");
    expect(JSON.stringify(r)).not.toContain("root_password");
  });

  describe.each(endings)("after %s", (_n, landed, lost) => {
    it("finds the server by its create-key label when the write landed: one write", async () => {
      const { c, imageId } = await base();
      world.failNext.push(landed);
      const r = await c.createServerFromImage(input("amb", imageId));
      expect(r.reused).toBe(true);
      expect(writes(/^\/v1\/servers$/).filter((w) => w.body.includes("from-amb"))).toHaveLength(1);
      expect(world.servers.filter((s) => s.name === "from-amb")).toHaveLength(1);
    });
    it("sends once more only when nothing is found: at most two writes, one server", async () => {
      const { c, imageId } = await base();
      world.failNext.push(lost);
      const r = await c.createServerFromImage(input("amb", imageId));
      expect(r.reused).toBe(false);
      expect(writes(/^\/v1\/servers$/).filter((w) => w.body.includes("from-amb"))).toHaveLength(2);
      expect(world.servers.filter((s) => s.name === "from-amb")).toHaveLength(1);
    });
  });
});
describe("the strict fake refuses what the real API refuses (P-5)", () => {
  const server = async () => (await newServer()).id;
  it("create_image: a type other than snapshot, an unknown field, a bad label key or value, and a missing server", async () => {
    const id = await server();
    const path = `/servers/${id}/actions/create_image`;
    expect(await raw("POST", path, { type: "backup" })).toMatchObject({ status: 422, json: { error: { code: "invalid_input" } } });
    expect(await raw("POST", path, { type: "snapshot", color: "red" })).toMatchObject({ status: 422 });
    expect(await raw("POST", path, { type: "snapshot", labels: { "bad key!": "v" } })).toMatchObject({ status: 422 });
    expect(await raw("POST", path, { type: "snapshot", labels: { k: "bad value!" } })).toMatchObject({ status: 422 });
    expect(await raw("POST", "/servers/424242/actions/create_image", { type: "snapshot" })).toMatchObject({ status: 404 });
    expect(world.images).toHaveLength(0);
    expect((await raw("POST", path, { type: "snapshot", description: "ok", labels: { k: "v" } })).status).toBe(201);
  });
  it("create server: an unknown field is refused, and an image id that is unknown or still creating", async () => {
    const id = await server();
    expect((await raw("POST", "/servers", { name: "x", server_type: "cx22", location: "fsn1", image: "ubuntu-24.04", surprise: 1 })).status).toBe(422);
    expect((await raw("POST", "/servers", { name: "x", server_type: "cx22", location: "fsn1", image: 555 })).status).toBe(422);
    await raw("POST", `/servers/${id}/actions/create_image`, { type: "snapshot" });
    expect((await raw("POST", "/servers", { name: "x", server_type: "cx22", location: "fsn1", image: world.images[0]!.id as number })).status).toBe(422);
    ready(world.images[0]!.id as number);
    expect((await raw("POST", "/servers", { name: "x", server_type: "cx22", location: "fsn1", image: world.images[0]!.id as number })).status).toBe(201);
  });
  it("answers 404, 423 and 403 on image deletes, and an unknown list type with 422", async () => {
    expect((await raw("DELETE", "/images/5")).status).toBe(404);
    expect((await raw("GET", "/images?type=nope")).status).toBe(422);
    world.images.push({ id: 6, status: "available", type: "snapshot", labels: {}, protection: { delete: true } });
    expect((await raw("DELETE", "/images/6")).status).toBe(403);
  });
  it("injects a failure after the write committed: the snapshot exists although the answer never came", async () => {
    const id = await server();
    world.failNext.push({ method: "POST", after: "500" });
    expect((await raw("POST", `/servers/${id}/actions/create_image`, { type: "snapshot" })).status).toBe(500);
    expect(world.images).toHaveLength(1);
  });
});

describe("the parser and the neutral error (P-2, P-6)", () => {
  it("reads exactly the image fields the code uses, and ignores the rest (drift pin)", () => {
    const wire = { id: 1, status: "available", type: "snapshot", image_size: 2.5, created: "2026-01-01T00:00:00+00:00", labels: { a: "b" }, bound_to: 9, description: "d", os_flavor: "ubuntu", created_from: { id: 7, name: "srv" }, protection: { delete: false }, root_password: "nope" };
    const parsed = parseImage(wire);
    expect(Object.keys(parsed).sort()).toEqual(["created", "createdFromId", "description", "id", "imageSize", "labels", "status", "type"]);
    expect(parsed).toEqual({ id: 1, status: "available", type: "snapshot", imageSize: 2.5, created: "2026-01-01T00:00:00+00:00", labels: { a: "b" }, createdFromId: 7, description: "d" });
    expect(parseImage({ ...wire, image_size: null, created_from: null, description: null, status: "weird" })).toMatchObject({ imageSize: null, createdFromId: null, description: null, status: "unknown" });
    expect(() => parseImage({ ...wire, id: "1" })).toThrow();
    expect(() => parseImage({ ...wire, labels: undefined })).toThrow();
  });

  it("maps every new error to a neutral code and passes no Hetzner words or user_data through the provider", async () => {
    const p = createHetznerProvider(createHetznerClient(options({ maxRetries: 0 })));
    const s = await p.create({ name: "pm", type: "cx22", location: "fsn1", image: "base", idempotencyKey: "pm1" });
    const { snapshot, actionId } = await p.createSnapshot(s.machine.id, { key: "pk", keyLabel: "fx-park-id", description: "d" });
    const cases: Array<[() => Promise<unknown>, string, number]> = [
      [() => p.deleteSnapshot(snapshot.id), "conflict", 423], // locked while creating
      [() => p.createFromSnapshot({ snapshotId: snapshot.id, name: "n", type: "cx22", location: "fsn1", userData: SENTINEL, idempotencyKey: "z1" }), "invalid_input", 422], // not available yet
      [() => p.createFromSnapshot({ snapshotId: "99999", name: "n", type: "cx22", location: "fsn1", userData: SENTINEL, idempotencyKey: "z2" }), "invalid_input", 422],
      [() => p.createSnapshot("424242", { key: "pk2", description: "d" }), "not_found", 404],
    ];
    for (const [call, code, status] of cases) {
      const e = await call().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(MachineProviderError);
      expect(e).toMatchObject({ code, extra: { status } });
      const text = [String((e as Error).message), JSON.stringify(e, Object.getOwnPropertyNames(e))].join("\n");
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toMatch(/image not found|not available|is locked|item is locked/);
    }
    world.failNext.push({ status: 422, code: "invalid_input", message: `echo ${SENTINEL}` });
    const echo = await p.getSnapshot(snapshot.id).catch((x: unknown) => x);
    expect(String((echo as Error).message)).not.toContain(SENTINEL);
    world.imageActionError = true;
    const failed = await p.waitForAction(actionId!).catch((x: unknown) => x);
    expect(failed).toMatchObject({ code: "unavailable", extra: { providerCode: "unavailable" } });
    expect(toMachineProviderError(new HetznerError("locked", "m", { status: 423 }))).toMatchObject({ code: "conflict", extra: { providerCode: "locked" } });
  });

  it("the client logs and returns nothing of the token or user_data, and stays frozen", async () => {
    const c = make();
    expect(Object.isFrozen(c)).toBe(true);
    expect(String(c)).toBe("[HetznerClient]");
    expect(JSON.stringify(c)).toBe("{}");
    expect(typeof c.createSnapshot).toBe("function");
  });
});

describe("the park flow through the provider seam only (P-1)", () => {
  it("snapshots a machine, waits, verifies, deletes it, lists, and starts a new one from the snapshot", async () => {
    const p = createHetznerProvider(createHetznerClient(options()));
    const m = await p.create({ name: "pk", type: "cx22", location: "fsn1", image: "base", labels: { owner: "acct1" }, idempotencyKey: "pk1" });
    const made = await p.createSnapshot(m.machine.id, { key: "park-9", keyLabel: "fx-park-id", description: "park", labels: { "fx-server-id": m.machine.id } });
    expect(made).toMatchObject({ reused: false, snapshot: { status: "creating", sizeGb: null, machineId: m.machine.id } });
    await p.waitForAction(made.actionId!);
    const got = await p.getSnapshot(made.snapshot.id);
    expect(got).toMatchObject({ status: "available", sizeGb: 1.5, labels: { "fx-park-id": "park-9" } });
    expect((await p.listSnapshots("fx-park-id=park-9")).map((x) => x.id)).toEqual([made.snapshot.id]);
    expect(await p.delete(m.machine.id)).toBe(true);
    const back = await p.createFromSnapshot({ snapshotId: made.snapshot.id, name: "pk", type: "cx22", location: "fsn1", labels: { owner: "acct1" }, sshKeyIds: ["5"], idempotencyKey: "pk2" });
    expect(back).toMatchObject({ reused: false, machine: { name: "pk", type: "cx22", location: "fsn1", labels: { owner: "acct1" } } });
    expect(await p.deleteSnapshot(made.snapshot.id)).toBe(true);
    expect(await p.deleteSnapshot(made.snapshot.id)).toBe(false);
    expect(await p.getSnapshot(made.snapshot.id)).toBeNull();
  });
});

describe("review fixes", () => {
  it("a snapshot records its source in created_from, and bound_to stays null (as on the real API)", async () => {
    const c = make();
    const server = await newServer(c);
    await c.createSnapshot(server.id, snap());
    expect(world.images[0]).toMatchObject({ bound_to: null, created_from: { id: server.id } });
  });

  it("refuses to adopt a snapshot with this key that was taken from another server, and sends nothing", async () => {
    const c = make();
    const a = await newServer(c, "a");
    const b = await newServer(c, "b");
    await c.createSnapshot(a.id, snap());
    expect(await thrown(c.createSnapshot(b.id, snap()))).toMatchObject({ code: "uniqueness_error", extra: { reason: "create_key_mismatch" } });
    expect(writes(/create_image/)).toHaveLength(1);
    expect(world.images).toHaveLength(1);
  });

  it("waitForAction refuses NaN, negative, zero, infinite and over-long bounds, and a bad interval, before any request", async () => {
    const c = make();
    const n = world.requests.length;
    for (const o of [{ timeoutMs: NaN }, { timeoutMs: -1 }, { timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: WAIT_MAX_MS + 1 }, { intervalMs: NaN }, { intervalMs: -5 }, { intervalMs: Infinity }]) {
      expect(await thrown(c.waitForAction(1, o)), JSON.stringify(o)).toMatchObject({ code: "invalid_input" });
    }
    expect(world.requests.length).toBe(n);
  });

  it("waitForAction never polls faster than 500 ms", async () => {
    world.imageSteps = 3;
    const c = make();
    const server = await newServer(c);
    const { action } = await c.createSnapshot(server.id, snap());
    await c.waitForAction(action!.id, { intervalMs: 0 });
    expect(Math.min(...sleeps)).toBeGreaterThanOrEqual(500);
  });
});

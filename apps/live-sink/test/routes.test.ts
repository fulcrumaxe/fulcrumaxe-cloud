import { timingSafeEqual } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as health } from "../app/api/health/route";
import { POST as hook } from "../app/api/hook/[id]/route";
import { GET as read } from "../app/api/read/[id]/route";
import { MAX_BODY_BYTES, TTL_SECONDS, createRedisStore, getStore, setStoreForTests } from "../lib/store";
import { createFakeRedis, type FakeRedis } from "./support/fakeRedis";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const ID = "0123456789abcdef0123456789abcdef";
const READ_TOKEN = "read-token-fixture";
const STORE_TOKEN = "store-token-fixture";
const HOUR = TTL_SECONDS * 1000;

let redis: FakeRedis;
beforeEach(() => {
  redis = createFakeRedis(STORE_TOKEN);
  vi.stubEnv("LIVE_SINK_READ_TOKEN", READ_TOKEN);
  setStoreForTests(createRedisStore({ url: "https://redis.test", token: STORE_TOKEN, fetch: redis.fetch }));
});
afterEach(() => {
  setStoreForTests(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const post = (id: string, body: RequestInit["body"] = "{}", headers: Record<string, string> = {}, extra: RequestInit = {}) =>
  hook(new Request(`https://sink.test/api/hook/${id}`, { method: "POST", body, headers, ...extra }), { params: Promise.resolve({ id }) });
const get = (id: string, token: string | null = READ_TOKEN) =>
  read(new Request(`https://sink.test/api/read/${id}`, { headers: token === null ? {} : { authorization: `Bearer ${token}` } }), { params: Promise.resolve({ id }) });

describe("POST /api/hook/<id>", () => {
  it("answers 404 for an id that is not 32 hex characters, and stores nothing", async () => {
    for (const id of ["short", "g".repeat(32), `${ID}0`, ID.slice(1), "../".repeat(11), ""]) {
      expect((await post(id)).status, id).toBe(404);
    }
    expect(redis.keys()).toEqual([]);
  });

  it("stores a body of exactly 64 KB, and answers 413 for one byte more without storing it", async () => {
    expect((await post(ID, "a".repeat(MAX_BODY_BYTES))).status).toBe(200);
    expect(redis.keys()).toHaveLength(1);
    redis = createFakeRedis(STORE_TOKEN);
    setStoreForTests(createRedisStore({ url: "https://redis.test", token: STORE_TOKEN, fetch: redis.fetch }));
    expect((await post(ID, "a".repeat(MAX_BODY_BYTES + 1))).status).toBe(413);
    expect(redis.keys()).toEqual([]);
  });

  it("answers 413 from the declared length alone, before reading the body", async () => {
    expect((await post(ID, "tiny", { "content-length": String(MAX_BODY_BYTES + 1) })).status).toBe(413);
    expect(redis.keys()).toEqual([]);
  });

  it("answers 413 for a streamed body that never declares its length", async () => {
    const chunk = new TextEncoder().encode("b".repeat(MAX_BODY_BYTES / 2 + 1));
    const stream = new ReadableStream({ start: (c) => { c.enqueue(chunk); c.enqueue(chunk); c.close(); } });
    expect((await post(ID, stream, {}, { duplex: "half" } as RequestInit)).status).toBe(413);
    expect(redis.keys()).toEqual([]);
  });
});

describe("GET /api/read/<id>", () => {
  it("answers 401 without the token, with a wrong one and with a wrong scheme, and leaves the entry in place", async () => {
    await post(ID, "keep me");
    for (const token of [null, "wrong", READ_TOKEN.slice(1), `${READ_TOKEN}x`, ""]) expect((await get(ID, token)).status, String(token)).toBe(401);
    const noScheme = await read(new Request("https://sink.test", { headers: { authorization: READ_TOKEN } }), { params: Promise.resolve({ id: ID }) });
    expect(noScheme.status).toBe(401);
    expect(((await (await get(ID)).json()) as { deliveries: { body: string }[] }).deliveries[0]?.body).toBe("keep me");
  });

  it("answers 401 to everyone when no read token is configured", async () => {
    vi.stubEnv("LIVE_SINK_READ_TOKEN", "");
    expect((await get(ID, "")).status).toBe(401);
    expect((await get(ID, "undefined")).status).toBe(401);
  });

  it("compares the token with timingSafeEqual", async () => {
    vi.mocked(timingSafeEqual).mockClear();
    await get(ID, "wrong-token-of-another-length");
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
  });

  it("returns the stored body and headers once, oldest first", async () => {
    await post(ID, '{"n":1}', { "x-signature": "sig-1" });
    await post(ID.toUpperCase(), '{"n":2}', { "x-signature": "sig-2" });
    const res = await get(ID);
    expect(res.status).toBe(200);
    const { deliveries } = (await res.json()) as { deliveries: { body: string; headers: Record<string, string>; receivedAt: string }[] };
    expect(deliveries.map((d) => [d.body, d.headers["x-signature"]])).toEqual([['{"n":1}', "sig-1"], ['{"n":2}', "sig-2"]]);
    expect(Number.isNaN(Date.parse(deliveries[0]!.receivedAt))).toBe(false);
    expect((await get(ID)).status).toBe(404);
    expect(redis.keys()).toEqual([]);
  });

  it("answers 404 for an unknown id and for a bad id", async () => {
    expect((await get(ID)).status).toBe(404);
    expect((await get("nope")).status).toBe(404);
  });

  it("holds an entry for one hour from its first delivery, then it is gone", async () => {
    await post(ID, "first");
    redis.advance(HOUR - 1);
    expect(((await (await get(ID)).json()) as { deliveries: unknown[] }).deliveries).toHaveLength(1);
    await post(ID, "second");
    redis.advance(HOUR);
    expect((await get(ID)).status).toBe(404);
    expect(redis.keys()).toEqual([]);
  });

  it("does not stretch the hour when a later delivery arrives", async () => {
    await post(ID, "first");
    redis.advance(HOUR / 2);
    await post(ID, "second");
    redis.advance(HOUR / 2);
    expect((await get(ID)).status).toBe(404);
  });

  it("keeps only the newest 100 deliveries", async () => {
    for (let i = 0; i < 101; i++) await post(ID, String(i));
    const { deliveries } = (await (await get(ID)).json()) as { deliveries: { body: string }[] };
    expect([deliveries.length, deliveries[0]?.body]).toEqual([100, "1"]);
  });
});

describe("GET /api/health", () => {
  it("answers 200 with exactly { ok: true }, whatever is configured", async () => {
    vi.stubEnv("KV_REST_API_TOKEN", STORE_TOKEN);
    const res = health();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
  });
});

describe("store configuration and failure", () => {
  it("builds the store from the Marketplace names, or the Upstash names, and from nothing else", () => {
    setStoreForTests(undefined);
    expect(getStore({})).toBeUndefined();
    expect(getStore({ KV_REST_API_URL: "https://a" })).toBeUndefined();
    expect(getStore({ KV_REST_API_URL: "https://a", KV_REST_API_TOKEN: "t" })).toBeDefined();
    expect(getStore({ UPSTASH_REDIS_REST_URL: "https://a", UPSTASH_REDIS_REST_TOKEN: "t" })).toBeDefined();
  });

  it("answers 503 on both routes when no store is configured or the store refuses the call", async () => {
    setStoreForTests(createRedisStore({ url: "https://redis.test", token: "wrong", fetch: redis.fetch }));
    expect((await post(ID)).status).toBe(503);
    expect((await get(ID)).status).toBe(503);
    setStoreForTests(undefined);
    for (const name of ["KV_REST_API_URL", "UPSTASH_REDIS_REST_URL"]) vi.stubEnv(name, "");
    expect((await post(ID)).status).toBe(503);
    expect((await get(ID)).status).toBe(503);
  });
});

describe("logging", () => {
  it("never writes a body, a header value or a token to any log, on success or on store failure", async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation(capture);
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (capture(chunk), true));
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (capture(chunk), true));
    const marker = "MARKER-7f3a9c-do-not-log";
    await post(ID, JSON.stringify({ secret: marker }), { "x-marker": marker });
    await get(ID);
    await get(ID, `${READ_TOKEN}-wrong`);
    setStoreForTests(createRedisStore({ url: "https://redis.test", token: "wrong", fetch: redis.fetch }));
    await post(ID, marker, { "x-marker": marker });
    await get(ID);
    expect(lines.some((l) => l.includes("live-sink: store write failed"))).toBe(true);
    const all = lines.join("\n");
    for (const secret of [marker, READ_TOKEN, `${READ_TOKEN}-wrong`, STORE_TOKEN]) expect(all).not.toContain(secret);
  });
});

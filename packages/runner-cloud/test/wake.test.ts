import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_CREATED_SKEW_SECONDS, WAKE_PATH, WAKE_TOKEN_LIFETIME_SECONDS, WakeReply } from "@fulcrumaxe/runner-protocol";
import {
  BACKSTOP_MS,
  WAKE_ALLOW_MAX_TTL_SECONDS,
  WAKE_REVOKE_SECOND_DELETE_MS,
  allowRunnerWake,
  revokeRunnerWake,
  runnerWorkDueKeyFor,
  runnerWorkKeyFor,
  setPendingHooks,
  wakeAllowKeyFor,
  wakeAllowValue,
  type PendingStore,
} from "@fx/core/src/pendingWork.js";
import { RUNNER_SEEN_REFRESH_MS, WAKE_SAFETY_JITTER_SECONDS, acceptsWakeJson, mintWakeToken, runnerSeenKey, runnerSeenWriter, runnerWake, wakeSafetyRetryAfterSeconds, type RunnerHttpRequest, type WakeDeps } from "../src/index.js";
import { ORIGIN, newKey, signed, type TestKey } from "./helpers.js";

/**
 * D#6 RUNNER-WAKE R3b: the wake check, with no database anywhere (there is no pool in its deps to reach). The store fake is no kinder than the
 * Runtime Cache client: values go through JSON, entries end at their TTL, and a failing call NEVER throws: a read answers null and a write or
 * delete is silently dropped (the real client swallows its own errors). `hanging` stands for a call that never answers (our own bound).
 */
const KEY = randomBytes(32);
const DAY = 86_400_000;

interface FakeStore extends PendingStore {
  map: Map<string, { json: string; expiresAt: number }>;
  reads: string[];
  writes: string[];
  failing: boolean;
  hanging: boolean;
  /** Writes and deletes only are dropped (reads still answer). */
  droppingWrites: boolean;
}
let clock: Date;
function fakeStore(): FakeStore {
  const never = new Promise<never>(() => {});
  const s: FakeStore = {
    map: new Map(),
    reads: [],
    writes: [],
    failing: false,
    hanging: false,
    droppingWrites: false,
    async get(key) {
      s.reads.push(key);
      if (s.hanging) return never;
      if (s.failing) return null;
      const entry = s.map.get(key);
      if (!entry || entry.expiresAt <= clock.getTime()) return null;
      return JSON.parse(entry.json) as unknown;
    },
    async set(key, value, ttlSeconds) {
      s.writes.push(key);
      if (s.hanging) return never;
      if (s.failing || s.droppingWrites) return;
      s.map.set(key, { json: JSON.stringify(value), expiresAt: clock.getTime() + ttlSeconds * 1000 });
    },
    async delete(key) {
      if (s.hanging) return never;
      if (s.failing || s.droppingWrites) return;
      s.map.delete(key);
    },
  };
  return s;
}
const put = (s: FakeStore, key: string, value: unknown, ttlSeconds = 3600) => s.map.set(key, { json: JSON.stringify(value), expiresAt: clock.getTime() + ttlSeconds * 1000 });

let pending: FakeStore;
let seen: FakeStore;
const lines: string[] = [];

beforeEach(() => {
  pending = fakeStore();
  seen = fakeStore();
  clock = new Date();
  lines.length = 0;
  setPendingHooks({ store: pending });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  setPendingHooks(null);
  vi.restoreAllMocks();
});

const deps = (over: Partial<WakeDeps> = {}): WakeDeps => ({ origin: ORIGIN, wakeKey: () => KEY, seenWriter: runnerSeenWriter(seen), now: () => clock, log: (l) => void lines.push(l), ...over });

interface Runner {
  key: TestKey;
  runnerId: string;
  accountId: string;
  token: string;
}
/** A runner as a claim leaves it: a token, and (unless `allow: false`) the allow record that claim writes. */
async function runner(o: { accountId?: string; at?: Date; allow?: boolean; keyValidUntil?: Date } = {}): Promise<Runner> {
  const key = newKey();
  const runnerId = randomUUID();
  const accountId = o.accountId ?? randomUUID();
  const at = o.at ?? clock;
  if (o.allow !== false) await allowRunnerWake({ runnerId, accountId, jkt: key.jkt, keyValidUntil: o.keyValidUntil ?? new Date(at.getTime() + 30 * DAY) }, at.getTime());
  return { key, runnerId, accountId, token: mintWakeToken(KEY, { runnerId, accountId, jkt: key.jkt, publicKeyX: key.jwk.x }, at) };
}

/** A wake check the way a runner sends it: GET, empty body, signed with its key, the token as a bearer, JSON accepted. */
function wakeRequest(r: Runner, o: { token?: string | null; accept?: string | null; signer?: TestKey; created?: number; url?: string; method?: string } = {}): RunnerHttpRequest {
  const req = signed(o.signer ?? r.key, WAKE_PATH, undefined, { method: o.method ?? "GET", rawBody: Buffer.alloc(0), created: o.created ?? Math.floor(clock.getTime() / 1000), ...(o.url ? { url: o.url } : {}) });
  const headers: Record<string, string | undefined> = { ...req.headers };
  if (o.token !== null) headers.authorization = `Bearer ${o.token ?? r.token}`;
  if (o.accept !== null) headers.accept = o.accept ?? "application/json";
  return { ...req, headers };
}
const call = (req: RunnerHttpRequest, d: WakeDeps = deps()) => runnerWake(d, req);
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};
const unavailable = { status: 503, body: { error: { code: "wake_unavailable" } } };
const unauthorized = { status: 401, body: { error: { code: "unauthorized" } } };

describe("the wake check answers", () => {
  it("exactly {epoch, due_at} for the token's account: 0 and null when nothing is stored, the stored times otherwise", async () => {
    const r = await runner();
    const empty = await call(wakeRequest(r));
    expect(empty).toMatchObject({ status: 200, body: { epoch: 0, due_at: null } });
    expect(Object.keys(empty.body as object)).toEqual(["epoch", "due_at"]);
    expect(empty.headers?.["cache-control"]).toBe("no-store");

    put(pending, runnerWorkKeyFor(r.accountId), 1_700_000_000_123);
    put(pending, runnerWorkDueKeyFor(r.accountId), 1_700_000_900_000);
    const res = await call(wakeRequest(r));
    expect(res.body).toEqual({ epoch: 1_700_000_000_123, due_at: 1_700_000_900_000 });
    expect(WakeReply.safeParse(res.body).success).toBe(true);
  });

  it("the reply schema is strict: an extra field, a string, a negative or a fractional time is refused", () => {
    expect(WakeReply.safeParse({ epoch: 1, due_at: null }).success).toBe(true);
    for (const bad of [{ epoch: 1, due_at: null, runner: "x" }, { epoch: "1", due_at: null }, { epoch: -1, due_at: null }, { epoch: 1.5, due_at: null }, { epoch: null, due_at: null }, { epoch: 1 }]) {
      expect(WakeReply.safeParse(bad).success).toBe(false);
    }
  });

  it("an unusable stored value reads as nothing, never as a reply that breaks the schema", async () => {
    const r = await runner();
    put(pending, runnerWorkKeyFor(r.accountId), "not a time");
    put(pending, runnerWorkDueKeyFor(r.accountId), 1e300);
    expect((await call(wakeRequest(r))).body).toEqual({ epoch: 0, due_at: null });
  });
});

describe("the allow record: the decision fails closed", () => {
  it("no record (never written, evicted, dropped by a failing client) is 503 wake_unavailable, never an answer", async () => {
    expect(await call(wakeRequest(await runner({ allow: false })))).toMatchObject(unavailable);
    const evicted = await runner();
    pending.map.delete(wakeAllowKeyFor(evicted.runnerId));
    expect(await call(wakeRequest(evicted))).toMatchObject(unavailable);
    // The real client answers null on an error, a timeout or another region: the same refusal.
    const r = await runner();
    pending.failing = true;
    expect(await call(wakeRequest(r))).toMatchObject(unavailable);
    expect(seen.writes).toEqual([]);
  });

  it("the record lives one hour: a runner that has not claimed for an hour is 503; its next claim's record answers again", async () => {
    const r = await runner();
    advance(WAKE_ALLOW_MAX_TTL_SECONDS * 1000 - 1000);
    expect((await call(wakeRequest(r))).status).toBe(200);
    advance(2000);
    expect(await call(wakeRequest(r))).toMatchObject(unavailable);
    await allowRunnerWake({ runnerId: r.runnerId, accountId: r.accountId, jkt: r.key.jkt, keyValidUntil: new Date(clock.getTime() + 30 * DAY) }, clock.getTime());
    expect((await call(wakeRequest(r))).status).toBe(200);
  });

  it("never outlives the key's age limit: no record past it, and one that ends with it", async () => {
    expect(await call(wakeRequest(await runner({ keyValidUntil: new Date(clock.getTime() - 1000) })))).toMatchObject(unavailable);
    const soon = await runner({ keyValidUntil: new Date(clock.getTime() + 10 * 60_000) });
    expect((await call(wakeRequest(soon))).status).toBe(200);
    advance(10 * 60_000 + 1000);
    expect(await call(wakeRequest(soon, { created: Math.floor(clock.getTime() / 1000) }))).toMatchObject(unavailable);
  });

  it("a record for another key or account is 401 (a rotated key's token, a token moved to another account's record)", async () => {
    const r = await runner();
    put(pending, wakeAllowKeyFor(r.runnerId), wakeAllowValue(newKey().jkt, r.accountId));
    expect(await call(wakeRequest(r))).toMatchObject(unauthorized);
    put(pending, wakeAllowKeyFor(r.runnerId), wakeAllowValue(r.key.jkt, randomUUID()));
    expect(await call(wakeRequest(r))).toMatchObject(unauthorized);
  });

  it("a store that never answers is cut off by our own bound: 503", async () => {
    const r = await runner();
    pending.hanging = true;
    expect(await call(wakeRequest(r))).toMatchObject(unavailable);
  });
});

describe("content negotiation and configuration", () => {
  it("406 unless Accept lists application/json (absent, */*, a stream type or q=0 are refused)", async () => {
    const r = await runner();
    for (const accept of [null, "*/*", "text/event-stream", "application/json;q=0", "text/html, application/xml", "application/jsonx"]) {
      expect((await call(wakeRequest(r, { accept }))).status, String(accept)).toBe(406);
    }
    expect(acceptsWakeJson("text/html, application/json; q=0.5")).toBe(true);
    expect(acceptsWakeJson("APPLICATION/JSON")).toBe(true);
  });

  it("503 not_configured with no key (missing, short or throwing); nothing is read", async () => {
    const r = await runner();
    pending.reads.length = 0;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const wakeKey of [null, () => null, () => Buffer.alloc(8), () => { throw new Error("unreadable"); }]) {
      expect(await call(wakeRequest(r), deps({ wakeKey }))).toMatchObject({ status: 503, body: { error: { code: "not_configured" } } });
    }
    expect(pending.reads).toEqual([]);
  });

  it("503 with no configured origin or no store", async () => {
    const r = await runner();
    expect((await call(wakeRequest(r), deps({ origin: undefined }))).status).toBe(503);
    setPendingHooks(null);
    expect(await call(wakeRequest(r))).toMatchObject(unavailable);
  });

  it("only GET, and no body", async () => {
    const r = await runner();
    expect((await call(wakeRequest(r, { method: "POST" }))).status).toBe(405);
    const withBody = signed(r.key, WAKE_PATH, { a: 1 }, { method: "GET" });
    expect((await call({ ...withBody, headers: { ...withBody.headers, authorization: `Bearer ${r.token}`, accept: "application/json" } })).status).toBe(400);
  });
});

describe("authentication: token AND the runner's signature", () => {
  const expect401 = async (req: RunnerHttpRequest) => expect(await call(req)).toMatchObject(unauthorized);

  it("the token alone, without a signature, is 401", async () => {
    const r = await runner();
    await expect401({ method: "GET", headers: { authorization: `Bearer ${r.token}`, accept: "application/json" }, body: new Uint8Array(0) });
  });

  it("a signature alone, without a token (or a malformed bearer), is 401", async () => {
    const r = await runner();
    await expect401(wakeRequest(r, { token: null }));
    const req = wakeRequest(r);
    await expect401({ ...req, headers: { ...req.headers, authorization: `Basic ${r.token}` } });
    await expect401({ ...req, headers: { ...req.headers, authorization: `Bearer  ${r.token}` } });
  });

  it("tampered, expired, other-key-MAC'd and over-long tokens are 401", async () => {
    const r = await runner();
    const [body, mac] = r.token.split(".") as [string, string];
    await expect401(wakeRequest(r, { token: `${body}.${mac.slice(0, -2)}${mac.endsWith("AA") ? "BA" : "AA"}` }));
    await expect401(wakeRequest(r, { token: mintWakeToken(randomBytes(32), { runnerId: r.runnerId, accountId: r.accountId, jkt: r.key.jkt, publicKeyX: r.key.jwk.x }, clock) }));
    const old = await runner({ at: new Date(clock.getTime() - (WAKE_TOKEN_LIFETIME_SECONDS + 1) * 1000) });
    await expect401(wakeRequest(old));
    // Signed with the real key, but an expiry no mint gives: refused even though the MAC is ours.
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
    const longBody = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(clock.getTime() / 1000) + WAKE_TOKEN_LIFETIME_SECONDS + MAX_CREATED_SKEW_SECONDS + 3600 })).toString("base64url");
    await expect401(wakeRequest(r, { token: `${longBody}.${createHmac("sha256", KEY).update(longBody).digest("base64url")}` }));
  });

  it("a request signed by any key other than the token's is 401 (another runner's token, a stranger's key)", async () => {
    const a = await runner();
    const b = await runner({ accountId: a.accountId });
    await expect401(wakeRequest(a, { signer: b.key }));
    await expect401(wakeRequest(b, { token: a.token }));
    await expect401(wakeRequest(a, { signer: newKey() }));
  });

  it("a bad signature, a stale created time, a different URL or a changed method is 401", async () => {
    const r = await runner();
    const req = wakeRequest(r);
    const sig = req.headers.signature!;
    await expect401({ ...req, headers: { ...req.headers, signature: sig.replace(/:(.)/, (_m, c: string) => `:${c === "A" ? "B" : "A"}`) } });
    await expect401(wakeRequest(r, { created: Math.floor(clock.getTime() / 1000) - MAX_CREATED_SKEW_SECONDS - 5 }));
    await expect401(wakeRequest(r, { url: `${ORIGIN}/api/runner/claim` }));
    await expect401(wakeRequest(r, { url: `${ORIGIN}${WAKE_PATH}?x=1` }));
  });

  it("a replay inside the skew window gets the same answer (no nonce is recorded, as for hello and heartbeat); outside it, 401", async () => {
    const r = await runner();
    put(pending, runnerWorkKeyFor(r.accountId), 42);
    const req = wakeRequest(r);
    expect((await call(req)).body).toEqual({ epoch: 42, due_at: null });
    expect((await call(req)).body).toEqual({ epoch: 42, due_at: null });
    advance((MAX_CREATED_SKEW_SECONDS + 2) * 1000);
    await expect401(req);
  });

  it("no authentication refusal reads the store or writes a liveness stamp", async () => {
    const r = await runner();
    await expect401(wakeRequest(r, { token: null }));
    await expect401(wakeRequest(r, { signer: newKey() }));
    expect(pending.reads).toEqual([]);
    expect(seen.writes).toEqual([]);
  });
});

describe("revocation inside the token's lifetime", () => {
  it("revoke (and remove, revoke-all, membership): with a working cache the very next call is refused", async () => {
    const r = await runner();
    const bystander = await runner(); // another account: untouched
    expect((await call(wakeRequest(r))).status).toBe(200);
    await revokeRunnerWake([r.runnerId]);
    expect(pending.map.has(wakeAllowKeyFor(r.runnerId))).toBe(false);
    expect(await call(wakeRequest(r))).toMatchObject(unavailable);
    expect((await call(wakeRequest(bystander))).status).toBe(200);
  });

  it("a delete the client dropped is bounded by the record's one-hour TTL", async () => {
    const r = await runner();
    pending.droppingWrites = true;
    await revokeRunnerWake([r.runnerId]);
    pending.droppingWrites = false;
    expect((await call(wakeRequest(r))).status).toBe(200); // the documented exposure: timing only, every DB claim is refused
    advance(WAKE_ALLOW_MAX_TTL_SECONDS * 1000 + 1000);
    expect(await call(wakeRequest(r))).toMatchObject(unavailable);
  });

  it("rotate: the old key's token is refused; the record the new key's claim writes answers the new token", async () => {
    const r = await runner();
    await revokeRunnerWake([r.runnerId]);
    expect(await call(wakeRequest(r))).toMatchObject(unavailable);
    const next = newKey();
    await allowRunnerWake({ runnerId: r.runnerId, accountId: r.accountId, jkt: next.jkt, keyValidUntil: new Date(clock.getTime() + 30 * DAY) }, clock.getTime());
    expect(await call(wakeRequest(r))).toMatchObject(unauthorized); // the old token no longer matches the record
    const fresh: Runner = { key: next, runnerId: r.runnerId, accountId: r.accountId, token: mintWakeToken(KEY, { runnerId: r.runnerId, accountId: r.accountId, jkt: next.jkt, publicKeyX: next.jwk.x }, clock) };
    expect((await call(wakeRequest(fresh))).status).toBe(200);
  });

  it("account close: every runner of the account is refused", async () => {
    const a = await runner();
    const b = await runner({ accountId: a.accountId });
    await revokeRunnerWake([a.runnerId, b.runnerId]);
    expect(await call(wakeRequest(a))).toMatchObject(unavailable);
    expect(await call(wakeRequest(b))).toMatchObject(unavailable);
  });

  it("a claim that writes its record after the revoke committed is caught by the second delete", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const kept: Promise<unknown>[] = [];
      setPendingHooks({ store: pending, keepAlive: (p) => void kept.push(p) });
      const r = await runner();
      await revokeRunnerWake([r.runnerId]);
      // The in-flight claim lands after the first delete:
      await allowRunnerWake({ runnerId: r.runnerId, accountId: r.accountId, jkt: r.key.jkt, keyValidUntil: new Date(clock.getTime() + 30 * DAY) }, clock.getTime());
      expect(pending.map.has(wakeAllowKeyFor(r.runnerId))).toBe(true);
      await vi.advanceTimersByTimeAsync(WAKE_REVOKE_SECOND_DELETE_MS + 10);
      await Promise.all(kept);
      expect(pending.map.has(wakeAllowKeyFor(r.runnerId))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("every key is an id, never the token text, so every spelling of a token is refused alike", async () => {
    const r = await runner();
    await revokeRunnerWake([r.runnerId]);
    const [body, mac] = r.token.split(".") as [string, string];
    for (const key of [...pending.writes, wakeAllowKeyFor(r.runnerId)]) {
      expect(key).not.toContain(mac.slice(0, 10));
      expect(key).not.toContain(body.slice(0, 10));
    }
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(mac.at(-1)!);
    for (let low = 0; low < 4; low++) {
      const spelling = `${body}.${mac.slice(0, -1)}${alphabet[(last & ~3) | low]}`;
      expect(await call(wakeRequest(r, { token: spelling }))).toMatchObject(unavailable);
    }
  });

  it("one parallel round of three reads: the allow record and the account's two values", async () => {
    const r = await runner();
    pending.reads.length = 0;
    await call(wakeRequest(r));
    expect(new Set(pending.reads)).toEqual(new Set([wakeAllowKeyFor(r.runnerId), runnerWorkKeyFor(r.accountId), runnerWorkDueKeyFor(r.accountId)]));
    expect(pending.reads).toHaveLength(3);
  });

  it("revoking never throws to the revoking path, whatever the store does", async () => {
    pending.failing = true;
    await expect(revokeRunnerWake([randomUUID()])).resolves.toBeUndefined();
    setPendingHooks(null);
    await expect(revokeRunnerWake([randomUUID()])).resolves.toBeUndefined();
  });
});

describe("cross-account: a token from account A never reads account B", () => {
  it("property over random ids: A's reply is A's values, B's keys are never read", async () => {
    for (let i = 0; i < 200; i++) {
      const a = await runner();
      const b = await runner();
      pending.reads.length = 0;
      put(pending, runnerWorkKeyFor(a.accountId), 1_000 + i);
      put(pending, runnerWorkKeyFor(b.accountId), 9_000_000 + i);
      put(pending, runnerWorkDueKeyFor(b.accountId), 9_500_000 + i);
      pending.map.delete(wakeAllowKeyFor(b.runnerId)); // B revoked: must not affect A
      expect((await call(wakeRequest(a))).body).toEqual({ epoch: 1_000 + i, due_at: null });
      expect(pending.reads.some((key) => key.includes(b.accountId) || key.includes(b.runnerId) || key.includes(b.key.jkt))).toBe(false);
      // B's token signed by A's key: refused before anything is read.
      pending.reads.length = 0;
      expect((await call(wakeRequest(a, { token: b.token }))).status).toBe(401);
      expect(pending.reads).toEqual([]);
      // A's record never answers B's token (each record names its own runner, key and account).
      expect(wakeAllowValue(a.key.jkt, a.accountId)).not.toBe(wakeAllowValue(a.key.jkt, b.accountId));
    }
  });
});

describe("liveness stamp", () => {
  it("writes seen:<rid> on a verified call, at most once a minute per process, without ever reading the cache", async () => {
    const d = deps();
    const r = await runner();
    await call(wakeRequest(r), d);
    expect(seen.writes).toEqual([runnerSeenKey(r.runnerId)]);
    expect(JSON.parse(seen.map.get(runnerSeenKey(r.runnerId))!.json)).toBe(clock.getTime());
    advance(RUNNER_SEEN_REFRESH_MS - 1000);
    await call(wakeRequest(r), d);
    expect(seen.writes).toHaveLength(1);
    advance(2000);
    await call(wakeRequest(r), d);
    expect(seen.writes).toHaveLength(2);
    expect(seen.reads).toEqual([]);
  });

  it("a liveness store that never answers does not fail the check; it is logged to stdout", async () => {
    seen.hanging = true;
    const r = await runner();
    expect((await call(wakeRequest(r))).status).toBe(200);
    expect(lines.some((l) => l.includes("runner_wake.seen_failed"))).toBe(true);
  });

  it("a refused runner gets no stamp", async () => {
    const r = await runner();
    await revokeRunnerWake([r.runnerId]);
    await call(wakeRequest(r));
    expect(seen.writes).toEqual([]);
  });

  it("the writer's memory is bounded", async () => {
    const write = runnerSeenWriter(seen, 3);
    for (const id of ["a", "b", "c", "d"]) expect(await write(id, clock)).toBe(true);
    expect(await write("d", clock)).toBe(false);
    expect(await write("a", clock)).toBe(true); // forgotten when the map was cleared: one extra write, never a missing one
  });
});

describe("the safety claim's retry_after for a runner holding a grant", () => {
  it("lands just after the next 30-minute slot boundary, within the per-runner jitter, and inside the protocol bound", () => {
    for (let i = 0; i < 500; i++) {
      const id = randomUUID();
      const now = new Date(Date.UTC(2026, 9, 23) + Math.floor(Math.random() * DAY));
      const s = wakeSafetyRetryAfterSeconds(id, now);
      const boundary = (Math.floor(now.getTime() / BACKSTOP_MS) + 1) * BACKSTOP_MS;
      const at = now.getTime() + s * 1000;
      expect(at).toBeGreaterThanOrEqual(boundary);
      expect(at).toBeLessThan(boundary + (WAKE_SAFETY_JITTER_SECONDS + 1) * 1000);
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThanOrEqual(1800 + WAKE_SAFETY_JITTER_SECONDS);
      expect(s).toBeLessThan(WAKE_ALLOW_MAX_TTL_SECONDS); // the next claim always comes before the allow record ends
      const later = new Date(now.getTime() + 1000);
      if (later.getTime() < boundary - 1000) expect(later.getTime() + wakeSafetyRetryAfterSeconds(id, later) * 1000).toBe(at);
    }
  });
});

import { randomBytes, randomUUID } from "node:crypto";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { WAKE_PATH, jwkThumbprint, signRequest, type Ed25519Jwk } from "@fulcrumaxe/runner-protocol";
import { allowRunnerWake, runnerWorkKeyFor, setPendingHooks } from "@fx/core/src/pendingWork";
import { mintWakeToken } from "@fx/runner-cloud";
import { makeRegion, storeOf } from "../../../../test/support/runtimeCacheFake";

/**
 * D#6 RUNNER-WAKE R3b: GET /api/runner/wake through the real route module and its default deps. `createPool` is mocked so a pool created
 * anywhere on this path (the runner deps, the auth deps, the error reporter) fails the zero-connection assertion.
 */
const createPool = vi.hoisted(() => vi.fn(() => ({ fake: "pool" })));
vi.mock("@fx/db/src/pool", () => ({ createPool }));
vi.mock("@fx/db/src/pool.js", () => ({ createPool }));

const ORIGIN = "https://runner.example.test";
const KEY = randomBytes(32).toString("base64url");

function runnerKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as Ed25519Jwk;
  return { privateKey, x: jwk.x, jkt: jwkThumbprint({ kty: "OKP", crv: "Ed25519", x: jwk.x }) };
}

/** What a claim that granted leaves: a token, and the allow record in the installed store. */
async function grant(k: ReturnType<typeof runnerKey>, accountId: string): Promise<string> {
  const runnerId = randomUUID();
  await allowRunnerWake({ runnerId, accountId, jkt: k.jkt, keyValidUntil: new Date(Date.now() + 86_400_000) });
  return mintWakeToken(Buffer.from(KEY, "utf8"), { runnerId, accountId, jkt: k.jkt, publicKeyX: k.x }, new Date());
}

function wakeRequest(k: ReturnType<typeof runnerKey>, token: string, accept = "application/json"): NextRequest {
  const signature = signRequest({ method: "GET", url: `${ORIGIN}${WAKE_PATH}`, body: new Uint8Array(0), privateKey: k.privateKey, keyid: k.jkt, nonce: randomBytes(16).toString("base64url"), created: Math.floor(Date.now() / 1000) });
  return new NextRequest(`https://attacker.example${WAKE_PATH}`, { method: "GET", headers: { ...signature, authorization: `Bearer ${token}`, accept } });
}

beforeEach(() => {
  vi.stubEnv("FX_APP_ORIGIN", ORIGIN);
  vi.stubEnv("FX_RUNNER_WAKE_KEY", KEY);
  vi.stubEnv("DATABASE_URL_APP_USER", "postgres://app_user@localhost/none");
  vi.stubEnv("DATABASE_URL_PLATFORM_OPS", "postgres://platform_ops@localhost/none");
  createPool.mockClear();
  setPendingHooks({ store: storeOf(makeRegion({ value: Date.now() })) });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  setPendingHooks(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/runner/wake", () => {
  it("1000 calls (answered, refused and unconfigured) create ZERO database pools", async () => {
    vi.resetModules();
    const { GET } = await import("./route");
    const k = runnerKey();
    const accountId = randomUUID();
    const token = await grant(k, accountId);
    const statuses = new Map<number, number>();
    for (let i = 0; i < 1000; i++) {
      let req: NextRequest;
      if (i % 10 === 1) req = wakeRequest(k, token, "text/event-stream"); // 406
      else if (i % 10 === 2) req = wakeRequest(runnerKey(), token); // 401: another key
      else if (i % 10 === 3) req = new NextRequest(`${ORIGIN}${WAKE_PATH}`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } }); // 401: token alone
      else req = wakeRequest(k, token);
      if (i === 500) vi.stubEnv("FX_RUNNER_WAKE_KEY", ""); // the rest of one stretch is unconfigured: 503
      if (i === 510) vi.stubEnv("FX_RUNNER_WAKE_KEY", KEY);
      const res = await GET(req);
      statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
    }
    expect(createPool).not.toHaveBeenCalled();
    expect([...statuses.keys()].sort()).toEqual([200, 401, 406, 503]);
  });

  it("answers the account's epoch as strict JSON with no-store", async () => {
    const { GET } = await import("./route");
    const k = runnerKey();
    const accountId = randomUUID();
    const store = storeOf(makeRegion({ value: Date.now() }));
    setPendingHooks({ store });
    await store.set(runnerWorkKeyFor(accountId), 123_456, 60);
    const token = await grant(k, accountId);
    const res = await GET(wakeRequest(k, token));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ epoch: 123_456, due_at: null });
    expect(createPool).not.toHaveBeenCalled();
  });

  it("no wake key is 503 not_configured, a non-JSON Accept is 406", async () => {
    const { GET } = await import("./route");
    const k = runnerKey();
    const token = mintWakeToken(Buffer.from(KEY, "utf8"), { runnerId: randomUUID(), accountId: randomUUID(), jkt: k.jkt, publicKeyX: k.x }, new Date());
    expect((await GET(wakeRequest(k, token, "*/*"))).status).toBe(406);
    vi.stubEnv("FX_RUNNER_WAKE_KEY", "");
    const res = await GET(wakeRequest(k, token));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "not_configured" } });
  });
});

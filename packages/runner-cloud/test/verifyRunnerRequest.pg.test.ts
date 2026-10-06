import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signRequest } from "@fulcrumaxe/runner-protocol";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { MAX_BODY_BYTES, RunnerHttpError, verifyRunnerRequest, withRunnerSession, type RunnerHttpRequest } from "../src/index.js";
import { ORIGIN, harness, newKey, registerKey, signed, type Harness, type TestKey } from "./helpers.js";

const PATH = "/api/runner/hello";

describe("verifyRunnerRequest [pg]", () => {
  let h: Harness;
  let a: SeedRefs;
  let b: SeedRefs;
  const NOW = new Date("2026-10-04T12:00:00Z");
  const nowSeconds = Math.floor(NOW.getTime() / 1000);
  const withClock = () => h.deps({ now: () => NOW });

  beforeAll(async () => {
    h = await harness();
    a = await seedAccount(h.admin, randomUUID());
    b = await seedAccount(h.admin, randomUUID());
  });
  afterAll(() => h.close());

  /** A registered runner of account A and a request it signed at `created`. */
  async function runner(): Promise<TestKey & { id: string }> {
    const key = newKey();
    return { ...key, id: await registerKey(h.admin, a.accountId, a.userId, key) };
  }
  const statusOf = async (run: () => Promise<unknown>): Promise<number | string> => {
    try {
      await run();
      return "ok";
    } catch (e) {
      if (e instanceof RunnerHttpError) return e.status;
      throw e;
    }
  };
  const verify = (req: RunnerHttpRequest, replay: "once" | "none" = "none", deps = withClock()) => verifyRunnerRequest(deps, PATH, req, { replay });

  it("accepts a signed request and takes the tenant from the runner's row, whatever the request claims", async () => {
    const k = await runner();
    const req = signed(k, PATH, { account_id: b.accountId }, { created: nowSeconds });
    req.headers = { ...req.headers, "x-fx-account-id": b.accountId };
    const verified = await verify(req);
    expect(verified).toMatchObject({ runnerId: k.id, accountId: a.accountId, jkt: k.jkt });
  });

  it("refuses unsigned, tampered and re-aimed requests with 401", async () => {
    const k = await runner();
    const good = signed(k, PATH, { x: 1 }, { created: nowSeconds });
    const { signature: _s, "signature-input": _i, ...unsigned } = good.headers;
    expect(await statusOf(() => verify({ ...good, headers: unsigned }))).toBe(401);
    expect(await statusOf(() => verify({ ...good, body: Buffer.from('{"x":2}') }))).toBe(401);
    expect(await statusOf(() => verify({ ...good, method: "PUT" }))).toBe(401);
    expect(await statusOf(() => verify(signed(k, PATH, {}, { created: nowSeconds, url: `${ORIGIN}/api/runner/other` })))).toBe(401);
    expect(await statusOf(() => verify(signed(newKey(), PATH, {}, { created: nowSeconds })))).toBe(401);
    expect(await statusOf(() => verify(good))).toBe("ok");
  });

  it("checks the signature against the configured origin and path, never the Host header", async () => {
    const k = await runner();
    // Signed for the host the client claims in its own headers: refused.
    expect(await statusOf(() => verify(signed(k, PATH, {}, { created: nowSeconds, url: `https://attacker.example${PATH}` })))).toBe(401);
    // Signed for the configured origin while every Host-like header says otherwise: accepted.
    const req = signed(k, PATH, {}, { created: nowSeconds });
    expect(req.headers.host).toBe("attacker.example");
    expect(await statusOf(() => verify(req))).toBe("ok");
  });

  it("answers 503 when the origin is not a bare configured origin", async () => {
    const k = await runner();
    const req = signed(k, PATH, {}, { created: nowSeconds });
    for (const origin of [undefined, "", "not a url", "ftp://runner.example.test", `${ORIGIN}/prefix`, `${ORIGIN}?q=1`, "https://user@runner.example.test"]) {
      expect(await statusOf(() => verify(req, "none", h.deps({ now: () => NOW, origin }))), String(origin)).toBe(503);
    }
  });

  it("answers 413 to an oversize body before any key lookup or signature work", async () => {
    let lookups = 0;
    const deps = withClock();
    const spy = { ...deps, platformOpsPool: { query: () => { lookups++; throw new Error("no lookup expected"); }, connect: () => { lookups++; throw new Error("no connect expected"); } } as unknown as typeof deps.platformOpsPool };
    const big: RunnerHttpRequest = { method: "POST", headers: {}, body: Buffer.alloc(MAX_BODY_BYTES + 1) };
    expect(await statusOf(() => verify(big, "none", spy))).toBe(413);
    expect(lookups).toBe(0);
    const k = await runner();
    expect(await statusOf(() => verify(signed(k, PATH, null, { created: nowSeconds, rawBody: Buffer.alloc(MAX_BODY_BYTES) })))).toBe("ok");
  });

  it("enforces the created window of 60 seconds either side", async () => {
    const k = await runner();
    expect(await statusOf(() => verify(signed(k, PATH, {}, { created: nowSeconds - 60 })))).toBe("ok");
    expect(await statusOf(() => verify(signed(k, PATH, {}, { created: nowSeconds + 60 })))).toBe("ok");
    expect(await statusOf(() => verify(signed(k, PATH, {}, { created: nowSeconds - 61 })))).toBe(401);
    expect(await statusOf(() => verify(signed(k, PATH, {}, { created: nowSeconds + 61 })))).toBe(401);
  });

  it("rejects a reused nonce on a once-only endpoint, remembers only verified requests, and prunes after 2 minutes", async () => {
    const k = await runner();
    const nonce = "A".repeat(22);
    expect(await statusOf(() => verify(signed(k, PATH, {}, { created: nowSeconds, nonce }), "once"))).toBe("ok");
    expect(await statusOf(() => verify(signed(k, PATH, { again: 1 }, { created: nowSeconds, nonce }), "once"))).toBe(409);
    expect(await statusOf(() => verify(signed(k, PATH, {}, { created: nowSeconds, nonce: "B".repeat(22) }), "once"))).toBe("ok");
    // An idempotent endpoint stores nothing, so the same nonce is not a replay there.
    expect(await statusOf(() => verify(signed(k, PATH, {}, { created: nowSeconds, nonce: "C".repeat(22) }), "none"))).toBe("ok");
    expect(await statusOf(() => verify(signed(k, PATH, {}, { created: nowSeconds, nonce: "C".repeat(22) }), "none"))).toBe("ok");
    // A request that fails verification leaves no nonce behind.
    const forged = signed(k, PATH, {}, { created: nowSeconds, nonce: "D".repeat(22) });
    expect(await statusOf(() => verify({ ...forged, body: Buffer.from("{}x") }, "once"))).toBe(401);
    const stored = (n: string) => h.admin.query("SELECT 1 FROM runner_request_nonces WHERE runner_id = $1 AND nonce = $2", [k.id, n]);
    expect((await stored("D".repeat(22))).rowCount).toBe(0);
    // Rows older than the 2 minute window are pruned by the next once-only request; fresh ones stay.
    await h.admin.query(`UPDATE runner_request_nonces SET seen_at = now() - interval '121 seconds' WHERE runner_id = $1 AND nonce = $2`, [k.id, nonce]);
    await h.admin.query(`UPDATE runner_request_nonces SET seen_at = now() - interval '119 seconds' WHERE runner_id = $1 AND nonce = $2`, [k.id, "B".repeat(22)]);
    expect(await statusOf(() => verify(signed(k, PATH, {}, { created: nowSeconds, nonce: "E".repeat(22) }), "once"))).toBe("ok");
    expect((await stored(nonce)).rowCount).toBe(0);
    expect((await stored("B".repeat(22))).rowCount).toBe(1);
  });

  it("refuses a revoked runner on its very next request", async () => {
    const k = await runner();
    expect(await statusOf(() => verify(signed(k, PATH, {}, { created: nowSeconds })))).toBe("ok");
    await h.admin.query("UPDATE runners SET revoked_at = now(), revoked_reason = 'revoked' WHERE id = $1", [k.id]);
    expect(await statusOf(() => verify(signed(k, PATH, {}, { created: nowSeconds })))).toBe(401);
  });

  it("refuses a key older than 90 days with reregister_required, counting from the last rotation", async () => {
    const k = await runner();
    const setAge = (days: number, rotated: boolean) =>
      h.admin.query(
        rotated
          ? `UPDATE runners SET created_at = now() - interval '200 days', key_rotated_at = now() - make_interval(days => $2) WHERE id = $1`
          : `UPDATE runners SET created_at = now() - make_interval(days => $2), key_rotated_at = NULL WHERE id = $1`,
        [k.id, days],
      );
    const clock = () => h.deps({ now: () => new Date() });
    const req = () => signed(k, PATH, {});
    await setAge(89, false);
    expect(await statusOf(() => verify(req(), "none", clock()))).toBe("ok");
    await setAge(91, false);
    await expect(verify(req(), "none", clock())).rejects.toMatchObject({ status: 401, code: "reregister_required" });
    await setAge(10, true);
    expect(await statusOf(() => verify(req(), "none", clock()))).toBe("ok");
  });

  it("refuses a stored key of small order, even though OpenSSL would accept a forged signature under it", async () => {
    const zero = { kty: "OKP", crv: "Ed25519", x: Buffer.alloc(32).toString("base64url") };
    const { jwkThumbprint } = await import("@fulcrumaxe/runner-protocol");
    const jkt = jwkThumbprint(zero as never);
    await h.admin.query(`INSERT INTO runners (account_id, registered_by, public_key_jwk, jkt, credential_mode) VALUES ($1, $2, $3::jsonb, $4, 'api_key')`, [a.accountId, a.userId, JSON.stringify(zero), jkt]);
    // About one message in four verifies under R = A, S = 0; vary the nonce until it would.
    const decoy = newKey();
    let accepted = 0;
    for (let i = 0; i < 40; i++) {
      const nonce = `forge${String(i).padStart(20, "0")}`;
      const headers = signRequest({ method: "POST", url: `${ORIGIN}${PATH}`, body: Buffer.from("{}"), privateKey: decoy.privateKey, keyid: jkt, nonce, created: nowSeconds });
      const forged = { ...headers, signature: `fx=:${Buffer.concat([Buffer.alloc(32), Buffer.alloc(32)]).toString("base64")}:` };
      if ((await statusOf(() => verify({ method: "POST", headers: forged, body: Buffer.from("{}") }))) === "ok") accepted++;
    }
    expect(accepted).toBe(0);
  });

  it("sets app.runner_id only through withRunnerSession, only for a verified runner, only for that transaction", async () => {
    const k = await runner();
    const verified = await verify(signed(k, PATH, {}, { created: nowSeconds }));
    const seen = await withRunnerSession(h.appPool, verified, async (c) => (await c.query<{ r: string; t: string }>("SELECT current_setting('app.runner_id', true) AS r, current_setting('app.account_id', true) AS t")).rows[0]);
    expect(seen).toEqual({ r: k.id, t: a.accountId });
    const after = await h.appPool.connect();
    try {
      expect((await after.query("SELECT current_setting('app.runner_id', true) AS r")).rows[0].r ?? "").toBe("");
    } finally {
      after.release();
    }
    // An object that did not come from the verifier is refused, however well formed.
    const forged = { runnerId: k.id, accountId: a.accountId, registeredBy: a.userId, credentialMode: "api_key", jkt: k.jkt };
    await expect(withRunnerSession(h.appPool, forged, async () => 1)).rejects.toThrow("not a verified runner");
    await expect(withRunnerSession(h.appPool, { ...verified }, async () => 1)).rejects.toThrow("not a verified runner");
  });

  it("a runner session sees its own account's rows and no other account's, so another account's run id finds nothing", async () => {
    const k = await runner();
    const verified = await verify(signed(k, PATH, {}, { created: nowSeconds }));
    const rows = await withRunnerSession(h.appPool, verified, async (c) => ({
      other: (await c.query("SELECT 1 FROM agent_runs WHERE id = $1", [b.runId])).rowCount,
      own: (await c.query("SELECT 1 FROM agent_runs WHERE id = $1", [a.runId])).rowCount,
    }));
    expect(rows).toEqual({ other: 0, own: 1 });
  });
});

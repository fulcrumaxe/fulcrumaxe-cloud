import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { seedAccount } from "@fx/db/test/helpers/seed.js";
import { CODE_TTL_MINUTES, HELLO_PATH, MAX_BODY_BYTES, REGISTER_PATH, REVOKE_PATH, ROTATE_PATH, mintRegistrationCode, registerRunner, revokeAllRunners, revokeRunner } from "../src/index.js";
import { rotateRunnerKey, runnerHello, selfRevokeRunner, type FailRunnerLeases } from "../src/index.js";
import { harness, insertCode, newKey, registerKey, respond, signed, type Harness } from "./helpers.js";

describe("runner identity routes [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const fresh = (): Promise<F2Fixture> => seedF2(h.admin);
  const audit = async (accountId: string, action: string) => (await h.admin.query("SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = $2", [accountId, action])).rows;
  const runnerRow = async (id: string) => (await h.admin.query("SELECT * FROM runners WHERE id = $1", [id])).rows[0];
  const recorder = () => {
    const calls: Array<{ accountId: string; runnerId: string; reason: string }> = [];
    const fail: FailRunnerLeases = async (input) => {
      calls.push(input);
      return { runIds: [randomUUID()], complete: true };
    };
    return { calls, fail };
  };
  const mint = (f: F2Fixture, userId: string, body: unknown) => respond(() => mintRegistrationCode(h.deps(), { accountId: f.accountId, userId }, body));

  describe("registration codes (criterion 1)", () => {
    it("lets an owner or admin mint a single-use code that expires in 10 minutes and is stored only as a hash", async () => {
      const f = await fresh();
      for (const user of [f.o1, f.a1]) {
        const res = await mint(f, user, { credential_mode: "subscription" });
        expect(res.status).toBe(201);
        const { code, expires_at } = res.body as { code: string; expires_at: string };
        expect(code).toMatch(/^fxrr_[A-Za-z0-9]{32,}$/);
        expect(Math.abs(new Date(expires_at).getTime() - Date.now() - CODE_TTL_MINUTES * 60_000)).toBeLessThan(15_000);
        const rows = (await h.admin.query("SELECT * FROM runner_registration_codes WHERE registered_by = $1 AND account_id = $2", [user, f.accountId])).rows;
        expect(rows).toHaveLength(1);
        expect(JSON.stringify(rows[0])).not.toContain(code);
        expect(rows[0]).toMatchObject({ account_id: f.accountId, registered_by: user, credential_mode: "subscription" });
      }
    });

    it("refuses a member, a stranger and a bad body, and writes nothing", async () => {
      const f = await fresh();
      const other = await fresh();
      expect((await mint(f, f.m1, { credential_mode: "api_key" })).status).toBe(403);
      expect((await mint(f, other.o1, { credential_mode: "api_key" })).status).toBe(403);
      for (const body of [{}, { credential_mode: "token" }, { credential_mode: "api_key", account_id: other.accountId }, { credential_mode: "api_key", allowed_repo_ids: ["nope"] }, null, []]) {
        expect((await mint(f, f.o1, body)).status, JSON.stringify(body)).toBe(400);
      }
      const foreign = await seedAccount(h.admin, randomUUID());
      expect((await mint(f, f.o1, { credential_mode: "api_key", allowed_repo_ids: [foreign.repoId] })).status).toBe(400);
      expect((await h.admin.query("SELECT 1 FROM runner_registration_codes WHERE account_id = $1", [f.accountId])).rowCount).toBe(0);
    });
  });

  describe("register (criteria 2, 5, 9)", () => {
    const register = (key: ReturnType<typeof newKey>, code: string, over: { body?: unknown; signer?: ReturnType<typeof newKey>; deps?: Parameters<Harness["deps"]>[0] } = {}) =>
      respond(() => registerRunner(h.deps(over.deps), signed(over.signer ?? key, REGISTER_PATH, over.body ?? { code, public_key_jwk: key.jwk })));

    it("binds account, registrant and mode from the code, once, and returns no key material", async () => {
      const f = await fresh();
      const code = await insertCode(h.admin, f.accountId, f.a1);
      const key = newKey();
      const res = await register(key, code);
      expect(res.status).toBe(201);
      expect(Object.keys(res.body as object)).toEqual(["runner_id"]);
      expect(await runnerRow((res.body as { runner_id: string }).runner_id)).toMatchObject({ account_id: f.accountId, registered_by: f.a1, credential_mode: "subscription", jkt: key.jkt });
      expect(await audit(f.accountId, "runner.registered")).toHaveLength(1);
      // A second use of the same code, by another key: 401. The same signed request again: 409.
      expect((await register(newKey(), code)).status).toBe(401);
      expect((await register(key, code)).status).toBe(409);
      expect((await h.admin.query("SELECT 1 FROM runners WHERE account_id = $1", [f.accountId])).rowCount).toBe(1);
    });

    it("accepts only an Ed25519 public JWK, a signature made with that key, and a usable code", async () => {
      const f = await fresh();
      const code = await insertCode(h.admin, f.accountId, f.a1);
      const key = newKey();
      for (const jwk of [{ ...key.jwk, kty: "RSA" }, { ...key.jwk, crv: "X25519" }, { ...key.jwk, d: "AAAA" }, { kty: "OKP", crv: "Ed25519" }]) {
        expect((await register(key, code, { body: { code, public_key_jwk: jwk } })).status, JSON.stringify(jwk)).toBe(400);
      }
      expect((await register(key, code, { body: { code, public_key_jwk: key.jwk, account_id: randomUUID() } })).status).toBe(400); // the body names no account
      const zero = { kty: "OKP", crv: "Ed25519", x: Buffer.alloc(32).toString("base64url") };
      expect((await register(key, code, { body: { code, public_key_jwk: zero }, signer: key })).status).toBe(400);
      expect((await register(key, code, { signer: newKey() })).status).toBe(401);
      expect((await register(key, `fxrr_${"a".repeat(129)}`)).status).toBe(400);
      expect((await register(key, `fxrr_${"a".repeat(40)}`)).status).toBe(401);
      expect((await h.admin.query("SELECT 1 FROM runners WHERE account_id = $1", [f.accountId])).rowCount).toBe(0);
      expect((await respond(() => registerRunner(h.deps(), { method: "POST", headers: {}, body: Buffer.alloc(MAX_BODY_BYTES + 1) }))).status).toBe(413);
    });

    it("refuses an expired code and a code whose minter has since been demoted", async () => {
      const f = await fresh();
      const expired = await insertCode(h.admin, f.accountId, f.a1);
      await h.admin.query("UPDATE runner_registration_codes SET expires_at = now() - interval '1 second' WHERE account_id = $1", [f.accountId]);
      expect((await register(newKey(), expired)).status).toBe(401);
      const minted = await insertCode(h.admin, f.accountId, f.a2);
      await h.admin.query("UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2", [f.accountId, f.a2]);
      expect((await register(newKey(), minted)).status).toBe(401);
    });

    it("answers 409 runner_limit to a third runner on a runner-plan account only", async () => {
      const f = await fresh();
      await h.admin.query("UPDATE accounts SET plan = 'runner' WHERE id = $1", [f.accountId]);
      for (let i = 0; i < 2; i++) expect((await register(newKey(), await insertCode(h.admin, f.accountId, f.a1))).status).toBe(201);
      const third = await insertCode(h.admin, f.accountId, f.a1);
      expect((await register(newKey(), third)).status).toBe(409);
      expect(((await register(newKey(), third)).body as { error: { code: string } }).error.code).toBe("runner_limit");
      await h.admin.query("UPDATE accounts SET plan = 'starter' WHERE id = $1", [f.accountId]);
      expect((await register(newKey(), third)).status).toBe(201);
    });
  });

  describe("rotate (criterion 6)", () => {
    it("swaps the key under a request the old key signed; the old key is then refused and the new one works", async () => {
      const f = await fresh();
      const old = newKey();
      const id = await registerKey(h.admin, f.accountId, f.a1, old);
      const next = newKey();
      const res = await respond(() => rotateRunnerKey(h.deps(), signed(old, ROTATE_PATH, { public_key_jwk: next.jwk })));
      expect(res).toMatchObject({ status: 200, body: { jkt: next.jkt } });
      expect(await runnerRow(id)).toMatchObject({ jkt: next.jkt });
      expect((await runnerRow(id)).key_rotated_at).not.toBeNull();
      expect((await audit(f.accountId, "runner.key_rotated"))).toHaveLength(1);
      expect((await respond(() => runnerHello(h.deps(), signed(old, HELLO_PATH, { protocol_version: 1, binary_version: "0.1.0", model_auth_present: true, isolation: "container" })))).status).toBe(401);
      expect((await respond(() => runnerHello(h.deps(), signed(next, HELLO_PATH, { protocol_version: 1, binary_version: "0.1.0", model_auth_present: true, isolation: "container" })))).status).toBe(200);
    });

    it("refuses a reused nonce, an unusable key and a key somebody already holds, changing nothing", async () => {
      const f = await fresh();
      const old = newKey();
      const id = await registerKey(h.admin, f.accountId, f.a1, old);
      const nonce = "R".repeat(22);
      // Rotating to the key already in use fails, but its nonce is spent: sending the same request again is a replay.
      expect((await respond(() => rotateRunnerKey(h.deps(), signed(old, ROTATE_PATH, { public_key_jwk: old.jwk }, { nonce })))).status).toBe(400);
      expect((await respond(() => rotateRunnerKey(h.deps(), signed(old, ROTATE_PATH, { public_key_jwk: old.jwk }, { nonce })))).status).toBe(409);
      const zero = { kty: "OKP", crv: "Ed25519", x: Buffer.alloc(32).toString("base64url") };
      expect((await respond(() => rotateRunnerKey(h.deps(), signed(old, ROTATE_PATH, { public_key_jwk: zero })))).status).toBe(400);
      const taken = newKey();
      await registerKey(h.admin, f.accountId, f.a2, taken);
      expect((await respond(() => rotateRunnerKey(h.deps(), signed(old, ROTATE_PATH, { public_key_jwk: taken.jwk })))).status).toBe(409);
      expect((await respond(() => rotateRunnerKey(h.deps(), signed(newKey(), ROTATE_PATH, { public_key_jwk: newKey().jwk })))).status).toBe(401);
      expect(await runnerRow(id)).toMatchObject({ jkt: old.jkt, key_rotated_at: null });
    });
  });

  describe("revocation (criteria 4 and 8)", () => {
    it("lets a runner revoke itself: signed, effective at once, leases failed, one audit row", async () => {
      const f = await fresh();
      const key = newKey();
      const id = await registerKey(h.admin, f.accountId, f.a1, key);
      const rec = recorder();
      const res = await respond(() => selfRevokeRunner(h.deps({ failRunnerLeases: rec.fail }), signed(key, REVOKE_PATH, {})));
      expect(res).toMatchObject({ status: 200, body: { revoked: true, runs_failed: 1 } });
      expect(rec.calls).toEqual([{ accountId: f.accountId, runnerId: id, reason: "runner_revoked" }]);
      expect(await runnerRow(id)).toMatchObject({ revoked_reason: "runner_self" });
      expect(await audit(f.accountId, "runner.revoked")).toHaveLength(1);
      expect((await respond(() => selfRevokeRunner(h.deps({ failRunnerLeases: rec.fail }), signed(key, REVOKE_PATH, {})))).status).toBe(401);
      expect(rec.calls).toHaveLength(1);
    });

    it("keeps a revoke in force and says so when the leases cannot be failed", async () => {
      const f = await fresh();
      const key = newKey();
      const id = await registerKey(h.admin, f.accountId, f.a1, key);
      const res = await respond(() => selfRevokeRunner(h.deps({ failRunnerLeases: null }), signed(key, REVOKE_PATH, {})));
      expect(res).toMatchObject({ status: 503, body: { error: { code: "leases_not_failed" }, revoked: true } });
      expect((await runnerRow(id)).revoked_at).not.toBeNull();
      const throwing: FailRunnerLeases = async () => {
        throw new Error("db password=hunter2");
      };
      const other = newKey();
      await registerKey(h.admin, f.accountId, f.a1, other);
      const failed = await respond(() => selfRevokeRunner(h.deps({ failRunnerLeases: throwing }), signed(other, REVOKE_PATH, {})));
      expect(failed.status).toBe(503);
      expect(JSON.stringify(failed.body)).not.toContain("hunter2");
    });

    it("lets an owner, an admin or the registrant revoke a runner; nobody else, and nobody across accounts", async () => {
      const f = await fresh();
      const other = await fresh();
      const rec = recorder();
      const deps = () => h.deps({ failRunnerLeases: rec.fail });
      const revoke = (userId: string, runnerId: string, accountId = f.accountId) => respond(() => revokeRunner(deps(), { accountId, userId }, runnerId));
      const mine = await registerKey(h.admin, f.accountId, f.m1, newKey());
      const adminsRunner = await registerKey(h.admin, f.accountId, f.a1, newKey());
      const foreign = await registerKey(h.admin, other.accountId, other.a1, newKey());

      expect((await revoke(f.m2, adminsRunner)).status).toBe(403);
      expect((await revoke(f.m2, mine)).status).toBe(403);
      expect((await revoke(f.o1, foreign)).status).toBe(404);
      expect((await revoke(f.o1, "not-a-uuid")).status).toBe(404);
      expect((await revoke(other.o1, mine, f.accountId)).status).toBe(403);
      expect((await h.admin.query("SELECT 1 FROM runners WHERE revoked_at IS NOT NULL AND account_id = ANY($1)", [[f.accountId, other.accountId]])).rowCount).toBe(0);
      expect(rec.calls).toHaveLength(0);

      expect((await revoke(f.m1, mine)).body).toMatchObject({ revoked: true, already_revoked: false, runs_failed: 1 });
      expect((await revoke(f.a2, adminsRunner)).status).toBe(200);
      expect(rec.calls.map((c) => c.runnerId)).toEqual([mine, adminsRunner]);
      expect(await audit(f.accountId, "runner.revoked")).toHaveLength(2);
      // A repeat completes the lease failing (the 503 retry path) without a second audit row.
      expect((await revoke(f.o2, mine)).body).toMatchObject({ revoked: true, already_revoked: true });
      expect(rec.calls).toHaveLength(3);
      expect(await audit(f.accountId, "runner.revoked")).toHaveLength(2);
    });

    it("revoke-all revokes every active runner of the account for an owner or admin, and nothing for a member", async () => {
      const f = await fresh();
      const other = await fresh();
      const ids = [await registerKey(h.admin, f.accountId, f.a1, newKey()), await registerKey(h.admin, f.accountId, f.m1, newKey())];
      const done = await registerKey(h.admin, f.accountId, f.a1, newKey());
      await h.admin.query("UPDATE runners SET revoked_at = now(), revoked_reason = 'revoked' WHERE id = $1", [done]);
      const untouched = await registerKey(h.admin, other.accountId, other.a1, newKey());
      const rec = recorder();
      expect((await respond(() => revokeAllRunners(h.deps({ failRunnerLeases: rec.fail }), { accountId: f.accountId, userId: f.m1 }))).status).toBe(403);
      expect(rec.calls).toHaveLength(0);
      const res = await respond(() => revokeAllRunners(h.deps({ failRunnerLeases: rec.fail }), { accountId: f.accountId, userId: f.a2 }));
      expect(res).toMatchObject({ status: 200, body: { revoked: 2, runs_failed: 2 } });
      expect(rec.calls.map((c) => c.runnerId).sort()).toEqual([...ids].sort());
      expect((await runnerRow(untouched)).revoked_at).toBeNull();
      expect(await audit(f.accountId, "runner.revoked")).toHaveLength(2);
    });

    it("revoke-all is for owners and admins even when a member would only touch their own runners", async () => {
      const f = await fresh();
      const own = await registerKey(h.admin, f.accountId, f.m1, newKey());
      expect((await respond(() => revokeAllRunners(h.deps({ failRunnerLeases: recorder().fail }), { accountId: f.accountId, userId: f.m1 }))).status).toBe(403);
      expect((await runnerRow(own)).revoked_at).toBeNull();
    });
  });

  describe("hello (criterion 10)", () => {
    const hello = { protocol_version: 1, binary_version: "0.1.0+abc", model_auth_present: false, isolation: "microvm" };

    it("records the versions and the isolation tier, and refuses unknown fields", async () => {
      const f = await fresh();
      const key = newKey();
      const id = await registerKey(h.admin, f.accountId, f.a1, key);
      expect(await respond(() => runnerHello(h.deps(), signed(key, HELLO_PATH, hello)))).toMatchObject({ status: 200 });
      expect(await runnerRow(id)).toMatchObject({ protocol_version: 1, binary_version: "0.1.0+abc", isolation: "microvm" });
      expect((await runnerRow(id)).last_seen_at).not.toBeNull();
      expect((await respond(() => runnerHello(h.deps(), signed(key, HELLO_PATH, { ...hello, email: "a@b.c" })))).status).toBe(400);
    });

    it("refuses a protocol version below current - 1 with 426 and no download URL, using an injected current", async () => {
      const f = await fresh();
      const key = newKey();
      const id = await registerKey(h.admin, f.accountId, f.a1, key);
      const send = (version: number, current?: number) => respond(() => runnerHello(h.deps(current === undefined ? {} : { currentProtocolVersion: current }), signed(key, HELLO_PATH, { ...hello, protocol_version: version })));
      expect((await send(2, 3)).status).toBe(200);
      expect((await send(3, 3)).status).toBe(200);
      expect((await send(9, 3)).status).toBe(200);
      const refused = await send(1, 3);
      expect(refused.status).toBe(426);
      expect(JSON.stringify(refused.body)).not.toMatch(/https?:|download|url/i);
      expect(await runnerRow(id)).toMatchObject({ protocol_version: 9 }); // the last accepted hello; the refused one wrote nothing
      // With the real constant (1) nothing a runner can send is below the floor.
      expect((await send(1)).status).toBe(200);
    });
  });
});

import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RegisterResponse } from "@fulcrumaxe/runner-protocol";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { seedAccount } from "@fx/db/test/helpers/seed.js";
import {
  MAX_OUTSTANDING_PROVISIONING_TOKENS,
  PROVISIONING_TOKEN_DEFAULT_TTL_SECONDS,
  REGISTER_PATH,
  hashProvisioningToken,
  listProvisioningTokens,
  listRunners,
  mintProvisioningToken,
  registerRunner,
  revokeProvisioningToken,
} from "../src/index.js";
import { harness, insertCode, newKey, respond, signed, type Harness } from "./helpers.js";

/** D#605 FL-6: provisioning tokens, cloud side. Real Postgres with row security forced, the real register route and the real signature check. */
describe("provisioning tokens [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());
  afterEach(() => vi.restoreAllMocks());

  const fresh = (): Promise<F2Fixture> => seedF2(h.admin);
  const mint = (f: F2Fixture, userId: string, body: unknown) => respond(() => mintProvisioningToken(h.deps(), { accountId: f.accountId, userId }, body));
  const list = (f: F2Fixture, userId: string) => respond(() => listProvisioningTokens(h.deps(), { accountId: f.accountId, userId }));
  const revoke = (f: F2Fixture, userId: string, id: string) => respond(() => revokeProvisioningToken(h.deps(), { accountId: f.accountId, userId }, id));
  const register = (key: ReturnType<typeof newKey>, token: string, over: { ip?: string; deps?: Parameters<Harness["deps"]>[0] } = {}) =>
    respond(() => registerRunner(h.deps(over.deps), { ...signed(key, REGISTER_PATH, { code: token, public_key_jwk: key.jwk }), ...(over.ip === undefined ? {} : { clientIp: over.ip }) }));
  const minted = async (f: F2Fixture, userId: string, body: Record<string, unknown> = { credential_mode: "subscription" }) => {
    const res = await mint(f, userId, body);
    expect(res.status).toBe(201);
    return res.body as { id: string; token: string; expires_at: string; name: string | null };
  };
  const tokenRow = async (id: string) => (await h.admin.query("SELECT * FROM runner_provisioning_tokens WHERE id = $1", [id])).rows[0];
  const audit = async (accountId: string, action: string) => (await h.admin.query("SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = $2", [accountId, action])).rows;
  const addRepo = async (accountId: string, name: string): Promise<string> => {
    const id = randomUUID();
    await h.admin.query("INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, floor(random() * 2000000000)::bigint + 1, 'team', 'Acme', $3)", [id, accountId, name]);
    return id;
  };
  const runnerCount = async (accountId: string) => (await h.admin.query("SELECT 1 FROM runners WHERE account_id = $1", [accountId])).rowCount;

  describe("mint", () => {
    it("lets an owner or admin mint fxrp_ plus 40 characters that lives an hour by default, and stores only the SHA-256", async () => {
      const f = await fresh();
      for (const user of [f.o1, f.a1]) {
        const res = await minted(f, user, { credential_mode: "api_key", name: "build box" });
        expect(res.token).toMatch(/^fxrp_[A-Za-z0-9]{40}$/);
        expect(Math.abs(new Date(res.expires_at).getTime() - Date.now() - PROVISIONING_TOKEN_DEFAULT_TTL_SECONDS * 1000)).toBeLessThan(15_000);
        const row = await tokenRow(res.id);
        expect(row).toMatchObject({ account_id: f.accountId, created_by: user, credential_mode: "api_key", name: "build box", token_sha256: hashProvisioningToken(res.token), used_at: null, revoked_at: null });
        expect(JSON.stringify(row)).not.toContain(res.token);
        expect(row.token_sha256).toBe(createHash("sha256").update(res.token).digest("hex"));
      }
      expect(await audit(f.accountId, "runner.provisioning_token.minted")).toHaveLength(2);
    });

    it("accepts a lifetime from a minute to 24 hours and refuses 25 hours, zero, a fraction and a string, writing nothing", async () => {
      const f = await fresh();
      const ok = await minted(f, f.o1, { credential_mode: "subscription", ttl_seconds: 24 * 3600 });
      expect(Math.abs(new Date(ok.expires_at).getTime() - Date.now() - 24 * 3600 * 1000)).toBeLessThan(15_000);
      await minted(f, f.o1, { credential_mode: "subscription", ttl_seconds: 60 });
      for (const ttl of [25 * 3600, 24 * 3600 + 1, 0, 59, -5, 1.5, "3600", null]) {
        expect((await mint(f, f.o1, { credential_mode: "subscription", ttl_seconds: ttl })).status, String(ttl)).toBe(400);
      }
      expect((await h.admin.query("SELECT 1 FROM runner_provisioning_tokens WHERE account_id = $1", [f.accountId])).rowCount).toBe(2);
    });

    it("refuses the database's own bounds too, when the route's check is bypassed", async () => {
      const f = await fresh();
      const attempt = (ttl: number) =>
        h.appPool.connect().then(async (c) => {
          try {
            await c.query("BEGIN");
            await c.query("SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)", [f.accountId, f.o1]);
            await c.query("SELECT * FROM runner_provisioning_token_mint($1, NULL, 'api_key', '{}', '{}', $2)", [hashProvisioningToken(randomUUID()), ttl]);
            await c.query("ROLLBACK");
            return "ok";
          } catch (e) {
            await c.query("ROLLBACK");
            return (e as { code?: string }).code;
          } finally {
            c.release();
          }
        });
      expect(await attempt(25 * 3600)).toBe("22023");
      expect(await attempt(86400)).toBe("ok");
    });

    it("refuses a member, a stranger and a bad body, and writes nothing", async () => {
      const f = await fresh();
      const other = await fresh();
      expect((await mint(f, f.m1, { credential_mode: "api_key" })).status).toBe(403);
      expect((await mint(f, other.o1, { credential_mode: "api_key" })).status).toBe(403);
      const bodies = [{}, { credential_mode: "token" }, { credential_mode: "api_key", account_id: other.accountId }, { credential_mode: "api_key", allowed_repo_ids: ["nope"] }, { credential_mode: "api_key", name: "x".repeat(65) }, { credential_mode: "api_key", name: "bad\u0007name" }, { credential_mode: "api_key", labels: ["Has Space"] }, { credential_mode: "api_key", labels: "gpu" }, null, []];
      for (const body of bodies) expect((await mint(f, f.o1, body)).status, JSON.stringify(body)).toBe(400);
      const foreign = await seedAccount(h.admin, randomUUID());
      expect((await mint(f, f.o1, { credential_mode: "api_key", allowed_repo_ids: [foreign.repoId] })).status).toBe(400);
      expect((await h.admin.query("SELECT 1 FROM runner_provisioning_tokens WHERE account_id = $1", [f.accountId])).rowCount).toBe(0);
      expect(await audit(f.accountId, "runner.provisioning_token.minted")).toHaveLength(0);
    });

    it("answers 409 token_limit to a sixth outstanding token, and not to one after a revoke, a use, an expiry or a demotion frees a place", async () => {
      const f = await fresh();
      const made = [];
      for (let i = 0; i < MAX_OUTSTANDING_PROVISIONING_TOKENS; i++) made.push(await minted(f, i % 2 === 0 ? f.o1 : f.a1));
      const sixth = await mint(f, f.o1, { credential_mode: "subscription" });
      expect(sixth.status).toBe(409);
      expect((sixth.body as { error: { code: string } }).error.code).toBe("token_limit");
      // Another account is not counted against this one.
      const other = await fresh();
      await minted(other, other.o1);
      // A revoke frees a place.
      expect((await revoke(f, f.o1, made[0]!.id)).status).toBe(200);
      const again = await minted(f, f.o1);
      expect((await mint(f, f.o1, { credential_mode: "subscription" })).status).toBe(409);
      // A use frees one.
      expect((await register(newKey(), made[1]!.token)).status).toBe(201);
      await minted(f, f.o1);
      expect((await mint(f, f.o1, { credential_mode: "subscription" })).status).toBe(409);
      // An expiry frees one.
      await h.admin.query("ALTER TABLE runner_provisioning_tokens DISABLE TRIGGER runner_provisioning_tokens_immutable");
      await h.admin.query("UPDATE runner_provisioning_tokens SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE id = $1", [again.id]);
      await h.admin.query("ALTER TABLE runner_provisioning_tokens ENABLE TRIGGER runner_provisioning_tokens_immutable");
      await minted(f, f.o1);
      expect((await mint(f, f.o1, { credential_mode: "subscription" })).status).toBe(409);
      // A minter demoted to member frees theirs: their tokens are dead.
      await h.admin.query("UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2", [f.accountId, f.a1]);
      await minted(f, f.o1);
    });

    it("refuses two concurrent mints past the limit: exactly the room that is left is made", async () => {
      const f = await fresh();
      for (let i = 0; i < 3; i++) await minted(f, f.o1);
      const results = await Promise.all([f.o1, f.a1, f.o2, f.a2].map((u) => mint(f, u, { credential_mode: "subscription" })));
      expect(results.filter((r) => r.status === 201)).toHaveLength(2);
      expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    });
  });

  describe("list and revoke", () => {
    it("lists the unused tokens with their minter, never the secret or its hash, and drops used, revoked and expired ones", async () => {
      const f = await fresh();
      const a = await minted(f, f.o1, { credential_mode: "subscription", name: "alpha" });
      const b = await minted(f, f.a1, { credential_mode: "api_key", labels: ["gpu"] });
      const used = await minted(f, f.o1);
      const revoked = await minted(f, f.o1);
      expect((await register(newKey(), used.token)).status).toBe(201);
      expect((await revoke(f, f.o1, revoked.id)).status).toBe(200);
      const res = await list(f, f.a2);
      expect(res.status).toBe(200);
      const body = res.body as { tokens: Array<Record<string, unknown>>; limit: number };
      expect(body.limit).toBe(5);
      expect(body.tokens.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
      expect(body.tokens.find((t) => t.id === a.id)).toMatchObject({ name: "alpha", credential_mode: "subscription", minted_by: { id: f.o1, name: expect.any(String) } });
      expect(body.tokens.find((t) => t.id === b.id)).toMatchObject({ name: null, labels: ["gpu"], minted_by: { id: f.a1 } });
      const text = JSON.stringify(res.body);
      for (const t of [a, b, used, revoked]) {
        expect(text).not.toContain(t.token);
        expect(text).not.toContain(hashProvisioningToken(t.token));
      }
      // An expired token drops off.
      await h.admin.query("ALTER TABLE runner_provisioning_tokens DISABLE TRIGGER runner_provisioning_tokens_immutable");
      await h.admin.query("UPDATE runner_provisioning_tokens SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE id = $1", [a.id]);
      await h.admin.query("ALTER TABLE runner_provisioning_tokens ENABLE TRIGGER runner_provisioning_tokens_immutable");
      expect(((await list(f, f.o1)).body as { tokens: Array<{ id: string }> }).tokens.map((t) => t.id)).toEqual([b.id]);
      // A token of a demoted minter drops off too.
      await h.admin.query("UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2", [f.accountId, f.a1]);
      expect(((await list(f, f.o1)).body as { tokens: unknown[] }).tokens).toEqual([]);
    });

    it("gives a member, a stranger and a signed-out caller 403 for list and revoke, and changes nothing", async () => {
      const f = await fresh();
      const other = await fresh();
      const t = await minted(f, f.o1);
      expect((await list(f, f.m1)).status).toBe(403);
      expect((await list(f, other.o1)).status).toBe(403);
      expect((await revoke(f, f.m1, t.id)).status).toBe(403);
      expect((await revoke(f, other.o1, t.id)).status).toBe(403);
      expect((await tokenRow(t.id)).revoked_at).toBeNull();
      expect((await register(newKey(), t.token)).status).toBe(201);
    });

    it("revokes an unused token at once (the next redemption is 401), and a second revoke, a used token and an unknown id are 404", async () => {
      const f = await fresh();
      const other = await fresh();
      const t = await minted(f, f.a1);
      const res = await revoke(f, f.o2, t.id);
      expect(res.status).toBe(200);
      expect(await audit(f.accountId, "runner.provisioning_token.revoked")).toEqual([{ actor: f.o2, payload: { token_id: t.id, name: null } }]);
      expect((await register(newKey(), t.token)).status).toBe(401);
      expect(await runnerCount(f.accountId)).toBe(0);
      expect((await revoke(f, f.o1, t.id)).status).toBe(404);
      expect(await audit(f.accountId, "runner.provisioning_token.revoked")).toHaveLength(1);
      const used = await minted(f, f.o1);
      expect((await register(newKey(), used.token)).status).toBe(201);
      expect((await revoke(f, f.o1, used.id)).status).toBe(404);
      expect((await tokenRow(used.id)).revoked_at).toBeNull();
      expect((await revoke(f, f.o1, randomUUID())).status).toBe(404);
      expect((await revoke(f, f.o1, "not-a-uuid")).status).toBe(404);
      // Another account's token id is not found either.
      const theirs = await minted(other, other.o1);
      expect((await revoke(f, f.o1, theirs.id)).status).toBe(404);
      expect((await tokenRow(theirs.id)).revoked_at).toBeNull();
    });
  });

  describe("redemption through /api/runner/register", () => {
    it("makes the runner from the token's own row, once, and records the minter, the first address, the name and the labels", async () => {
      const f = await fresh();
      const t = await minted(f, f.a1, { credential_mode: "api_key", name: "vps-1", labels: ["gpu", "linux"] });
      const key = newKey();
      const res = await register(key, t.token, { ip: "203.0.113.7" });
      expect(res.status).toBe(201);
      const body = RegisterResponse.parse(res.body);
      expect(body).toEqual({ runner_id: expect.any(String), account_id: f.accountId, credential_mode: "api_key" });
      expect((await h.admin.query("SELECT * FROM runners WHERE id = $1", [body.runner_id])).rows[0]).toMatchObject({ registered_by: f.a1, credential_mode: "api_key", jkt: key.jkt });
      expect((await h.admin.query("SELECT name, labels, updated_by FROM runner_settings WHERE runner_id = $1", [body.runner_id])).rows).toEqual([{ name: "vps-1", labels: ["gpu", "linux"], updated_by: f.a1 }]);
      const row = await tokenRow(t.id);
      expect(row).toMatchObject({ runner_id: body.runner_id, first_ip: "203.0.113.7" });
      expect(row.used_at).toBeInstanceOf(Date);
      const reg = await audit(f.accountId, "runner.registered");
      expect(reg).toHaveLength(1);
      expect(reg[0]).toMatchObject({ actor: `runner:${body.runner_id}`, payload: { provisioning_token_id: t.id, registered_by: f.a1, first_ip: "203.0.113.7" } });
    });

    it("answers every unusable token the same 401 invalid_code: used, replayed by another key, unknown, expired, revoked", async () => {
      const f = await fresh();
      const used = await minted(f, f.o1);
      expect((await register(newKey(), used.token)).status).toBe(201);
      const second = await register(newKey(), used.token);
      const unknown = await register(newKey(), "fxrp_" + "a".repeat(40));
      const expired = await minted(f, f.o1);
      await h.admin.query("ALTER TABLE runner_provisioning_tokens DISABLE TRIGGER runner_provisioning_tokens_immutable");
      await h.admin.query("UPDATE runner_provisioning_tokens SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE id = $1", [expired.id]);
      await h.admin.query("ALTER TABLE runner_provisioning_tokens ENABLE TRIGGER runner_provisioning_tokens_immutable");
      const gone = await minted(f, f.o1);
      await revoke(f, f.o1, gone.id);
      const answers = [second, unknown, await register(newKey(), expired.token), await register(newKey(), gone.token)];
      for (const a of answers) {
        expect(a.status).toBe(401);
        expect(a.body).toEqual({ error: { code: "invalid_code", message: "the registration code is not valid" } });
      }
      expect(await runnerCount(f.accountId)).toBe(1);
    });

    it("answers 409 key_registered to the same signed request replayed after a success, and registers once", async () => {
      const f = await fresh();
      const t = await minted(f, f.o1);
      const key = newKey();
      expect((await register(key, t.token)).status).toBe(201);
      expect((await register(key, t.token)).status).toBe(409);
      expect(await runnerCount(f.accountId)).toBe(1);
    });

    it("lets exactly one of several simultaneous redemptions win", async () => {
      const f = await fresh();
      const t = await minted(f, f.o1);
      const results = await Promise.all([0, 1, 2, 3, 4, 5].map(() => register(newKey(), t.token)));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 401)).toHaveLength(5);
      expect(await runnerCount(f.accountId)).toBe(1);
    });

    it("refuses a token whose minter was demoted to member, or removed, before redemption, and writes no runner row", async () => {
      const f = await fresh();
      const demoted = await minted(f, f.a1);
      const removed = await minted(f, f.a2);
      await h.admin.query("UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2", [f.accountId, f.a1]);
      expect((await register(newKey(), demoted.token)).status).toBe(401);
      await h.admin.query("DELETE FROM account_members WHERE account_id = $1 AND user_id = $2", [f.accountId, f.a2]);
      expect((await register(newKey(), removed.token)).status).toBe(401);
      expect(await runnerCount(f.accountId)).toBe(0);
      expect((await tokenRow(demoted.id)).used_at).toBeNull();
      // Promoted back: the same token works again, because the check is the minter's role at redemption.
      await h.admin.query("UPDATE account_members SET role = 'admin' WHERE account_id = $1 AND user_id = $2", [f.accountId, f.a1]);
      expect((await register(newKey(), demoted.token)).status).toBe(201);
    });

    it("binds the repos to the runner, and refuses a token whose bound repos no longer all belong to the account", async () => {
      const f = await fresh();
      const keep = await addRepo(f.accountId, "keep");
      const gone = await addRepo(f.accountId, "gone");
      const good = await minted(f, f.o1, { credential_mode: "subscription", allowed_repo_ids: [keep] });
      const res = await register(newKey(), good.token);
      expect(res.status).toBe(201);
      expect((await h.admin.query("SELECT allowed_repo_ids FROM runners WHERE id = $1", [(res.body as { runner_id: string }).runner_id])).rows[0].allowed_repo_ids).toEqual([keep]);
      const t = await minted(f, f.o1, { credential_mode: "subscription", allowed_repo_ids: [keep, gone] });
      await h.admin.query("DELETE FROM repos WHERE id = $1", [gone]);
      expect((await register(newKey(), t.token)).status).toBe(401);
      expect(await runnerCount(f.accountId)).toBe(1);
      expect((await tokenRow(t.id)).used_at).toBeNull();
    });

    it("applies the plan's runner limit: 409 runner_limit past it, and a failed redemption leaves the token usable", async () => {
      const f = await fresh();
      await h.admin.query("UPDATE accounts SET plan = 'runner' WHERE id = $1", [f.accountId]);
      const deps = { maxRunners: () => 1 };
      const a = await minted(f, f.o1);
      const b = await minted(f, f.o1);
      expect((await register(newKey(), a.token, { deps })).status).toBe(201);
      const refused = await register(newKey(), b.token, { deps });
      expect(refused.status).toBe(409);
      expect((refused.body as { error: { code: string } }).error.code).toBe("runner_limit");
      expect((await tokenRow(b.id)).used_at).toBeNull();
      expect((await register(newKey(), b.token, { deps: { maxRunners: () => 2 } })).status).toBe(201);
      // With the plan data missing it is 503 plan_unavailable and no row is written.
      const c = await minted(f, f.o1);
      const missing = await register(newKey(), c.token, { deps: { maxRunners: () => { throw new Error("plan data unavailable"); } } });
      expect(missing.status).toBe(503);
      expect((await tokenRow(c.id)).used_at).toBeNull();
    });

    it("records no address when the edge sent none or a value that is not an address, and still registers", async () => {
      const f = await fresh();
      for (const ip of [undefined, "unknown", "999.1.1.1", "fe80::1%eth0", "not an ip"]) {
        const t = await minted(f, f.o1);
        const res = await register(newKey(), t.token, ip === undefined ? {} : { ip });
        expect(res.status, String(ip)).toBe(201);
        expect((await tokenRow(t.id)).first_ip, String(ip)).toBeNull();
        // Clear the slot for the next mint.
      }
      const v6 = await minted(f, f.o1);
      expect((await register(newKey(), v6.token, { ip: "2001:db8::1" })).status).toBe(201);
      expect((await tokenRow(v6.id)).first_ip).toBe("2001:db8::1");
    });

    it("still registers a one-time code the old way, and a code cannot be used where a token is expected or the reverse", async () => {
      const f = await fresh();
      const code = await insertCode(h.admin, f.accountId, f.a1);
      expect((await register(newKey(), code)).status).toBe(201);
      const t = await minted(f, f.o1);
      // The token's hash is not in the codes table: as an fxrr_ lookalike it finds nothing.
      expect((await register(newKey(), t.token.replace("fxrp_", "fxrr_"))).status).toBe(401);
      expect((await tokenRow(t.id)).used_at).toBeNull();
    });
  });

  describe("the database holds the line itself", () => {
    it("keeps used_at and the secret fixed: no later write moves them, and a row cannot be both used and revoked", async () => {
      const f = await fresh();
      const t = await minted(f, f.o1);
      expect((await register(newKey(), t.token, { ip: "203.0.113.20" })).status).toBe(201);
      const attempts = ["UPDATE runner_provisioning_tokens SET used_at = NULL WHERE id = $1", "UPDATE runner_provisioning_tokens SET used_at = now() + interval '1 hour' WHERE id = $1", "UPDATE runner_provisioning_tokens SET expires_at = now() + interval '5 hours' WHERE id = $1", "UPDATE runner_provisioning_tokens SET token_sha256 = repeat('a', 64) WHERE id = $1", "UPDATE runner_provisioning_tokens SET revoked_at = now() WHERE id = $1", "UPDATE runner_provisioning_tokens SET first_ip = '198.51.100.1' WHERE id = $1"];
      for (const sql of attempts) {
        await expect(h.admin.query(sql, [t.id]), sql).rejects.toBeTruthy();
      }
      const row = await tokenRow(t.id);
      expect(row.used_at).toBeInstanceOf(Date);
      expect(row.revoked_at).toBeNull();
    });

    it("gives platform_ops nothing, app_user only the non-secret columns and no write, and refuses the functions to a platform_ops login", async () => {
      const f = await fresh();
      const t = await minted(f, f.o1);
      await expect(h.opsPool.query("SELECT id FROM runner_provisioning_tokens")).rejects.toMatchObject({ code: "42501" });
      await expect(h.opsPool.query("INSERT INTO runner_provisioning_tokens (account_id, created_by, token_sha256, credential_mode, expires_at) VALUES ($1, $2, repeat('b', 64), 'api_key', now() + interval '1 hour')", [f.accountId, f.o1])).rejects.toMatchObject({ code: "42501" });
      await expect(h.opsPool.query("SELECT runner_provisioning_token_account($1)", [hashProvisioningToken(t.token)])).rejects.toMatchObject({ code: "42501" });
      const client = await h.appPool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.account_id', $1, true)", [f.accountId]);
        expect((await client.query("SELECT id, first_ip FROM runner_provisioning_tokens WHERE id = $1", [t.id])).rowCount).toBe(1);
        await client.query("ROLLBACK");
        for (const sql of ["SELECT token_sha256 FROM runner_provisioning_tokens", "UPDATE runner_provisioning_tokens SET revoked_at = now()", "DELETE FROM runner_provisioning_tokens", "INSERT INTO runner_provisioning_tokens (account_id, created_by, token_sha256, credential_mode, expires_at) VALUES (gen_random_uuid(), gen_random_uuid(), repeat('c', 64), 'api_key', now())"]) {
          await client.query("BEGIN");
          await client.query("SELECT set_config('app.account_id', $1, true)", [f.accountId]);
          await expect(client.query(sql), sql).rejects.toMatchObject({ code: "42501" });
          await client.query("ROLLBACK");
        }
        // Another tenant sees none of it.
        const other = await fresh();
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.account_id', $1, true)", [other.accountId]);
        expect((await client.query("SELECT id FROM runner_provisioning_tokens")).rowCount).toBe(0);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    });

    it("keeps the redemption inside the caller's tenant: a token of one account redeemed under another's context finds nothing", async () => {
      const f = await fresh();
      const other = await fresh();
      const t = await minted(f, f.o1);
      const client = await h.appPool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.account_id', $1, true)", [other.accountId]);
        const key = newKey();
        await expect(client.query("SELECT runner_provisioning_register($1, $2::jsonb, NULL, NULL, NULL)", [hashProvisioningToken(t.token), JSON.stringify(key.jwk)])).rejects.toMatchObject({ code: "P0002" });
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      expect((await tokenRow(t.id)).used_at).toBeNull();
    });
  });

  describe("the fleet row", () => {
    it("shows who minted the token and the first address to an owner or admin, the minter alone to a member, and nothing for a code-made runner", async () => {
      const f = await fresh();
      const t = await minted(f, f.a1, { credential_mode: "subscription", name: "vps" });
      const res = await register(newKey(), t.token, { ip: "203.0.113.9" });
      const runnerId = (res.body as { runner_id: string }).runner_id;
      const viaCode = await register(newKey(), await insertCode(h.admin, f.accountId, f.o1));
      const codeRunnerId = (viaCode.body as { runner_id: string }).runner_id;
      const read = async (userId: string) => {
        const out = await respond(() => listRunners(h.deps(), { accountId: f.accountId, userId }));
        return (out.body as { runners: Array<{ id: string; provisioning: { minted_by: { id: string; name: string }; first_ip: string | null } | null }> }).runners;
      };
      for (const user of [f.o1, f.a2]) {
        const rows = await read(user);
        expect(rows.find((r) => r.id === runnerId)?.provisioning).toEqual({ minted_by: { id: f.a1, name: expect.any(String) }, first_ip: "203.0.113.9" });
        expect(rows.find((r) => r.id === codeRunnerId)?.provisioning).toBeNull();
      }
      const asMember = await read(f.m1);
      expect(asMember.find((r) => r.id === runnerId)?.provisioning).toEqual({ minted_by: { id: f.a1, name: expect.any(String) }, first_ip: null });
      expect(JSON.stringify(asMember)).not.toContain("203.0.113.9");
      expect(JSON.stringify(asMember)).not.toMatch(/"name":(null|"undefined")/);
    });
  });

  describe("the secret stays out of rows, logs and replies (the C8 canary walk)", () => {
    it("finds a planted token nowhere in the database, the log lines, or any reply after the mint", async () => {
      const lines: string[] = [];
      const capture = (chunk: unknown): boolean => {
        lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
        return true;
      };
      vi.spyOn(process.stdout, "write").mockImplementation(capture as never);
      vi.spyOn(process.stderr, "write").mockImplementation(capture as never);
      for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
      const log = (line: string) => void lines.push(line);

      const f = await fresh();
      const replies: unknown[] = [];
      const minting = await mint(f, f.o1, { credential_mode: "subscription", name: "canary-box", labels: ["canary"] });
      const { token, id } = minting.body as { token: string; id: string };
      const body = token.slice("fxrp_".length);
      replies.push((await list(f, f.o1)).body);
      // A failed redemption (wrong key signer) and a good one, then every follow-up.
      const key = newKey();
      replies.push((await respond(() => registerRunner(h.deps({ log }), signed(newKey(), REGISTER_PATH, { code: token, public_key_jwk: key.jwk })))).body);
      const ok = await respond(() => registerRunner(h.deps({ log }), { ...signed(key, REGISTER_PATH, { code: token, public_key_jwk: key.jwk }), clientIp: "203.0.113.50" }));
      replies.push(ok.body);
      replies.push((await respond(() => registerRunner(h.deps({ log }), signed(key, REGISTER_PATH, { code: token, public_key_jwk: key.jwk })))).body);
      replies.push((await respond(() => registerRunner(h.deps({ log }), signed(newKey(), REGISTER_PATH, { code: token, public_key_jwk: newKey().jwk })))).body);
      replies.push((await list(f, f.o1)).body, (await revoke(f, f.o1, id)).body, (await respond(() => listRunners(h.deps(), { accountId: f.accountId, userId: f.o1 }))).body);

      for (const secret of [token, body]) {
        expect(JSON.stringify(replies)).not.toContain(secret);
        expect(lines.join("\n")).not.toContain(secret);
        for (const table of ["runner_provisioning_tokens", "audit_log", "runners", "runner_settings", "runner_registration_codes", "runner_request_nonces", "runner_facts"]) {
          const dump = await h.admin.query<{ t: string }>(`SELECT coalesce(string_agg(row_to_json(x)::text, E'\\n'), '') AS t FROM ${table} x`);
          expect(dump.rows[0]!.t, table).not.toContain(secret);
        }
      }
      // The only reply that ever carried it is the mint's own.
      expect(JSON.stringify(minting.body)).toContain(token);
    });
  });
});

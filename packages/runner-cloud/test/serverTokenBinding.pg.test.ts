import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RegisterResponse } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { REGISTER_PATH, hashProvisioningToken, mintProvisioningToken, mintServerProvisioningToken, registerRunner } from "../src/index.js";
import { harness, newKey, respond, signed, type Harness } from "./helpers.js";

const SERVER_IP = "203.0.113.50";

/** D#845 MC-5: a token that belongs to a rented server's row registers only from that row's IPv4, read from the platform-set header alone. Real Postgres, real route. */
describe("server token-to-IP binding [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const register = (token: string, headers: Record<string, string>) => {
    const key = newKey();
    const req = signed(key, REGISTER_PATH, { code: token, public_key_jwk: key.jwk });
    return respond(() => registerRunner(h.deps({ maxRunners: () => 50 }), { ...req, headers: { ...req.headers, ...headers }, clientIp: headers["x-forwarded-for"] ?? headers["x-vercel-forwarded-for"] }));
  };
  const tokenRow = async (id: string) => (await h.admin.query("SELECT used_at, runner_id FROM runner_provisioning_tokens WHERE id = $1", [id])).rows[0];

  /** An owner mints a server token and a managed_servers row (bound to it) is made, as the create flow will. */
  async function serverWithToken(f: F2Fixture, ip: string | null) {
    const t = await mintServerProvisioningToken(h.deps({ repoVisibility: async () => "private" }), { accountId: f.accountId, userId: f.o1 }, "subscription");
    const cred = (
      await h.admin.query<{ id: string }>(
        "INSERT INTO machine_provider_credentials (account_id, provider, ciphertext, nonce, wrapped_dek, kek_version, token_hint, created_by) VALUES ($1, 'hetzner_cloud', '\\x01', $2, '\\x01', 1, 'a1b2', $3) RETURNING id",
        [f.accountId, randomBytes(12), f.o1],
      )
    ).rows[0]!.id;
    await h.admin.query("INSERT INTO managed_servers (account_id, kind, credential_id, name, public_ipv4, provisioning_token_id, created_by) VALUES ($1, 'hetzner_cloud', $2, 'box', $3, $4, $5)", [f.accountId, cred, ip, t.id, f.o1]);
    return t;
  }

  it("registers from the bound address, whatever the other forwarding headers say", async () => {
    const f = await seedF2(h.admin);
    const t = await serverWithToken(f, SERVER_IP);
    const res = await register(t.secret, { "x-vercel-forwarded-for": SERVER_IP, "x-forwarded-for": "198.51.100.9", "x-real-ip": "198.51.100.9" });
    expect(res.status).toBe(201);
    expect(RegisterResponse.parse(res.body).account_id).toBe(f.accountId);
    expect((await tokenRow(t.id)).used_at).toBeInstanceOf(Date);
  });

  it("answers a spoofed X-Forwarded-For 403 token_bound_elsewhere, and the token is still usable afterwards", async () => {
    const f = await seedF2(h.admin);
    const t = await serverWithToken(f, SERVER_IP);
    // The attacker sets the headers a caller can set. The platform-set one carries their real address.
    const spoof = await register(t.secret, { "x-forwarded-for": SERVER_IP, "x-real-ip": SERVER_IP, "x-vercel-forwarded-for": "198.51.100.77" });
    expect(spoof.status).toBe(403);
    expect(spoof.body).toMatchObject({ error: { code: "token_bound_elsewhere" } });
    expect(await tokenRow(t.id)).toEqual({ used_at: null, runner_id: null });
    expect((await h.admin.query("SELECT 1 FROM runners WHERE account_id = $1", [f.accountId])).rowCount).toBe(0);
    const real = await register(t.secret, { "x-vercel-forwarded-for": SERVER_IP });
    expect(real.status).toBe(201);
  });

  it("fails closed when the platform header is missing, empty, a list or not an address, even with every other header matching", async () => {
    const f = await seedF2(h.admin);
    const t = await serverWithToken(f, SERVER_IP);
    const others = { "x-forwarded-for": SERVER_IP, "x-real-ip": SERVER_IP };
    for (const extra of [{} as Record<string, string>,{ "x-vercel-forwarded-for": "" }, { "x-vercel-forwarded-for": `${SERVER_IP}, 198.51.100.1` }, { "x-vercel-forwarded-for": "not-an-ip" }, { "x-vercel-forwarded-for": "198.51.100.1" }]) {
      const res = await register(t.secret, { ...others, ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(403);
      expect(res.body).toMatchObject({ error: { code: "token_bound_elsewhere" } });
    }
    expect((await tokenRow(t.id)).used_at).toBeNull();
    expect((await register(t.secret, { "x-vercel-forwarded-for": SERVER_IP })).status).toBe(201);
  });

  it("refuses while the server's address is not known yet", async () => {
    const f = await seedF2(h.admin);
    const t = await serverWithToken(f, null);
    const res = await register(t.secret, { "x-vercel-forwarded-for": SERVER_IP });
    expect(res.status).toBe(403);
    expect((await tokenRow(t.id)).used_at).toBeNull();
  });

  it("refuses a server row's token that was minted another way: a life other than 1800 s, or any repository, even from the right address", async () => {
    const f = await seedF2(h.admin);
    const repoId = randomUUID();
    await h.admin.query("INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, floor(random() * 2000000000)::bigint + 1, 'team', 'Acme', 'r1')", [repoId, f.accountId]);
    const cred = (
      await h.admin.query<{ id: string }>(
        "INSERT INTO machine_provider_credentials (account_id, provider, ciphertext, nonce, wrapped_dek, kek_version, token_hint, created_by) VALUES ($1, 'hetzner_cloud', '\\x01', $2, '\\x01', 1, 'a1b2', $3) RETURNING id",
        [f.accountId, randomBytes(12), f.o1],
      )
    ).rows[0]!.id;
    for (const body of [{ credential_mode: "subscription", ttl_seconds: 3600 }, { credential_mode: "subscription", ttl_seconds: 86400 }, { credential_mode: "subscription", ttl_seconds: 1799 }, { credential_mode: "subscription", ttl_seconds: 1800, allowed_repo_ids: [repoId] }]) {
      const res = await respond(() => mintProvisioningToken(h.deps({ repoVisibility: async () => "private" }), { accountId: f.accountId, userId: f.o1 }, body));
      expect(res.status).toBe(201);
      const t = res.body as { id: string; token: string };
      await h.admin.query("INSERT INTO managed_servers (account_id, kind, credential_id, name, public_ipv4, provisioning_token_id, created_by) VALUES ($1, 'hetzner_cloud', $2, 'odd', $3, $4, $5)", [f.accountId, cred, SERVER_IP, t.id, f.o1]);
      const out = await register(t.token, { "x-vercel-forwarded-for": SERVER_IP });
      expect(out.status, JSON.stringify(body)).toBe(403);
      expect(out.body).toMatchObject({ error: { code: "token_bound_elsewhere" } });
      expect((await tokenRow(t.id)).used_at).toBeNull();
    }
  });

  it("allows one server row per token: a second row naming the same token is refused by the database", async () => {
    const f = await seedF2(h.admin);
    const t = await serverWithToken(f, SERVER_IP);
    const cred = (await h.admin.query<{ credential_id: string }>("SELECT credential_id FROM managed_servers WHERE provisioning_token_id = $1", [t.id])).rows[0]!.credential_id;
    await expect(
      h.admin.query("INSERT INTO managed_servers (account_id, kind, credential_id, name, public_ipv4, provisioning_token_id, created_by) VALUES ($1, 'hetzner_cloud', $2, 'second', '198.51.100.9', $3, $4)", [f.accountId, cred, t.id, f.o1]),
    ).rejects.toMatchObject({ code: "23505", constraint: "managed_servers_one_per_token" });
  });

  it("does not bind a token that no server row holds: the person's own token registers from anywhere", async () => {
    const f = await seedF2(h.admin);
    const res = await respond(() => mintProvisioningToken(h.deps({ repoVisibility: async () => "private" }), { accountId: f.accountId, userId: f.o1 }, { credential_mode: "subscription" }));
    const token = (res.body as { token: string }).token;
    expect((await register(token, {})).status).toBe(201);
  });

  it("mints a server token for 30 minutes and no repositories, whatever the account's other tokens are", async () => {
    const f = await seedF2(h.admin);
    const t = await mintServerProvisioningToken(h.deps(), { accountId: f.accountId, userId: f.o1 }, "api_key");
    expect(t).toMatchObject({ ttlSeconds: 1800, repoCount: 0 });
    const row = (await h.admin.query("SELECT allowed_repo_ids, credential_mode, extract(epoch FROM expires_at - created_at)::int AS life FROM runner_provisioning_tokens WHERE id = $1", [t.id])).rows[0];
    expect(row).toEqual({ allowed_repo_ids: [], credential_mode: "api_key", life: 1800 });
    // A member who is not an owner or admin cannot make one.
    await expect(mintServerProvisioningToken(h.deps(), { accountId: f.accountId, userId: f.m1 }, "api_key")).rejects.toMatchObject({ status: 403 });
  });

  describe("the runner link (D#845 MC-7)", () => {
    const rowOf = async (token: string) => (await h.admin.query<{ runner_id: string | null }>("SELECT s.runner_id FROM managed_servers s JOIN runner_provisioning_tokens t ON t.id = s.provisioning_token_id WHERE t.token_sha256 = $1", [hashProvisioningToken(token)])).rows[0]!.runner_id;

    it("records the runner on the server's row in the registering transaction, and not before", async () => {
      const f = await seedF2(h.admin);
      const t = await serverWithToken(f, SERVER_IP);
      expect(await rowOf(t.secret)).toBeNull();
      expect((await register(t.secret, { "x-vercel-forwarded-for": "198.51.100.77" })).status).toBe(403);
      expect(await rowOf(t.secret)).toBeNull();
      const res = await register(t.secret, { "x-vercel-forwarded-for": SERVER_IP });
      expect(await rowOf(t.secret)).toBe(RegisterResponse.parse(res.body).runner_id);
    });

    it("links nothing for a token no server holds, and the definer touches only the caller's account, only an unlinked row, only the runner that redeemed the token, and refuses a platform_ops login", async () => {
      const f = await seedF2(h.admin);
      const other = await seedF2(h.admin);
      const own = await respond(() => mintProvisioningToken(h.deps({ repoVisibility: async () => "private" }), { accountId: f.accountId, userId: f.o1 }, { credential_mode: "subscription" }));
      const stranger = RegisterResponse.parse((await register((own.body as { token: string }).token, {})).body).runner_id;
      const t = await serverWithToken(f, SERVER_IP);
      const runner = RegisterResponse.parse((await register(t.secret, { "x-vercel-forwarded-for": SERVER_IP })).body).runner_id;
      expect(await rowOf(t.secret)).toBe(runner);
      await h.admin.query("UPDATE managed_servers SET runner_id = NULL WHERE provisioning_token_id = $1", [t.id]);
      // Another runner of the same account (one registered with a different token) is not the redeemer: refused, the row stays unlinked.
      expect(await withTenant(h.appPool, f.accountId, async (c) => (await c.query<{ ok: boolean }>("SELECT managed_server_link_runner($1, $2::uuid) AS ok", [hashProvisioningToken(t.secret), stranger])).rows[0]!.ok)).toBe(false);
      expect(await rowOf(t.secret)).toBeNull();
      const link = (accountId: string) => withTenant(h.appPool, accountId, async (c) => (await c.query<{ ok: boolean }>("SELECT managed_server_link_runner($1, $2::uuid) AS ok", [hashProvisioningToken(t.secret), runner])).rows[0]!.ok);
      expect(await link(other.accountId)).toBe(false);
      expect(await rowOf(t.secret)).toBeNull();
      expect(await link(f.accountId)).toBe(true);
      expect(await link(f.accountId)).toBe(false);
      await expect(h.opsPool.query("SELECT managed_server_link_runner($1, $2::uuid)", [hashProvisioningToken(t.secret), runner])).rejects.toMatchObject({ code: "42501" });
      await expect(withTenant(h.appPool, f.accountId, (c) => c.query("SELECT managed_server_link_runner('nope', $1::uuid)", [runner]))).rejects.toMatchObject({ code: "22023" });
    });
  });

  describe("the definer", () => {
    const ask = (accountId: string | null, token: string) =>
      accountId === null
        ? h.appPool.query("SELECT * FROM runner_provisioning_token_bound_ip($1)", [hashProvisioningToken(token)])
        : withTenant(h.appPool, accountId, (c) => c.query<{ bound: boolean; ip: string | null }>("SELECT * FROM runner_provisioning_token_bound_ip($1)", [hashProvisioningToken(token)]));

    it("answers for the caller's own account only: another account asking about the same token learns nothing", async () => {
      const f = await seedF2(h.admin);
      const other = await seedF2(h.admin);
      const t = await serverWithToken(f, SERVER_IP);
      expect((await ask(f.accountId, t.secret)).rows).toEqual([{ bound: true, ip: SERVER_IP }]);
      expect((await ask(other.accountId, t.secret)).rows).toEqual([{ bound: false, ip: null }]);
      expect((await ask(f.accountId, "fxrp_" + "z".repeat(40))).rows).toEqual([{ bound: false, ip: null }]);
    });

    it("refuses a call with no tenant, a malformed hash, and a platform_ops login; PUBLIC and platform_ops cannot execute it", async () => {
      await expect(ask(null, "fxrp_" + "a".repeat(40))).rejects.toMatchObject({ code: "22023" });
      const f = await seedF2(h.admin);
      await expect(withTenant(h.appPool, f.accountId, (c) => c.query("SELECT * FROM runner_provisioning_token_bound_ip('nope')"))).rejects.toMatchObject({ code: "22023" });
      await expect(h.opsPool.query("SELECT * FROM runner_provisioning_token_bound_ip($1)", [hashProvisioningToken(randomUUID())])).rejects.toMatchObject({ code: "42501" });
      const acl = (await h.admin.query<{ pub: boolean; app: boolean; ops: boolean }>("SELECT has_function_privilege('public', 'runner_provisioning_token_bound_ip(text)', 'EXECUTE') AS pub, has_function_privilege('app_user', 'runner_provisioning_token_bound_ip(text)', 'EXECUTE') AS app, has_function_privilege('platform_ops', 'runner_provisioning_token_bound_ip(text)', 'EXECUTE') AS ops")).rows[0];
      expect(acl).toEqual({ pub: false, app: true, ops: false });
    });
  });
});

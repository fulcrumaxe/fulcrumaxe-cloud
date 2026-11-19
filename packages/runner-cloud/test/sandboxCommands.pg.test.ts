import { randomUUID, generateKeyPairSync, type KeyObject } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { SANDBOX_COMMAND_CAPABILITY, SANDBOX_INVENTORY_MIN_PROTOCOL, verifySandboxCommand, type SignedSandboxCommand } from "@fulcrumaxe/runner-protocol";
import { createJobSigner } from "@fx/runner";
import { CLAIM_PATH, SANDBOX_COMMAND_MAX_OPEN, claimRun, enqueueSandboxCommand, exchangeSandboxCommands, type RunnerCloudDeps, type RunnerLeaseOps } from "../src/index.js";
import { harness, newKey, registerKey, respond, signed, type Harness, type TestKey } from "./helpers.js";

const KEY_ID = "test-signer-1";

/**
 * [pg] D#587 B-7b: signed sandbox commands through the real claim route and the real enqueue function, as the runner login the routes use, with row security forced
 * (migration 1041). The tests that pin the gates (signature, expiry, single use, name, capability) are here and in the protocol and runner suites.
 */
describe("sandbox commands: enqueue, delivery and ack [pg]", () => {
  let h: Harness;
  let signKey: KeyObject;
  let keyring: Record<string, KeyObject>;
  beforeAll(async () => {
    h = await harness();
    const pair = generateKeyPairSync("ed25519");
    signKey = pair.privateKey;
    keyring = { [KEY_ID]: pair.publicKey };
  });
  afterAll(() => h.close());

  const idle = { claimRunnerRun: async () => ({ kind: "idle" as const, retryAfter: 60 }) } as unknown as RunnerLeaseOps;
  const deps = (over: Partial<RunnerCloudDeps> = {}): RunnerCloudDeps => h.deps({ leases: idle, engineCommandSigner: async () => createJobSigner({ keyId: KEY_ID, privateKey: signKey }), ...over });
  const open = (id: string) => h.admin.query("UPDATE runner_claim_stamps SET last_claim_at = now() - interval '1 hour' WHERE runner_id = $1", [id]);
  const claim = async (r: { id: string; key: TestKey }, body: unknown = {}, d: RunnerCloudDeps = deps()) => {
    await open(r.id);
    return respond(() => claimRun(d, signed(r.key, CLAIM_PATH, body)));
  };
  const commandsOf = (res: { body: unknown }): SignedSandboxCommand[] => (res.body as { sandbox_commands?: SignedSandboxCommand[] }).sandbox_commands ?? [];
  const enqueue = (f: F2Fixture, userId: string, runnerId: string, body: unknown) => respond(() => enqueueSandboxCommand(deps(), { accountId: f.accountId, userId }, runnerId, body));
  const stateOf = async (id: string) => (await h.admin.query<{ state: string; refusal: string | null }>("SELECT state, refusal FROM sandbox_commands WHERE id = $1", [id])).rows[0];
  const rows = async (runnerId: string) => (await h.admin.query<{ id: string; kind: string; name: string | null; state: string }>("SELECT id, kind, name, state FROM sandbox_commands WHERE runner_id = $1 ORDER BY issued_at, id", [runnerId])).rows;

  /** A runner of the account at `protocol` listing `capabilities` (written the way the hello's definer does: straight into the table, as the admin role). */
  async function runner(f: F2Fixture, o: { protocol?: number; capable?: boolean } = {}): Promise<{ id: string; key: TestKey }> {
    const key = newKey();
    const id = await registerKey(h.admin, f.accountId, f.m1, key);
    await h.admin.query("UPDATE runners SET protocol_version = $2 WHERE id = $1", [id, o.protocol ?? SANDBOX_INVENTORY_MIN_PROTOCOL]);
    await h.admin.query("INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, $3::text[])", [id, f.accountId, o.capable === false ? [] : [SANDBOX_COMMAND_CAPABILITY]]);
    return { id, key };
  }
  const idOf = (res: { body: unknown }) => (res.body as { command_id: string }).command_id;

  it("an owner and an admin queue a command; a member, a stranger's account and a bad body are refused", async () => {
    const f = await seedF2(h.admin);
    const other = await seedF2(h.admin);
    const r = await runner(f);
    const ok = await enqueue(f, f.o1, r.id, { kind: "stop_sandbox", name: "vm-one" });
    expect(ok).toMatchObject({ status: 200, body: { runner_id: r.id, kind: "stop_sandbox", name: "vm-one", state: "pending" } });
    expect(await enqueue(f, f.a1, r.id, { kind: "reap_sandboxes" })).toMatchObject({ status: 200 });
    expect(await enqueue(f, f.m1, r.id, { kind: "delete_sandbox", name: "vm-two" })).toMatchObject({ status: 403 });
    // Another account's person asking about this runner: the runner does not exist for them.
    expect(await enqueue(other, other.o1, r.id, { kind: "delete_sandbox", name: "vm-two" })).toMatchObject({ status: 404 });
    expect(await enqueue(f, f.o1, randomUUID(), { kind: "reap_sandboxes" })).toMatchObject({ status: 404 });
    expect(await enqueue(f, f.o1, "not-a-uuid", { kind: "reap_sandboxes" })).toMatchObject({ status: 404 });
    for (const body of [{}, { kind: "run_sandbox", name: "x" }, { kind: "stop_sandbox" }, { kind: "reap_sandboxes", name: "vm-one" }, { kind: "delete_sandbox", name: "../x" }, { kind: "delete_sandbox", name: "A" }, { kind: "stop_sandbox", name: "vm-one", extra: 1 }, [], null, "x"]) {
      expect(await enqueue(f, f.o1, r.id, body), JSON.stringify(body)).toMatchObject({ status: 400 });
    }
    expect((await rows(r.id)).map((x) => x.kind)).toEqual(["stop_sandbox", "reap_sandboxes"]);
    expect((await h.admin.query<{ issued_by: string }>("SELECT issued_by FROM sandbox_commands WHERE runner_id = $1 ORDER BY issued_at", [r.id])).rows.map((x) => x.issued_by)).toEqual([f.o1, f.a1]);
  });

  it("refuses a removed runner and a runner that does not take sandbox commands, and queues nothing", async () => {
    const f = await seedF2(h.admin);
    const gone = await runner(f);
    await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [gone.id]);
    expect(await enqueue(f, f.o1, gone.id, { kind: "reap_sandboxes" })).toMatchObject({ status: 409, body: { error: { code: "runner_revoked" } } });
    const nocap = await runner(f, { capable: false });
    const old = await runner(f, { protocol: SANDBOX_INVENTORY_MIN_PROTOCOL - 1 });
    expect(await enqueue(f, f.o1, nocap.id, { kind: "reap_sandboxes" })).toMatchObject({ status: 409, body: { error: { code: "not_supported" } } });
    expect(await enqueue(f, f.o1, old.id, { kind: "reap_sandboxes" })).toMatchObject({ status: 409, body: { error: { code: "not_supported" } } });
    expect([...(await rows(gone.id)), ...(await rows(nocap.id)), ...(await rows(old.id))]).toEqual([]);
  });

  it("the same request while it waits is one command; the twenty-first open one is refused", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    const a = await enqueue(f, f.o1, r.id, { kind: "delete_sandbox", name: "vm-one" });
    const b = await enqueue(f, f.o1, r.id, { kind: "delete_sandbox", name: "vm-one" });
    expect(idOf(b)).toBe(idOf(a));
    expect(await rows(r.id)).toHaveLength(1);
    for (let n = 1; n < SANDBOX_COMMAND_MAX_OPEN; n++) expect(await enqueue(f, f.o1, r.id, { kind: "delete_sandbox", name: `vm-${n}` })).toMatchObject({ status: 200 });
    expect(await enqueue(f, f.o1, r.id, { kind: "delete_sandbox", name: "one-too-many" })).toMatchObject({ status: 429, body: { error: { code: "too_many" } } });
  });

  it("asking again after an unclaimed command expired queues a fresh one and retires the old one", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    const old = idOf(await enqueue(f, f.o1, r.id, { kind: "stop_sandbox", name: "vm-one" }));
    await h.admin.query("UPDATE sandbox_commands SET issued_at = now() - interval '2 hours', expires_at = now() - interval '110 minutes' WHERE id = $1", [old]);
    const again = await enqueue(f, f.o1, r.id, { kind: "stop_sandbox", name: "vm-one" });
    expect(again.status).toBe(200);
    expect(idOf(again)).not.toBe(old);
    expect((await stateOf(old))?.state).toBe("expired");
    expect((await stateOf(idOf(again)))?.state).toBe("pending");
    expect(await rows(r.id)).toHaveLength(2);
    // another runner's stale row of the same account is not this request's business
    const other = await runner(f);
    const stale = idOf(await enqueue(f, f.o1, other.id, { kind: "stop_sandbox", name: "vm-one" }));
    await h.admin.query("UPDATE sandbox_commands SET issued_at = now() - interval '2 hours', expires_at = now() - interval '110 minutes' WHERE id = $1", [stale]);
    expect((await enqueue(f, f.o1, r.id, { kind: "stop_sandbox", name: "vm-one" })).status).toBe(200);
    expect((await stateOf(stale))?.state).toBe("pending");
  });

  it("a request that wins the one-pending slot between the lookup and the insert is answered with that command, not a 500", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    // A second connection holds an uncommitted identical pending row: the enqueue's lookup cannot see it, its insert waits on the unique index, and when the other
    // connection commits the insert finds the slot taken.
    const other = await h.adminPool.connect();
    try {
      await other.query("BEGIN");
      const won = (
        await other.query<{ id: string }>(
          `INSERT INTO sandbox_commands (account_id, runner_id, kind, name, issued_by, issued_at, expires_at) VALUES ($1, $2, 'delete_sandbox', 'vm-race', $3, now(), now() + interval '300 seconds') RETURNING id`,
          [f.accountId, r.id, f.o1],
        )
      ).rows[0]!.id;
      const asking = enqueue(f, f.o1, r.id, { kind: "delete_sandbox", name: "vm-race" });
      for (let n = 0; n < 100; n++) {
        const waiting = await h.admin.query("SELECT 1 FROM pg_locks WHERE NOT granted AND locktype = 'transactionid'");
        if (waiting.rowCount) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await other.query("COMMIT");
      const res = await asking;
      expect(res.status).toBe(200);
      expect(idOf(res)).toBe(won);
      expect(await rows(r.id)).toHaveLength(1);
    } finally {
      await other.query("ROLLBACK");
      other.release();
    }
  });

  it("a person cannot move a command to expired while it is still live, or to any state but cancelled and expired", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    const id = idOf(await enqueue(f, f.o1, r.id, { kind: "reap_sandboxes" }));
    const { withTenant } = await import("@fx/db/src/withTenant.js");
    const live = withTenant(h.deps().appUserPool, f.accountId, f.o1, (c) => c.query("UPDATE sandbox_commands SET state = 'expired' WHERE id = $1", [id]));
    await expect(live).rejects.toMatchObject({ code: "42501" });
    expect((await stateOf(id))?.state).toBe("pending");
  });

  it("delivers a signed command to the runner it names, once, and the signature verifies for that runner only", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    const r2 = await runner(f);
    const id = idOf(await enqueue(f, f.o1, r.id, { kind: "delete_sandbox", name: "vm-one" }));
    expect(commandsOf(await claim(r2))).toEqual([]);
    const reply = await claim(r);
    const [cmd] = commandsOf(reply);
    expect(reply.status).toBe(200);
    expect(commandsOf(reply)).toHaveLength(1);
    const verified = verifySandboxCommand(cmd, keyring, r.id);
    expect(verified).toMatchObject({ purpose: "sandbox_command_v1", runner_id: r.id, kind: "delete_sandbox", name: "vm-one" });
    expect(() => verifySandboxCommand(cmd, keyring, r2.id)).toThrow();
    expect(Date.parse(verified.exp)).toBeGreaterThan(Date.now());
    expect(await stateOf(id)).toMatchObject({ state: "delivered" });
    expect(commandsOf(await claim(r))).toEqual([]);
    expect((await h.admin.query<{ nonce: string }>("SELECT nonce FROM sandbox_commands WHERE id = $1", [id])).rows[0]!.nonce).toBe(verified.nonce);
  });

  it("hands over at most five per claim, oldest first", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    for (let n = 0; n < 7; n++) await enqueue(f, f.o1, r.id, { kind: "delete_sandbox", name: `vm-${n}` });
    const first = commandsOf(await claim(r)).map((c) => c.command.name);
    expect(first).toEqual(["vm-0", "vm-1", "vm-2", "vm-3", "vm-4"]);
    expect(commandsOf(await claim(r)).map((c) => c.command.name)).toEqual(["vm-5", "vm-6"]);
  });

  it("hands nothing to a runner that did not list the capability or declared less than protocol 21, and the command waits", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    await enqueue(f, f.o1, r.id, { kind: "reap_sandboxes" });
    await h.admin.query("UPDATE runner_capabilities SET capabilities = '{}' WHERE runner_id = $1", [r.id]);
    expect(commandsOf(await claim(r))).toEqual([]);
    await h.admin.query("UPDATE runner_capabilities SET capabilities = ARRAY['wake_v1'] WHERE runner_id = $1", [r.id]);
    expect(commandsOf(await claim(r))).toEqual([]);
    await h.admin.query("DELETE FROM runner_capabilities WHERE runner_id = $1", [r.id]);
    expect(commandsOf(await claim(r))).toEqual([]);
    await h.admin.query("INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, ARRAY['sandbox_commands_v1'])", [r.id, f.accountId]);
    await h.admin.query("UPDATE runners SET protocol_version = 20 WHERE id = $1", [r.id]);
    expect(commandsOf(await claim(r))).toEqual([]);
    expect((await rows(r.id))[0]!.state).toBe("pending");
    await h.admin.query("UPDATE runners SET protocol_version = 21 WHERE id = $1", [r.id]);
    expect(commandsOf(await claim(r))).toHaveLength(1);
  });

  it("an expired command is never handed over, and a status poll or a removed runner gets none", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    const id = idOf(await enqueue(f, f.o1, r.id, { kind: "reap_sandboxes" }));
    await h.admin.query("UPDATE sandbox_commands SET issued_at = now() - interval '2 hours', expires_at = now() - interval '110 minutes' WHERE id = $1", [id]);
    expect(commandsOf(await claim(r))).toEqual([]);
    expect((await stateOf(id))?.state).toBe("expired");
    const id2 = idOf(await enqueue(f, f.o1, r.id, { kind: "reap_sandboxes" }));
    expect(commandsOf(await claim(r, { sandbox_unavailable: "bwrap_missing" }))).toEqual([]);
    expect((await stateOf(id2))?.state).toBe("pending");
    await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [r.id]);
    expect((await claim(r)).status).toBe(401);
    expect((await stateOf(id2))?.state).toBe("pending");
  });

  it("delivers nothing, and marks nothing delivered, when the key is not configured or cannot sign", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    const id = idOf(await enqueue(f, f.o1, r.id, { kind: "reap_sandboxes" }));
    expect(commandsOf(await claim(r, {}, deps({ engineCommandSigner: null })))).toEqual([]);
    expect(commandsOf(await claim(r, {}, deps({ engineCommandSigner: async () => null })))).toEqual([]);
    const broken = { keyId: KEY_ID, signEngineCommand: () => { throw new Error("no key"); }, signSandboxCommand: () => { throw new Error("no key"); } };
    const res = await claim(r, {}, deps({ engineCommandSigner: async () => broken as never }));
    expect(res.status).toBe(200);
    expect(commandsOf(res)).toEqual([]);
    expect((await stateOf(id))?.state).toBe("pending");
    expect(commandsOf(await claim(r))).toHaveLength(1);
  });

  it("stores an ack for a delivered command: applied, or refused with the reason; once; and ignores any other nonce", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    const r2 = await runner(f);
    const a = idOf(await enqueue(f, f.o1, r.id, { kind: "delete_sandbox", name: "vm-a" }));
    const b = idOf(await enqueue(f, f.o1, r.id, { kind: "delete_sandbox", name: "vm-b" }));
    const c = idOf(await enqueue(f, f.o1, r.id, { kind: "delete_sandbox", name: "vm-c" }));
    const sent = commandsOf(await claim(r));
    const nonceOf = (name: string) => sent.find((x) => x.command.name === name)!.command.nonce;
    // c was only just queued: pending rows have no ack to take. Another runner's nonce changes nothing.
    await h.admin.query("UPDATE sandbox_commands SET state = 'pending', delivered_at = NULL WHERE id = $1", [c]);
    const res = await claim(r, { sandbox_acks: [{ nonce: nonceOf("vm-a"), outcome: "applied" }, { nonce: nonceOf("vm-b"), outcome: "refused", refusal: "in_use" }, { nonce: nonceOf("vm-c"), outcome: "applied" }, { nonce: randomUUID(), outcome: "applied" }] });
    expect(res.status).toBe(200);
    expect(await stateOf(a)).toMatchObject({ state: "applied", refusal: null });
    expect(await stateOf(b)).toMatchObject({ state: "refused", refusal: "in_use" });
    expect((await stateOf(c))?.state).toBe("delivered");
    // A second ack for the same command, and an ack from another runner, change nothing.
    await claim(r, { sandbox_acks: [{ nonce: nonceOf("vm-a"), outcome: "refused", refusal: "failed" }] });
    expect(await stateOf(a)).toMatchObject({ state: "applied", refusal: null });
    await claim(r2, { sandbox_acks: [{ nonce: nonceOf("vm-c"), outcome: "applied" }] });
    expect((await stateOf(c))?.state).toBe("delivered");
    // The protocol refuses a refusal with no reason, and an applied one with a reason.
    expect(await claim(r, { sandbox_acks: [{ nonce: randomUUID(), outcome: "refused" }] })).toMatchObject({ status: 400 });
    expect(await claim(r, { sandbox_acks: [{ nonce: randomUUID(), outcome: "applied", refusal: "failed" }] })).toMatchObject({ status: 400 });
  });

  it("the delivery and ack queries carry their own runner and account predicates: run through the admin role, where row security does not help, they touch only the named runner's rows", async () => {
    const f = await seedF2(h.admin);
    const g = await seedF2(h.admin);
    const r1 = await runner(f);
    const r2 = await runner(f);
    const gr = await runner(g);
    const ids: Record<string, string> = {};
    for (const [label, fx, r] of [["r1", f, r1], ["r2", f, r2], ["gr", g, gr]] as const) ids[label] = idOf(await enqueue(fx, fx.o1, r.id, { kind: "delete_sandbox", name: `vm-${label}` }));
    const who = (fx: F2Fixture, r: { id: string }) => ({ runnerId: r.id, accountId: fx.accountId, registeredBy: fx.m1, credentialMode: "subscription", jkt: "x", publicKeyX: "x", keyValidUntil: new Date(Date.now() + 1e9) });
    const signer = async () => createJobSigner({ keyId: KEY_ID, privateKey: signKey });
    // Delivery: runner r1 gets its own command only, though r2's (same account) and gr's (another account) wait in the same table.
    const got = await exchangeSandboxCommands(h.admin, who(f, r1), [], signer);
    expect(got.map((c) => c.command.name)).toEqual(["vm-r1"]);
    expect((await stateOf(ids.r2!))?.state).toBe("pending");
    expect((await stateOf(ids.gr!))?.state).toBe("pending");
    // The same call with another account's id for r2 finds nothing: the account predicate stands on its own.
    expect(await exchangeSandboxCommands(h.admin, who(g, r2), [], signer)).toEqual([]);
    expect((await stateOf(ids.r2!))?.state).toBe("pending");
    // Ack: r2 delivered, then r1 names r2's nonce, and a foreign account names it too: nothing changes. The owner of the nonce acks it.
    const sent2 = await exchangeSandboxCommands(h.admin, who(f, r2), [], signer);
    const nonce2 = sent2[0]!.command.nonce;
    await exchangeSandboxCommands(h.admin, who(f, r1), [{ nonce: nonce2, outcome: "applied" }], signer);
    await exchangeSandboxCommands(h.admin, who(g, r2), [{ nonce: nonce2, outcome: "applied" }], signer);
    expect((await stateOf(ids.r2!))?.state).toBe("delivered");
    await exchangeSandboxCommands(h.admin, who(f, r2), [{ nonce: nonce2, outcome: "applied" }], signer);
    expect((await stateOf(ids.r2!))?.state).toBe("applied");
  });

  it("row security: an account sees only its own commands, and neither a member, a runner session nor the admin client under a foreign account can write or read across", async () => {
    const f = await seedF2(h.admin);
    const g = await seedF2(h.admin);
    const r = await runner(f);
    const gr = await runner(g);
    await enqueue(f, f.o1, r.id, { kind: "reap_sandboxes" });
    await enqueue(g, g.o1, gr.id, { kind: "reap_sandboxes" });
    const as = async <T,>(account: string, user: string | null, runnerId: string | null, run: (q: (sql: string, args?: unknown[]) => Promise<{ rows: Array<Record<string, string>>; rowCount: number | null }>) => Promise<T>): Promise<T> => {
      const client = await h.appPool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.account_id', $1, true)", [account]);
        if (user) await client.query("SELECT set_config('app.user_id', $1, true)", [user]);
        if (runnerId) await client.query("SELECT set_config('app.runner_id', $1, true)", [runnerId]);
        return await run((sql, args) => client.query(sql, args));
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    };
    expect(await as(f.accountId, f.m1, null, async (q) => (await q("SELECT runner_id FROM sandbox_commands")).rows.map((x) => x.runner_id))).toEqual([r.id]);
    // A runner session sees its own runner's rows only (a second runner of the same account has none visible).
    const sibling = await runner(f);
    expect(await as(f.accountId, null, sibling.id, async (q) => (await q("SELECT 1 FROM sandbox_commands")).rowCount)).toBe(0);
    // Foreign account id, as the application login: nothing of ours.
    expect(await as(g.accountId, g.o1, null, async (q) => (await q("SELECT 1 FROM sandbox_commands WHERE runner_id = $1", [r.id])).rowCount)).toBe(0);
    // Reading through the admin client with a foreign account id as a predicate finds no row of ours under it.
    expect((await h.admin.query("SELECT 1 FROM sandbox_commands WHERE account_id = $1 AND runner_id = $2", [g.accountId, r.id])).rowCount).toBe(0);
    const insert = (account: string, user: string, runnerId: string) => `INSERT INTO sandbox_commands (account_id, runner_id, kind, issued_by, expires_at) VALUES ('${account}', '${runnerId}', 'reap_sandboxes', '${user}', now() + interval '60 seconds')`;
    // A member cannot issue; an owner of another account cannot issue for this one's runner; nobody can issue as someone else; a runner session cannot issue.
    await expect(as(f.accountId, f.m1, null, (q) => q(insert(f.accountId, f.m1, r.id)))).rejects.toMatchObject({ code: "42501" });
    await expect(as(g.accountId, g.o1, null, (q) => q(insert(g.accountId, g.o1, r.id)))).rejects.toThrow();
    await expect(as(f.accountId, f.o1, null, (q) => q(insert(f.accountId, f.a1, r.id)))).rejects.toMatchObject({ code: "42501" });
    await expect(as(f.accountId, f.o1, r.id, (q) => q(insert(f.accountId, f.o1, r.id)))).rejects.toMatchObject({ code: "42501" });
    // No one may delete or rewrite what a command says; an owner may only cancel a pending one; a runner may not walk a row backwards.
    await expect(as(f.accountId, f.o1, null, (q) => q("DELETE FROM sandbox_commands"))).rejects.toMatchObject({ code: "42501" });
    await expect(as(f.accountId, f.o1, null, (q) => q("UPDATE sandbox_commands SET name = 'x'"))).rejects.toMatchObject({ code: "42501" });
    await expect(as(f.accountId, f.o1, null, (q) => q("UPDATE sandbox_commands SET state = 'applied'"))).rejects.toThrow();
    expect(await as(f.accountId, f.o1, null, async (q) => (await q("UPDATE sandbox_commands SET state = 'cancelled' WHERE runner_id = $1", [r.id])).rowCount)).toBe(1);
    await expect(as(f.accountId, null, r.id, (q) => q("UPDATE sandbox_commands SET state = 'applied', acked_at = now(), delivered_at = now()"))).rejects.toThrow();
    // The table itself holds the rules: the shape of a command, and its life.
    const raw = (sql: string) => h.admin.query(sql);
    await expect(raw(`INSERT INTO sandbox_commands (account_id, runner_id, kind, name, issued_by, expires_at) VALUES ('${f.accountId}', '${r.id}', 'reap_sandboxes', 'vm-one', '${f.o1}', now() + interval '60 seconds')`)).rejects.toMatchObject({ code: "23514" });
    await expect(raw(`INSERT INTO sandbox_commands (account_id, runner_id, kind, issued_by, expires_at) VALUES ('${f.accountId}', '${r.id}', 'delete_sandbox', '${f.o1}', now() + interval '60 seconds')`)).rejects.toMatchObject({ code: "23514" });
    await expect(raw(`INSERT INTO sandbox_commands (account_id, runner_id, kind, name, issued_by, expires_at) VALUES ('${f.accountId}', '${r.id}', 'delete_sandbox', '../x', '${f.o1}', now() + interval '60 seconds')`)).rejects.toMatchObject({ code: "23514" });
    await expect(raw(`INSERT INTO sandbox_commands (account_id, runner_id, kind, issued_by, expires_at) VALUES ('${f.accountId}', '${r.id}', 'reap_sandboxes', '${f.o1}', now() + interval '3 hours')`)).rejects.toMatchObject({ code: "23514" });
    await expect(raw(`INSERT INTO sandbox_commands (account_id, runner_id, kind, name, issued_by, expires_at) VALUES ('${g.accountId}', '${r.id}', 'delete_sandbox', 'vm-fk', '${g.o1}', now() + interval '60 seconds')`)).rejects.toMatchObject({ code: "23503" });
  });
});

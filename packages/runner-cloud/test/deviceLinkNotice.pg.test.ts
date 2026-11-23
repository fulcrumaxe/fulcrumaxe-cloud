import type { QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEVICE_START_PATH, signDevicePop } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { approveDeviceCode, hashUserCode, lookupDeviceCode, startDevice, type RunnerCloudDeps } from "../src/index.js";
import { boundSourceIp } from "../src/boundSourceIp.js";
import { ORIGIN, harness, newKey, respond, type Harness } from "./helpers.js";

const KEY = Buffer.from("k".repeat(32));
const FACTS = { hostname: "build-box-1", os: "linux", arch: "x64", kvm: true };
const IP = "203.0.113.77";

describe("machine link notice and link facts [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const deps = (over: Partial<RunnerCloudDeps> = {}) => h.deps({ deviceCodeKey: () => KEY, deviceFlowGlobalPerHour: () => 100_000, maxRunners: () => 1000, ...over });
  let n = 0;
  const start = async (headers: Record<string, string> = {}) => {
    const key = newKey();
    const pop = signDevicePop(key.privateKey, { origin: ORIGIN, path: DEVICE_START_PATH, iat: Math.floor(Date.now() / 1000) });
    const req = { method: "POST", headers: { "content-type": "application/json", ...headers }, body: Buffer.from(JSON.stringify({ public_key_jwk: key.jwk, pop, facts: FACTS })), clientIp: `192.0.2.${++n % 250}` };
    const res = await respond(() => startDevice(deps(), req));
    expect(res.status).toBe(201);
    return (res.body as { user_code: string }).user_code;
  };
  const codeRow = async (userCode: string) => (await h.admin.query("SELECT facts, status, host(source_ip) AS source_ip FROM runner_device_codes WHERE user_code_hash = $1", [hashUserCode(KEY, userCode)])).rows[0];
  const approve = (f: F2Fixture, user: string, userCode: string) => respond(() => approveDeviceCode(deps(), { accountId: f.accountId, userId: user }, { user_code: userCode, confirm: true }));
  const linked = async (headers: Record<string, string> = { "x-vercel-forwarded-for": IP }) => {
    const f = await seedF2(h.admin);
    const code = await start(headers);
    const res = await approve(f, f.o1, code);
    expect(res.status).toBe(200);
    return { f, code, runnerId: (res.body as { runner_id: string }).runner_id };
  };
  const as = <T extends QueryResultRow>(accountId: string, userId: string, sql: string, params: unknown[] = []) => withTenant(h.appPool, accountId, userId, async (c) => (await c.query<T>(sql, params)).rows);

  it("reads the address from the platform header alone: a list, a stray value, or the generic headers give none", async () => {
    expect(boundSourceIp({ "x-vercel-forwarded-for": IP })).toBe(IP);
    const stray: Array<Record<string, string>> = [{ "x-forwarded-for": IP }, { "x-real-ip": IP }, { "x-vercel-forwarded-for": `${IP}, 198.51.100.1` }, { "x-vercel-forwarded-for": "not-an-ip" }, {}];
    for (const headers of stray) {
      const code = await start(headers);
      expect((await codeRow(code)).source_ip, JSON.stringify(headers)).toBeNull();
    }
    const row = await codeRow(await start({ "x-vercel-forwarded-for": IP, "x-forwarded-for": "10.9.9.9" }));
    expect(row).toMatchObject({ source_ip: IP, facts: FACTS });
  });

  it("the person's lookup does not carry the address", async () => {
    const f = await seedF2(h.admin);
    const code = await start({ "x-vercel-forwarded-for": IP });
    const res = await respond(() => lookupDeviceCode(deps(), { accountId: f.accountId, userId: f.o1 }, { user_code: code }));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(IP);
  });

  it("approval stores the address for the machine, takes it out of the code row, and tells every owner and admin and no member", async () => {
    const { f, code, runnerId } = await linked();
    expect((await codeRow(code)).source_ip).toBeNull();
    // A session of the account cannot read the column of the code row even while the address is still there.
    await expect(as(f.accountId, f.o1, "SELECT source_ip FROM runner_device_codes")).rejects.toMatchObject({ code: "42501" });
    const facts = (await h.admin.query("SELECT account_id, host(linked_from_ip) AS ip FROM runner_link_facts WHERE runner_id = $1", [runnerId])).rows;
    expect(facts).toEqual([{ account_id: f.accountId, ip: IP }]);
    const notices = (await h.admin.query("SELECT user_id, kind, ref FROM account_notices WHERE account_id = $1 ORDER BY user_id", [f.accountId])).rows;
    expect(notices.map((r) => r.user_id).sort()).toEqual([f.o1, f.o2, f.a1, f.a2].sort());
    expect(notices.every((r) => r.kind === "machine.linked" && r.ref === runnerId)).toBe(true);
    const audit = (await h.admin.query("SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'machine.linked_notified'", [f.accountId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].payload).toMatchObject({ runner_id: runnerId, recipients: 4 });
    // The address is in no audit row, no notice and no event of the account.
    const everywhere = JSON.stringify([
      (await h.admin.query("SELECT * FROM audit_log WHERE account_id = $1", [f.accountId])).rows,
      (await h.admin.query("SELECT * FROM account_notices WHERE account_id = $1", [f.accountId])).rows,
      (await h.admin.query("SELECT * FROM domain_events WHERE account_id = $1", [f.accountId])).rows,
      (await h.admin.query("SELECT * FROM runner_device_codes WHERE account_id = $1", [f.accountId])).rows,
    ]);
    expect(everywhere).not.toContain(IP);
  });

  it("a machine whose request carried no usable header is still linked and announced, with no address", async () => {
    const { f, runnerId } = await linked({});
    expect((await h.admin.query("SELECT linked_from_ip FROM runner_link_facts WHERE runner_id = $1", [runnerId])).rows).toEqual([{ linked_from_ip: null }]);
    expect((await h.admin.query("SELECT count(*)::int AS n FROM account_notices WHERE account_id = $1", [f.accountId])).rows[0].n).toBe(4);
  });

  it("only an owner or admin of the account reads the address: a member, another account's owner and a member of nowhere get nothing", async () => {
    const { f, runnerId } = await linked();
    const other = await seedF2(h.admin);
    const read = (acct: string, user: string) => as<{ ip: string }>(acct, user, "SELECT host(linked_from_ip) AS ip FROM runner_link_facts WHERE runner_id = $1", [runnerId]);
    for (const who of [f.o1, f.o2, f.a1, f.a2]) expect(await read(f.accountId, who), who).toEqual([{ ip: IP }]);
    for (const who of [f.m1, f.m2]) expect(await read(f.accountId, who), who).toEqual([]);
    // Another account's owner, in their own account or claiming this one.
    expect(await read(other.accountId, other.o1)).toEqual([]);
    expect(await read(f.accountId, other.o1)).toEqual([]);
    // The RLS-bypassing admin client with a foreign account id finds nothing under that account.
    expect((await h.admin.query("SELECT 1 FROM runner_link_facts WHERE runner_id = $1 AND account_id = $2", [runnerId, other.accountId])).rows).toEqual([]);
    // A member cannot reach it through the runners table either: it is not a column there.
    expect((await h.admin.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'runners' AND column_name = 'linked_from_ip'")).rows).toEqual([]);
  });

  it("each recipient reads their own notices only, and a member reads none", async () => {
    const { f } = await linked();
    const mine = (acct: string, user: string) => as<{ user_id: string }>(acct, user, "SELECT user_id FROM account_notices");
    expect(await mine(f.accountId, f.o1)).toEqual([{ user_id: f.o1 }]);
    expect(await mine(f.accountId, f.a2)).toEqual([{ user_id: f.a2 }]);
    expect(await mine(f.accountId, f.m1)).toEqual([]);
    const other = await seedF2(h.admin);
    expect(await mine(other.accountId, other.o1)).toEqual([]);
  });

  it("is written in the approval's transaction: a failure after it leaves no machine, no address and no notice", async () => {
    const f = await seedF2(h.admin);
    const code = await start({ "x-vercel-forwarded-for": IP });
    const hash = hashUserCode(KEY, code);
    await expect(
      withTenant(h.appPool, f.accountId, f.o1, async (c) => {
        const id = (await c.query<{ runner_id: string }>("SELECT runner_id FROM runner_device_approve($1, NULL, 1000)", [hash])).rows[0]!.runner_id;
        expect((await c.query<{ n: number }>("SELECT machine_link_record($1::uuid) AS n", [id])).rows[0]!.n).toBe(4);
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");
    expect((await h.admin.query("SELECT count(*)::int AS n FROM account_notices WHERE account_id = $1", [f.accountId])).rows[0].n).toBe(0);
    expect((await h.admin.query("SELECT count(*)::int AS n FROM runner_link_facts WHERE account_id = $1", [f.accountId])).rows[0].n).toBe(0);
    expect((await codeRow(code)).status).toBe("pending");
  });

  it("does nothing a second time, for another account's runner, or for a member; the member is refused", async () => {
    const { f, runnerId } = await linked();
    const other = await seedF2(h.admin);
    const call = (acct: string, user: string) => as<{ n: number }>(acct, user, "SELECT machine_link_record($1::uuid) AS n", [runnerId]);
    expect(await call(f.accountId, f.o1)).toEqual([{ n: 0 }]);
    expect(await call(other.accountId, other.o1)).toEqual([{ n: 0 }]);
    await expect(call(f.accountId, f.m1)).rejects.toMatchObject({ code: "42501" });
    expect((await h.admin.query("SELECT count(*)::int AS n FROM account_notices WHERE account_id = $1", [f.accountId])).rows[0].n).toBe(4);
    expect((await h.admin.query("SELECT count(*)::int AS n FROM account_notices WHERE account_id = $1", [other.accountId])).rows[0].n).toBe(0);
  });

  it("another account's owner cannot take a runner's first link record: nothing is written for it, and the real account's call still works", async () => {
    const f = await seedF2(h.admin);
    const other = await seedF2(h.admin);
    const hash = hashUserCode(KEY, await start({ "x-vercel-forwarded-for": IP }));
    const id = await withTenant(h.appPool, f.accountId, f.o1, async (c) => (await c.query<{ runner_id: string }>("SELECT runner_id FROM runner_device_approve($1, NULL, 1000)", [hash])).rows[0]!.runner_id);
    const call = (acct: string, user: string) => as<{ n: number }>(acct, user, "SELECT machine_link_record($1::uuid) AS n", [id]);
    expect(await call(other.accountId, other.o1)).toEqual([{ n: 0 }]);
    expect((await h.admin.query("SELECT count(*)::int AS n FROM runner_link_facts WHERE runner_id = $1", [id])).rows[0].n).toBe(0);
    expect(await call(f.accountId, f.o1)).toEqual([{ n: 4 }]);
  });

  it("drops the address when the runner is revoked, whichever way", async () => {
    const { runnerId } = await linked();
    await h.admin.query("UPDATE runners SET revoked_at = now(), revoked_reason = 'test' WHERE id = $1", [runnerId]);
    expect((await h.admin.query("SELECT 1 FROM runner_link_facts WHERE runner_id = $1", [runnerId])).rows).toEqual([]);
  });

  it("a session cannot post a notice at all: account_notice_post is not granted to it, owner or not", async () => {
    const f = await seedF2(h.admin);
    await expect(as(f.accountId, f.o1, "SELECT account_notice_post('machine.linked', NULL)")).rejects.toMatchObject({ code: "42501" });
    await expect(as(f.accountId, f.o1, "SELECT account_notice_post('Bad Kind', NULL)")).rejects.toMatchObject({ code: "42501" });
    await expect(h.appPool.query("SELECT account_notice_post('a.b', NULL)")).rejects.toMatchObject({ code: "42501" });
    expect((await h.admin.query("SELECT count(*)::int AS n FROM account_notices WHERE account_id = $1", [f.accountId])).rows[0].n).toBe(0);
  });

  it("a revoked runner is not linked: no facts row, no notice, no address kept, and the code row's address stays for the prune", async () => {
    const f = await seedF2(h.admin);
    const hash = hashUserCode(KEY, await start({ "x-vercel-forwarded-for": IP }));
    const id = await withTenant(h.appPool, f.accountId, f.o1, async (c) => (await c.query<{ runner_id: string }>("SELECT runner_id FROM runner_device_approve($1, NULL, 1000)", [hash])).rows[0]!.runner_id);
    await h.admin.query("UPDATE runners SET revoked_at = now(), revoked_reason = 'test' WHERE id = $1", [id]);
    expect(await as<{ n: number }>(f.accountId, f.o1, "SELECT machine_link_record($1::uuid) AS n", [id])).toEqual([{ n: 0 }]);
    expect((await h.admin.query("SELECT count(*)::int AS n FROM runner_link_facts WHERE runner_id = $1", [id])).rows[0].n).toBe(0);
    expect((await h.admin.query("SELECT count(*)::int AS n FROM account_notices WHERE account_id = $1", [f.accountId])).rows[0].n).toBe(0);
    expect((await h.admin.query("SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1 AND action = 'machine.linked_notified'", [f.accountId])).rows[0].n).toBe(0);
  });
});

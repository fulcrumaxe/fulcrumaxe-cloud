import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEVICE_POLL_PATH,
  DEVICE_START_PATH,
  DEVICE_USER_CODE_PATTERN,
  DevicePollResponse,
  DeviceStartResponse,
  RegisterResponse,
  signDevicePop,
  type DevicePopClaims,
} from "@fulcrumaxe/runner-protocol";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import {
  approveDeviceCode,
  denyDeviceCode,
  ed25519Thumbprint,
  hashDeviceCode,
  hashUserCode,
  lookupDeviceCode,
  pollDevice,
  startDevice,
  type RunnerCloudDeps,
  type RunnerHttpRequest,
} from "../src/index.js";
import { addressBucket } from "../src/deviceFlow.js";
import { ORIGIN, harness, newKey, respond, signed, type Harness, type TestKey } from "./helpers.js";

const KEY = Buffer.from("k".repeat(32));
const FACTS = { hostname: "build-box-1", os: "linux", arch: "x64", kvm: true };

describe("device flow, cloud side [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const deps = (over: Partial<RunnerCloudDeps> = {}) => h.deps({ deviceCodeKey: () => KEY, deviceFlowGlobalPerHour: () => 100_000, maxRunners: () => 1000, ...over });
  let ipCounter = 0;
  const uniqueIp = () => `198.51.100.${(ipCounter++ % 250) + 1}-${randomBytes(4).toString("hex")}`;
  const popFor = (key: TestKey, over: Partial<DevicePopClaims> = {}) => signDevicePop(key.privateKey, { origin: ORIGIN, path: DEVICE_START_PATH, iat: Math.floor(Date.now() / 1000), ...over });
  const startReq = (key: TestKey, o: { ip?: string; body?: Record<string, unknown>; pop?: string; headers?: Record<string, string> } = {}): RunnerHttpRequest => ({
    method: "POST",
    headers: { "content-type": "application/json", ...(o.headers ?? {}) },
    body: Buffer.from(JSON.stringify({ public_key_jwk: key.jwk, pop: o.pop ?? popFor(key), facts: FACTS, ...(o.body ?? {}) })),
    clientIp: o.ip ?? uniqueIp(),
  });
  const start = async (key: TestKey = newKey(), o: Parameters<typeof startReq>[1] = {}, over: Partial<RunnerCloudDeps> = {}) => {
    const res = await respond(() => startDevice(deps(over), startReq(key, o)));
    return { res, key, body: res.body as { device_code: string; user_code: string; verification_uri: string; expires_at: string; interval_s: number } };
  };
  const poll = (key: TestKey, deviceCode: string, o: { created?: number; rawBody?: Buffer } = {}) => respond(() => pollDevice(deps(), signed(key, DEVICE_POLL_PATH, { device_code: deviceCode }, o)));
  const rowOf = async (userCode: string) => (await h.admin.query("SELECT * FROM runner_device_codes WHERE user_code_hash = $1", [hashUserCode(KEY, userCode)])).rows[0];
  const fresh = (): Promise<F2Fixture> => seedF2(h.admin);
  const lookup = (f: F2Fixture, user: string, body: unknown) => respond(() => lookupDeviceCode(deps(), { accountId: f.accountId, userId: user }, body));
  const approve = (f: F2Fixture, user: string, body: unknown, over: Partial<RunnerCloudDeps> = {}) => respond(() => approveDeviceCode(deps(over), { accountId: f.accountId, userId: user }, body));
  const deny = (f: F2Fixture, user: string, body: unknown) => respond(() => denyDeviceCode(deps(), { accountId: f.accountId, userId: user }, body));
  const unmark = (poll0: number) => h.admin.query(`UPDATE runner_device_codes SET last_polled_at = now() - interval '${poll0} seconds' WHERE last_polled_at IS NOT NULL`);

  describe("start", () => {
    it("answers 201 in the protocol's shape, stores only hashes and no plaintext, and shows the code the way a person types it", async () => {
      const { res, body, key } = await start(newKey(), { headers: { "x-vercel-ip-country": "DE" } });
      expect(res.status).toBe(201);
      DeviceStartResponse.parse(body);
      expect(body.user_code).toMatch(DEVICE_USER_CODE_PATTERN);
      expect(body.verification_uri).toBe(`${ORIGIN}/link`);
      expect(body.interval_s).toBe(5);
      const row = await rowOf(body.user_code);
      expect(row).toMatchObject({ status: "pending", account_id: null, jkt: key.jkt, device_code_hash: hashDeviceCode(body.device_code), user_code_hash: hashUserCode(KEY, body.user_code) });
      expect(row.facts).toEqual({ ...FACTS, ip_country: "DE" });
      expect(JSON.stringify(row)).not.toContain(body.device_code);
      expect(JSON.stringify(row)).not.toContain(body.user_code);
      // The user code is keyed: the same code under another key is another hash, so a leaked table cannot be searched without the server's key.
      expect(hashUserCode(Buffer.from("z".repeat(32)), body.user_code)).not.toBe(row.user_code_hash);
      expect(ed25519Thumbprint(key.jwk.x)).toBe(key.jkt);
      expect((await h.admin.query("SELECT runner_key_thumbprint($1::jsonb) AS t", [JSON.stringify(key.jwk)])).rows[0].t).toBe(ed25519Thumbprint(key.jwk.x));
    });

    it("draws different codes each time, from the letters the Spec allows (no vowel, digit or lower case)", async () => {
      const seen = new Set<string>();
      for (let i = 0; i < 20; i++) seen.add((await start()).body.user_code);
      expect(seen.size).toBe(20);
      for (const code of seen) expect(code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    });

    // A character in the middle of the signature is all data bits. (The last two are not: an Ed25519 signature ends in zero bits, so rewriting the end can leave it unchanged.)
    const mangled = (pop: string): string => {
      const at = pop.length - 40;
      return pop.slice(0, at) + (pop[at] === "A" ? "B" : "A") + pop.slice(at + 1);
    };
    it("refuses a proof that does not verify, and stores nothing: another key, another path, another origin, a stale time, a mangled signature", async () => {
      const key = newKey();
      const other = newKey();
      const before = (await h.admin.query("SELECT count(*)::int AS n FROM runner_device_codes")).rows[0].n;
      const pops = [
        popFor(other),
        popFor(key, { path: DEVICE_POLL_PATH }),
        popFor(key, { origin: "https://attacker.example" }),
        popFor(key, { iat: Math.floor(Date.now() / 1000) - 3600 }),
        mangled(popFor(key)),
        "not.a.jws",
      ];
      for (const pop of pops) {
        const { res } = await start(key, { pop });
        expect([res.status, (res.body as { error: { code: string } }).error.code], pop).toEqual([400, expect.stringMatching(/^invalid_(pop|message)$/)]);
      }
      expect((await h.admin.query("SELECT count(*)::int AS n FROM runner_device_codes")).rows[0].n).toBe(before);
    });

    it("refuses a key of small order and any key the body names twice or any field the shape does not name, at any depth", async () => {
      const key = newKey();
      const small = { kty: "OKP", crv: "Ed25519", x: Buffer.alloc(32).toString("base64url") };
      const refused = (await start(key, { body: { public_key_jwk: small } })).res;
      expect([refused.status, (refused.body as { error: { code: string } }).error.code]).toEqual([400, "invalid_key"]);
      for (const body of [{ extra: 1 }, { facts: { ...FACTS, extra: 1 } }, { public_key_jwk: { ...key.jwk, d: "x" } }, { facts: { ...FACTS, kvm: "yes" } }, { facts: { ...FACTS, os: "Linux" } }]) {
        expect((await start(key, { body })).res.status, JSON.stringify(body)).toBe(400);
      }
    });

    it("answers 503 and stores nothing while no server key is configured, or it is shorter than 32 bytes", async () => {
      const before = (await h.admin.query("SELECT count(*)::int AS n FROM runner_device_codes")).rows[0].n;
      for (const key of [null, Buffer.from("short")]) {
        const { res } = await start(newKey(), {}, { deviceCodeKey: () => key });
        expect([res.status, (res.body as { error: { code: string } }).error.code]).toEqual([503, "not_configured"]);
      }
      expect((await start(newKey(), {}, { deviceCodeKey: () => { throw new Error("unreadable"); } })).res.status).toBe(503);
      expect((await h.admin.query("SELECT count(*)::int AS n FROM runner_device_codes")).rows[0].n).toBe(before);
    });

    it("limits one address to 10 starts an hour (the 11th is 429 and stores nothing) and leaves another address alone", async () => {
      const ip = uniqueIp();
      for (let i = 0; i < 10; i++) expect((await start(newKey(), { ip })).res.status).toBe(201);
      const refused = await start(newKey(), { ip });
      expect([refused.res.status, (refused.res.body as { error: { code: string } }).error.code]).toEqual([429, "rate_limited"]);
      expect((await start(newKey(), { ip: uniqueIp() })).res.status).toBe(201);
      // The address is keyed in the table: the address itself is never stored.
      expect(JSON.stringify((await h.admin.query("SELECT start_ip_hash FROM runner_device_codes WHERE start_ip_hash IS NOT NULL LIMIT 5")).rows)).not.toContain(ip);
    });

    it("counts an IPv6 client by its /64: ten starts from ten addresses of one block use the hourly budget, the 11th is 429, and another block is untouched", async () => {
      const block = randomBytes(2).toString("hex");
      const inBlock = (n: number) => `2001:db8:${block}:7:${n.toString(16)}::${n + 1}`;
      for (let i = 0; i < 10; i++) expect((await start(newKey(), { ip: inBlock(i) })).res.status).toBe(201);
      const refused = await start(newKey(), { ip: `2001:db8:${block}:7:ffff:ffff:ffff:ffff` });
      expect([refused.res.status, (refused.res.body as { error: { code: string } }).error.code]).toEqual([429, "rate_limited"]);
      expect((await start(newKey(), { ip: `2001:db8:${block}:8::1` })).res.status).toBe(201);
      // The same block written differently is the same block; a bare IPv4 address and a literal that is not a plain address keep their own string.
      expect(addressBucket("2001:DB8:0:0:1::1")).toBe(addressBucket("2001:db8::2:3:4:5"));
      expect(addressBucket("2001:db8::1")).toBe("2001:0db8:0000:0000::/64");
      expect(addressBucket("203.0.113.7")).toBe("203.0.113.7");
      expect(addressBucket("::ffff:203.0.113.7")).toBe("::ffff:203.0.113.7");
      expect(addressBucket("1:2:3::4::5")).toBe("1:2:3::4::5");
    });

    it("limits all addresses together to the configured figure, and reads it on each call", async () => {
      const total = (await h.admin.query("SELECT count(*)::int AS n FROM runner_device_codes WHERE created_at > now() - interval '1 hour'")).rows[0].n;
      expect((await start(newKey(), {}, { deviceFlowGlobalPerHour: () => total })).res.status).toBe(429);
      expect((await start(newKey(), {}, { deviceFlowGlobalPerHour: () => total + 1 })).res.status).toBe(201);
    });

    it("draws again when a hash collides with a live code, and gives up with 503 after five collisions", async () => {
      let calls = 0;
      const flaky = (failures: number) => ({
        query: async (...args: unknown[]) => {
          calls++;
          if (calls <= failures) throw Object.assign(new Error("duplicate"), { code: "23505" });
          return (h.appPool.query as (...a: unknown[]) => unknown)(...args);
        },
      });
      const key = newKey();
      calls = 0;
      const ok = await respond(() => startDevice(deps({ appUserPool: flaky(2) as never }), startReq(key)));
      expect([ok.status, calls]).toEqual([201, 3]);
      calls = 0;
      const gaveUp = await respond(() => startDevice(deps({ appUserPool: flaky(99) as never }), startReq(key)));
      expect([gaveUp.status, calls]).toEqual([503, 5]);
    });
  });

  describe("poll", () => {
    it("answers pending to the key it was started with, and 429 slow_down when faster than the interval", async () => {
      const { key, body } = await start();
      const first = await poll(key, body.device_code);
      expect(first.body).toEqual({ status: "pending" });
      DevicePollResponse.parse(first.body);
      const fast = await poll(key, body.device_code);
      expect([fast.status, (fast.body as { error: { code: string }; interval_s: number }).error.code, (fast.body as { interval_s: number }).interval_s]).toEqual([429, "slow_down", 5]);
      await unmark(6);
      expect((await poll(key, body.device_code)).status).toBe(200);
    });

    it("answers 401 to a poll signed by another key, to an unknown code, to a stale signature and to an unsigned one, all the same", async () => {
      const { key, body } = await start();
      const answers = [
        await poll(newKey(), body.device_code),
        await poll(key, "fxrd_" + "a".repeat(43)),
        await poll(key, body.device_code, { created: Math.floor(Date.now() / 1000) - 3600 }),
        await respond(() => pollDevice(deps(), { method: "POST", headers: {}, body: Buffer.from(JSON.stringify({ device_code: body.device_code })) })),
      ];
      for (const a of answers) expect([a.status, (a.body as { error: { code: string } }).error.code]).toEqual([401, "unauthorized"]);
      expect((await rowOf(body.user_code)).status).toBe("pending");
    });

    it("refuses a body with another field, or a code that is not a device code, with 400 after the signature", async () => {
      const { key, body } = await start();
      for (const b of [{ device_code: body.device_code, extra: 1 }, { device_code: "BCDF-GHJK" }, {}]) {
        expect((await respond(() => pollDevice(deps(), signed(key, DEVICE_POLL_PATH, b)))).status).toBe(400);
      }
    });
  });

  describe("the person's side", () => {
    it("types the code, sees the facts and a fixed warning, approves with confirm, and the machine's next poll gets its registration once", async () => {
      const f = await fresh();
      const { key, body } = await start();
      await poll(key, body.device_code);
      const found = await lookup(f, f.o1, { user_code: body.user_code });
      expect(found.status).toBe(200);
      expect(found.body).toMatchObject({ facts: { ...FACTS }, warning: expect.stringContaining("Only link a machine you started") });
      const ok = await approve(f, f.a1, { user_code: body.user_code, confirm: true, name: "Build box" });
      expect(ok.status).toBe(200);
      const runnerId = (ok.body as { runner_id: string }).runner_id;
      await unmark(6);
      const done = await poll(key, body.device_code);
      expect(done.status).toBe(200);
      const parsed = DevicePollResponse.parse(done.body);
      expect(parsed).toEqual({ status: "approved", registration: { runner_id: runnerId, account_id: f.accountId, credential_mode: "subscription" } });
      RegisterResponse.parse((parsed as { registration: unknown }).registration);
      await unmark(6);
      for (let i = 0; i < 2; i++) {
        const again = await poll(key, body.device_code);
        expect([again.status, (again.body as { error: { code: string } }).error.code]).toEqual([410, "consumed"]);
        await unmark(6);
      }
      // A new machine has no repositories, and no repository is named anywhere in what it was handed.
      const runner = (await h.admin.query("SELECT allowed_repo_ids, registered_by, jkt FROM runners WHERE id = $1", [runnerId])).rows[0];
      expect(runner).toMatchObject({ allowed_repo_ids: [], registered_by: f.a1, jkt: key.jkt });
    });

    it("takes the code as typed (spaces and case), and refuses a shape that is not a code with 400 without counting an attempt", async () => {
      const f = await fresh();
      const { body } = await start();
      expect((await lookup(f, f.o1, { user_code: ` ${body.user_code.toLowerCase().replace("-", " ")} ` })).status).toBe(200);
      for (const bad of ["ABCD-EFGH", "BCDF-GHJ1", "BCDFGHJ", "", 5, null]) {
        expect((await lookup(f, f.o1, { user_code: bad })).status, String(bad)).toBe(400);
      }
      expect((await lookup(f, f.o1, { user_code: body.user_code, extra: 1 })).status).toBe(400);
      expect((await approve(f, f.o1, { user_code: body.user_code })).status).toBe(400);
      expect((await approve(f, f.o1, { user_code: body.user_code, confirm: false })).status).toBe(400);
      expect((await h.admin.query("SELECT count(*)::int AS n FROM runner_device_attempts WHERE account_id = $1", [f.accountId])).rows[0].n).toBe(0);
      expect((await rowOf(body.user_code)).status).toBe("pending");
    });

    it("refuses a member with 403, and a person who is not in the account; nothing is approved", async () => {
      const f = await fresh();
      const other = await fresh();
      const { body } = await start();
      for (const call of [lookup, deny, (ff: F2Fixture, u: string, b: unknown) => approve(ff, u, { ...(b as object), confirm: true })]) {
        expect((await call(f, f.m1, { user_code: body.user_code })).status).toBe(403);
        expect((await call(f, other.o1, { user_code: body.user_code })).status).toBe(403);
      }
      expect((await rowOf(body.user_code)).status).toBe("pending");
    });

    it("counts a code that matches nothing: the sixth in 15 minutes is 429, and it stops a right code too, for this account only", async () => {
      const f = await fresh();
      const g = await fresh();
      const { body } = await start();
      const wrong = (): string => `${"BCDF"}-${[...randomBytes(4)].map((b) => "BCDFGHJKLMNPQRSTVWXZ"[b % 20]).join("")}`;
      const out: number[] = [];
      for (let i = 0; i < 6; i++) out.push((await lookup(f, f.o1, { user_code: wrong() })).status);
      expect(out).toEqual([404, 404, 404, 404, 404, 429]);
      expect((await lookup(f, f.o1, { user_code: body.user_code })).status).toBe(429);
      expect((await approve(f, f.o1, { user_code: body.user_code, confirm: true })).status).toBe(429);
      expect((await deny(f, f.o1, { user_code: body.user_code })).status).toBe(429);
      expect((await lookup(g, g.o1, { user_code: body.user_code })).status).toBe(200);
    });

    it("40 wrong codes fired at once from one account make 6 searches at most: 5 are 404, the rest 429, and none of them is a 200 or a 5xx", async () => {
      const f = await fresh();
      const wrong = (): string => `${"BCDF"}-${[...randomBytes(4)].map((b) => "BCDFGHJKLMNPQRSTVWXZ"[b % 20]).join("")}`;
      const out = await Promise.all(Array.from({ length: 40 }, () => lookup(f, f.o1, { user_code: wrong() }).then((r) => r.status)));
      expect(out.filter((s) => s === 404).length).toBe(5);
      expect(out.filter((s) => s === 429).length).toBe(35);
      expect((await h.admin.query("SELECT count(*)::int AS n FROM runner_device_attempts WHERE account_id = $1", [f.accountId])).rows[0].n).toBe(6);
    });

    it("answers 410 for an expired code and a denied one, and the machine hears which", async () => {
      const f = await fresh();
      const expired = await start();
      await h.admin.query("UPDATE runner_device_codes SET created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute' WHERE user_code_hash = $1", [hashUserCode(KEY, expired.body.user_code)]);
      const denied = await start();
      expect((await deny(f, f.o1, { user_code: denied.body.user_code })).body).toEqual({ denied: true });
      for (const code of [expired, denied]) {
        for (const call of [lookup, deny, (ff: F2Fixture, u: string, b: unknown) => approve(ff, u, { ...(b as object), confirm: true })]) {
          const r = await call(f, f.o1, { user_code: code.body.user_code });
          expect([r.status, (r.body as { error: { code: string } }).error.code]).toEqual([410, "code_gone"]);
        }
      }
      expect((await poll(expired.key, expired.body.device_code)).body).toMatchObject({ error: { code: "expired" } });
      await unmark(6);
      const d = await poll(denied.key, denied.body.device_code);
      expect([d.status, (d.body as { error: { code: string } }).error.code]).toEqual([410, "denied"]);
    });

    it("answers 409 runner_limit at the plan's ceiling and leaves the code to be approved later", async () => {
      const f = await fresh();
      const { body } = await start();
      const full = await approve(f, f.o1, { user_code: body.user_code, confirm: true }, { maxRunners: () => 0 });
      expect([full.status, (full.body as { error: { code: string } }).error.code]).toEqual([409, "runner_limit"]);
      expect((await rowOf(body.user_code)).status).toBe("pending");
      expect((await approve(f, f.o1, { user_code: body.user_code, confirm: true })).status).toBe(200);
    });

    it("D#845 ON-22a (ruling 42): the machine limit is asked for the runner tier unless the account carries a paid hosted plan item", async () => {
      const f = await fresh();
      await h.admin.query("UPDATE accounts SET plan = 'team', hosted_plan_paid = false WHERE id = $1", [f.accountId]);
      const asked: Array<string | undefined> = [];
      const { body } = await start();
      const res = await approve(f, f.o1, { user_code: body.user_code, confirm: true }, { maxRunners: (plan: string) => (asked.push(plan), 1000) });
      expect(res.status).toBe(200);
      expect(asked).toEqual(["runner"]);
      await h.admin.query("UPDATE accounts SET hosted_plan_paid = true WHERE id = $1", [f.accountId]);
      const second = await start();
      await approve(f, f.o1, { user_code: second.body.user_code, confirm: true }, { maxRunners: (plan: string) => (asked.push(plan), 1000) });
      expect(asked).toEqual(["runner", "team"]);
    });

    it("answers 503 for every call of the person while the server key is missing", async () => {
      const f = await fresh();
      const none = { deviceCodeKey: () => null };
      for (const r of [await respond(() => lookupDeviceCode(deps(none), { accountId: f.accountId, userId: f.o1 }, { user_code: "BCDF-GHJK" })), await respond(() => approveDeviceCode(deps(none), { accountId: f.accountId, userId: f.o1 }, { user_code: "BCDF-GHJK", confirm: true })), await respond(() => denyDeviceCode(deps(none), { accountId: f.accountId, userId: f.o1 }, { user_code: "BCDF-GHJK" }))]) {
        expect(r.status).toBe(503);
      }
    });
  });
});

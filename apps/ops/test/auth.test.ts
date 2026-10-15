import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as enrollOptionsPOST } from "../app/api/auth/enroll/options/route";
import { POST as enrollVerifyPOST } from "../app/api/auth/enroll/verify/route";
import { POST as loginOptionsPOST } from "../app/api/auth/login/options/route";
import { POST as loginVerifyPOST } from "../app/api/auth/login/verify/route";
import { POST as logoutPOST } from "../app/api/auth/logout/route";
import { opsPool } from "../lib/db";
import { clientKey } from "../lib/rateLimit";
import { requireStaff } from "../lib/requireStaff";
import { OPS_SESSION_COOKIE, verifyOpsSession } from "../lib/session";
import { CHALLENGE_COOKIE } from "../lib/webauthn";
import { StaffRefusedError, withStaff } from "../lib/withStaff";
import { ENROLLMENT_TTL_MINUTES, enrollStaff } from "../scripts/enroll-staff";
import { ORIGIN, req, useOpsEnv } from "./support/env";
import { SoftAuthenticator, type CeremonyOptions } from "./support/softAuthenticator";

const run = promisify(execFile);
const RP_ID = new URL(ORIGIN).hostname;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

describe("staff enrollment and passkey sign-in against a real database", () => {
  let restore: () => void;
  let admin: pg.Pool;
  const staffIds: string[] = [];

  beforeAll(() => {
    restore = useOpsEnv();
    admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  });
  afterAll(async () => {
    await admin.query("DELETE FROM platform_staff WHERE id = ANY($1::uuid[])", [staffIds]);
    await admin.end();
    await opsPool().end();
    restore();
  });

  const newStaff = async () => {
    const email = `${randomUUID()}@example.test`;
    const made = await enrollStaff(admin, { email, name: "Test Person" });
    staffIds.push(made.staffId);
    return { ...made, email };
  };

  const json = async (res: Response) => (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  async function enroll(token: string, authenticator: SoftAuthenticator, ceremony?: CeremonyOptions) {
    const opts = await enrollOptionsPOST(req("/api/auth/enroll/options", { json: { token } }));
    if (opts.status !== 200) return { opts, verify: undefined };
    const { options } = await json(opts);
    const challenge = opts.cookies.get(CHALLENGE_COOKIE)!.value;
    const verify = await enrollVerifyPOST(req("/api/auth/enroll/verify", { json: { token, response: authenticator.register(options, ceremony) }, cookies: { [CHALLENGE_COOKIE]: challenge } }));
    return { opts, verify, challenge };
  }

  async function login(authenticator: SoftAuthenticator, ceremony?: CeremonyOptions, ip?: string) {
    const headers = ip ? { "x-vercel-forwarded-for": ip } : undefined;
    const opts = await loginOptionsPOST(req("/api/auth/login/options", { json: {}, ...(headers ? { headers } : {}) }));
    const { options } = await json(opts);
    const challenge = opts.cookies.get(CHALLENGE_COOKIE)!.value;
    const response = authenticator.assert(options, ceremony);
    const verify = await loginVerifyPOST(req("/api/auth/login/verify", { json: { response }, cookies: { [CHALLENGE_COOKIE]: challenge }, ...(headers ? { headers } : {}) }));
    return { verify, challenge, response };
  }

  /** Runs `fn` and returns its result with the `stage` of every refusal line the console logged meanwhile. */
  async function withRefusalStages<R>(fn: () => Promise<R>) {
    const stages: string[] = [];
    const real = process.stdout.write.bind(process.stdout);
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array, ...rest: unknown[]) => {
      try {
        const line = JSON.parse(String(chunk)) as { event?: string; stage?: string };
        if (line.event === "ops.auth.login_refused" && typeof line.stage === "string") stages.push(line.stage);
      } catch {
        // fx-swallow-ok: not one of the logger's JSON lines; let it through unchanged
      }
      return (real as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write);
    try {
      return { stages, replay: await fn() };
    } finally {
      spy.mockRestore();
    }
  }

  const enrolled = async () => {
    const staff = await newStaff();
    const authenticator = new SoftAuthenticator(RP_ID, ORIGIN);
    expect((await enroll(staff.token, authenticator)).verify?.status).toBe(200);
    return { staff, authenticator };
  };

  it("OPS-C2-5: enrolls one passkey with a single-use token, stores only the token's SHA-256, then the passkey signs in", async () => {
    const staff = await newStaff();
    const stored = await admin.query("SELECT token_hash, expires_at - now() AS left FROM staff_enrollment_tokens WHERE staff_id = $1", [staff.staffId]);
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].token_hash).toBe(sha256(staff.token));
    expect(stored.rows[0].token_hash).not.toBe(staff.token);
    expect(stored.rows[0].left.minutes).toBeGreaterThanOrEqual(14);
    expect(ENROLLMENT_TTL_MINUTES).toBe(15);

    const authenticator = new SoftAuthenticator(RP_ID, ORIGIN);
    const done = await enroll(staff.token, authenticator);
    expect(done.verify!.status).toBe(200);
    const creds = await admin.query("SELECT credential_id FROM staff_webauthn_credentials WHERE staff_id = $1", [staff.staffId]);
    expect(creds.rows).toHaveLength(1);
    expect(Buffer.compare(creds.rows[0].credential_id, authenticator.credentialId)).toBe(0);

    const { verify } = await login(authenticator);
    expect(verify.status).toBe(200);
    const cookie = verify.cookies.get(OPS_SESSION_COOKIE)!;
    expect((await verifyOpsSession(cookie.value))?.staffId).toBe(staff.staffId);
    const header = verify.headers.getSetCookie().find((c) => c.startsWith(OPS_SESSION_COOKIE))!;
    expect(header).toMatch(/Secure/i);
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=strict/i);
    expect(header).toMatch(/Path=\//);
    expect(header).not.toMatch(/Domain=/i);
  });

  it("OPS-C2-5: a reused token and an expired token are each refused, and the second passkey is not stored", async () => {
    const { staff } = await enrolled();
    const second = await enroll(staff.token, new SoftAuthenticator(RP_ID, ORIGIN));
    expect(second.opts.status).toBe(401);
    expect(second.opts.cookies.get(OPS_SESSION_COOKIE)).toBeUndefined();

    const expired = await newStaff();
    await admin.query("UPDATE staff_enrollment_tokens SET expires_at = now() - interval '1 minute' WHERE staff_id = $1", [expired.staffId]);
    expect((await enroll(expired.token, new SoftAuthenticator(RP_ID, ORIGIN))).opts.status).toBe(401);
    expect((await enroll("not-a-token", new SoftAuthenticator(RP_ID, ORIGIN))).opts.status).toBe(401);
    const n = await admin.query("SELECT count(*)::int AS n FROM staff_webauthn_credentials WHERE staff_id = ANY($1::uuid[])", [[staff.staffId, expired.staffId]]);
    expect(n.rows[0].n).toBe(1);
  });

  it("OPS-C2-5: an enrollment without user verification is refused and leaves the token unspent", async () => {
    const staff = await newStaff();
    const done = await enroll(staff.token, new SoftAuthenticator(RP_ID, ORIGIN), { uv: false });
    expect(done.verify!.status).toBe(401);
    const spent = await admin.query("SELECT used_at FROM staff_enrollment_tokens WHERE staff_id = $1", [staff.staffId]);
    expect(spent.rows).toEqual([{ used_at: null }]);
    expect((await enroll(staff.token, new SoftAuthenticator(RP_ID, ORIGIN))).verify?.status).toBe(200);
  });

  it("OPS-C2-2: an assertion with the user-verified flag false gets no session cookie", async () => {
    const { authenticator } = await enrolled();
    const { verify } = await login(authenticator, { uv: false });
    expect(verify.status).toBe(401);
    expect(verify.cookies.get(OPS_SESSION_COOKIE)).toBeUndefined();
    expect(verify.headers.get("set-cookie") ?? "").not.toContain(`${OPS_SESSION_COOKIE}=ey`);
  });

  it("OPS-C2-2: a password-style POST, an unknown passkey, a forged origin and a bad signature get no session cookie", async () => {
    const { authenticator } = await enrolled();
    const opts = await loginOptionsPOST(req("/api/auth/login/options", { json: {} }));
    const challenge = opts.cookies.get(CHALLENGE_COOKIE)!.value;
    const cookies = { [CHALLENGE_COOKIE]: challenge };
    const password = await loginVerifyPOST(req("/api/auth/login/verify", { json: { username: "a@example.test", password: "hunter2" }, cookies }));
    expect(password.status).toBe(401);
    expect(password.cookies.get(OPS_SESSION_COOKIE)).toBeUndefined();

    const cases: [string, (o: { challenge: string }) => unknown][] = [
      ["unknown passkey", (o) => new SoftAuthenticator(RP_ID, ORIGIN).assert(o)],
      ["forged origin", (o) => authenticator.assert(o, { origin: "https://evil.example" })],
      ["wrong challenge", () => authenticator.assert({ challenge: "AAAA" })],
    ];
    for (const [name, make] of cases) {
      const fresh = await loginOptionsPOST(req("/api/auth/login/options", { json: {} }));
      const { options } = await json(fresh);
      const res = await loginVerifyPOST(req("/api/auth/login/verify", { json: { response: make(options) }, cookies: { [CHALLENGE_COOKIE]: fresh.cookies.get(CHALLENGE_COOKIE)!.value } }));
      expect(res.status, name).toBe(401);
      expect(res.cookies.get(OPS_SESSION_COOKIE), name).toBeUndefined();
    }
  });

  it("OPS-C2-2: no route accepts a password", async () => {
    // The options route takes no input at all; the credential check is in the other three.
    expect((await loginOptionsPOST(req("/api/auth/login/options", { json: { password: "hunter2" } }))).cookies.get(OPS_SESSION_COOKIE)).toBeUndefined();
    for (const route of [loginVerifyPOST, enrollOptionsPOST, enrollVerifyPOST]) {
      const res = await route(req("/api/auth/x", { json: { password: "hunter2", email: "a@example.test" } }));
      expect(res.status).toBe(401);
      expect(res.cookies.get(OPS_SESSION_COOKIE)).toBeUndefined();
    }
  });

  it("the challenge is single-use and short-lived: a missing, replayed, mistyped or expired one is refused", async () => {
    const { authenticator } = await enrolled();
    const first = await login(authenticator);
    expect(first.verify.status).toBe(200);
    // The very same challenge cookie and assertion, sent again.
    const replay = await loginVerifyPOST(req("/api/auth/login/verify", { json: { response: first.response }, cookies: { [CHALLENGE_COOKIE]: first.challenge } }));
    expect(replay.status).toBe(401);
    expect(replay.cookies.get(OPS_SESSION_COOKIE)).toBeUndefined();
    // The assertion above carries counter 1, so the signature-counter check would refuse its replay even with no challenge store.
    // Many synced platform passkeys always report counter 0; for those only the single-use challenge stands in the way.
    const zero = await enrolled();
    const first0 = await login(zero.authenticator, { counter: 0 });
    expect(first0.verify.status).toBe(200);
    const { stages, replay: replay0 } = await withRefusalStages(() =>
      loginVerifyPOST(req("/api/auth/login/verify", { json: { response: first0.response }, cookies: { [CHALLENGE_COOKIE]: first0.challenge } })),
    );
    expect(replay0.status).toBe(401);
    expect(replay0.cookies.get(OPS_SESSION_COOKIE)).toBeUndefined();
    expect(stages).toEqual(["challenge_replayed"]);
    // No challenge cookie at all.
    const opts = await loginOptionsPOST(req("/api/auth/login/options", { json: {} }));
    const { options } = await json(opts);
    const none = await loginVerifyPOST(req("/api/auth/login/verify", { json: { response: authenticator.assert(options) } }));
    expect(none.status).toBe(401);
    // An enrollment challenge does not work for sign-in.
    const staff = await newStaff();
    const enrollOpts = await enrollOptionsPOST(req("/api/auth/enroll/options", { json: { token: staff.token } }));
    const wrongPurpose = await loginVerifyPOST(req("/api/auth/login/verify", { json: { response: authenticator.assert(options) }, cookies: { [CHALLENGE_COOKIE]: enrollOpts.cookies.get(CHALLENGE_COOKIE)!.value } }));
    expect(wrongPurpose.status).toBe(401);
    // A garbage cookie.
    expect((await loginVerifyPOST(req("/api/auth/login/verify", { json: { response: authenticator.assert(options) }, cookies: { [CHALLENGE_COOKIE]: "garbage" } }))).status).toBe(401);
    // The enrollment challenge is bound to its token.
    const other = await newStaff();
    const bound = await enrollVerifyPOST(
      req("/api/auth/enroll/verify", { json: { token: other.token, response: new SoftAuthenticator(RP_ID, ORIGIN).register((await json(enrollOpts)).options) }, cookies: { [CHALLENGE_COOKIE]: enrollOpts.cookies.get(CHALLENGE_COOKIE)!.value } }),
    );
    expect(bound.status).toBe(401);
  });

  it("a signature counter that does not move forward is refused once the stored one has advanced", async () => {
    const { authenticator } = await enrolled();
    expect((await login(authenticator, { counter: 5 })).verify.status).toBe(200);
    expect((await login(authenticator, { counter: 5 })).verify.status).toBe(401);
    expect((await login(authenticator, { counter: 4 })).verify.status).toBe(401);
    expect((await login(authenticator, { counter: 6 })).verify.status).toBe(200);
  });

  it("a passkey that always reports counter 0 signs in every time, and the stored counter is touched only after the signature verifies", async () => {
    const { staff, authenticator } = await enrolled();
    expect((await login(authenticator, { counter: 0 })).verify.status).toBe(200);
    expect((await login(authenticator, { counter: 0 })).verify.status).toBe(200);
    const stored = () => admin.query("SELECT sign_count FROM staff_webauthn_credentials WHERE staff_id = $1", [staff.staffId]);
    expect((await stored()).rows).toEqual([{ sign_count: "0" }]);
    // A response that fails verification (no user verification, forged origin) never raises the counter.
    expect((await login(authenticator, { counter: 9, uv: false })).verify.status).toBe(401);
    expect((await login(authenticator, { counter: 9, origin: "https://evil.example" })).verify.status).toBe(401);
    expect((await stored()).rows).toEqual([{ sign_count: "0" }]);
    expect((await login(authenticator, { counter: 9 })).verify.status).toBe(200);
    expect((await stored()).rows).toEqual([{ sign_count: "9" }]);
  });

  it("OPS-C2-4: deactivating a staff member ends their next request and blocks a new sign-in", async () => {
    const { staff, authenticator } = await enrolled();
    const pool = opsPool();
    const asStaff = new Headers({ "x-fx-staff-id": staff.staffId, "x-fx-staff-sid": randomUUID() });
    expect(await requireStaff(asStaff, pool)).toEqual({ staffId: staff.staffId });
    await admin.query("UPDATE platform_staff SET active = false WHERE id = $1", [staff.staffId]);
    expect(await requireStaff(asStaff, pool)).toBeNull();
    const { verify } = await login(authenticator);
    expect(verify.status).toBe(401);
    expect(await requireStaff(new Headers(), pool)).toBeNull();
    expect(await requireStaff(new Headers({ "x-fx-staff-id": randomUUID(), "x-fx-staff-sid": randomUUID() }), pool)).toBeNull();
    expect(await requireStaff(new Headers({ "x-fx-staff-id": "not-a-uuid", "x-fx-staff-sid": randomUUID() }), pool)).toBeNull();
    // A staff id with no session id is refused: middleware always sets both.
    expect(await requireStaff(new Headers({ "x-fx-staff-id": staff.staffId }), pool)).toBeNull();
  });

  it("sign-out clears the session cookie, and with no session there is nothing to revoke", async () => {
    const res = await logoutPOST(req("/api/auth/logout", { json: {} }));
    expect(res.status).toBe(200);
    const header = res.headers.getSetCookie().find((c) => c.startsWith(OPS_SESSION_COOKIE))!;
    expect(header).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
  });

  it("sign-out revokes the session on the server: the same token is refused by requireStaff afterwards, and another session of the same person is not", async () => {
    const { staff, authenticator } = await enrolled();
    const pool = opsPool();
    const session = async () => {
      const { verify } = await login(authenticator);
      const claims = (await verifyOpsSession(verify.cookies.get(OPS_SESSION_COOKIE)!.value))!;
      // What middleware passes on for a verified cookie.
      return { sid: claims.sid, headers: new Headers({ "x-fx-staff-id": staff.staffId, "x-fx-staff-sid": claims.sid }) };
    };
    const a = await session();
    const b = await session();
    expect(a.sid).not.toBe(b.sid);
    expect(await requireStaff(a.headers, pool)).toEqual({ staffId: staff.staffId });

    const signOut = () => logoutPOST(req("/api/auth/logout", { json: {}, headers: { "x-fx-staff-sid": a.sid } }));
    expect((await signOut()).status).toBe(200);
    expect(await requireStaff(a.headers, pool)).toBeNull();
    expect(await requireStaff(b.headers, pool)).toEqual({ staffId: staff.staffId });
    // Only a hash of the session id is stored.
    const rows = await admin.query("SELECT key_hash FROM staff_auth_rate WHERE bucket = 'sid_revoked' AND key_hash = ANY($1)", [[sha256(`sid:${a.sid}`), sha256(a.sid)]]);
    expect(rows.rows).toEqual([{ key_hash: sha256(`sid:${a.sid}`) }]);
    // Signing out twice is harmless, and the revocation lapses with the session's own absolute limit.
    expect((await signOut()).status).toBe(200);
    await admin.query("UPDATE staff_auth_rate SET at = now() - interval '8 hours 1 minute' WHERE bucket = 'sid_revoked' AND key_hash = $1", [sha256(`sid:${a.sid}`)]);
    expect(await requireStaff(a.headers, pool)).toEqual({ staffId: staff.staffId });
  });

  it("sign-out answers 503 and keeps the cookie when the deny-list cannot be written, so nobody is told they are signed out when they are not", async () => {
    const pool = opsPool();
    const spy = vi.spyOn(pool, "query").mockRejectedValue(new Error("database down"));
    try {
      const res = await logoutPOST(req("/api/auth/logout", { json: {}, headers: { "x-fx-staff-sid": randomUUID() } }));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "unavailable" });
      expect(res.headers.getSetCookie()).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("on Vercel only x-vercel-forwarded-for picks the rate-limit key: a spoofed x-forwarded-for or x-real-ip changes nothing", () => {
    const real = process.env.VERCEL;
    try {
      process.env.VERCEL = "1";
      const base = clientKey(new Headers({ "x-vercel-forwarded-for": "203.0.113.9" }));
      expect(base).toBe(sha256("203.0.113.9"));
      expect(clientKey(new Headers({ "x-vercel-forwarded-for": "203.0.113.9", "x-forwarded-for": "198.51.100.77", "x-real-ip": "198.51.100.78" }))).toBe(base);
      // With no Vercel header the spoofed ones are not read either: the request shares the "unknown" key.
      expect(clientKey(new Headers({ "x-forwarded-for": "198.51.100.77", "x-real-ip": "198.51.100.78" }))).toBe(sha256("unknown"));
      // Local development (no VERCEL) still falls back to the conventional headers.
      delete process.env.VERCEL;
      expect(clientKey(new Headers({ "x-forwarded-for": "198.51.100.77, 10.0.0.1" }))).toBe(sha256("198.51.100.77"));
    } finally {
      if (real === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = real;
    }
  });

  it("R-68-C2-6: /api/auth/* answers 429 with no detail after 30 requests in 5 minutes from one address, and other addresses are not affected", async () => {
    const ip = `203.0.113.7-${randomUUID()}`;
    const from = { "x-vercel-forwarded-for": ip };
    const call = () => loginOptionsPOST(req("/api/auth/login/options", { json: {}, headers: from }));
    for (let i = 0; i < 30; i++) expect((await call()).status, `request ${i + 1}`).toBe(200);
    const { stages, replay: limited } = await withRefusalStages(call);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect(limited.headers.getSetCookie()).toEqual([]);
    expect(stages).toEqual(["rate_limited"]);
    // The other routes share the one budget.
    expect((await enrollOptionsPOST(req("/api/auth/enroll/options", { json: { token: "x" }, headers: from }))).status).toBe(429);
    // Sign-out is exempt from the budget: a spent budget never keeps a person signed in.
    expect((await logoutPOST(req("/api/auth/logout", { json: {}, headers: from }))).status).toBe(200);
    expect((await loginVerifyPOST(req("/api/auth/login/verify", { json: {}, headers: from }))).status).toBe(429);
    expect((await loginOptionsPOST(req("/api/auth/login/options", { json: {} }))).status).toBe(200);
    // Only a hash of the address is stored. The window slides: 6 minutes on, the address may call again.
    const stored = await admin.query("SELECT count(*)::int AS n FROM staff_auth_rate WHERE key_hash = $1 AND bucket = 'auth_req'", [sha256(ip)]);
    expect(stored.rows[0].n).toBe(30);
    await admin.query("UPDATE staff_auth_rate SET at = now() - interval '6 minutes' WHERE key_hash = $1", [sha256(ip)]);
    expect((await call()).status).toBe(200);
  });

  it("R-68-C2-6: after 10 refused verifies in 15 minutes an address gets 429 even for a valid assertion; successful sign-ins do not count, and another address is unaffected", async () => {
    const { authenticator } = await enrolled();
    const failures = async (ip: string) => (await admin.query("SELECT count(*)::int AS n FROM staff_auth_rate WHERE key_hash = $1 AND bucket = 'auth_fail'", [sha256(ip)])).rows[0].n;
    // Twelve good sign-ins (24 requests) leave the failure budget untouched.
    const good = `198.51.100.1-${randomUUID()}`;
    for (let i = 0; i < 12; i++) expect((await login(authenticator, undefined, good)).verify.status, `sign-in ${i + 1}`).toBe(200);
    expect(await failures(good)).toBe(0);
    // Another address makes ten refused verifies.
    const bad = `192.0.2.1-${randomUUID()}`;
    for (let i = 0; i < 10; i++) {
      const res = await loginVerifyPOST(req("/api/auth/login/verify", { json: { response: { id: "nope" } }, headers: { "x-vercel-forwarded-for": bad } }));
      expect(res.status, `refusal ${i + 1}`).toBe(401);
    }
    expect(await failures(bad)).toBe(10);
    const blocked = await login(authenticator, undefined, bad);
    expect(blocked.verify.status).toBe(429);
    expect(await blocked.verify.json()).toEqual({ error: "rate_limited" });
    expect(blocked.verify.cookies.get(OPS_SESSION_COOKIE)).toBeUndefined();
    // The blocked attempt is not recorded as one more failure, and the same passkey works from another address.
    expect(await failures(bad)).toBe(10);
    expect((await login(authenticator)).verify.status).toBe(200);
    // Sixteen minutes later the failures have aged out.
    await admin.query("UPDATE staff_auth_rate SET at = now() - interval '16 minutes' WHERE key_hash = $1 AND bucket = 'auth_fail'", [sha256(bad)]);
    expect((await login(authenticator, undefined, bad)).verify.status).toBe(200);
  });

  it("OPS-C2-6: withStaff runs in one transaction on the ops_console pool, with app.staff_id set for that transaction only", async () => {
    const { staff } = await enrolled();
    const pool = opsPool();
    const seen = await withStaff(pool, staff.staffId, async (c) => {
      const who = await c.query("SELECT current_user AS u, current_setting('app.staff_id') AS s");
      const first = await c.query("SELECT now() AS t");
      await c.query("SELECT pg_sleep(0.01)");
      const second = await c.query("SELECT now() AS t");
      return { ...who.rows[0], sameTransaction: first.rows[0].t.getTime() === second.rows[0].t.getTime() };
    });
    expect(seen).toMatchObject({ u: "ops_console", s: staff.staffId, sameTransaction: true });
    // Same pool, next transaction: nothing leaked.
    const after = await pool.query("SELECT coalesce(current_setting('app.staff_id', true), '') AS s");
    expect(after.rows[0].s).toBe("");
    // A failure inside rolls the transaction back.
    await expect(withStaff(pool, staff.staffId, async (c) => { await c.query("SELECT 1/0"); })).rejects.toMatchObject({ code: "22012" });
    await expect(withStaff(pool, randomUUID(), async () => 1)).rejects.toBeInstanceOf(StaffRefusedError);
    await expect(withStaff(pool, "x'; DROP TABLE accounts; --", async () => 1)).rejects.toBeInstanceOf(StaffRefusedError);
  });

  it("OPS-C2-5: the console's own login cannot create staff, and the enroll script runs only with the migration credential", async () => {
    const consoleLogin = new pg.Pool({ connectionString: process.env.TEST_OPS_CONSOLE_URL });
    try {
      await expect(consoleLogin.query("INSERT INTO platform_staff (email, display_name) VALUES ('a@example.test', 'A')")).rejects.toMatchObject({ code: "42501" });
      await expect(consoleLogin.query("INSERT INTO staff_enrollment_tokens (staff_id, token_hash, expires_at) VALUES (gen_random_uuid(), 'x', now())")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await consoleLogin.end();
    }
    const script = new URL("../scripts/enroll-staff.ts", import.meta.url).pathname;
    const base = { PATH: process.env.PATH ?? "" } as unknown as NodeJS.ProcessEnv;
    const args = ["--experimental-strip-types", "--no-warnings", script, "--email", `${randomUUID()}@example.test`, "--name", "Script Person"];
    await expect(run("node", args, { env: base })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("DATABASE_URL") });
    await expect(run("node", args, { env: { ...base, DATABASE_URL_OPS_CONSOLE: process.env.TEST_OPS_CONSOLE_URL! } })).rejects.toMatchObject({ code: 1 });
    await expect(run("node", args, { env: { ...base, DATABASE_URL: process.env.TEST_OPS_CONSOLE_URL! } })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("migration credential") });
    const ok = await run("node", args, { env: { ...base, DATABASE_URL: process.env.DATABASE_URL!, FX_OPS_ORIGIN: ORIGIN } });
    const token = /token=(\S+)/.exec(ok.stdout)![1]!;
    const row = await admin.query("SELECT s.id, t.token_hash FROM platform_staff s JOIN staff_enrollment_tokens t ON t.staff_id = s.id WHERE s.display_name = 'Script Person' AND t.token_hash = $1", [sha256(token)]);
    expect(row.rows).toHaveLength(1);
    staffIds.push(row.rows[0].id);
    expect(ok.stdout.split(token).length - 1).toBe(1); // printed once
    expect(ok.stdout).toContain(`${ORIGIN}/enroll?token=`);
  });
});

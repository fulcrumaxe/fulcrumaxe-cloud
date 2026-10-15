import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  OPS_SESSION_ABSOLUTE_MS,
  OPS_SESSION_COOKIE,
  OPS_SESSION_IDLE_MS,
  opsSessionCookieAttributes,
  refreshOpsSession,
  signOpsSession,
  verifyOpsSession,
} from "../lib/session";
import { OPS_SECRET } from "./support/env";

const env = { FX_OPS_SESSION_SECRET: OPS_SECRET };
const STAFF = "7d6e3f0a-1b2c-4d5e-8f90-a1b2c3d4e5f6";
const MIN = 60_000;

describe("the ops session (OPS-C2-3)", () => {
  it("uses the __Host- cookie with Secure, HttpOnly, SameSite=Strict and Path=/", () => {
    expect(opsSessionCookieAttributes()).toEqual({ name: "__Host-fx_ops_session", httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 8 * 3600 });
    expect(OPS_SESSION_COOKIE).toBe("__Host-fx_ops_session");
  });

  it("rejects a session idle for more than 30 minutes and accepts one just inside it (fake clock)", async () => {
    let t = 1_700_000_000_000;
    const token = await signOpsSession(STAFF, env, () => t);
    t += 29 * MIN;
    expect(await verifyOpsSession(token, env, () => t)).toMatchObject({ staffId: STAFF });
    t += 2 * MIN; // 31 minutes since the last activity
    expect(await verifyOpsSession(token, env, () => t)).toBeNull();
    expect(OPS_SESSION_IDLE_MS).toBe(30 * MIN);
  });

  it("keeps an active session alive by refreshing, but never past 8 hours from the passkey ceremony", async () => {
    let t = 1_700_000_000_000;
    const start = t;
    let token = await signOpsSession(STAFF, env, () => t);
    // Active every 20 minutes: every refresh is accepted until the 8 hour line.
    while (t - start + 20 * MIN < OPS_SESSION_ABSOLUTE_MS) {
      t += 20 * MIN;
      const session = await verifyOpsSession(token, env, () => t);
      expect(session, `at +${(t - start) / MIN} min`).not.toBeNull();
      expect(session!.authTime).toBe(start);
      token = (await refreshOpsSession(session!, env, () => t))!;
      expect(token).not.toBeNull();
    }
    t = start + OPS_SESSION_ABSOLUTE_MS + MIN; // active a minute ago, but 8h01 past auth_time
    const lastGood = await signOpsSession(STAFF, env, () => start); // same authTime as the chain above
    expect(await verifyOpsSession(lastGood, env, () => t)).toBeNull();
    const nearEnd = await verifyOpsSession(token, env, () => start + OPS_SESSION_ABSOLUTE_MS - MIN);
    expect(nearEnd).not.toBeNull();
    expect(await refreshOpsSession(nearEnd!, env, () => start + OPS_SESSION_ABSOLUTE_MS + MIN)).toBeNull();
    expect(await verifyOpsSession(token, env, () => start + OPS_SESSION_ABSOLUTE_MS + MIN)).toBeNull();
  });

  it("rejects a token with the wrong secret, the wrong audience, no audience, or no secret configured", async () => {
    const key = new TextEncoder().encode(OPS_SECRET);
    const claims = { sid: "s", auth_time: Math.floor(Date.now() / 1000), last_seen: Math.floor(Date.now() / 1000) };
    const make = (aud: string | undefined, secret: Uint8Array) => {
      const jwt = new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setSubject(STAFF).setExpirationTime("10m");
      return (aud ? jwt.setAudience(aud) : jwt).sign(secret);
    };
    expect(await verifyOpsSession(await make("fx-ops", key), env)).toMatchObject({ staffId: STAFF });
    expect(await verifyOpsSession(await make("fx-ops", new TextEncoder().encode("x".repeat(40))), env)).toBeNull();
    expect(await verifyOpsSession(await make("fx-tenant", key), env)).toBeNull();
    expect(await verifyOpsSession(await make(undefined, key), env)).toBeNull();
    expect(await verifyOpsSession(await make("fx-ops", key), {})).toBeNull();
    expect(await verifyOpsSession("not-a-token", env)).toBeNull();
    await expect(signOpsSession(STAFF, { FX_OPS_SESSION_SECRET: "short" })).rejects.toThrow();
  });
});

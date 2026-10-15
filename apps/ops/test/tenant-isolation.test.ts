import { describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME, signSession, verifySession } from "@fx/core/src/auth/session";
import { OPS_SESSION_COOKIE, signOpsSession, verifyOpsSession } from "../lib/session";
import { middleware } from "../middleware";
import { OPS_SECRET, req, useOpsEnv } from "./support/env";

/**
 * OPS-C2-1: a tenant session never opens the console, and an ops session never opens the tenant app. This is the one file under
 * apps/ops that may name the tenant signer and its secret (test/scan.test.ts allows exactly those two names here).
 */
const TENANT_SECRET = "tenant-session-secret-for-tests-0123456789abc";
const tenantEnv = (secret: string) => ({ FX_SESSION_SECRET: secret }) as unknown as NodeJS.ProcessEnv;
const STAFF = "7d6e3f0a-1b2c-4d5e-8f90-a1b2c3d4e5f6";

describe("tenant and ops sessions are separate (OPS-C2-1)", () => {
  it("a token from signSession under the tenant secret fails ops verification, and so does one that shares the ops secret", async () => {
    const tenant = await signSession({ userId: "u1", accountId: "a1" }, tenantEnv(TENANT_SECRET));
    expect(await verifyOpsSession(tenant, { FX_OPS_SESSION_SECRET: OPS_SECRET })).toBeNull();
    // Same secret value on both sides: the audience claim alone still refuses it.
    const sameSecret = await signSession({ userId: "u1", accountId: "a1" }, tenantEnv(OPS_SECRET));
    expect(await verifySession(sameSecret, tenantEnv(OPS_SECRET))).not.toBeNull();
    expect(await verifyOpsSession(sameSecret, { FX_OPS_SESSION_SECRET: OPS_SECRET })).toBeNull();
  });

  it("an ops token fails the tenant verifier, with a different secret and with the same one", async () => {
    const ops = await signOpsSession(STAFF, { FX_OPS_SESSION_SECRET: OPS_SECRET });
    expect(await verifySession(ops, tenantEnv(TENANT_SECRET))).toBeNull();
    expect(await verifySession(ops, tenantEnv(OPS_SECRET))).toBeNull();
  });

  it("a request carrying only a valid tenant cookie is not a staff session, and the cookie names differ", async () => {
    const restore = useOpsEnv();
    try {
      const tenant = await signSession({ userId: "u1", accountId: "a1" }, tenantEnv(TENANT_SECRET));
      expect(SESSION_COOKIE_NAME).not.toBe(OPS_SESSION_COOKIE);
      for (const cookies of [{ [SESSION_COOKIE_NAME]: tenant }, { [OPS_SESSION_COOKIE]: tenant }] as Record<string, string>[]) {
        expect((await middleware(req("/", { cookies }))).status).toBe(307);
        expect((await middleware(req("/api/anything", { cookies }))).status).toBe(401);
      }
    } finally {
      restore();
    }
  });
});

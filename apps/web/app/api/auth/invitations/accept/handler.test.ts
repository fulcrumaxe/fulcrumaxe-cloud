import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, signSession } from "@fx/core/src/auth/session";
import { acceptInvitationHandler, type AcceptInvitationDeps } from "./handler";
import { RateLimitedError } from "@fx/api/src/errors.js";

const env = { FX_SESSION_SECRET: "s".repeat(32) } as unknown as NodeJS.ProcessEnv;

/**
 * A fake platform_ops pool that answers the one query
 * invitations.ts's lookupInvitationByToken issues, plus the combined
 * epoch-and-revocation query the shared `resolveActiveSession` helper
 * (security fix round item 1, correction C15a) now issues for every
 * request that carries a session cookie, regardless of which invitation
 * shape the test cares about. `liveSessionEpoch` defaults to 0 to match
 * `requestWithSession`'s token, which embeds epoch 0. No test in this
 * file exercises per-session revocation (that's identity.test.ts and
 * shell-routes.test.ts's job) -- `revoked` is always false here.
 */
function fakePlatformOpsPoolWithInvitation(
  invitation: {
    id: string;
    account_id: string;
    email: string;
    role: string;
    expires_at: string;
    accepted_at: string | null;
  } | null,
  liveSessionEpoch = 0,
): Pool {
  const client = {
    async query(sql: string) {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (/FROM invitations WHERE token_hash/.test(sql)) {
        return { rows: invitation ? [invitation] : [] };
      }
      if (/SELECT session_epoch, EXISTS \(SELECT 1 FROM revoked_sessions WHERE session_id = \$2\) AS revoked FROM users WHERE id/.test(sql)) {
        return { rows: [{ session_epoch: liveSessionEpoch, revoked: false }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    release() {},
  };
  return { connect: async () => client } as unknown as Pool;
}

/** A fake app_user pool that answers the accept transaction's two statements. */
function fakeAppUserPool(): Pool {
  let accepted = false;
  const client = {
    async query(sql: string) {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.startsWith("SELECT set_config(") || sql.startsWith("RESET ")) return { rows: [] };
      if (/INSERT INTO account_members/.test(sql)) return { rows: [] };
      if (/UPDATE invitations SET accepted_at/.test(sql)) {
        if (accepted) return { rows: [], rowCount: 0 };
        accepted = true;
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    release() {},
  };
  return { connect: async () => client } as unknown as Pool;
}

async function requestWithSession(body: unknown): Promise<NextRequest> {
  const token = await signSession({ userId: randomUUID(), accountId: randomUUID() }, env);
  return new NextRequest("https://example.test/api/auth/invitations/accept", {
    method: "POST",
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/invitations/accept", () => {
  const baseDeps = (invitation: Parameters<typeof fakePlatformOpsPoolWithInvitation>[0]): AcceptInvitationDeps => ({
    platformOpsPool: fakePlatformOpsPoolWithInvitation(invitation),
    appUserPool: fakeAppUserPool(),
    getUserEmail: async () => "invitee@example.test",
  });

  it("requires an existing session", async () => {
    const req = new NextRequest("https://example.test/api/auth/invitations/accept", {
      method: "POST",
      body: JSON.stringify({ token: "x" }),
    });
    const res = await acceptInvitationHandler(req, baseDeps(null));
    expect(res.status).toBe(401);
  });

  it("requires a token in the body", async () => {
    process.env.FX_SESSION_SECRET = env.FX_SESSION_SECRET;
    const req = await requestWithSession({});
    const res = await acceptInvitationHandler(req, baseDeps(null));
    expect(res.status).toBe(400);
    delete process.env.FX_SESSION_SECRET;
  });

  it("returns 400 for an invalid invitation (no matching token)", async () => {
    process.env.FX_SESSION_SECRET = env.FX_SESSION_SECRET;
    const req = await requestWithSession({ token: "nope" });
    const res = await acceptInvitationHandler(req, baseDeps(null));
    expect(res.status).toBe(400);
    delete process.env.FX_SESSION_SECRET;
  });

  it("accepts a valid invitation and returns the new membership", async () => {
    process.env.FX_SESSION_SECRET = env.FX_SESSION_SECRET;
    const rawToken = "a-real-raw-token";
    const invitationId = randomUUID();
    const accountId = randomUUID();
    const req = await requestWithSession({ token: rawToken });
    const deps = baseDeps({
      id: invitationId,
      account_id: accountId,
      email: "invitee@example.test",
      role: "member",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      accepted_at: null,
    });
    // getUserEmail must resolve to the SAME email the fake invitation carries.
    deps.getUserEmail = async () => "invitee@example.test";

    const res = await acceptInvitationHandler(req, deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ accountId, role: "member" });
    delete process.env.FX_SESSION_SECRET;
  });

  /**
   * Security fix round item 1 (CWE-613): before this fix, this handler
   * checked the session cookie with `verifySession` alone and never
   * re-checked `users.session_epoch` -- a "sign out everywhere" call
   * bumped the epoch, but a still-unexpired token signed under the OLD
   * epoch could keep accepting invitations for up to 24h regardless.
   */
  it("returns 401 for a token signed under an epoch a sign-out-everywhere has since bumped past", async () => {
    process.env.FX_SESSION_SECRET = env.FX_SESSION_SECRET;
    const userId = randomUUID();
    const token = await signSession({ userId, accountId: randomUUID() }, env, { epoch: 0 });
    const req = new NextRequest("https://example.test/api/auth/invitations/accept", {
      method: "POST",
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ token: "x" }),
    });
    // The live users row has since moved to epoch 1 (as if a "sign out
    // everywhere" already ran), while the token above still embeds the
    // stale epoch 0.
    const deps: AcceptInvitationDeps = {
      platformOpsPool: fakePlatformOpsPoolWithInvitation(null, 1),
      appUserPool: fakeAppUserPool(),
      getUserEmail: async () => "invitee@example.test",
    };
    const res = await acceptInvitationHandler(req, deps);
    expect(res.status).toBe(401);
    delete process.env.FX_SESSION_SECRET;
  });

  describe("the per-user cap on redeeming tokens", () => {
    it("over the cap is a 429 with Retry-After, and the token is never looked up", async () => {
      process.env.FX_SESSION_SECRET = env.FX_SESSION_SECRET;
      const deps = baseDeps(null);
      let lookedUp = false;
      deps.getUserEmail = async () => {
        lookedUp = true;
        return "invitee@example.test";
      };
      deps.limitSession = async () => {
        throw new RateLimitedError(6);
      };
      const res = await acceptInvitationHandler(await requestWithSession({ token: "guess" }), deps);
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("6");
      expect(lookedUp).toBe(false);
      delete process.env.FX_SESSION_SECRET;
    });

    it("a limiter that cannot run is not an unlimited pass", async () => {
      process.env.FX_SESSION_SECRET = env.FX_SESSION_SECRET;
      const deps = baseDeps(null);
      deps.limitSession = async () => {
        throw new Error("db down");
      };
      await expect(acceptInvitationHandler(await requestWithSession({ token: "guess" }), deps)).rejects.toThrow("db down");
      delete process.env.FX_SESSION_SECRET;
    });

    it("a request with no session is refused before it is counted", async () => {
      let counted = false;
      const deps = baseDeps(null);
      deps.limitSession = async () => {
        counted = true;
      };
      const req = new NextRequest("https://example.test/api/auth/invitations/accept", { method: "POST", body: JSON.stringify({ token: "x" }) });
      expect((await acceptInvitationHandler(req, deps)).status).toBe(401);
      expect(counted).toBe(false);
    });
  });
});

import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, absoluteLimitSeconds, signSession, verifySession } from "@fx/core/src/auth/session";
import { signOutHandler } from "./handler";
import { fakePlatformOpsPool } from "../_lib/testFakes";

const env = { FX_SESSION_SECRET: "a".repeat(32) } as unknown as NodeJS.ProcessEnv;

describe("POST /api/auth/signout", () => {
  it("clears the session cookie", async () => {
    const req = new NextRequest("https://example.test/api/auth/signout", { method: "POST" });
    const res = await signOutHandler(req);
    expect(res.status).toBe(200);
    const cookie = res.cookies.get(SESSION_COOKIE_NAME);
    expect(cookie?.value).toBe("");
    expect(cookie?.maxAge).toBe(0);
  });

  /**
   * Security fix round item 3: inspecting the response's cookie object (as
   * the test above does) is not enough -- __Host-fx_session requires
   * Secure or a real browser silently REFUSES to apply the clearing
   * Set-Cookie header at all, which the cookie-jar object alone can't
   * catch. This reads the literal Set-Cookie header string sign-out
   * emits, the same thing a browser parses, and checks it carries every
   * attribute the __Host- prefix requires.
   */
  it("the Set-Cookie header sign-out emits carries Secure, Path=/, and the __Host- name", async () => {
    const req = new NextRequest("https://example.test/api/auth/signout", { method: "POST" });
    const res = await signOutHandler(req);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=;`));
    expect(setCookie).toMatch(/;\s*Secure/i);
    expect(setCookie).toMatch(/;\s*Path=\//i);
    expect(setCookie).toMatch(/;\s*HttpOnly/i);
    expect(setCookie).toMatch(/;\s*SameSite=Lax/i);
  });

  /**
   * D#37 WS-C1 criterion 8: a plain sign-out (no "everywhere") never
   * touches the DB at all -- confirmed by NOT injecting a pool here; if
   * the handler tried to resolve one, this test would throw
   * (defaultAuthDeps requires DATABASE_URL_PLATFORM_OPS, unset in this
   * suite) rather than pass.
   */
  it("a JSON body without everywhere:true still just clears the cookie, no DB pool needed", async () => {
    const req = new NextRequest("https://example.test/api/auth/signout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await signOutHandler(req);
    expect(res.status).toBe(200);
  });

  /**
   * D#37 WS-C1 criterion 8: {"everywhere": true} with a valid session
   * cookie bumps the user's session_epoch server-side.
   */
  it('{"everywhere": true} with a valid session cookie bumps the epoch', async () => {
    const userId = "11111111-1111-1111-1111-111111111111";
    const pool = fakePlatformOpsPool({ existingUser: { id: userId, email: "a@example.test", name: "A", sessionEpoch: 0 } });
    const token = await signSession({ userId, accountId: "acc-1" }, env, { epoch: 0 });

    const req = new NextRequest("https://example.test/api/auth/signout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ everywhere: true }),
    });
    req.cookies.set(SESSION_COOKIE_NAME, token);

    process.env.FX_SESSION_SECRET = env.FX_SESSION_SECRET;
    let res: Response;
    try {
      res = await signOutHandler(req, pool);
    } finally {
      delete process.env.FX_SESSION_SECRET;
    }
    expect(res.status).toBe(200);

    const { rows } = await (await pool.connect()).query("SELECT session_epoch FROM users WHERE id = $1", [userId]);
    expect(rows[0].session_epoch).toBe(1);
  });

  /** API-5c criterion 3: "everywhere" writes one session.revoked per membership (same transaction as the bump); a plain sign-out writes none. */
  it("everywhere emits session.revoked for each membership; a plain sign-out emits nothing", async () => {
    const userId = "11111111-1111-1111-1111-111111111111";
    const memberships = [
      { accountId: "acc-1", role: "owner" as const },
      { accountId: "acc-2", role: "member" as const },
    ];
    const post = async (body: object): Promise<Pool & { domainEvents: unknown[] }> => {
      const pool = fakePlatformOpsPool({ existingUser: { id: userId, email: "a@example.test", name: "A", sessionEpoch: 0 }, memberships });
      const req = new NextRequest("https://example.test/api/auth/signout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      req.cookies.set(SESSION_COOKIE_NAME, await signSession({ userId, accountId: "acc-1" }, env, { epoch: 0 }));
      process.env.FX_SESSION_SECRET = env.FX_SESSION_SECRET;
      try {
        expect((await signOutHandler(req, pool)).status).toBe(200);
      } finally {
        delete process.env.FX_SESSION_SECRET;
      }
      return pool;
    };
    expect((await post({ everywhere: true })).domainEvents).toEqual([
      { accountId: "acc-1", type: "session.revoked", subjectId: userId },
      { accountId: "acc-2", type: "session.revoked", subjectId: userId },
    ]);
    expect((await post({})).domainEvents).toEqual([]);
  });

  /**
   * Security fix round item 1 (E1, CWE-613, correction C15a): a PLAIN
   * (non-"everywhere") sign-out with a valid session cookie now revokes
   * THAT session server-side too -- not just clears the browser's own
   * cookie. Confirmed here by resolving the SAME cookie again through
   * the shared guard directly: a revoked session must fail
   * resolveActiveSession's re-check even though its epoch never moved.
   */
  it("a plain sign-out (no everywhere) with a valid session cookie revokes that session server-side", async () => {
    const userId = "22222222-2222-2222-2222-222222222222";
    const pool = fakePlatformOpsPool({ existingUser: { id: userId, email: "b@example.test", name: "B", sessionEpoch: 0 } });
    const token = await signSession({ userId, accountId: "acc-1" }, env, { epoch: 0 });

    const req = new NextRequest("https://example.test/api/auth/signout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    req.cookies.set(SESSION_COOKIE_NAME, token);

    process.env.FX_SESSION_SECRET = env.FX_SESSION_SECRET;
    try {
      const res = await signOutHandler(req, pool);
      expect(res.status).toBe(200);

      // Epoch is untouched (no "everywhere") -- revocation is what must
      // now reject a replay of the exact same cookie.
      const { resolveActiveSession } = await import("../../../../lib/shell/session-guard");
      const replay = new NextRequest("https://example.test/api/shell/session", { method: "GET" });
      replay.cookies.set(SESSION_COOKIE_NAME, token);
      const resolved = await resolveActiveSession(replay, { platformOpsPool: pool });
      expect(resolved).toBeNull();
    } finally {
      delete process.env.FX_SESSION_SECRET;
    }
  });

  /**
   * Regression test for the security re-review of D#37 WS-C2 correction
   * C15a (PR#119 review comment):
   * the row a plain sign-out writes must carry THIS session's own
   * absolute deadline -- `sessionStart + absoluteLimitSeconds() * 1000`
   * (see handler.ts's own doc comment on the `revokeSession` call) --
   * not some other value. Asserted directly against the row
   * `revokeSession` wrote, not just that a row exists.
   *
   * Mutation check: pass `new Date(Date.now() + 1000)` as `expiresAt`
   * instead of `sessionStart + absoluteLimitSeconds() * 1000`. With a
   * `sessionStart` set far enough in the past (as below), that mutant's
   * stored `expires_at` would differ from this test's expectation by
   * far more than any timing slack, and the final assertion fails.
   */
  it("a plain sign-out records the revoked session's expires_at as sessionStart + absoluteLimitSeconds()*1000", async () => {
    const userId = "55555555-5555-5555-5555-555555555555";
    const pool = fakePlatformOpsPool({ existingUser: { id: userId, email: "e@example.test", name: "E", sessionEpoch: 0 } });

    // Fixed well in the past so it can never collide with
    // `Date.now() + 1000` (the mutant's own value) by coincidence.
    const sessionStart = Date.now() - 1000 * 60 * 60;
    const token = await signSession({ userId, accountId: "acc-1" }, env, { epoch: 0, now: () => sessionStart });

    const req = new NextRequest("https://example.test/api/auth/signout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    req.cookies.set(SESSION_COOKIE_NAME, token);

    process.env.FX_SESSION_SECRET = env.FX_SESSION_SECRET;
    let sid: string;
    try {
      const claims = await verifySession(token, env);
      if (!claims) throw new Error("test setup: token did not verify");
      sid = claims.sid;

      const res = await signOutHandler(req, pool);
      expect(res.status).toBe(200);
    } finally {
      delete process.env.FX_SESSION_SECRET;
    }

    const { rows } = await (await pool.connect()).query("SELECT expires_at FROM revoked_sessions WHERE session_id = $1", [sid]);
    expect(rows).toHaveLength(1);
    expect((rows[0].expires_at as Date).getTime()).toBe(sessionStart + absoluteLimitSeconds() * 1000);
  });

  /**
   * Fix round 1 (W1, CWE-613/755, security review of this fix round): the epoch
   * bump must run BEFORE the revoke on the `everywhere` path, so a retry
   * after a failed bump can still bump. Wraps the fake pool so the epoch
   * `UPDATE` throws on its first call only -- the same probe the security
   * review used. At head 1714660624b15ac0c7c92c6f4a8b6477dd31a747
   * (revoke-then-bump order) this fails: the first request's revoke still
   * commits before the bump throws, so the retry replays an
   * already-revoked cookie, resolveActiveSession rejects it, the handler
   * returns 200 having never bumped, and the SECOND session (token B)
   * stays live -- `expected 401 to be 200` on the final assertion below.
   */
  it('a failed "everywhere" epoch bump can be retried, and the retry still invalidates every other session', async () => {
    const userId = "33333333-3333-3333-3333-333333333333";
    const basePool = fakePlatformOpsPool({ existingUser: { id: userId, email: "c@example.test", name: "C", sessionEpoch: 0 } });

    // Wraps basePool's client.query so the epoch-bump UPDATE throws on
    // its FIRST call only -- every other query (including the retry's
    // own bump) passes straight through to the fake.
    let bumpCalls = 0;
    const flakyPool = {
      connect: async () => {
        const client = await (basePool as unknown as { connect: () => Promise<{ query: (sql: string, params?: unknown[]) => Promise<unknown>; release: () => void }> }).connect();
        return {
          async query(sql: string, params: unknown[] = []) {
            if (/UPDATE users SET session_epoch = session_epoch \+ 1 WHERE id/.test(sql)) {
              bumpCalls += 1;
              if (bumpCalls === 1) {
                throw new Error("simulated transient DB error on epoch bump");
              }
            }
            return client.query(sql, params);
          },
          release: () => client.release(),
        };
      },
    } as unknown as Pool;

    const tokenA = await signSession({ userId, accountId: "acc-1" }, env, { epoch: 0 });
    const tokenB = await signSession({ userId, accountId: "acc-1" }, env, { epoch: 0 });

    const reqA = new NextRequest("https://example.test/api/auth/signout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ everywhere: true }),
    });
    reqA.cookies.set(SESSION_COOKIE_NAME, tokenA);

    process.env.FX_SESSION_SECRET = env.FX_SESSION_SECRET;
    try {
      // First attempt: the epoch bump throws. Nothing committed --
      // reordering means the bump runs before the revoke, so a bump
      // failure leaves the revoke un-attempted too.
      await expect(signOutHandler(reqA, flakyPool)).rejects.toThrow();

      // Retry with the SAME cookie -- it must still be accepted, because
      // the failed first attempt committed nothing.
      const reqARetry = new NextRequest("https://example.test/api/auth/signout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ everywhere: true }),
      });
      reqARetry.cookies.set(SESSION_COOKIE_NAME, tokenA);
      const retryRes = await signOutHandler(reqARetry, flakyPool);
      expect(retryRes.status).toBe(200);

      // Token B (a different session of the same user) must now be
      // rejected -- the retry's epoch bump invalidated it, even though
      // this specific request never touched token B's own sid.
      const { resolveActiveSession } = await import("../../../../lib/shell/session-guard");
      const replayB = new NextRequest("https://example.test/api/shell/session", { method: "GET" });
      replayB.cookies.set(SESSION_COOKIE_NAME, tokenB);
      const resolvedB = await resolveActiveSession(replayB, { platformOpsPool: basePool });
      expect(resolvedB).toBeNull();
    } finally {
      delete process.env.FX_SESSION_SECRET;
    }
  });

  /**
   * A request with no cookie at all still writes nothing -- same "no
   * pool needed" invariant as the everywhere case above, now covering
   * the plain-sign-out revoke path too.
   */
  it("a plain sign-out with no session cookie revokes nothing (and needs no pool)", async () => {
    const req = new NextRequest("https://example.test/api/auth/signout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await signOutHandler(req);
    expect(res.status).toBe(200);
  });

  /**
   * D#37 WS-C2 criterion 12 (CWE-525, Information Exposure Through
   * Browser Caching): the browser must be told to drop any cached
   * response for this origin on sign-out, so a bfcache or HTTP-cache
   * hit can't keep answering a stale, now-revoked /api/cloud/auth/me
   * 200 after the session cookie is gone.
   */
  it('sets Clear-Site-Data: "cache"', async () => {
    const req = new NextRequest("https://example.test/api/auth/signout", { method: "POST" });
    const res = await signOutHandler(req);
    expect(res.headers.get("clear-site-data")).toBe('"cache"');
  });

  /**
   * D#31 API-1 correction C1's own test list: "A bearer token on
   * POST /api/auth/signout with no cookie revokes nothing." No cookie
   * means no userId to resolve, so "everywhere" bumps nothing -- and,
   * as above, never needs a DB pool at all.
   */
  it('{"everywhere": true} with no session cookie revokes nothing (and needs no pool)', async () => {
    const req = new NextRequest("https://example.test/api/auth/signout", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sometoken" },
      body: JSON.stringify({ everywhere: true }),
    });
    const res = await signOutHandler(req);
    expect(res.status).toBe(200);
  });
});

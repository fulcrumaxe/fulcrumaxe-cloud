// auth pack, rows A1 and A7 (signed in). A1 follows the real redirect to github.com with no session; A7 reads the
// shell's five session paths as the stored owner session. Both are reads. The sign-in callback, the allowlist and the
// invitation (A2, A3, A6) are in the auth-scripted pack, which needs a scripted sign-in. A7 signed out is in
// auth-negative. Reaches the app only through the fixtures and the shared client (test/pack-lint.test.ts).
import { expect, test } from "../../fixtures/session.js";
import { authorizeViolations, entitlementsViolations, identityViolations, plansViolations, SIGN_IN_PATH, stateCookieViolations } from "./expected.js";

test.use({ sessionRole: "owner" });

const JSON_HEADERS = { accept: "application/json" };

test.describe("A1 sign-in redirect", () => {
  test("/api/auth/github redirects to GitHub's authorize URL with a fresh state, and no bypass header reaches github.com", async ({ api, target }) => {
    const res = await api.get(SIGN_IN_PATH);
    // Followed to the real github.com (one anonymous GET): the hop list is the structured request log.
    expect(authorizeViolations(res.hops, target.origin)).toEqual([]);
  });

  test("the state is bound to a locked-down cookie set by the same redirect", async ({ api }) => {
    // One request, redirect not followed: the first 3xx with its headers. The cookie is read from Set-Cookie and the
    // state from the Location, so the check compares what the browser would hold with what GitHub would hand back.
    const res = await api.get(SIGN_IN_PATH, { redirect: "manual" });
    expect(res.status, "the sign-in path did not redirect").toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    let state = "";
    try {
      state = new URL(res.headers.get("location") ?? "").searchParams.get("state") ?? "";
    } catch {
      state = "";
    }
    expect(stateCookieViolations(res.headers.getSetCookie(), state)).toEqual([]);
  });

  test("each sign-in start gets its own state", async ({ api }) => {
    const states = new Set<string>();
    for (let i = 0; i < 2; i += 1) {
      const res = await api.get(SIGN_IN_PATH);
      const hop = res.hops.find((h) => new URL(h.url).hostname === "github.com");
      states.add(new URL(hop?.url ?? "https://github.com/").searchParams.get("state") ?? "");
    }
    expect(states.size).toBe(2);
    expect(states.has("")).toBe(false);
  });
});

test.describe("A7 shell session paths, signed in as the owner", () => {
  test("/api/cloud/auth/me and /api/profile give the same, right identity", async ({ session }) => {
    const me = await session.api.get("/api/cloud/auth/me", { headers: JSON_HEADERS });
    expect(me.status).toBe(200);
    expect(me.headers.get("cache-control")).toMatch(/no-store/);
    const meBody = JSON.parse(me.body) as unknown;
    expect(identityViolations(meBody, "owner")).toEqual([]);
    const profile = await session.api.get("/api/profile", { headers: JSON_HEADERS });
    expect(profile.status).toBe(200);
    // Same answer from both paths; compared as text so a mismatch never prints the login or email.
    expect(profile.body === me.body, "/api/profile differs from /api/cloud/auth/me").toBe(true);
  });

  test("/api/entitlements/me follows the workspace access", async ({ session }) => {
    const me = JSON.parse((await session.api.get("/api/cloud/auth/me", { headers: JSON_HEADERS })).body) as { workspace_access?: string };
    const res = await session.api.get("/api/entitlements/me", { headers: JSON_HEADERS });
    expect(res.status).toBe(200);
    expect(entitlementsViolations(JSON.parse(res.body), me.workspace_access)).toEqual([]);
  });

  test("/api/plans lists the plans and knows the caller owns the account", async ({ session }) => {
    const res = await session.api.get("/api/plans", { headers: JSON_HEADERS });
    expect(res.status).toBe(200);
    expect(plansViolations(JSON.parse(res.body), "owner")).toEqual([]);
  });

  test("/api/preferences answers an empty object", async ({ session }) => {
    const res = await session.api.get("/api/preferences", { headers: JSON_HEADERS });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({});
  });

  test("/api/shell/session called directly is refused even with a session", async ({ session }) => {
    const res = await session.api.get("/api/shell/session", { headers: JSON_HEADERS });
    expect(res.status).toBe(404);
  });
});

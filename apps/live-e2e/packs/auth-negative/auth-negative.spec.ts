// auth-negative pack, rows P6 and A4: what must NOT be reachable.
import { expect, test } from "../../fixtures/bypass.js";
import { isDeploymentWall } from "../../src/client.js";

test.describe("P6 deployment protection", () => {
  test("without the bypass an anonymous visitor meets Vercel's wall, not the app", async ({ anon, target }) => {
    test.skip(!target.protected, "this target declares no protection");
    const res = await anon.get("/", { redirect: "manual" });
    expect(isDeploymentWall(res), `status ${res.status}`).toBe(true);
    expect(res.body).not.toMatch(/\/s\/[^"']+\.js/);
  });

  test("with the bypass the app answers", async ({ api }) => {
    const res = await api.get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.body).toMatch(/\/s\/[^"']+/);
  });
});

test.describe("A4 test sign-in endpoint", () => {
  test("/api/auth/test/callback is 404 and sets no session", async ({ api }) => {
    const res = await api.get("/api/auth/test/callback?githubUserId=1&email=a@b.test", { redirect: "manual" });
    expect(res.status).toBe(404);
    // A boolean, so a failure never prints the cookie value.
    expect(/\bfx_session=/.test(res.headers.get("set-cookie") ?? ""), "a session cookie was set").toBe(false);
  });
});

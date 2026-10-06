import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "@fx/core/src/auth/session";
import { fakePlatformOpsPool } from "../../_lib/testFakes";
import { testSignInHandler } from "./handler";

describe("GET /api/auth/test/callback", () => {
  beforeEach(() => {
    process.env.FX_SESSION_SECRET = "s".repeat(32);
    // Security fix round item 6: TestOnlyProvider now requires this
    // explicit opt-in; most tests below exercise the "enabled" path, and
    // the dedicated "unset" tests below delete it again for their case.
    process.env.FX_ENABLE_TEST_AUTH = "1";
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.FX_SESSION_SECRET;
    delete process.env.FX_ENABLE_TEST_AUTH;
  });

  it("requires githubUserId and email query params", async () => {
    const req = new NextRequest("https://example.test/api/auth/test/callback");
    const res = await testSignInHandler(req, fakePlatformOpsPool());
    expect(res.status).toBe(400);
  });

  it("404s when NODE_ENV=production, even with FX_ENABLE_TEST_AUTH=1 (H06 pass/fail item 1)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const req = new NextRequest(
      "https://example.test/api/auth/test/callback?githubUserId=1&email=a@example.test",
    );
    const res = await testSignInHandler(req, fakePlatformOpsPool());
    expect(res.status).toBe(404);
  });

  // Security fix round item 6: the old gate was a blocklist
  // (NODE_ENV === 'production'), so this route was reachable whenever
  // NODE_ENV was unset or 'development'. Proves the route now refuses
  // with the opt-in flag unset, under the exact env this used to leave
  // open.
  it("404s when FX_ENABLE_TEST_AUTH is unset, including under NODE_ENV=development", async () => {
    delete process.env.FX_ENABLE_TEST_AUTH;
    vi.stubEnv("NODE_ENV", "development");
    const req = new NextRequest(
      "https://example.test/api/auth/test/callback?githubUserId=1&email=a@example.test",
    );
    const res = await testSignInHandler(req, fakePlatformOpsPool());
    expect(res.status).toBe(404);
  });

  it("signs a brand-new fixed identity in and redirects with a session cookie", async () => {
    const req = new NextRequest(
      "https://example.test/api/auth/test/callback?githubUserId=42&email=a@example.test&name=Ada",
    );
    const res = await testSignInHandler(req, fakePlatformOpsPool());

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://example.test/");
    expect(res.cookies.get(SESSION_COOKIE_NAME)).toBeDefined();
  });
});

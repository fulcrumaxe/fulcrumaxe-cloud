import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "../../../../../middleware";
import { appSlugFromEnv } from "../../../../../lib/github/installationReconcile";
import { GET, POST } from "./route";

/**
 * D#454 H2b2 at the HTTP layer: the release route's own bearer secret. The release, hold and restore behaviour is
 * @fx/reconcile's real-Postgres suite; this covers the wiring: fail closed with no secret, no database or App credential touched
 * before the header matches, the cron secret is not accepted, and the middleware lets a bearer call through.
 */
const TOKEN = "release-token-that-is-long-enough-0123456789";
// Built at runtime so no secret-shaped literal sits in the source.
const CRON = "cron-secret-" + "x".repeat(33);
const URL_ = "https://example.test/api/internal/reconcile/release";

afterEach(() => vi.unstubAllEnvs());

const req = (method: string, auth: string | null, body?: unknown) =>
  new Request(URL_, { method, headers: { ...(auth ? { authorization: auth } : {}), "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });

describe("/api/internal/reconcile/release", () => {
  it("answers 503 and touches nothing when FX_RECONCILE_RELEASE_TOKEN is unset, whatever the header", async () => {
    vi.stubEnv("FX_RECONCILE_RELEASE_TOKEN", "");
    vi.stubEnv("DATABASE_URL_PLATFORM_OPS", ""); // a pool built here would throw "must be set"
    for (const auth of [null, "Bearer ", `Bearer ${TOKEN}`]) {
      const res = await POST(req("POST", auth, { action: "release", hold_id: 1, gh_installation_ids: [1] }));
      expect(res.status).toBe(503);
    }
    expect((await GET(req("GET", `Bearer ${TOKEN}`))).status).toBe(503);
  });

  it("treats a FX_RECONCILE_RELEASE_TOKEN shorter than 32 characters as unset: 503 even for the matching header", async () => {
    const short = "too-short-0123456789";
    vi.stubEnv("FX_RECONCILE_RELEASE_TOKEN", short);
    vi.stubEnv("DATABASE_URL_PLATFORM_OPS", "");
    expect((await GET(req("GET", `Bearer ${short}`))).status).toBe(503);
    expect((await POST(req("POST", `Bearer ${short}`, { action: "release", hold_id: 1, gh_installation_ids: [1] }))).status).toBe(503);
  });

  it("answers 401 for a missing or wrong header, and does not accept the cron secret", async () => {
    vi.stubEnv("FX_RECONCILE_RELEASE_TOKEN", TOKEN);
    vi.stubEnv("CRON_SECRET", CRON);
    vi.stubEnv("DATABASE_URL_PLATFORM_OPS", "");
    for (const auth of [null, "Bearer wrong", `Bearer ${CRON}`, TOKEN]) {
      expect((await POST(req("POST", auth, { action: "restore", kind: "team", gh_installation_id: 5 }))).status).toBe(401);
    }
    expect((await GET(req("GET", null))).status).toBe(401);
  });

  it("a right header reaches the database layer (and only then): without a database setting it fails, not 401/503", async () => {
    vi.stubEnv("FX_RECONCILE_RELEASE_TOKEN", TOKEN);
    vi.stubEnv("DATABASE_URL_PLATFORM_OPS", "");
    await expect(GET(req("GET", `Bearer ${TOKEN}`))).rejects.toThrow("DATABASE_URL_PLATFORM_OPS must be set");
  });

  it("the middleware lets a bearer call with no cookie through untouched", async () => {
    const res = await middleware(new NextRequest(URL_, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("the identity slugs the installation job compares", () => {
  it("reads GITHUB_APP_{TEAM,TEAM_READONLY,SITEKIT}_SLUG per kind; unset or blank is null", () => {
    const env = { GITHUB_APP_TEAM_SLUG: " fx-team ", GITHUB_APP_TEAM_READONLY_SLUG: "", GITHUB_APP_SITEKIT_SLUG: undefined };
    expect(appSlugFromEnv("team", env)).toBe("fx-team");
    expect(appSlugFromEnv("team_readonly", env)).toBeNull();
    expect(appSlugFromEnv("sitekit", env)).toBeNull();
    expect(appSlugFromEnv("sitekit", { GITHUB_APP_SITEKIT_SLUG: "fx-kit" })).toBe("fx-kit");
  });
});

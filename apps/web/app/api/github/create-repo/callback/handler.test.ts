import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, signSession } from "@fx/core/src/auth/session";
import { descriptionHash, mintCreateRepoState, type CreateRepoResult } from "@fx/github";
import { captureReports } from "../../../../../test/captureReports";
import { createRepoCallbackHandler, type CreateRepoCallbackDeps } from "./handler";
import { RateLimitedError } from "@fx/api/src/errors.js";

/** D#2 RC-1b: the route layer only. The creation service has its own tests in packages/github. */
const SECRET = "x".repeat(32);
const SESSION_ENV = { FX_SESSION_SECRET: "s".repeat(32) } as unknown as NodeJS.ProcessEnv;
const accountId = randomUUID();
const userId = randomUUID();

/** Answers the one query resolveActiveSession issues. */
const sessionPool = {
  connect: async () => ({
    query: async (sql: string) =>
      /session_epoch/.test(sql) || sql === "BEGIN" || sql === "COMMIT"
        ? { rows: sql.startsWith("SELECT") ? [{ session_epoch: 0, revoked: false }] : [] }
        : { rows: [] },
    release() {},
  }),
} as unknown as Pool;

function deps(result: CreateRepoResult | Error = { outcome: "ok" }) {
  const create = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  const d: CreateRepoCallbackDeps = {
    platformOpsPool: sessionPool,
    appUserPool: sessionPool,
    appCredentials: () => ({ appId: "7", privateKeyPem: "", webhookSecret: "" }),
    env: { GITHUB_INSTALL_STATE_SECRET: SECRET },
    create,
  };
  return { d, create };
}

async function call(query: Record<string, string>, opts: { session?: boolean } = {}, d = deps().d) {
  const url = new URL("https://example.test/api/github/create-repo/callback");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (opts.session !== false) headers.cookie = `${SESSION_COOKIE_NAME}=${await signSession({ userId, accountId }, SESSION_ENV)}`;
  return createRepoCallbackHandler(new NextRequest(url, { headers }), d);
}

const state = (over: Partial<{ account_id: string; user_id: string }> = {}, now?: Date) =>
  mintCreateRepoState(
    { account_id: accountId, user_id: userId, owner_gh_id: 500, name: "widgets", visibility: "private", description_sha256: descriptionHash(null), auto_init: true, ...over },
    SECRET,
    now,
  );
const q = (s: string) => ({ state: s, code: "SECRETCODE" });

beforeEach(() => {
  process.env.FX_SESSION_SECRET = SESSION_ENV.FX_SESSION_SECRET;
});
afterEach(() => {
  delete process.env.FX_SESSION_SECRET;
  vi.restoreAllMocks();
});

// Flip the second-to-last character (all six bits significant in base64url, unlike the
// last one) to a different one, so the result is guaranteed to differ from the input.
const tamper = (s: string): string => {
  const out = `${s.slice(0, -2)}${s.at(-2) === "A" ? "B" : "A"}${s.slice(-1)}`;
  expect(out).not.toBe(s);
  return out;
};

describe("GET /api/github/create-repo/callback", () => {
  it("a good state calls the service with the session's ids, the code and the state, and redirects to our root", async () => {
    const { d, create } = deps({ outcome: "ok", repoUrl: "https://github.com/acme/widgets" });
    const s = state();
    const res = await call(q(s), {}, d);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?create=ok");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(create).toHaveBeenCalledWith(expect.anything(), { accountId, userId, code: "SECRETCODE", state: s });
    expect(await res.text()).toBe("");
  });

  it("a state secret shorter than 32 bytes is refused before the service is called", async () => {
    const { d, create } = deps();
    d.env = { GITHUB_INSTALL_STATE_SECRET: "short" };
    const res = await call(q(mintCreateRepoState({ account_id: accountId, user_id: userId, owner_gh_id: 500, name: "widgets", visibility: "private", description_sha256: descriptionHash(null), auto_init: true }, "short")), {}, d);
    expect(res.headers.get("location")).toBe("/?create=failed");
    expect(create).not.toHaveBeenCalled();
  });

  it("no session: failed, and the service is never called", async () => {
    const { d, create } = deps();
    const res = await call(q(state()), { session: false }, d);
    expect(res.headers.get("location")).toBe("/?create=failed");
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ["an expired state", () => q(state({}, new Date(Date.now() - 3_600_000)))],
    ["another user's state", () => q(state({ user_id: randomUUID() }))],
    ["another account's state", () => q(state({ account_id: randomUUID() }))],
    ["a tampered state", () => q(tamper(state()))],
    ["an install-flow-shaped state", () => q("e30.e30")],
    ["a missing state", () => ({ code: "c" })],
    ["a missing code (GitHub's access_denied return)", () => ({ state: state(), error: "access_denied" })],
  ])("%s: failed with no GitHub work at all", async (_name, make) => {
    const { d, create } = deps();
    const res = await call(make(), {}, d);
    expect(res.headers.get("location")).toBe("/?create=failed");
    expect(create).not.toHaveBeenCalled();
  });

  it.each(["ok", "name_taken", "visibility_not_allowed", "refused", "github_busy", "rate_limited", "install_first", "failed"] as const)(
    "outcome %s is a 302 to its fixed query on our own root",
    async (outcome) => {
      const res = await call(q(state()), {}, deps({ outcome, repoUrl: "https://github.com/a/b" }).d);
      expect(res.headers.get("location")).toBe(`/?create=${outcome}`);
    },
  );

  it("created_not_connected carries the repo URL and the installation settings URL, encoded", async () => {
    const result: CreateRepoResult = {
      outcome: "created_not_connected",
      repoUrl: "https://github.com/acme/widgets",
      installationUrl: "https://github.com/organizations/acme/settings/installations/12",
    };
    const loc = new URL((await call(q(state()), {}, deps(result).d)).headers.get("location")!, "https://example.test");
    expect(loc.pathname).toBe("/");
    expect(Object.fromEntries(loc.searchParams)).toEqual({
      create: "created_not_connected",
      repo_url: "https://github.com/acme/widgets",
      settings_url: "https://github.com/organizations/acme/settings/installations/12",
    });
  });

  it.each([
    ["http", "http://github.com/a/b"],
    ["another host", "https://evil.example/a/b"],
    ["a look-alike host", "https://github.com.evil.example/a/b"],
    ["a suffix look-alike host", "https://evilgithub.com/a"],
    ["userinfo", "https://github.com@evil.example/a/b"],
    ["a port", "https://github.com:8443/a/b"],
    ["a relative path", "//evil.example/x"],
    ["javascript", "javascript:alert(1)"],
  ])("a URL that is %s is dropped, never redirected to", async (_n, bad) => {
    const res = await call(q(state()), {}, deps({ outcome: "created_not_connected", repoUrl: bad, installationUrl: bad }).d);
    expect(res.headers.get("location")).toBe("/?create=created_not_connected");
  });

  it("a URL on a non-created outcome is not passed along, and an outcome the service did not define is failed", async () => {
    expect((await call(q(state()), {}, deps({ outcome: "ok", repoUrl: "https://github.com/a/b", installationUrl: "https://github.com/x" }).d)).headers.get("location")).toBe("/?create=ok");
    expect((await call(q(state()), {}, deps({ outcome: "//evil.example" } as never).d)).headers.get("location")).toBe("/?create=failed");
  });

  it("a service that throws is a plain failed, and nothing is echoed or logged", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    const reports = captureReports();
    const res = await call(q(state()), {}, deps(new Error("ghu_TOKENVALUE boom")).d);
    expect(res.headers.get("location")).toBe("/?create=failed");
    // Reported as one coded class under the request's route template; the error text is not in it.
    expect(reports.classes).toEqual([{ service: "test", route: "/api/github/create-repo/callback", stage: "github.create_repo", code: "other" }]);
    expect(reports.everything()).not.toMatch(/ghu_|boom/);
    expect(JSON.stringify([...res.headers.entries()])).not.toMatch(/ghu_|boom|SECRETCODE/);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  describe("the per-account cap on GitHub returns", () => {
    it("a visit over the cap is rate_limited and the service is never called", async () => {
      const { d, create } = deps();
      const limitSession = vi.fn(async () => {
        throw new RateLimitedError(9);
      });
      const reports = captureReports();
      const res = await call(q(state()), {}, { ...d, limitSession });
      expect(res.headers.get("location")).toBe("/?create=rate_limited");
      // A refusal by the limiter is the answer, not a failure: nothing is reported.
      expect(reports.classes).toEqual([]);
      expect(limitSession).toHaveBeenCalledWith({ accountId, userId });
      expect(create).not.toHaveBeenCalled();
    });

    it("a limiter that cannot run is failed, never an unlimited pass", async () => {
      const { d, create } = deps();
      const reports = captureReports();
      const res = await call(q(state()), {}, { ...d, limitSession: async () => { throw new Error("db down FAKE-h1b-db-password"); } });
      expect(res.headers.get("location")).toBe("/?create=failed");
      expect(create).not.toHaveBeenCalled();
      expect(reports.classes).toEqual([{ service: "test", route: "/api/github/create-repo/callback", stage: "github.create_repo.limit", code: "other" }]);
      expect(reports.everything()).not.toContain("FAKE-h1b-db-password");
    });

    it("a visit with a bad state is refused before it is counted", async () => {
      const { d } = deps();
      const limitSession = vi.fn(async () => {});
      const res = await call(q(tamper(state())), {}, { ...d, limitSession });
      expect(res.headers.get("location")).toBe("/?create=failed");
      expect(limitSession).not.toHaveBeenCalled();
    });
  });
});

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, signSession } from "@fx/core/src/auth/session";
import { mintInstallState } from "@fx/api/src/github/installUrl.js";
import { RateLimitedError } from "@fx/api/src/errors.js";
import type { InstallOutcome } from "@fx/github";
import { captureReports } from "../../../../../../test/captureReports";
import { installCallbackHandler, type InstallCallbackDeps } from "./handler";

/** D#2 H17a: the route layer only. The recording and the GitHub checks are in packages/github's tests. */
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

function deps(outcome: InstallOutcome | Error = "ok") {
  const complete = vi.fn(async () => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  const d: InstallCallbackDeps = {
    platformOpsPool: sessionPool,
    appCredentials: () => ({ appId: "7", privateKeyPem: "", webhookSecret: "" }),
    env: { GITHUB_INSTALL_STATE_SECRET: SECRET },
    complete,
  };
  return { d, complete };
}

async function call(kind: string, query: Record<string, string>, opts: { session?: boolean } = {}, d = deps().d) {
  const url = new URL(`https://example.test/api/github/install/${kind}/callback`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (opts.session !== false) {
    headers.cookie = `${SESSION_COOKIE_NAME}=${await signSession({ userId, accountId }, SESSION_ENV)}`;
  }
  return installCallbackHandler(new NextRequest(url, { headers }), kind, d);
}

const state = (over: Partial<{ accountId: string; userId: string; appKind: "team" | "team_readonly" | "sitekit" }> = {}, now?: Date) =>
  mintInstallState({ accountId, userId, appKind: "team", ...over }, SECRET, now);
const q = (s: string) => ({ state: s, installation_id: "987654", code: "SECRETCODE" });

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

describe("GET /api/github/install/{kind}/callback", () => {
  it.each(["", "Team", "team%20", "admin", "github"])("kind %j is a 404 and reaches nothing", async (kind) => {
    const { d, complete } = deps();
    const res = await call(kind, q(state()), {}, d);
    expect(res.status).toBe(404);
    expect(complete).not.toHaveBeenCalled();
  });

  it.each(["team", "team_readonly", "sitekit"] as const)("%s: a good state calls the recorder with the path's kind and the session's ids", async (kind) => {
    const { d, complete } = deps("ok");
    const res = await call(kind, q(state({ appKind: kind })), {}, d);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?install=ok");
    expect(complete).toHaveBeenCalledWith(
      expect.anything(),
      { kind, accountId, userId, installationId: "987654", code: "SECRETCODE" },
    );
  });

  it("no session: failed, nothing recorded", async () => {
    const { d, complete } = deps();
    const res = await call("team", q(state()), { session: false }, d);
    expect(res.headers.get("location")).toBe("/?install=failed");
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([
    ["an expired state", () => state({}, new Date(Date.now() - 3_600_000))],
    ["a state minted for another kind", () => state({ appKind: "sitekit" })],
    ["another user's state", () => state({ userId: randomUUID() })],
    ["another account's state", () => state({ accountId: randomUUID() })],
    ["a tampered state", () => tamper(state())],
    ["a missing state", () => ""],
  ])("%s: failed, nothing recorded", async (_name, make) => {
    const { d, complete } = deps();
    const res = await call("team", make() ? q(make()) : { installation_id: "1", code: "c" }, {}, d);
    expect(res.headers.get("location")).toBe("/?install=failed");
    expect(complete).not.toHaveBeenCalled();
  });

  it.each(["ok", "failed", "claimed", "pay_first", "pending", "not_installer", "inactive"] as const)("outcome %s is a 302 to its fixed path with an empty body", async (outcome) => {
    const res = await call("team", q(state()), {}, deps(outcome).d);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/?install=${outcome}`);
    expect(await res.text()).toBe("");
  });

  it("a recorder that throws is a plain failed, and nothing is echoed or logged", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const reports = captureReports();
    const res = await call("team", q(state()), {}, deps(new Error("boom 987654 SECRETCODE")).d);
    expect(reports.classes).toEqual([{ service: "test", route: "/api/github/install/:id/callback", stage: "github.install", code: "other" }]);
    expect(reports.everything()).not.toMatch(/boom|987654|SECRETCODE/);
    expect(res.headers.get("location")).toBe("/?install=failed");
    expect(`${res.headers.get("location")}${await res.text()}`).not.toMatch(/987654|SECRETCODE/);
    // The one permitted line is the fixed outcome note: the kind and the outcome word, nothing from the error.
    const [, info, ...rest] = spies;
    expect(info!.mock.calls).toEqual([["install callback: team outcome=failed"]]);
    for (const s of [spies[0]!, ...rest]) expect(s).not.toHaveBeenCalled();
  });

  it("a full run through the real recorder logs no installation id, code or token", async () => {
    const lines: string[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    }
    const fetchImpl = (async (url: string | URL | Request) =>
      String(url).includes("/login/oauth/")
        ? Response.json({ access_token: "ghu_LEAKME" })
        : Response.json({ installations: [] })) as unknown as typeof fetch;
    const { d } = deps();
    const res = await call("team", q(state()), {}, {
      ...d,
      complete: undefined,
      fetchImpl,
      env: { ...d.env, GITHUB_APP_TEAM_CLIENT_ID: "i", GITHUB_APP_TEAM_CLIENT_SECRET: "CLIENTSECRET" },
    });
    expect(res.headers.get("location")).toBe("/?install=failed");
    expect(lines.join("\n")).not.toMatch(/987654|SECRETCODE|ghu_LEAKME|CLIENTSECRET/);
  });

  describe("the per-account cap on GitHub returns", () => {
    it("a visit over the cap is rate_limited and GitHub is never called", async () => {
      const { d, complete } = deps("ok");
      const limitSession = vi.fn(async () => {
        throw new RateLimitedError(7);
      });
      const reports = captureReports();
      const res = await call("team", q(state()), {}, { ...d, limitSession });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/?install=rate_limited");
      expect(reports.classes).toEqual([]);
      expect(limitSession).toHaveBeenCalledWith({ accountId, userId });
      expect(complete).not.toHaveBeenCalled();
    });

    it("a limiter that cannot run is failed, never an unlimited pass", async () => {
      const { d, complete } = deps("ok");
      const reports = captureReports();
      const res = await call("team", q(state()), {}, { ...d, limitSession: async () => { throw new Error("db down FAKE-h1b-db-password"); } });
      expect(res.headers.get("location")).toBe("/?install=failed");
      expect(complete).not.toHaveBeenCalled();
      expect(reports.classes).toEqual([{ service: "test", route: "/api/github/install/:id/callback", stage: "github.install.limit", code: "other" }]);
      expect(reports.everything()).not.toContain("FAKE-h1b-db-password");
    });

    it("a visit inside the cap goes through, and a bad state is refused before it is counted", async () => {
      const { d, complete } = deps("ok");
      const limitSession = vi.fn(async () => {});
      const good = await call("team", q(state()), {}, { ...d, limitSession });
      expect(good.headers.get("location")).toBe("/?install=ok");
      expect(complete).toHaveBeenCalledTimes(1);
      const bad = await call("team", q(tamper(state())), {}, { ...d, limitSession });
      expect(bad.headers.get("location")).toBe("/?install=failed");
      expect(limitSession).toHaveBeenCalledTimes(1);
    });
  });
});

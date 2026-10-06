import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { OAUTH_ENV_NAMES, verifyUserInstallation } from "../src/userInstallations.js";
import { completeInstall } from "../src/installCallback.js";
import { pagedListing, strictGithubFetch } from "./helpers/strictGithub.js";

/** D#2 H17a: the user-token verification, against a fake GitHub. No database. */
const ENV = {
  GITHUB_APP_TEAM_CLIENT_ID: "Iv1.team",
  GITHUB_APP_TEAM_CLIENT_SECRET: "team-client-secret",
};
const TOKEN = "ghu_usertoken";
const USER_ID = 5150;

function github(pages: Array<Array<{ id: number; app_id: number }>>, exchange: unknown = { access_token: TOKEN }) {
  const calls: Array<{ url: string; auth: string | null }> = [];
  // The pages are one list cut at 100 per page, the way GitHub cuts it (total_count and a Link header included).
  const fetchImpl = vi.fn(strictGithubFetch(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, auth: new Headers(init?.headers).get("authorization") });
    if (u.startsWith("https://github.com/login/oauth/access_token")) return Response.json(exchange);
    if (u === "https://api.github.com/user") return Response.json({ id: USER_ID });
    return pagedListing("installations", pages.flat(), u);
  })) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const verify = (fetchImpl: typeof fetch, over: Partial<Parameters<typeof verifyUserInstallation>[0]> = {}) =>
  verifyUserInstallation({ kind: "team", code: "c0de", ghInstallationId: 42, appId: "7", env: ENV, fetchImpl, ...over });

describe("verifyUserInstallation (H17a criterion 3)", () => {
  it("accepts an installation in the user's list that belongs to this App", async () => {
    const gh = github([[{ id: 42, app_id: 7 }]]);
    expect(await verify(gh.fetchImpl)).toBe(USER_ID);
    expect(gh.calls[1]!.auth).toBe(`Bearer ${TOKEN}`);
  });

  it("refuses an installation id that is not in the user's list (the forged-id attack)", async () => {
    expect(await verify(github([[{ id: 41, app_id: 7 }]]).fetchImpl)).toBe(null);
  });

  it("refuses an installation that belongs to a different App", async () => {
    expect(await verify(github([[{ id: 42, app_id: 8 }]]).fetchImpl)).toBe(null);
  });

  it("reads later pages", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, app_id: 7 }));
    expect(await verify(github([full, [{ id: 42, app_id: 7 }]]).fetchImpl)).toBe(USER_ID);
  });

  it("refuses when the code exchange returns no token, and when GitHub errors", async () => {
    expect(await verify(github([[{ id: 42, app_id: 7 }]], { error: "bad_verification_code" }).fetchImpl)).toBe(null);
    expect(await verify((async () => new Response("no", { status: 502 })) as unknown as typeof fetch)).toBe(null);
    expect(
      await verify((async () => {
        throw new Error("net");
      }) as unknown as typeof fetch),
    ).toBe(null);
  });

  it.each(Object.entries(OAUTH_ENV_NAMES))(
    "%s: fails closed with no GitHub call when either half of the client credentials is unset",
    async (kind, names) => {
      const gh = github([[{ id: 42, app_id: 7 }]]);
      const k = kind as keyof typeof OAUTH_ENV_NAMES;
      expect(await verify(gh.fetchImpl, { kind: k, env: {} })).toBe(null);
      expect(await verify(gh.fetchImpl, { kind: k, env: { [names.clientId]: "id" } })).toBe(null);
      expect(await verify(gh.fetchImpl, { kind: k, env: { [names.clientSecret]: "secret" } })).toBe(null);
      expect(gh.fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("names distinct client credentials per kind", () => {
    const names = Object.values(OAUTH_ENV_NAMES).flatMap((n) => [n.clientId, n.clientSecret]);
    expect(new Set(names).size).toBe(6);
  });
});

describe("completeInstall before any database work", () => {
  const pool = { connect: vi.fn() } as unknown as Pool;
  const creds = () => ({ appId: "7", privateKeyPem: "", webhookSecret: "" });
  const base = { kind: "team" as const, accountId: "a", userId: "u", installationId: "42", code: "c0de" };

  it.each([
    ["missing code", { code: null }],
    ["missing installation_id", { installationId: null }],
    ["a non-numeric installation_id", { installationId: "42; DROP" }],
  ])("%s is refused without a GitHub call or a connection", async (_name, over) => {
    const gh = github([[{ id: 42, app_id: 7 }]]);
    const out = await completeInstall(
      { platformOpsPool: pool, appCredentials: creds, env: ENV, fetchImpl: gh.fetchImpl },
      { ...base, ...over },
    );
    expect(out).toBe("failed");
    expect(gh.fetchImpl).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("an unverified installation is refused before any connection", async () => {
    const gh = github([[{ id: 99, app_id: 7 }]]);
    const out = await completeInstall(
      { platformOpsPool: pool, appCredentials: creds, env: ENV, fetchImpl: gh.fetchImpl },
      base,
    );
    expect(out).toBe("failed");
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("an unconfigured App is refused", async () => {
    const gh = github([[{ id: 42, app_id: 7 }]]);
    const out = await completeInstall(
      {
        platformOpsPool: pool,
        appCredentials: () => {
          throw new Error("x");
        },
        env: ENV,
        fetchImpl: gh.fetchImpl,
      },
      base,
    );
    expect(out).toBe("failed");
    expect(gh.fetchImpl).not.toHaveBeenCalled();
  });
});

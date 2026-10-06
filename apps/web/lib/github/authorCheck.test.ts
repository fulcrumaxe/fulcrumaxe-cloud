import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkRetryAuthor } from "@fx/core/src/runActions/authorCheck.js";
import { defaultGithubWebhookDeps } from "../../app/api/github/webhook/handler";
import { getAuthorCheck, setAuthorCheckSeamForTests } from "./authorCheck";
import { setIntakeAllowlistForTests } from "./intakeTrust";

/**
 * D#31 AUTHOR-CHECK-WIRE A3, A4, A5: the production provider over a fetch fake, a fake
 * platform_ops resolver (the test seam) and a fake pg pool. Nothing here reaches a network or a database.
 */
const OWNER = "acme-corp";
const REPO = "widgets-secret";
const APP_VARS = ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY_PEM", "GITHUB_WEBHOOK_SECRET"];

let fetchCalls: unknown[][];
let resolverCalls: string[];

beforeEach(() => {
  fetchCalls = [];
  resolverCalls = [];
  vi.stubGlobal("fetch", (...args: unknown[]) => (fetchCalls.push(args), Promise.reject(new Error("no network in this test"))));
  vi.stubEnv("DATABASE_URL_PLATFORM_OPS", "postgres://u:p@127.0.0.1:1/none");
  vi.stubEnv("DATABASE_URL_APP_USER", "postgres://u:p@127.0.0.1:1/none");
  for (const name of APP_VARS) vi.stubEnv(name, "");
  setAuthorCheckSeamForTests({ resolveInstallation: async (repoId) => (resolverCalls.push(repoId), { installationId: 777, appKind: "team" }) });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setAuthorCheckSeamForTests();
  setIntakeAllowlistForTests();
});

/** A pool whose one client answers the provenance chain query with `rows` and every other statement with none. */
function fakePool(rows: unknown[]): Pool {
  const client = {
    query: async (sql: string) => ({ rows: sql.includes("WITH RECURSIVE") ? rows : [], rowCount: 0 }),
    release: () => {},
  };
  return { connect: async () => client } as unknown as Pool;
}
const internalRoot = { id: randomUUID(), parent_id: null, provenance: "internal", kind: "issue", repo_id: null, gh_number: null, gh_owner: null, gh_name: null };
const externalRoot = { id: randomUUID(), parent_id: null, provenance: "external", kind: "issue", repo_id: randomUUID(), gh_number: "5", gh_owner: OWNER, gh_name: REPO };
const check = (pool: Pool, lookup: Parameters<typeof checkRetryAuthor>[0]["lookup"], allowlist: readonly string[] = []) =>
  checkRetryAuthor({ pool, accountId: randomUUID(), userId: randomUUID(), workItemId: randomUUID(), lookup, allowlist });

describe("fail closed (A3)", () => {
  it("missing App credentials: the lookup rejects and an external chain is unavailable, never trusted", async () => {
    const provided = getAuthorCheck()!;
    expect(provided).not.toBeNull();
    await expect(provided.lookup({ repoId: randomUUID(), owner: OWNER, name: REPO, number: 5 })).rejects.toThrow();
    expect(await check(fakePool([externalRoot]), provided.lookup, provided.allowlist)).toBe("unavailable");
    expect(fetchCalls).toEqual([]);
  });

  it("building the lookup throws once: that call is null, and the failure is not kept", async () => {
    // A fresh module graph, so no platform_ops pool has been memoised by an earlier test.
    vi.resetModules();
    const fresh = await import("./authorCheck");
    vi.stubEnv("DATABASE_URL_PLATFORM_OPS", "");
    expect(fresh.getAuthorCheck()).toBeNull();
    vi.stubEnv("DATABASE_URL_PLATFORM_OPS", "postgres://u:p@127.0.0.1:1/none");
    expect(fresh.getAuthorCheck()).not.toBeNull();
  });

  it("the thrown error and anything logged carry no login, owner, repo name or token", async () => {
    const sinks = (["log", "warn", "error", "info", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const err = await getAuthorCheck()!.lookup({ repoId: randomUUID(), owner: OWNER, name: REPO, number: 5 }).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    for (const text of [String(err!.message), String(err!.stack)]) {
      for (const secret of [OWNER, REPO, "ghs_"]) expect(text).not.toContain(secret);
    }
    for (const s of sinks) expect(s).not.toHaveBeenCalled();
  });
});

describe("the shared allowlist (A4)", () => {
  it("the webhook deps and the author check read the same list, and read it again on every call", () => {
    setIntakeAllowlistForTests(["Alice"]);
    expect(defaultGithubWebhookDeps().allowlist).toEqual(["Alice"]);
    expect(getAuthorCheck()!.allowlist).toEqual(["Alice"]);

    setIntakeAllowlistForTests(["Bob", "Carol"]);
    expect(getAuthorCheck()!.allowlist).toEqual(["Bob", "Carol"]);
    expect(defaultGithubWebhookDeps().allowlist).toEqual(["Bob", "Carol"]);

    setIntakeAllowlistForTests(null);
    expect(defaultGithubWebhookDeps().allowlist).toBeUndefined();
    expect(getAuthorCheck()!.allowlist).toEqual([]);
  });
});

describe("an internal chain (A5)", () => {
  it("is trusted with zero GitHub calls and zero resolver calls", async () => {
    const provided = getAuthorCheck()!;
    expect(await check(fakePool([internalRoot]), provided.lookup, provided.allowlist)).toBe("trusted");
    expect(fetchCalls).toEqual([]);
    expect(resolverCalls).toEqual([]);
  });
});

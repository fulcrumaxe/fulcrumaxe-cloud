import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

/** The production wiring hands the run's call meter to the lifecycle function, so an un-suspend re-sync is counted. */
const captured: { apply?: (change: unknown, meter: unknown) => Promise<void> } = {};
const lifecycle = vi.fn(async (..._args: unknown[]) => undefined);

vi.mock("@fx/db/src/pool", () => ({ createPool: () => ({}) }));
vi.mock("@fx/github", () => ({
  loadAppCredentials: () => () => ({ appId: "1", privateKeyPem: "k" }),
  mintAppJwt: () => "jwt",
  recordInstallationLifecycle: (...args: unknown[]) => lifecycle(...args),
}));
vi.mock("@fx/reconcile", () => ({
  createGithubAppApi: () => ({}),
  createGithubInstallationsJob: (deps: { apply: typeof captured.apply }) => ((captured.apply = deps.apply), { name: "github_installations" }),
}));
vi.mock("./repoSync", () => ({ buildSyncRepos: () => async () => undefined }));

describe("githubInstallationsJobFromEnv", () => {
  beforeEach(() => {
    process.env.DATABASE_URL_APP_USER = "postgres://unused";
    lifecycle.mockClear();
  });

  it("passes the run's meter, unchanged, as the fourth argument of recordInstallationLifecycle", async () => {
    const { githubInstallationsJobFromEnv } = await import("./installationReconcile");
    githubInstallationsJobFromEnv({} as Pool, () => undefined);
    const meter = { take: () => true };
    await captured.apply!({ kind: "team", ghInstallationId: 7, action: "unsuspend" }, meter);
    const args = lifecycle.mock.calls[0] as unknown[];
    expect(args[1]).toBe("team");
    expect(args[2]).toEqual({ action: "unsuspend", installation: { id: 7 } });
    expect(args[3]).toBe(meter);
  });
});

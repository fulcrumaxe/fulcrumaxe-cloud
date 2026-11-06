import { afterEach, describe, expect, it, vi } from "vitest";

// The bot-login list is the platform's own App accounts. Both paths that open an issue-origin proposal (the webhook and the reconcile job's missed-issue import)
// must hand `platformBotLogins` to the shared intake; these tests pin the production wiring of each, not the intake's reading of the list.
const world = vi.hoisted(() => ({ logins: ["fulcrum-team[bot]"] as string[], calls: 0, jobDeps: null as null | { importIssues?: (t: unknown, g: unknown) => Promise<unknown> }, importDeps: null as null | { webhook: { botLogins?: () => Promise<string[]> | string[] } } }));

vi.mock("./authorTrust", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./authorTrust")>()),
  platformBotLogins: async () => {
    world.calls += 1;
    return world.logins;
  },
}));
vi.mock("@fx/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fx/github")>()),
  importMissedIssues: async (deps: typeof world.importDeps) => {
    world.importDeps = deps;
    return { failures: 0 };
  },
}));

vi.mock("@fx/reconcile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fx/reconcile")>()),
  createGithubReposJob: (deps: typeof world.jobDeps) => {
    world.jobDeps = deps;
    return {};
  },
}));

import { defaultGithubWebhookDeps } from "../../app/api/github/webhook/handler";
import { githubReposJobFromEnv } from "./repoReconcile";

afterEach(() => {
  world.calls = 0;
  world.importDeps = null;
  world.jobDeps = null;
  vi.unstubAllEnvs();
});

describe("the bot-login list reaches the issue intake (BOT-ISSUE-ORIGIN)", () => {
  it("the webhook's production deps answer with the platform's bot logins", async () => {
    vi.stubEnv("DATABASE_URL_APP_USER", "postgres://u:p@127.0.0.1:1/none");
    vi.stubEnv("DATABASE_URL_PLATFORM_OPS", "postgres://u:p@127.0.0.1:1/none");
    const botLogins = defaultGithubWebhookDeps().botLogins;
    expect(botLogins).toBeTypeOf("function");
    expect(await botLogins!()).toEqual(["fulcrum-team[bot]"]);
    expect(world.calls).toBe(1);
  });

  it("the reconcile job's missed-issue import hands the same bot logins to the webhook intake it runs", async () => {
    vi.stubEnv("DATABASE_URL_APP_USER", "postgres://u:p@127.0.0.1:1/none");
    githubReposJobFromEnv({} as never, () => {});
    const gate = { take: () => true, stopped: () => false };
    const out = await world.jobDeps!.importIssues!({ installationId: "11111111-1111-4111-8111-111111111111", kind: "team", ghInstallationId: 5 }, gate);
    expect(out).toEqual({ failures: 0 });
    const botLogins = world.importDeps?.webhook.botLogins;
    expect(botLogins).toBeTypeOf("function");
    expect(await botLogins!()).toEqual(["fulcrum-team[bot]"]);
    expect(world.calls).toBe(1);
  });
});

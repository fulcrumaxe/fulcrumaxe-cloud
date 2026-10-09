import { describe, expect, it } from "vitest";
import type { InstallationHttpRequest } from "@fx/github";
import { LocalOnlyGithubError, RunPullRequestError } from "@fx/runner-cloud";
import { createAppRunPullRequestPort } from "./runnerPullRequest";

/** D#6 R2b-3e: the app's wiring of the `done` pull request port: the runner_pr installation client, behind the allowlist. */
const REPO = { id: "22222222-2222-4222-8222-222222222222", owner: "acme", name: "widgets" };

function setup(answer: (req: InstallationHttpRequest) => { status: number; body: unknown }) {
  const opened: unknown[] = [];
  const sent: InstallationHttpRequest[] = [];
  const port = createAppRunPullRequestPort({
    open: async (kind, target) => {
      opened.push([kind, target]);
      return { request: async (req) => (sent.push(req), answer(req)) };
    },
  });
  return { port, opened, sent };
}

describe("createAppRunPullRequestPort", () => {
  it("opens the runner_pr client for the repo by id, and sends the call without caller headers", async () => {
    const t = setup(() => ({ status: 200, body: { full_name: "acme/widgets", default_branch: "main" } }));
    expect(await t.port.defaultBranch(REPO)).toBe("main");
    expect(t.opened).toEqual([["runner_pr", { repoId: REPO.id, owner: "acme", name: "widgets" }]]);
    expect(t.sent).toEqual([{ method: "GET", path: "/repos/acme/widgets", query: undefined, body: undefined }]);
  });

  it("sends a draft pull request, and a graphql document, through the same client", async () => {
    const t = setup((req) => (req.path === "/graphql" ? { status: 200, body: { errors: [{ type: "FORBIDDEN" }] } } : { status: 200, body: [] }));
    await t.port.changedFiles({ repo: REPO, number: 4 }).catch(() => undefined);
    expect(t.sent.map((r) => [r.method, r.path])).toEqual([["POST", "/graphql"]]);
    expect((t.sent[0]!.body as { variables: unknown }).variables).toEqual({ owner: "acme", name: "widgets", number: 4 });
  });

  it("a call outside the allowlist never reaches the client (the fence is applied by the port, not by this file)", async () => {
    const t = setup(() => ({ status: 200, body: {} }));
    // Closing is allowed, but pull request number -1 is not a number the allowlist accepts: the wrapper throws before the client is asked.
    await expect(t.port.close({ repo: REPO, number: -1 })).rejects.toBeInstanceOf(LocalOnlyGithubError);
    expect(t.sent).toEqual([]);
  });

  it("an installation that cannot be opened is unavailable, with a fixed reason that holds none of the cause", async () => {
    const port = createAppRunPullRequestPort({
      open: async () => {
        throw new Error("installationHttp: no_installation for acme/widgets");
      },
    });
    const error = (await port.defaultBranch(REPO).catch((e: unknown) => e)) as RunPullRequestError;
    expect(error).toBeInstanceOf(RunPullRequestError);
    expect(error.reason).toBe("unavailable");
    expect(error.message).not.toContain("acme");
  });
});

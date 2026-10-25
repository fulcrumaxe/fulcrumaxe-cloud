import { describe, expect, it, vi } from "vitest";
import { LocalOnlyGithubError } from "@fx/runner-cloud";
import type { InstallationHttp, InstallationHttpKind } from "@fx/github";
import * as runnerPullRequest from "./runnerPullRequest";
import { createPrCloseOpener } from "./prClose";

/**
 * The private-copy close client: the pull request port's installation client, opened only inside runnerPullRequest.ts and returned already behind the
 * local-only fence for every mode, so a repository is only ever asked the allowlisted list (A3) and close (A5), never GraphQL, contents, a commit, a
 * compare or a merge.
 */
function setup() {
  const sent: string[] = [];
  const kinds: InstallationHttpKind[] = [];
  const http = { request: vi.fn(async (req: { method: string; path: string }) => (sent.push(`${req.method} ${req.path}`), { status: 200, body: [] })) } as unknown as InstallationHttp;
  const opener = createPrCloseOpener(async (kind) => (kinds.push(kind), http));
  return { sent, kinds, opener };
}
const target = { repoId: "r1", owner: "acme", name: "widgets" };
type Req = Parameters<Awaited<ReturnType<ReturnType<typeof setup>["opener"]>>["request"]>[0];

describe("createPrCloseOpener", () => {
  it.each([["runner_local"], ["runner_verified"]])("%s: the list and the close go through, everything else is refused before a request is made", async (mode) => {
    const s = setup();
    const client = await s.opener(mode, target);
    await client.request({ method: "GET", path: "/repos/acme/widgets/pulls", query: { state: "all", head: "acme:fx/x-g1", per_page: 30 } });
    await client.request({ method: "PATCH", path: "/repos/acme/widgets/pulls/3", body: { state: "closed" } });
    expect(s.sent).toEqual(["GET /repos/acme/widgets/pulls", "PATCH /repos/acme/widgets/pulls/3"]);
    const bad: Req[] = [
      { method: "GET", path: "/repos/acme/widgets/pulls/3/files" },
      { method: "GET", path: "/repos/acme/widgets/contents/README.md" },
      { method: "GET", path: "/repos/acme/widgets/compare/main...fx/x-g1" },
      { method: "PATCH", path: "/repos/acme/widgets/pulls/3", body: { state: "open" } },
      { method: "PATCH", path: "/repos/acme/widgets/pulls/3", body: { state: "closed", title: "x" } },
      // Not in the type, but a caller could still try it at runtime: GraphQL (a contents query), a merge and a delete.
      { method: "POST", path: "/graphql", body: { query: "query { repository(owner: \"acme\", name: \"widgets\") { object(expression: \"HEAD:README.md\") { ... on Blob { text } } } }", variables: {} } } as unknown as Req,
      { method: "PUT", path: "/repos/acme/widgets/pulls/3/merge", body: { sha: "a".repeat(40), merge_method: "squash" } } as unknown as Req,
      { method: "DELETE", path: "/repos/acme/widgets/git/refs/heads/x" } as unknown as Req,
    ];
    for (const req of bad) await expect(client.request(req), `${req.method} ${req.path}`).rejects.toBeInstanceOf(LocalOnlyGithubError);
    expect(s.sent).toHaveLength(2);
    expect(s.kinds).toEqual(["runner_pr"]);
  });

  it("runnerPullRequest.ts exports no function that returns the raw client: only the fenced close opener and the port factories", () => {
    expect(Object.keys(runnerPullRequest).sort()).toEqual(["createAppBranchSync", "createAppContinuationBase", "createAppRunPullRequestPort", "openFencedPrCloseClient"]);
  });
});

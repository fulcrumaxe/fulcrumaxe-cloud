import { describe, expect, it, vi } from "vitest";
import { GITHUB_GRAPHQL_DOCUMENTS, LocalOnlyGithubError } from "@fx/runner-cloud";
import type { InstallationHttp, InstallationHttpRequest } from "@fx/github";
import { fenceInstallationHttp, openForRepo } from "../lib/github/localOnlyHttp";

/** D#6 R3c: the review driver's and the merge gate's client for a runner_local repo is the allowlist, in front of the installation client. */
const SHA = "a".repeat(40);

function inner() {
  const seen: InstallationHttpRequest[] = [];
  const http: InstallationHttp = { request: async (req) => (seen.push(req), { status: 200, body: {} }) };
  return { http, seen };
}

describe("fenceInstallationHttp", () => {
  it("passes the review path's calls (A1 files and checks documents, A3, A7, A8, A10) to the installation client unchanged", async () => {
    const { http, seen } = inner();
    const fenced = fenceInstallationHttp(http);
    await fenced.graphql("PullRequestFiles", { owner: "acme", name: "widgets", number: 41 });
    await fenced.graphql("CommitChecks", { owner: "acme", name: "widgets", number: 41 });
    await fenced.request({ method: "GET", path: "/repos/acme/widgets/pulls", query: { state: "open", head: "acme:fx/r-g1", per_page: 5 } });
    await fenced.request({ method: "GET", path: "/repos/acme/widgets/branches/main/protection" });
    await fenced.request({ method: "POST", path: `/repos/acme/widgets/statuses/${SHA}`, body: { state: "success", context: "fulcrumaxe/review", description: "d" } });
    await fenced.request({ method: "PUT", path: "/repos/acme/widgets/pulls/41/merge", body: { sha: SHA, merge_method: "squash" } });
    expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /graphql",
      "POST /graphql",
      "GET /repos/acme/widgets/pulls",
      "GET /repos/acme/widgets/branches/main/protection",
      `POST /repos/acme/widgets/statuses/${SHA}`,
      "PUT /repos/acme/widgets/pulls/41/merge",
    ]);
    expect((seen[0]!.body as { query: string }).query).toBe(GITHUB_GRAPHQL_DOCUMENTS.PullRequestFiles);
    expect((seen[1]!.body as { query: string }).query).toBe(GITHUB_GRAPHQL_DOCUMENTS.CommitChecks);
  });

  it("refuses everything wider before the installation client is reached, and logs the rule only", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { http, seen } = inner();
      const fenced = fenceInstallationHttp(http);
      const wider = [
        { method: "GET" as const, path: "/repos/acme/widgets/pulls/41/files", query: { per_page: 100, page: 1 } },
        { method: "GET" as const, path: "/repos/acme/widgets/pulls/41" },
        { method: "GET" as const, path: "/repos/acme/widgets/contents/src/a.ts" },
        { method: "GET" as const, path: `/repos/acme/widgets/git/blobs/${SHA}` },
        { method: "GET" as const, path: `/repos/acme/widgets/commits/${SHA}/check-runs` },
        { method: "GET" as const, path: `/repos/acme/widgets/commits/${SHA}/status` },
        { method: "GET" as const, path: "/repos/acme/widgets/rules/branches/main" },
        { method: "GET" as const, path: "/repos/acme/widgets/branches/main/protection/required_status_checks" },
        { method: "PUT" as const, path: "/repos/acme/widgets/pulls/41/merge", body: { sha: SHA, merge_method: "merge" } },
        { method: "POST" as const, path: `/repos/acme/widgets/statuses/${SHA}`, body: { state: "success", context: "ci/other", description: "d" } },
        { method: "POST" as const, path: "/graphql", body: { query: "{ viewer { login } }", variables: {} } },
      ];
      for (const req of wider) await expect(fenced.request(req), `${req.method} ${req.path}`).rejects.toBeInstanceOf(LocalOnlyGithubError);
      // A method the installation client does not speak is refused too.
      await expect(fenced.request({ method: "DELETE", path: "/repos/acme/widgets" } as never)).rejects.toBeInstanceOf(LocalOnlyGithubError);
      await expect(fenced.graphql("toString" as never, {})).rejects.toBeInstanceOf(LocalOnlyGithubError);
      expect(seen).toEqual([]);
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines.length).toBe(wider.length + 2);
      for (const line of lines) {
        expect(JSON.parse(line)).toEqual({ event: "advance.local_only_refused", rule: "not_allowlisted" });
        expect(line).not.toContain("acme");
      }
    } finally {
      warn.mockRestore();
    }
  });
});

describe("openForRepo", () => {
  const TARGET = { repoId: "r1", owner: "acme", name: "widgets" };

  it("a sandbox repo gets the plain client, opened exactly as before (no GraphQL)", async () => {
    const { http } = inner();
    const open = vi.fn(async () => http);
    expect(await openForRepo(open, "sandbox", "merge_gate", TARGET)).toBe(http);
    expect(open).toHaveBeenCalledWith("merge_gate", TARGET);
  });

  it("a runner_local repo gets a client opened with GraphQL allowed and put behind the fence", async () => {
    const { http, seen } = inner();
    const open = vi.fn(async () => http);
    const got = await openForRepo(open, "runner_local", "read", TARGET);
    expect(open).toHaveBeenCalledWith("read", { ...TARGET, allowGraphql: true });
    expect(got).not.toBe(http);
    await expect(got.request({ method: "GET", path: "/repos/acme/widgets/pulls/41/files" })).rejects.toBeInstanceOf(LocalOnlyGithubError);
    expect(seen).toEqual([]);
  });
});

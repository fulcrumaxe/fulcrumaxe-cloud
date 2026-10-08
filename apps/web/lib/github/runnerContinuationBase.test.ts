import { describe, expect, it } from "vitest";
import type { InstallationHttpRequest } from "@fx/github";
import { createAppContinuationBase, createAppRunPullRequestPort } from "./runnerPullRequest";

/** D#6 R2b-3f: the app's read of a continuation's branch head at dispatch, through the same allowlisted port. */
const REPO = { id: "22222222-2222-4222-8222-222222222222", owner: "acme", name: "widgets" };
const OID = "d".repeat(40);

function base(branchRef: unknown, fail?: number) {
  const sent: InstallationHttpRequest[] = [];
  const port = createAppRunPullRequestPort({
    appLogin: async () => "app[bot]",
    open: async () => ({
      request: async (req) => {
        sent.push(req);
        if (fail) return { status: fail, body: {} };
        if (req.path === "/graphql") return { status: 200, body: { data: { repository: { defaultBranchRef: { name: "main" }, ref: branchRef, baseRef: { compare: { aheadBy: 1 } } } } } };
        return { status: 200, body: { full_name: "acme/widgets", default_branch: "main" } };
      },
    }),
  });
  return { sent, continuation: createAppContinuationBase(port) };
}

describe("createAppContinuationBase", () => {
  it("answers the branch's head object id after reading the default branch and RunBranchState, and nothing else", async () => {
    const t = base({ name: "fx/issue-12", target: { oid: OID } });
    expect(await t.continuation.headOid({ repo: REPO, branch: "fx/issue-12" })).toBe(OID);
    expect(t.sent.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /repos/acme/widgets", "POST /graphql"]);
  });

  it("answers null for a branch that does not exist", async () => {
    expect(await base(null).continuation.headOid({ repo: REPO, branch: "fx/issue-12" })).toBeNull();
  });

  it("throws when GitHub cannot answer, so the dispatch is refused rather than recorded without a base", async () => {
    await expect(base(null, 502).continuation.headOid({ repo: REPO, branch: "fx/issue-12" })).rejects.toThrow();
  });
});

import { describe, expect, it } from "vitest";
import type { InstallationHttp, InstallationHttpRequest, InstallationHttpTarget } from "@fx/github";
import { createAppContinuationBinding } from "./continuationBinding";

/**
 * D#599 PL-2b-2 (R-599-PL2b-1-c, R-599-PL2b2-1): the live GitHub side of the continuation binding. GitHub is a fake with the real shapes: the pulls list applies the
 * `head=<owner>:<ref>` filter and includes closed pull requests for `state=all`; the protection read is 404 for an unprotected branch (never 200 with an
 * empty body) and answers only a branch name sent as ONE percent-encoded path segment. Not faked faithfully: real TLS and the User-Agent header (the
 * installation client sets both and has its own tests), and a branch covered only by a repository ruleset, which A8 does not see (accepted gap).
 */
const REPO = { id: "22222222-2222-4222-8222-222222222222", owner: "acme", name: "widgets" };
const STORED_GH_ID = 7001;
const BRANCH = "fx/issue-12";

interface FakePull {
  number: number;
  state: "open" | "closed";
  headOwner: string;
  headRef: string;
  headRepoId: number | null;
  title?: string;
  body?: string;
}

function fakeGitHub(o: { pulls?: FakePull[]; defaultBranch?: string; protection?: Record<string, number>; listStatus?: number } = {}) {
  const requests: InstallationHttpRequest[] = [];
  const kinds: Array<{ kind: string; target: InstallationHttpTarget }> = [];
  const open = async (kind: string, target: InstallationHttpTarget): Promise<InstallationHttp> => {
    kinds.push({ kind, target });
    return {
      async request(req) {
        requests.push(req);
        if (req.method !== "GET") return { status: 405, body: {} };
        if (req.path === "/repos/acme/widgets") return { status: 200, body: { full_name: "acme/widgets", default_branch: o.defaultBranch ?? "main", private: true } };
        if (req.path === "/repos/acme/widgets/pulls") {
          if (o.listStatus && o.listStatus !== 200) return { status: o.listStatus, body: { message: "boom" } };
          const q = req.query ?? {};
          const head = String(q.head ?? "");
          const wantAll = q.state === "all";
          const body = (o.pulls ?? [])
            .filter((p) => `${p.headOwner}:${p.headRef}` === head && (wantAll || p.state === q.state))
            .map((p) => ({
              number: p.number,
              state: p.state,
              title: p.title ?? "secret title",
              body: p.body ?? "secret body",
              head: { ref: p.headRef, sha: "c".repeat(40), repo: p.headRepoId === null ? null : { id: p.headRepoId, full_name: `${p.headOwner}/widgets` } },
              base: { ref: "main", repo: { id: STORED_GH_ID } },
            }));
          return { status: 200, body };
        }
        const m = /^\/repos\/acme\/widgets\/branches\/([^/]+)\/protection$/.exec(req.path);
        if (m) {
          const branch = decodeURIComponent(m[1]!);
          const status = (o.protection ?? {})[branch] ?? 404;
          return { status, body: status === 404 ? { message: "Branch not protected" } : {} };
        }
        return { status: 404, body: {} };
      },
    };
  };
  return { open, requests, kinds };
}

const port = (gh: ReturnType<typeof fakeGitHub>, stored: number | null = STORED_GH_ID) => createAppContinuationBinding({ open: gh.open, storedGhRepoId: async () => stored });
const verifiedRepo = { ...REPO, local: false };

describe("pullRequestsByHead", () => {
  it("lists this repository's pull requests for the branch in every state, and reports only structured values with OUR stored repository id as the base", async () => {
    const gh = fakeGitHub({ pulls: [{ number: 41, state: "open", headOwner: "acme", headRef: BRANCH, headRepoId: STORED_GH_ID }, { number: 30, state: "closed", headOwner: "acme", headRef: BRANCH, headRepoId: STORED_GH_ID }] });
    const out = await port(gh).pullRequestsByHead({ repo: verifiedRepo, branch: BRANCH });
    expect(out).toEqual({
      status: 200,
      pulls: [
        { number: 41, state: "open", headRepoId: STORED_GH_ID, baseRepoId: STORED_GH_ID, headRef: BRANCH },
        { number: 30, state: "closed", headRepoId: STORED_GH_ID, baseRepoId: STORED_GH_ID, headRef: BRANCH },
      ],
    });
    expect(JSON.stringify(out)).not.toMatch(/secret/);
    expect(gh.requests).toEqual([{ method: "GET", path: "/repos/acme/widgets/pulls", query: { head: `acme:${BRANCH}`, state: "all", per_page: 5 } }]);
  });

  it("a fork's pull request under the same owner name keeps its own head repository id, which is not ours; a deleted fork reads as null", async () => {
    const gh = fakeGitHub({
      pulls: [
        { number: 50, state: "open", headOwner: "acme", headRef: BRANCH, headRepoId: 9999 },
        { number: 51, state: "open", headOwner: "acme", headRef: BRANCH, headRepoId: null },
      ],
    });
    const out = await port(gh).pullRequestsByHead({ repo: verifiedRepo, branch: BRANCH });
    expect(out.pulls).toEqual([
      { number: 50, state: "open", headRepoId: 9999, baseRepoId: STORED_GH_ID, headRef: BRANCH },
      { number: 51, state: "open", headRepoId: null, baseRepoId: STORED_GH_ID, headRef: BRANCH },
    ]);
  });

  it("reports the status and no list when GitHub cannot answer, and 404 when we hold no repository id", async () => {
    expect(await port(fakeGitHub({ listStatus: 502 })).pullRequestsByHead({ repo: verifiedRepo, branch: BRANCH })).toEqual({ status: 502 });
    const none = fakeGitHub();
    expect(await port(none, null).pullRequestsByHead({ repo: verifiedRepo, branch: BRANCH })).toEqual({ status: 404 });
    expect(none.requests).toEqual([]);
  });

  it("answers 502 for a list it cannot read as pull requests", async () => {
    const open = async (): Promise<InstallationHttp> => ({ request: async () => ({ status: 200, body: [{ number: "41" }] }) });
    const p = createAppContinuationBinding({ open, storedGhRepoId: async () => STORED_GH_ID });
    expect(await p.pullRequestsByHead({ repo: verifiedRepo, branch: BRANCH })).toEqual({ status: 502 });
  });

  it("refuses a branch name that is not plain ref characters before any request is made", async () => {
    const gh = fakeGitHub();
    for (const branch of ["fx/issue-12; x", "-x", "a b", "", "fx/\n"]) expect((await port(gh).pullRequestsByHead({ repo: verifiedRepo, branch })).status, branch).toBe(400);
    expect(gh.requests).toEqual([]);
  });
});

describe("defaultBranch and branchProtection", () => {
  it("reads default_branch, and null when it cannot be read", async () => {
    expect(await port(fakeGitHub({ defaultBranch: "trunk" })).defaultBranch({ repo: verifiedRepo })).toBe("trunk");
    const down = async (): Promise<InstallationHttp> => ({ request: async () => ({ status: 500, body: {} }) });
    expect(await createAppContinuationBinding({ open: down, storedGhRepoId: async () => 1 }).defaultBranch({ repo: verifiedRepo })).toBeNull();
  });

  it("sends the branch as one percent-encoded segment, and reads 404 as not protected and 200 as protected", async () => {
    const gh = fakeGitHub({ protection: { [BRANCH]: 200 } });
    expect(await port(gh).branchProtection({ repo: verifiedRepo, branch: BRANCH })).toEqual({ status: 200 });
    expect(await port(gh).branchProtection({ repo: verifiedRepo, branch: "fx/issue-13" })).toEqual({ status: 404 });
    expect(gh.requests.map((r) => r.path)).toEqual(["/repos/acme/widgets/branches/fx%2Fissue-12/protection", "/repos/acme/widgets/branches/fx%2Fissue-13/protection"]);
  });
});

describe("which client reads", () => {
  it("a cloud-verified run's repository is read through the merge_gate installation client, unfenced", async () => {
    const gh = fakeGitHub();
    await port(gh).defaultBranch({ repo: verifiedRepo });
    expect(gh.kinds).toEqual([{ kind: "merge_gate", target: { repoId: REPO.id, owner: "acme", name: "widgets" } }]);
  });

  it("a runner_local run's repository is read through the local-only fence: the repository, pulls and (D#599 R-599-PL2b2-1) the encoded item-branch protection reads all pass", async () => {
    const gh = fakeGitHub({ pulls: [{ number: 41, state: "open", headOwner: "acme", headRef: BRANCH, headRepoId: STORED_GH_ID }] });
    const local = { ...REPO, local: true };
    expect(await port(gh).defaultBranch({ repo: local })).toBe("main");
    expect((await port(gh).pullRequestsByHead({ repo: local, branch: BRANCH })).status).toBe(200);
    expect(await port(gh).branchProtection({ repo: local, branch: BRANCH })).toEqual({ status: 404 });
    expect(gh.kinds.every((k) => k.kind === "merge_gate" && (k.target as { allowGraphql?: boolean }).allowGraphql === true)).toBe(true);
    expect(gh.requests.map((r) => r.path)).toContain("/repos/acme/widgets/branches/fx%2Fissue-12/protection");
  });

  it("an item-branch continuation's three reads on a runner_local run all pass through the fence, in the issuer's order, and read as an unprotected, open, own-repository pull request", async () => {
    // The issuer half (what it does with these answers) is pinned in packages/runner's jobIssuer tests; this file stays on the adapter and the fence.
    const gh = fakeGitHub({ pulls: [{ number: 41, state: "open", headOwner: "acme", headRef: BRANCH, headRepoId: STORED_GH_ID }] });
    const local = { ...REPO, local: true };
    const p = port(gh);
    const listed = await p.pullRequestsByHead({ repo: local, branch: BRANCH });
    expect(listed).toEqual({ status: 200, pulls: [{ number: 41, state: "open", headRepoId: STORED_GH_ID, baseRepoId: STORED_GH_ID, headRef: BRANCH }] });
    expect(await p.defaultBranch({ repo: local })).toBe("main");
    expect(await p.branchProtection({ repo: local, branch: BRANCH })).toEqual({ status: 404 });
    expect(gh.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /repos/acme/widgets/pulls",
      "GET /repos/acme/widgets",
      "GET /repos/acme/widgets/branches/fx%2Fissue-12/protection",
    ]);
  });

  it("a protected branch, a closed pull request and a fork's head read as such through the same fence", async () => {
    const local = { ...REPO, local: true };
    const open = { number: 41, state: "open" as const, headOwner: "acme", headRef: BRANCH, headRepoId: STORED_GH_ID };
    expect(await port(fakeGitHub({ pulls: [open], protection: { [BRANCH]: 200 } })).branchProtection({ repo: local, branch: BRANCH })).toEqual({ status: 200 });
    expect(await port(fakeGitHub({ pulls: [open], protection: { [BRANCH]: 500 } })).branchProtection({ repo: local, branch: BRANCH })).toEqual({ status: 500 });
    expect((await port(fakeGitHub({ pulls: [{ ...open, state: "closed" }] })).pullRequestsByHead({ repo: local, branch: BRANCH })).pulls?.[0]?.state).toBe("closed");
    expect((await port(fakeGitHub({ pulls: [{ ...open, headRepoId: 9999 }] })).pullRequestsByHead({ repo: local, branch: BRANCH })).pulls?.[0]).toMatchObject({ headRepoId: 9999, baseRepoId: STORED_GH_ID });
  });

  it("a run branch is read the same way: its protection path is the encoded run branch", async () => {
    const gh = fakeGitHub();
    const runBranch = "fx/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g1";
    expect(await port(gh).branchProtection({ repo: { ...REPO, local: true }, branch: runBranch })).toEqual({ status: 404 });
    expect(gh.requests[0]!.path).toBe("/repos/acme/widgets/branches/fx%2F5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g1/protection");
  });

  it("any other branch name is still refused by the fence before a request is made", async () => {
    const gh = fakeGitHub();
    for (const branch of ["fx/docs/x", "fx/issue-07", "release/1"]) {
      await expect(port(gh).branchProtection({ repo: { ...REPO, local: true }, branch }), branch).rejects.toThrow();
    }
    expect(gh.requests).toEqual([]);
  });

  it("an absent local flag reads as fenced, the cautious side", async () => {
    const gh = fakeGitHub();
    await port(gh).defaultBranch({ repo: REPO as unknown as typeof verifiedRepo });
    expect((gh.kinds[0]!.target as { allowGraphql?: boolean }).allowGraphql).toBe(true);
  });
});

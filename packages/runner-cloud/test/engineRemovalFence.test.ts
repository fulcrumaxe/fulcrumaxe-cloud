import { describe, expect, it } from "vitest";
import { GITHUB_GRAPHQL_DOCUMENTS, localOnlyViolation, type GithubRequest } from "../src/localOnlyGithub.js";

const R = "/repos/acme/app";
const S = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";
const del = { path: "engine/a.txt", mode: "100644", type: "blob", sha: null };
const REF = "refs/heads/fx/engine-remove-1.2.3";
const NEW: Array<[string, GithubRequest]> = [
  ["A19", { method: "GET", path: `${R}/pulls/7` }],
  ["A20", { method: "GET", path: `${R}/git/trees/${S}`, query: { recursive: "1" } }],
  ["A21", { method: "GET", path: `${R}/git/ref/heads/main` }],
  ["A22", { method: "POST", path: `${R}/git/trees`, body: { base_tree: S, tree: [del] } }],
  ["A23", { method: "POST", path: `${R}/git/commits`, body: { message: "Remove the engine", tree: S, parents: [S] } }],
  ["A24", { method: "POST", path: `${R}/git/refs`, body: { ref: REF, sha: S } }],
];

describe("the engineRemove fence (D#845 ON-16b)", () => {
  for (const [id, req] of NEW) {
    it(`${id} holds on the removal client and is refused on every other client`, () => {
      expect(localOnlyViolation(req, [], { engineRemove: true })).toBeNull();
      expect(localOnlyViolation(req)).toBe("not_allowlisted");
      expect(localOnlyViolation(req, [], { gate1Attest: true })).toBe("not_allowlisted");
    });
  }

  it("on the removal client only A1 to A4 and A19 to A24 hold: no status, merge, close, label, delete or other read", () => {
    const refused: GithubRequest[] = [
      { method: "POST", path: `${R}/statuses/${S}`, body: { state: "success", context: "fulcrumaxe/review", description: "x" } },
      { method: "PUT", path: `${R}/pulls/7/merge`, body: { sha: S, merge_method: "squash" } },
      { method: "PATCH", path: `${R}/pulls/7`, body: { state: "closed" } },
      { method: "POST", path: `${R}/issues/7/labels`, body: { labels: ["ci:full"] } },
      { method: "GET", path: `${R}/branches/main/protection` },
      { method: "DELETE", path: R },
      { method: "DELETE", path: `${R}/git/refs/heads/fx/engine-remove-1.2.3` },
      { method: "PATCH", path: `${R}/git/refs/heads/main`, body: { sha: S, force: true } },
      { method: "POST", path: `${R}/git/blobs`, body: { content: "x", encoding: "utf-8" } },
      { method: "GET", path: `${R}/git/blobs/${S}` },
      { method: "GET", path: `${R}/contents/README` },
      { method: "GET", path: `${R}/pulls/7/files` },
      { method: "GET", path: `${R}/git/ref/heads/fx/engine-remove-1.2.3` },
      { method: "POST", path: "/app/installations/9/access_tokens" },
    ];
    for (const req of refused) expect(localOnlyViolation(req, [], { engineRemove: true }), `${req.method} ${req.path}`).toBe("not_allowlisted");
    expect(localOnlyViolation({ method: "GET", path: `${R}/pulls`, query: { head: "acme:fx/engine-remove-1.2.3", state: "open" } }, [], { engineRemove: true })).toBeNull();
    expect(localOnlyViolation({ method: "POST", path: "/graphql", body: { query: GITHUB_GRAPHQL_DOCUMENTS.PullRequestFiles, variables: { owner: "acme", name: "app", number: 7, cursor: null } } }, [], { engineRemove: true })).toBeNull();
  });

  it("holds the bodies to their shape: only the removal branch, only deletions of files, one parent", () => {
    const run = (method: "POST", path: string, body: unknown) => localOnlyViolation({ method, path, body }, [], { engineRemove: true });
    for (const ref of ["refs/heads/main", "refs/heads/fx/engine-remove-latest", "refs/heads/fx/engine-remove-1.2.3/x", "refs/tags/fx/engine-remove-1.2.3", "heads/fx/engine-remove-1.2.3", "refs/heads/fx/engine-remove-1.2"]) {
      expect(run("POST", `${R}/git/refs`, { ref, sha: S }), ref).toBe("not_allowlisted");
    }
    expect(run("POST", `${R}/git/refs`, { ref: REF, sha: S, force: true })).toBe("not_allowlisted");
    expect(run("POST", `${R}/git/trees`, { base_tree: S, tree: [{ ...del, sha: S }] })).toBe("not_allowlisted"); // an add or a change, not a deletion
    expect(run("POST", `${R}/git/trees`, { base_tree: S, tree: [{ ...del, type: "tree" }] })).toBe("not_allowlisted");
    expect(run("POST", `${R}/git/trees`, { base_tree: S, tree: [{ ...del, content: "x" }] })).toBe("not_allowlisted");
    expect(run("POST", `${R}/git/trees`, { base_tree: S, tree: [{ ...del, path: "../x" }] })).toBe("not_allowlisted");
    expect(run("POST", `${R}/git/trees`, { base_tree: S, tree: [{ ...del, path: "/etc/x" }] })).toBe("not_allowlisted");
    expect(run("POST", `${R}/git/trees`, { base_tree: S, tree: [{ ...del, mode: "040000" }] })).toBe("not_allowlisted");
    expect(run("POST", `${R}/git/trees`, { base_tree: S, tree: [] })).toBe("not_allowlisted");
    expect(run("POST", `${R}/git/trees`, { base_tree: S, tree: Array.from({ length: 501 }, () => del) })).toBe("not_allowlisted");
    expect(run("POST", `${R}/git/trees`, { tree: [del] })).toBe("not_allowlisted"); // no base: it would drop the whole repository
    expect(run("POST", `${R}/git/commits`, { message: "x", tree: S, parents: [S, S] })).toBe("not_allowlisted");
    expect(run("POST", `${R}/git/commits`, { message: "x", tree: S, parents: [] })).toBe("not_allowlisted");
    expect(localOnlyViolation({ method: "GET", path: `${R}/git/trees/${S}`, query: { recursive: "true" } }, [], { engineRemove: true })).toBe("not_allowlisted");
  });

  it("narrows A4 to the removal branch and A1 to PullRequestFiles on the removal client only", () => {
    const pr = (head: string): GithubRequest => ({ method: "POST", path: `${R}/pulls`, body: { title: "t", head, base: "main", body: "b", draft: false } });
    const only = { engineRemove: true };
    expect(localOnlyViolation(pr("fx/engine-remove-1.2.3"), [], only)).toBeNull();
    for (const head of ["main", "fx/issue-4", "fx/engine-remove-latest", "other:fx/engine-remove-1.2.3"]) expect(localOnlyViolation(pr(head), [], only), head).toBe("not_allowlisted");
    expect(localOnlyViolation(pr("fx/issue-4"))).toBeNull(); // every other client is as before
    const doc = (query: string, variables: unknown): GithubRequest => ({ method: "POST", path: "/graphql", body: { query, variables } });
    expect(localOnlyViolation(doc(GITHUB_GRAPHQL_DOCUMENTS.PullRequestFiles, { owner: "acme", name: "app", number: 7 }), [], only)).toBeNull();
    expect(localOnlyViolation(doc(GITHUB_GRAPHQL_DOCUMENTS.MarkReady, { id: "PR_kwDOAbCd123" }), [], only)).toBe("not_allowlisted");
    expect(localOnlyViolation(doc(GITHUB_GRAPHQL_DOCUMENTS.RunBranchState, { owner: "acme", name: "app", head: "a", base: "b" }), [], only)).toBe("not_allowlisted");
  });
});

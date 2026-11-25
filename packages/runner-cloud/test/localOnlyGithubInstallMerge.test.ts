import { describe, expect, it } from "vitest";
import { GITHUB_GRAPHQL_DOCUMENTS, LOCAL_ONLY_ALLOWLIST, SETUP_INSTALL_DOCUMENTS, localOnlyGithub, localOnlyViolation, type GithubClient, type GithubRequest } from "../src/localOnlyGithub.js";

const sha = "c".repeat(40);
const gql = (variables: Record<string, unknown>, query: string = SETUP_INSTALL_DOCUMENTS.InstallPullRequest): Pick<GithubRequest, "method" | "path" | "body"> => ({ method: "POST", path: "/graphql", body: { query, variables } });
const good = { owner: "acme", name: "widgets", number: 7 };

/** D#845 ON-20a (A30): the install pull request's per-file line counts, on a setupInstall client only. */
describe("A30 InstallPullRequest", () => {
  it("is allowed on a setupInstall client with exactly owner, name, a pull request number and an optional cursor", () => {
    expect(localOnlyViolation(gql(good), [], { setupInstall: true })).toBeNull();
    expect(localOnlyViolation(gql({ ...good, cursor: "Y3Vyc29y" }), [], { setupInstall: true })).toBeNull();
    for (const bad of [{ ...good, extra: 1 }, { owner: "acme", name: "widgets" }, { ...good, number: 0 }, { ...good, number: "7" }, { ...good, number: 1.5 }, { ...good, owner: ".." }, { ...good, cursor: "a b" }, { ...good, cursor: 5 }]) {
      expect(localOnlyViolation(gql(bad as Record<string, unknown>), [], { setupInstall: true }), JSON.stringify(bad)).toBe("not_allowlisted");
    }
  });

  it("is refused on every other client: the default one, the attester's, the status one and the engine removal's", () => {
    expect(localOnlyViolation(gql(good))).toBe("not_allowlisted");
    for (const options of [{ gate1Attest: true }, { gate1Status: true }, { engineRemove: true }]) expect(localOnlyViolation(gql(good), [], options)).toBe("not_allowlisted");
  });

  it("takes only its fixed text: another document, an edited one, and one that asks for a patch, a file's content or a commit's message are refused", () => {
    const doc = SETUP_INSTALL_DOCUMENTS.InstallPullRequest;
    for (const query of [GITHUB_GRAPHQL_DOCUMENTS.RunBranchState, `${doc} `, doc.replace("first: 100", "first: 1000"), doc.replace("additions deletions", "additions deletions patch"), doc.replace("headRefOid", "headRefOid commits(first: 1) { nodes { commit { message } } }")]) {
      expect(localOnlyViolation(gql(good, query), [], { setupInstall: true })).toBe("not_allowlisted");
    }
  });

  it("selects state, head and counts per file: no patch, content, message, author, body or comment", () => {
    for (const word of ["patch", "content", "text", "message", "author", "body", "comments", "diff", "blob", "commits"]) expect(SETUP_INSTALL_DOCUMENTS.InstallPullRequest, word).not.toMatch(new RegExp(`\\b${word}\\b`));
  });
});

const MERGE = (n: number, body: unknown): Pick<GithubRequest, "method" | "path" | "body"> => ({ method: "PUT", path: `/repos/acme/widgets/pulls/${n}/merge`, body });
const pinned = { installMerge: { owner: "acme", name: "widgets", number: 7, sha } };

/** D#845 ON-20a (A10): the merge, fenced to exactly one pull request and one head. */
describe("A10 on the install merge client", () => {
  it("is allowed for exactly the pinned pull request at exactly the pinned head, squash only", () => {
    expect(localOnlyViolation(MERGE(7, { sha, merge_method: "squash" }), [], pinned)).toBeNull();
    expect(localOnlyViolation(MERGE(7, { sha, merge_method: "squash" }), [], { ...pinned, setupInstall: true })).toBeNull();
  });

  it("is refused for another pull request number, another head, another method, an extra key, a different path shape or repository case games", () => {
    for (const [req, why] of [
      [{ method: "PUT", path: "/repos/acme/gadgets/pulls/7/merge", body: { sha, merge_method: "squash" } }, "another repository"],
      [{ method: "PUT", path: "/repos/other/widgets/pulls/7/merge", body: { sha, merge_method: "squash" } }, "another owner"],
      [MERGE(8, { sha, merge_method: "squash" }), "another number"],
      [MERGE(70, { sha, merge_method: "squash" }), "a number that starts with the pin"],
      [MERGE(7, { sha: "d".repeat(40), merge_method: "squash" }), "another head"],
      [MERGE(7, { sha: sha.toUpperCase(), merge_method: "squash" }), "upper-case head"],
      [MERGE(7, { sha, merge_method: "merge" }), "another method"],
      [MERGE(7, { sha, merge_method: "rebase" }), "rebase"],
      [MERGE(7, { sha, merge_method: "squash", commit_title: "x" }), "an extra key"],
      [MERGE(7, { merge_method: "squash" }), "no sha"],
      [MERGE(7, undefined), "no body"],
      [{ method: "PUT", path: "/repos/acme/widgets/pulls/7/merge/x", body: { sha, merge_method: "squash" } }, "a longer path"],
      [{ method: "PUT", path: "/repos/acme/widgets/pulls/7%2F8/merge", body: { sha, merge_method: "squash" } }, "an encoded slash"],
      [{ method: "POST", path: "/repos/acme/widgets/pulls/7/merge", body: { sha, merge_method: "squash" } }, "another verb"],
      [{ method: "PUT", path: "/repos/acme/widgets/pulls/7/merge?x=1", body: { sha, merge_method: "squash" } }, "a query"],
    ] as const) {
      expect(localOnlyViolation(req, [], pinned), why).toBe("not_allowlisted");
    }
  });

  it("holds nothing but A10 on a pinned client: not the reads, not a pull request, not a label, not a status", () => {
    for (const req of [gql(good), { method: "GET", path: "/repos/acme/widgets" }, { method: "GET", path: "/repos/acme/widgets/pulls/7" }, { method: "POST", path: "/repos/acme/widgets/pulls", body: {} }, { method: "PATCH", path: "/repos/acme/widgets/pulls/7", body: { state: "closed" } }, { method: "POST", path: "/repos/acme/widgets/statuses/" + sha, body: {} }] as const) {
      expect(localOnlyViolation(req as never, [], pinned), JSON.stringify(req)).toBe("not_allowlisted");
    }
  });

  it("is refused on a setupInstall client with no pin, and on a pinned client that names a number or head that is not one", async () => {
    expect(localOnlyViolation(MERGE(7, { sha, merge_method: "squash" }), [], { setupInstall: true })).toBe("not_allowlisted");
    const inner: GithubClient = { request: async () => ({ status: 200, body: {} }) };
    for (const bad of [{ owner: "acme", name: "widgets", number: 0, sha }, { owner: "acme", name: "widgets", number: 1.5, sha }, { owner: "acme", name: "widgets", number: 7, sha: "c".repeat(39) }, { owner: "acme", name: "widgets", number: 7, sha: "refs/heads/main" }, { owner: "..", name: "widgets", number: 7, sha }, { owner: "acme", name: "", number: 7, sha }]) expect(() => localOnlyGithub(inner, { installMerge: bad })).toThrow(TypeError);
  });

  it("goes through the wrapper once, with the Accept header, and a second pull request is refused before anything is sent", async () => {
    const seen: GithubRequest[] = [];
    const inner: GithubClient = { request: async (r) => (seen.push(r), { status: 200, body: { merged: true } }) };
    const gh = localOnlyGithub(inner, pinned);
    await gh.request({ method: "PUT", path: "/repos/acme/widgets/pulls/7/merge", body: { sha, merge_method: "squash" } });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers).toMatchObject({ accept: "application/vnd.github+json" });
    await expect(gh.request({ method: "PUT", path: "/repos/acme/widgets/pulls/8/merge", body: { sha, merge_method: "squash" } })).rejects.toMatchObject({ rule: "not_allowlisted" });
    expect(seen).toHaveLength(1);
  });

  it("A10 stays one entry of the default list, and is the only entry a pin opens", () => {
    expect(LOCAL_ONLY_ALLOWLIST.filter((e) => e.id === "A10")).toHaveLength(1);
    expect(LOCAL_ONLY_ALLOWLIST.find((e) => e.id === "A10")!.only).toBeUndefined();
  });
});

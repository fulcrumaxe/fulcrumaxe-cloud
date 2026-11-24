import { describe, expect, it } from "vitest";
import { GATE1_QUEUE_DOCUMENTS, GITHUB_GRAPHQL_DOCUMENTS, LOCAL_ONLY_ALLOWLIST, SETUP_INSTALL_DOCUMENTS, localOnlyGithub, localOnlyViolation, type GithubClient, type GithubRequest } from "../src/localOnlyGithub.js";

/**
 * D#845 ON-8f2a (A25): the one extra read of the install step, the parents of one commit. It holds on a client built with `setupInstall` and on no other: not the default client, not the attester's, not the
 * engine removal's. The document selects commit ids and a count and nothing else of a commit.
 */
const sha = "c".repeat(40);
const body = (variables: Record<string, unknown>, query: string = SETUP_INSTALL_DOCUMENTS.CommitParents) => ({ query, variables });
const good = { owner: "acme", name: "widgets", sha };
const call = (b: unknown): Pick<GithubRequest, "method" | "path" | "body"> => ({ method: "POST", path: "/graphql", body: b });

describe("A25 CommitParents", () => {
  it("is allowed on a setupInstall client, with exactly owner, name and a full commit id", () => {
    expect(localOnlyViolation(call(body(good)), [], { setupInstall: true })).toBeNull();
    for (const bad of [{ ...good, extra: 1 }, { owner: "acme", name: "widgets" }, { ...good, sha: "c".repeat(39) }, { ...good, sha: "refs/heads/main" }, { ...good, sha: "C".repeat(40) }, { ...good, owner: ".." }, { ...good, sha: 1 }]) {
      expect(localOnlyViolation(call(body(bad as Record<string, unknown>)), [], { setupInstall: true }), JSON.stringify(bad)).toBe("not_allowlisted");
    }
  });

  it("is refused on every other client: the default one, the attester's, the read-only status client and the engine removal's", () => {
    expect(localOnlyViolation(call(body(good)))).toBe("not_allowlisted");
    expect(localOnlyViolation(call(body(good)), [], { gate1Attest: true })).toBe("not_allowlisted");
    expect(localOnlyViolation(call(body(good)), [], { gate1Status: true })).toBe("not_allowlisted");
    expect(localOnlyViolation(call(body(good)), [], { engineRemove: true })).toBe("not_allowlisted");
  });

  it("opening it does not open the attester's entries, and the attester's client does not open it", () => {
    expect(localOnlyViolation({ method: "POST", path: "/repos/acme/widgets/issues/1/labels", body: { labels: ["ci:full"] } }, [], { setupInstall: true })).toBe("not_allowlisted");
    expect(localOnlyViolation(call(body(good, GATE1_QUEUE_DOCUMENTS.Gate1QueueEntries)), [], { setupInstall: true })).toBe("not_allowlisted");
  });

  it("takes only the fixed text: another document, an edited one and a document that asks for more are refused", () => {
    for (const query of [GITHUB_GRAPHQL_DOCUMENTS.RunBranchState, `${SETUP_INSTALL_DOCUMENTS.CommitParents} `, SETUP_INSTALL_DOCUMENTS.CommitParents.replace("parents(first: 5)", "parents(first: 100)"), SETUP_INSTALL_DOCUMENTS.CommitParents.replace("oid", "oid message")]) {
      expect(localOnlyViolation(call(body(good, query)), [], { setupInstall: true })).toBe("not_allowlisted");
    }
  });

  it("selects commit ids and a count, no message, author, tree, file or patch", () => {
    const doc = SETUP_INSTALL_DOCUMENTS.CommitParents;
    for (const word of ["message", "author", "committer", "tree", "blob", "file", "patch", "diff", "text", "body", "history"]) expect(doc, word).not.toMatch(new RegExp(`\\b${word}\\b`));
  });

  it("goes through the wrapper's graphql(op) by name on that client only, and the A25 entry is the only opt-in entry of its kind", async () => {
    const seen: GithubRequest[] = [];
    const inner: GithubClient = { request: async (r) => (seen.push(r), { status: 200, body: {} }) };
    await localOnlyGithub(inner, { setupInstall: true }).graphql("CommitParents", good);
    expect(seen).toHaveLength(1);
    await expect(localOnlyGithub(inner).graphql("CommitParents", good)).rejects.toMatchObject({ rule: "not_allowlisted" });
    expect(seen).toHaveLength(1);
    expect(LOCAL_ONLY_ALLOWLIST.filter((e) => e.only === "setupInstall").map((e) => e.id)).toEqual(["A25"]);
  });
});

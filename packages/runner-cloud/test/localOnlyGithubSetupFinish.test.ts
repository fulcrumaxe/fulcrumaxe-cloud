import { describe, expect, it } from "vitest";
import { GATE1_QUEUE_DOCUMENTS, LOCAL_ONLY_ALLOWLIST, SETUP_FINISH_DOCUMENTS, SETUP_INSTALL_DOCUMENTS, SETUP_INSTALL_LABELS, localOnlyGithub, localOnlyViolation, type GithubClient, type GithubRequest } from "../src/localOnlyGithub.js";

/**
 * D#845 ON-13a4 (A27 to A29): the finish phase's calls, on a client built with `setupFinish` and on no other: the repository's Discussion facts, a lookup of our own marker in the newest Discussions, the one create, the
 * open team-log issues, and the one issue create. Every body is held to a fixed text and to our own marker, so a runner, a job or a person can never choose what the cloud posts.
 */
const SETUP = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e";
const SEED = `Do the thing.\n\n<!-- fx-seed:${SETUP}:A1 -->`;
const LOG = `Team activity log.\n\n<!-- fx-team-log:${SETUP} -->`;
const ON = { setupFinish: true } as const;
const gql = (query: string, variables: Record<string, unknown>): Pick<GithubRequest, "method" | "path" | "body"> => ({ method: "POST", path: "/graphql", body: { query, variables } });
const target = { owner: "acme", name: "widgets" };
const create = (over: Record<string, unknown> = {}) => ({ repositoryId: "R_kgDOabc123", categoryId: "DIC_kwDOabc_1", title: "Set up CI", body: SEED, ...over });
const issues = (over: Record<string, unknown> = {}): Pick<GithubRequest, "method" | "path" | "body"> => ({ method: "POST", path: "/repos/acme/widgets/issues", body: { title: "Team Activity Log 2026-11-24", body: LOG, labels: ["team-log"], ...over } });
const list = (query: Record<string, string | number>): Pick<GithubRequest, "method" | "path" | "query"> => ({ method: "GET", path: "/repos/acme/widgets/issues", query });

describe("A27 the three Discussion documents", () => {
  it("are allowed on a setupFinish client with exactly their own variables", () => {
    expect(localOnlyViolation(gql(SETUP_FINISH_DOCUMENTS.SeedTarget, target), [], ON)).toBeNull();
    expect(localOnlyViolation(gql(SETUP_FINISH_DOCUMENTS.SeedDiscussions, target), [], ON)).toBeNull();
    expect(localOnlyViolation(gql(SETUP_FINISH_DOCUMENTS.SeedDiscussions, { ...target, cursor: "Y3Vyc29yOjEwMA==" }), [], ON)).toBeNull();
    expect(localOnlyViolation(gql(SETUP_FINISH_DOCUMENTS.SeedCreateDiscussion, create()), [], ON)).toBeNull();
  });

  it("are refused with an extra, missing or malformed variable", () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      [SETUP_FINISH_DOCUMENTS.SeedTarget, { ...target, extra: 1 }],
      [SETUP_FINISH_DOCUMENTS.SeedTarget, { owner: "acme" }],
      [SETUP_FINISH_DOCUMENTS.SeedTarget, { owner: "..", name: "widgets" }],
      [SETUP_FINISH_DOCUMENTS.SeedTarget, { owner: "ac me", name: "widgets" }],
      [SETUP_FINISH_DOCUMENTS.SeedDiscussions, { ...target, cursor: "not a cursor!" }],
      [SETUP_FINISH_DOCUMENTS.SeedDiscussions, { ...target, first: 100 }],
      [SETUP_FINISH_DOCUMENTS.SeedCreateDiscussion, create({ extra: 1 })],
      [SETUP_FINISH_DOCUMENTS.SeedCreateDiscussion, create({ repositoryId: "has space" })],
      [SETUP_FINISH_DOCUMENTS.SeedCreateDiscussion, create({ categoryId: 5 })],
      [SETUP_FINISH_DOCUMENTS.SeedCreateDiscussion, create({ title: "" })],
      [SETUP_FINISH_DOCUMENTS.SeedCreateDiscussion, create({ title: "x".repeat(257) })],
      [SETUP_FINISH_DOCUMENTS.SeedCreateDiscussion, create({ title: "two\nlines" })],
    ];
    for (const [query, variables] of bad) expect(localOnlyViolation(gql(query, variables), [], ON), JSON.stringify(variables)).toBe("not_allowlisted");
  });

  it("a create must end with our own marker and hold no other comment, so the cloud posts nothing a caller chose", () => {
    for (const body of ["no marker", `${SEED}\nmore after it`, `<!-- other -->\n${SEED}`, `<!-- fx-seed:${SETUP}:a1 -->`, `<!-- fx-seed:not-a-uuid:A1 -->`, `<!-- fx-team-log:${SETUP} -->`, `${SEED}${"x".repeat(4000)}`, ""]) {
      expect(localOnlyViolation(gql(SETUP_FINISH_DOCUMENTS.SeedCreateDiscussion, create({ body })), [], ON), body.slice(0, 40)).toBe("not_allowlisted");
    }
  });

  it("takes only the fixed text: another document, an edited one and one that asks for more are refused", () => {
    for (const query of [SETUP_INSTALL_DOCUMENTS.CommitParents, GATE1_QUEUE_DOCUMENTS.Gate1QueueEntries, `${SETUP_FINISH_DOCUMENTS.SeedTarget} `, SETUP_FINISH_DOCUMENTS.SeedTarget.replace("first: 25", "first: 100"), SETUP_FINISH_DOCUMENTS.SeedDiscussions.replace("number body", "number body author { login }"), SETUP_FINISH_DOCUMENTS.SeedCreateDiscussion.replace("discussion { number }", "discussion { number body }"), "mutation { deleteDiscussion(input: {id: \"x\"}) { clientMutationId } }"]) {
      expect(localOnlyViolation(gql(query, query.includes("SeedCreateDiscussion") ? create() : target), [], ON)).toBe("not_allowlisted");
    }
  });

  it("is refused on every other client: the default one, the attester's, the read-only status client, the engine removal's and the install step's", () => {
    for (const options of [{}, { gate1Attest: true }, { gate1Status: true }, { engineRemove: true }, { setupInstall: true }]) {
      expect(localOnlyViolation(gql(SETUP_FINISH_DOCUMENTS.SeedTarget, target), [], options)).toBe("not_allowlisted");
      expect(localOnlyViolation(gql(SETUP_FINISH_DOCUMENTS.SeedCreateDiscussion, create()), [], options)).toBe("not_allowlisted");
    }
  });

  it("reads what a Discussion needs and no source: the target selects ids and names, the lookup selects only a number and a body, the create answers a number", () => {
    for (const word of ["object", "blob", "tree", "ref", "diff", "patch", "contents", "comments", "defaultBranchRef"]) {
      for (const [name, doc] of Object.entries(SETUP_FINISH_DOCUMENTS)) expect(doc, `${name} ${word}`).not.toMatch(new RegExp(`\\b${word}\\b`));
    }
    for (const name of ["SeedTarget", "SeedCreateDiscussion"] as const) expect(SETUP_FINISH_DOCUMENTS[name]).not.toMatch(/\bauthor\b/);
    expect(SETUP_FINISH_DOCUMENTS.SeedTarget).not.toMatch(/\bbody\b/);
    // the lookup reads a number, a body (for our marker) and the author's type and login (to know it is our App's): nothing else of a person
    expect(SETUP_FINISH_DOCUMENTS.SeedDiscussions).toMatch(/nodes \{ number body author \{ __typename login \} \}/);
    expect(SETUP_FINISH_DOCUMENTS.SeedDiscussions).toMatch(/first: 100/);
  });

  it("goes through the wrapper's graphql(op) by name on that client only", async () => {
    const seen: GithubRequest[] = [];
    const inner: GithubClient = { request: async (r) => (seen.push(r), { status: 200, body: {} }) };
    await localOnlyGithub(inner, ON).graphql("SeedTarget", target);
    expect(seen).toHaveLength(1);
    await expect(localOnlyGithub(inner).graphql("SeedTarget", target)).rejects.toMatchObject({ rule: "not_allowlisted" });
    await expect(localOnlyGithub(inner, { setupInstall: true }).graphql("SeedCreateDiscussion", create())).rejects.toMatchObject({ rule: "not_allowlisted" });
    expect(seen).toHaveLength(1);
  });
});

describe("A28 and A29 the team-log issue", () => {
  it("A28 reads only the open team-log issues, and A29 makes one issue with our marker and the one label", () => {
    expect(localOnlyViolation(list({ labels: "team-log", state: "open", per_page: 30 }), [], ON)).toBeNull();
    expect(localOnlyViolation(list({ labels: "team-log" }), [], ON)).toBeNull();
    expect(localOnlyViolation(issues(), [], ON)).toBeNull();
  });

  it("A28 refuses any other label, a query key it does not list, a body and a bad page size", () => {
    for (const query of ([{ labels: "bug", state: "open" }, { labels: "team-log,bug" }, { labels: "team-log", assignee: "x" }, { labels: "team-log", state: "bogus" }, { labels: "team-log", per_page: 500 }] as Array<Record<string, string | number>>)) {
      expect(localOnlyViolation(list(query), [], ON), JSON.stringify(query)).toBe("not_allowlisted");
    }
    expect(localOnlyViolation({ ...list({ labels: "team-log" }), body: { x: 1 } } as never, [], ON)).toBe("not_allowlisted");
    expect(localOnlyViolation({ method: "GET", path: "/repos/acme/widgets/issues/5", query: { labels: "team-log" } }, [], ON)).toBe("not_allowlisted");
    expect(localOnlyViolation({ method: "PATCH", path: "/repos/acme/widgets/issues/5", body: { state: "closed" } }, [], ON)).toBe("not_allowlisted");
  });

  it("A28 REQUIRES the team-log label as a query key: no label, only the other keys, or the label written in the path is refused", () => {
    for (const query of [{}, { state: "open" }, { state: "open", per_page: 30 }, { per_page: 100 }] as Array<Record<string, string | number>>) {
      expect(localOnlyViolation(list(query), [], ON), JSON.stringify(query)).toBe("not_allowlisted");
    }
    expect(localOnlyViolation({ method: "GET", path: "/repos/acme/widgets/issues" }, [], ON)).toBe("not_allowlisted");
    expect(localOnlyViolation({ method: "GET", path: "/repos/acme/widgets/issues?labels=team-log" }, [], ON)).toBe("not_allowlisted");
    expect(localOnlyViolation({ method: "GET", path: "/repos/acme/widgets/issues?state=open", query: { labels: "team-log" } }, [], ON)).toBe("not_allowlisted");
  });

  it("A29 refuses a body that is not exactly title, body and the team-log label, or that lacks our marker", () => {
    for (const over of [{ labels: ["team-log", "bug"] }, { labels: ["bug"] }, { labels: [] }, { labels: "team-log" }, { assignees: ["x"] }, { body: "no marker" }, { body: SEED }, { body: `${LOG} x` }, { title: "" }, { title: "x".repeat(257) }, { title: "a\u0000b" }]) {
      expect(localOnlyViolation(issues(over), [], ON), JSON.stringify(over)).toBe("not_allowlisted");
    }
    const noLabels = issues();
    delete (noLabels.body as Record<string, unknown>).labels;
    expect(localOnlyViolation(noLabels, [], ON)).toBe("not_allowlisted");
  });

  it("are refused on every other client", () => {
    for (const options of [{}, { gate1Attest: true }, { gate1Status: true }, { engineRemove: true }, { setupInstall: true }]) {
      expect(localOnlyViolation(list({ labels: "team-log", state: "open" }), [], options)).toBe("not_allowlisted");
      expect(localOnlyViolation(issues(), [], options)).toBe("not_allowlisted");
    }
  });

  it("opening them opens nothing else: not the attester's label call, not the install labels, not the install parents read", () => {
    expect(localOnlyViolation({ method: "POST", path: "/repos/acme/widgets/issues/1/labels", body: { labels: ["ci:full"] } }, [], ON)).toBe("not_allowlisted");
    const row = SETUP_INSTALL_LABELS[0]!;
    expect(localOnlyViolation({ method: "POST", path: "/repos/acme/widgets/labels", body: { name: row.name, color: row.color, description: row.description } }, [], ON)).toBe("not_allowlisted");
    expect(localOnlyViolation(gql(SETUP_INSTALL_DOCUMENTS.CommitParents, { ...target, sha: "c".repeat(40) }), [], ON)).toBe("not_allowlisted");
  });

  it("the A27 to A29 entries are the only ones of their kind", () => {
    expect(LOCAL_ONLY_ALLOWLIST.filter((e) => e.only === "setupFinish").map((e) => e.id)).toEqual(["A27", "A28", "A29"]);
  });
});

import { describe, expect, it } from "vitest";
import { GATE1_QUEUE_DOCUMENTS, GATE1_STATUS_DOCUMENTS, LocalOnlyGithubError, MERGE_QUEUE_READ_DOCUMENTS, localOnlyGithub, localOnlyViolation, type GithubClient, type GithubRequest } from "../src/localOnlyGithub.js";

/**
 * D#6 CLOUD-POSTS-FX-GATE1 PR 1d (TL ruling 11-07 01:00): A18, the merge queue's entries of the code repository for one branch (position, entry head and base oids,
 * pull request number and head oid). Opt-in on the attester client only: the default client, the plain code-repository client and the go phase's read-only
 * `gate1Status` client refuse it before GitHub is reached.
 */
const NOT = "not_allowlisted";
const DOC = GATE1_QUEUE_DOCUMENTS.Gate1QueueEntries;
const vars = { owner: "acme", name: "app", branch: "main" };
const graphql = (query: string, variables: unknown): GithubRequest => ({ method: "POST", path: "/graphql", body: { query, variables } });
const ATTESTER = { exclude: ["A10"], gate1Attest: true } as const;

function recorder(): { client: GithubClient; seen: GithubRequest[] } {
  const seen: GithubRequest[] = [];
  return { seen, client: { request: async (r) => (seen.push(r), { status: 200, body: {} }) } };
}
async function through(req: GithubRequest, options: Parameters<typeof localOnlyGithub>[1] = ATTESTER): Promise<{ result: string; reached: boolean }> {
  const { client, seen } = recorder();
  const result = await localOnlyGithub(client, options).request(req).then(
    () => "sent",
    (e: unknown) => (e instanceof LocalOnlyGithubError ? e.rule : `other:${String(e)}`),
  );
  return { result, reached: seen.length > 0 };
}

describe("A18: Gate1QueueEntries, on the attester client only", () => {
  it("is sent by name and as text on the attester client", async () => {
    expect(await through(graphql(DOC, vars))).toEqual({ result: "sent", reached: true });
    expect(await through(graphql(DOC, { ...vars, branch: "release/2.x" }))).toEqual({ result: "sent", reached: true });
    const r = recorder();
    await localOnlyGithub(r.client, ATTESTER).graphql("Gate1QueueEntries", vars);
    expect(r.seen.map((q) => (q.body as { query: string }).query)).toEqual([DOC]);
    expect(localOnlyViolation(graphql(DOC, vars), ["A10"], { gate1Attest: true })).toBeNull();
  });

  it("is refused before GitHub on the default client, the plain code-repository client, the go phase's read-only client, and with A18 excluded", async () => {
    for (const options of [{}, { exclude: ["A10"] }, { exclude: ["A10"], gate1Attest: false }, { exclude: ["A10"], gate1Status: true }, { exclude: ["A10", "A18"], gate1Attest: true }]) {
      expect(await through(graphql(DOC, vars), options), JSON.stringify(options)).toEqual({ result: NOT, reached: false });
    }
    const r = recorder();
    await expect(localOnlyGithub(r.client, { exclude: ["A10"], gate1Status: true }).graphql("Gate1QueueEntries", vars)).rejects.toMatchObject({ rule: NOT });
    await expect(localOnlyGithub(r.client).graphql("Gate1QueueEntries", vars)).rejects.toMatchObject({ rule: NOT });
    expect(r.seen).toEqual([]);
  });

  it("refuses variables outside its schema, another document's variables, an altered document and extra body keys", async () => {
    const cases: GithubRequest[] = [
      graphql(DOC, { ...vars, branch: "../main" }),
      graphql(DOC, { ...vars, branch: "" }),
      graphql(DOC, { ...vars, branch: 5 }),
      graphql(DOC, { ...vars, cursor: "abc" }),
      graphql(DOC, { ...vars, extra: 1 }),
      graphql(DOC, { owner: "acme", name: "app" }),
      graphql(DOC, { ...vars, owner: ".." }),
      graphql(DOC, { owner: "acme", name: "app", number: 12 }),
      graphql(`${DOC} `, vars),
      graphql(DOC.replace("entries(first: 100)", "entries(first: 100, after: $cursor)"), vars),
      graphql(DOC.replace("pullRequest { number headRefOid }", "pullRequest { number headRefOid title body author { login } }"), vars),
      graphql(DOC.replace("headCommit { oid }", "headCommit { oid message tree { oid } }"), vars),
      graphql(DOC.replace("baseCommit { oid }", "baseCommit { oid message }"), vars),
      graphql(DOC.replace(" baseCommit { oid }", ""), vars),
      graphql(DOC.replace("nodes { position", "nodes { state enqueuer { login } position"), vars),
      graphql(MERGE_QUEUE_READ_DOCUMENTS.MergeQueueRead.replace("{ id }", "{ id entries(first: 100) { nodes { position } } }"), vars),
      graphql(GATE1_STATUS_DOCUMENTS.Gate1Status, vars),
      { method: "POST", path: "/graphql", body: { query: DOC, variables: vars, operationName: "Gate1QueueEntries" } },
      { method: "GET", path: "/graphql", body: { query: DOC, variables: vars } },
    ];
    for (const req of cases) expect(await through(req), JSON.stringify(req.body).slice(0, 160)).toEqual({ result: NOT, reached: false });
  });

  it("selects only positions, oids (the entry's head and base commits, the pull request's head) and pull request numbers", () => {
    expect(DOC).toMatch(/^query Gate1QueueEntries\(/);
    expect(DOC).toContain("mergeQueue(branch: $branch)");
    expect(DOC).toContain("nodes { position headCommit { oid } baseCommit { oid } pullRequest { number headRefOid } }");
    for (const word of ["title", "body", "author", "enqueuer", "message", "tree", "blob", "text", "patch", "diff", "contents", "files", "url", "login", "state", "after"]) {
      expect(DOC, `selects ${word}`).not.toMatch(new RegExp(`\\b${word}\\b`, "i"));
    }
    expect(Object.keys(GATE1_QUEUE_DOCUMENTS)).toEqual(["Gate1QueueEntries"]);
    expect(Object.isFrozen(GATE1_QUEUE_DOCUMENTS)).toBe(true);
  });
});

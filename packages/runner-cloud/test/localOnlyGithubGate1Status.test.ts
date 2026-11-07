import { describe, expect, it } from "vitest";
import { GATE1_ATTEST_DOCUMENTS, GATE1_STATUS_DOCUMENTS, LocalOnlyGithubError, localOnlyGithub, localOnlyViolation, type GithubClient, type GithubRequest } from "../src/localOnlyGithub.js";

/**
 * D#6 CLOUD-POSTS-FX-GATE1 PR 1 (TL ruling 11-07 00:35): A17, the one read of who posted `fx-gate1` on a commit. Opt-in like A14 to A16: only the client built
 * with `gate1Attest` (the review round's client for a paired item's code repository) sends it; every other client refuses it before GitHub is reached.
 */
const NOT = "not_allowlisted";
const SHA = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";
const DOC = GATE1_STATUS_DOCUMENTS.Gate1Status;
const vars = { owner: "acme", name: "app", sha: SHA };
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

describe("A17: Gate1Status, on the attester client only", () => {
  it("is sent by name and as text on the attester client, for a sha-1 and a sha-256 commit", async () => {
    expect(await through(graphql(DOC, vars))).toEqual({ result: "sent", reached: true });
    expect(await through(graphql(DOC, { ...vars, sha: "b".repeat(64) }))).toEqual({ result: "sent", reached: true });
    const r = recorder();
    await localOnlyGithub(r.client, ATTESTER).graphql("Gate1Status", vars);
    expect(r.seen.map((q) => (q.body as { query: string }).query)).toEqual([DOC]);
  });

  it("is refused before GitHub on the default client, the plain code-repository client, and with A17 excluded", async () => {
    for (const options of [{}, { exclude: ["A10"] }, { exclude: ["A10"], gate1Attest: false }, { exclude: ["A10", "A17"], gate1Attest: true }]) {
      expect(await through(graphql(DOC, vars), options), JSON.stringify(options)).toEqual({ result: NOT, reached: false });
    }
    expect(localOnlyViolation(graphql(DOC, vars))).toBe(NOT);
    expect(localOnlyViolation(graphql(DOC, vars), ["A10"], { gate1Attest: true })).toBeNull();
    const r = recorder();
    await expect(localOnlyGithub(r.client).graphql("Gate1Status", vars)).rejects.toMatchObject({ rule: NOT });
    await expect(localOnlyGithub(r.client, { exclude: ["A10"] }).graphql("Gate1Status", vars)).rejects.toMatchObject({ rule: NOT });
    expect(r.seen).toEqual([]);
  });

  it("refuses variables outside its schema, another document's variables, an altered document and extra body keys", async () => {
    const cases: GithubRequest[] = [
      graphql(DOC, { ...vars, sha: "main" }),
      graphql(DOC, { ...vars, sha: SHA.toUpperCase() }),
      graphql(DOC, { ...vars, sha: SHA.slice(1) }),
      graphql(DOC, { ...vars, cursor: "abc" }),
      graphql(DOC, { ...vars, extra: 1 }),
      graphql(DOC, { owner: "acme", name: "app" }),
      graphql(DOC, { ...vars, owner: ".." }),
      graphql(DOC, { owner: "acme", name: "app", number: 12 }),
      graphql(`${DOC} `, vars),
      graphql(DOC.replace('context(name: "fx-gate1")', 'context(name: "fulcrumaxe/review")'), vars),
      graphql(DOC.replace('context(name: "fx-gate1") { state', 'context(name: "fx-gate1") { state description targetUrl'), vars),
      graphql(DOC.replace('status { context(name: "fx-gate1")', 'status { contexts { context state } context(name: "fx-gate1")'), vars),
      graphql(DOC.replace("creator { __typename login }", "creator { __typename login avatarUrl url }"), vars),
      graphql(GATE1_ATTEST_DOCUMENTS.Gate1CheckRuns, { ...vars, extra: 1 }),
      { method: "POST", path: "/graphql", body: { query: DOC, variables: vars, operationName: "Gate1Status" } },
      { method: "GET", path: "/graphql", body: { query: DOC, variables: vars } },
    ];
    for (const req of cases) expect(await through(req), JSON.stringify(req.body).slice(0, 140)).toEqual({ result: NOT, reached: false });
  });

  it("selects only the fx-gate1 context's state and its creator's type and login, on one commit by sha", () => {
    expect(DOC).toMatch(/^query Gate1Status\(/);
    expect(DOC).toContain("object(oid: $sha)");
    expect(DOC).toContain('status { context(name: "fx-gate1") { state creator { __typename login } } }');
    expect([...DOC.matchAll(/\.\.\. on (\w+)/g)].map((m) => m[1])).toEqual(["Commit"]);
    for (const word of ["contexts", "description", "targetUrl", "url", "avatarUrl", "email", "checkSuite", "CheckRun", "output", "text", "message", "body", "blob", "tree", "patch", "diff", "contents", "author", "committer"]) {
      expect(DOC, `selects ${word}`).not.toMatch(new RegExp(`\\b${word}\\b`, "i"));
    }
    expect(Object.keys(GATE1_STATUS_DOCUMENTS)).toEqual(["Gate1Status"]);
    expect(Object.isFrozen(GATE1_STATUS_DOCUMENTS)).toBe(true);
  });
});

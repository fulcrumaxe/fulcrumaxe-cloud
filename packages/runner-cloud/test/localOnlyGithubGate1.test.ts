import { describe, expect, it } from "vitest";
import {
  FX_GATE1_DESCRIPTIONS,
  GATE1_ATTEST_DOCUMENTS,
  LocalOnlyGithubError,
  localOnlyGithub,
  localOnlyViolation,
  type GithubClient,
  type GithubRequest,
} from "../src/localOnlyGithub.js";

/**
 * D#6 CLOUD-POSTS-FX-GATE1 PR 0 (TL ruling 11-07): A14 to A16 and A7's `fx-gate1` shape hold only on a client built with `gate1Attest` (the review round's
 * client for a paired item's code repository, which also leaves out A10). The rest of the allowlist is pinned in localOnlyGithub.test.ts.
 */
const R = "/repos/acme/app";
const NOT = "not_allowlisted";
const SHA = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";
const G = GATE1_ATTEST_DOCUMENTS;
const graphql = (query: string, variables: unknown): GithubRequest => ({ method: "POST", path: "/graphql", body: { query, variables } });
const labelPath = `${R}/issues/12/labels`;
const addLabel: GithubRequest = { method: "POST", path: labelPath, body: { labels: ["ci:full"] } };
const runsVars = { owner: "acme", name: "app", sha: SHA };
const eventsVars = { owner: "acme", name: "app", number: 12 };
const statusPath = `${R}/statuses/${SHA}`;
const review = { state: "success", context: "fulcrumaxe/review", description: "Local review: every required reviewer passed" };
const gate1 = (state: string, description: string): GithubRequest => ({ method: "POST", path: statusPath, body: { state, context: "fx-gate1", description } });
const FAILURES = Object.values(FX_GATE1_DESCRIPTIONS.failure);
const SQUASH: GithubRequest = { method: "PUT", path: `${R}/pulls/12/merge`, body: { sha: SHA, merge_method: "squash" } };
/** The client the review round opens for a paired item's code repository. */
const ATTESTER = { exclude: ["A10"], gate1Attest: true } as const;

function recorder(): { client: GithubClient; seen: GithubRequest[] } {
  const seen: GithubRequest[] = [];
  return { seen, client: { request: async (req) => (seen.push(req), { status: 200, body: {} }) } };
}

async function through(req: GithubRequest, options: Parameters<typeof localOnlyGithub>[1] = ATTESTER): Promise<{ result: string; reached: boolean }> {
  const { client, seen } = recorder();
  const result = await localOnlyGithub(client, options).request(req).then(
    () => "sent",
    (e: unknown) => (e instanceof LocalOnlyGithubError ? e.rule : `other:${String(e)}`),
  );
  return { result, reached: seen.length > 0 };
}

const OPT_IN: Array<[string, GithubRequest]> = [
  ["A14 adding ci:full", addLabel],
  ["A15 Gate1CheckRuns", graphql(G.Gate1CheckRuns, runsVars)],
  ["A15 Gate1CheckRuns, next page", graphql(G.Gate1CheckRuns, { ...runsVars, cursor: "Y3Vyc29yOnYyOpHOAAAB" })],
  ["A15 Gate1CheckRuns, a sha-256 commit", graphql(G.Gate1CheckRuns, { ...runsVars, sha: "b".repeat(64) })],
  ["A16 Gate1LabelEvents", graphql(G.Gate1LabelEvents, eventsVars)],
  ["A16 Gate1LabelEvents, a null cursor", graphql(G.Gate1LabelEvents, { ...eventsVars, cursor: null })],
  ["A7 fx-gate1 success", gate1("success", FX_GATE1_DESCRIPTIONS.success)],
  ...FAILURES.map((d): [string, GithubRequest] => [`A7 fx-gate1 failure "${d}"`, gate1("failure", d)]),
];

describe("gate1Attest: the opt-in entries", () => {
  for (const [name, req] of OPT_IN) {
    it(`the attester client sends ${name}; the default client and the plain code-repository client refuse it before GitHub`, async () => {
      expect(await through(req)).toEqual({ result: "sent", reached: true });
      expect(localOnlyViolation(req, ["A10"], { gate1Attest: true })).toBeNull();
      expect(await through(req, {})).toEqual({ result: NOT, reached: false });
      expect(await through(req, { exclude: ["A10"] })).toEqual({ result: NOT, reached: false });
      expect(await through(req, { exclude: ["A10"], gate1Attest: false })).toEqual({ result: NOT, reached: false });
      expect(localOnlyViolation(req)).toBe(NOT);
    });
  }

  it("the attester client still sends the review status and still refuses the squash call (A10 stays out)", async () => {
    expect(await through({ method: "POST", path: statusPath, body: review })).toEqual({ result: "sent", reached: true });
    expect(await through(SQUASH)).toEqual({ result: NOT, reached: false });
  });

  it("an entry can still be excluded from the attester client one by one", async () => {
    expect((await through(addLabel, { exclude: ["A14"], gate1Attest: true })).result).toBe(NOT);
    expect((await through(graphql(G.Gate1CheckRuns, runsVars), { exclude: ["A15"], gate1Attest: true })).result).toBe(NOT);
    expect((await through(graphql(G.Gate1LabelEvents, eventsVars), { exclude: ["A16"], gate1Attest: true })).result).toBe(NOT);
    expect((await through(gate1("success", FX_GATE1_DESCRIPTIONS.success), { exclude: ["A7"], gate1Attest: true })).result).toBe(NOT);
  });
});

describe("A14: only ci:full, only added", () => {
  it("refuses another label, an extra label, a wrong shape and an extra key", async () => {
    const bodies: unknown[] = [
      undefined, null, [], ["ci:full"], "ci:full", { labels: [] }, { labels: ["ci:full", "ready"] }, { labels: ["ready", "ci:full"] }, { labels: ["ci:full", "ci:full"] },
      { labels: ["CI:full"] }, { labels: ["ci:full "] }, { labels: ["fx-gate1"] }, { labels: "ci:full" }, { labels: [{ name: "ci:full" }] }, { labels: ["ci:full"], extra: 1 }, { name: "ci:full" },
    ];
    for (const body of bodies) expect(await through({ method: "POST", path: labelPath, body }), JSON.stringify(body)).toEqual({ result: NOT, reached: false });
  });

  it("refuses another method, another path and a query", async () => {
    const body = { labels: ["ci:full"] };
    const cases: GithubRequest[] = [
      { method: "PUT", path: labelPath, body },
      { method: "PATCH", path: labelPath, body },
      { method: "DELETE", path: `${labelPath}/ci%3Afull` },
      { method: "GET", path: labelPath },
      { method: "POST", path: `${R}/issues/abc/labels`, body },
      { method: "POST", path: `${labelPath}/extra`, body },
      { method: "POST", path: `${R}/labels`, body },
      { method: "POST", path: `${R}/issues/12/comments`, body },
      { method: "POST", path: `${R}/pulls/12/labels`, body },
      { method: "POST", path: `${R}/issues/12/../12/labels`, body },
      { method: "POST", path: labelPath, query: { x: "1" }, body },
      { method: "POST", path: `${labelPath}?x=1`, body },
    ];
    for (const req of cases) expect(await through(req), `${req.method} ${req.path}`).toEqual({ result: NOT, reached: false });
  });
});

describe("A7 on the attester client: fx-gate1 with a fixed description, and nothing wider", () => {
  it("refuses a free description, a mismatched state and text, another context and an extra key", async () => {
    const bad: unknown[] = [
      { state: "success", context: "fx-gate1", description: "Gate 1: full public CI 123 green (cloud)" },
      { state: "success", context: "fx-gate1", description: FAILURES[0] },
      { state: "failure", context: "fx-gate1", description: FX_GATE1_DESCRIPTIONS.success },
      { state: "failure", context: "fx-gate1", description: "anything" },
      { state: "pending", context: "fx-gate1", description: FX_GATE1_DESCRIPTIONS.success },
      { state: "error", context: "fx-gate1", description: FAILURES[0] },
      { state: "success", context: "FX-gate1", description: FX_GATE1_DESCRIPTIONS.success },
      { state: "success", context: "fx-gate1 ", description: FX_GATE1_DESCRIPTIONS.success },
      { state: "success", context: "check", description: FX_GATE1_DESCRIPTIONS.success },
      { state: "success", context: "ci/other", description: "d" },
      { state: "success", context: "fx-gate1", description: FX_GATE1_DESCRIPTIONS.success, target_url: "https://example.com" },
      { state: "success", context: "fx-gate1" },
    ];
    for (const body of bad) expect(await through({ method: "POST", path: statusPath, body }), JSON.stringify(body)).toEqual({ result: NOT, reached: false });
  });

  it("keeps A7's path rules: a full commit sha, POST only, no query", async () => {
    const body = { state: "success", context: "fx-gate1", description: FX_GATE1_DESCRIPTIONS.success };
    for (const req of [
      { method: "POST", path: `${R}/statuses/main`, body },
      { method: "POST", path: `${R}/statuses/${SHA}0`, body },
      { method: "POST", path: `${statusPath}/extra`, body },
      { method: "PUT", path: statusPath, body },
      { method: "POST", path: statusPath, query: { x: "1" }, body },
    ] as GithubRequest[]) expect(await through(req), `${req.method} ${req.path}`).toEqual({ result: NOT, reached: false });
  });
});

describe("A15 and A16: two fixed documents, by name, with their own variables", () => {
  it("refuse variables outside their schema, the other document's variables and an altered document", async () => {
    const cases: GithubRequest[] = [
      graphql(G.Gate1CheckRuns, { ...runsVars, sha: "main" }),
      graphql(G.Gate1CheckRuns, { ...runsVars, sha: SHA.toUpperCase() }),
      graphql(G.Gate1CheckRuns, { ...runsVars, sha: SHA.slice(1) }),
      graphql(G.Gate1CheckRuns, { ...runsVars, extra: 1 }),
      graphql(G.Gate1CheckRuns, { owner: "acme", name: "app" }),
      graphql(G.Gate1CheckRuns, { ...runsVars, owner: ".." }),
      graphql(G.Gate1CheckRuns, { ...runsVars, cursor: "a b" }),
      graphql(G.Gate1CheckRuns, eventsVars),
      graphql(G.Gate1LabelEvents, { ...eventsVars, number: "12" }),
      graphql(G.Gate1LabelEvents, { ...eventsVars, number: 0 }),
      graphql(G.Gate1LabelEvents, { ...eventsVars, extra: 1 }),
      graphql(G.Gate1LabelEvents, runsVars),
      graphql(`${G.Gate1CheckRuns} `, runsVars),
      graphql(G.Gate1CheckRuns.replace("startedAt", "startedAt output { text summary }"), runsVars),
      graphql(G.Gate1CheckRuns.replace("... on CheckRun {", "... on StatusContext { context state description }\n              ... on CheckRun {"), runsVars),
      graphql(G.Gate1LabelEvents.replace("... on LabeledEvent { createdAt", "... on LabeledEvent { actor { login } createdAt"), eventsVars),
      graphql(G.Gate1LabelEvents.replace("itemTypes: [LABELED_EVENT, UNLABELED_EVENT]", "itemTypes: [ISSUE_COMMENT]"), eventsVars),
      { method: "POST", path: "/graphql", body: { query: G.Gate1CheckRuns, variables: runsVars, operationName: "Gate1CheckRuns" } },
      { method: "GET", path: "/graphql", body: { query: G.Gate1CheckRuns, variables: runsVars } },
    ];
    for (const req of cases) expect(await through(req), JSON.stringify(req.body).slice(0, 120)).toEqual({ result: NOT, reached: false });
  });

  it("A1 never takes them: with A15 and A16 excluded, the documents are refused on the attester client", () => {
    expect(localOnlyViolation(graphql(G.Gate1CheckRuns, runsVars), ["A15"], { gate1Attest: true })).toBe(NOT);
    expect(localOnlyViolation(graphql(G.Gate1LabelEvents, eventsVars), ["A16"], { gate1Attest: true })).toBe(NOT);
  });

  it("graphql(op) runs them by name on the attester client, and refuses them on every other client before anything is sent", async () => {
    const att = recorder();
    const gh = localOnlyGithub(att.client, ATTESTER);
    await gh.graphql("Gate1CheckRuns", runsVars);
    await gh.graphql("Gate1LabelEvents", eventsVars);
    expect(att.seen.map((r) => (r.body as { query: string }).query)).toEqual([G.Gate1CheckRuns, G.Gate1LabelEvents]);
    const plain = recorder();
    await expect(localOnlyGithub(plain.client).graphql("Gate1CheckRuns", runsVars)).rejects.toMatchObject({ rule: NOT });
    await expect(localOnlyGithub(plain.client, { exclude: ["A10"] }).graphql("Gate1LabelEvents", eventsVars)).rejects.toMatchObject({ rule: NOT });
    expect(plain.seen).toEqual([]);
  });
});

describe("what the attester must never reach, even on its own client", () => {
  it("refuses the REST check-run, check-suite, status, log and issue-event reads", async () => {
    const cases: GithubRequest[] = [
      { method: "GET", path: `${R}/commits/${SHA}/check-runs` },
      { method: "GET", path: `${R}/commits/${SHA}/check-runs`, query: { per_page: 100 } },
      { method: "GET", path: `${R}/commits/${SHA}/check-runs?filter=latest` },
      { method: "GET", path: `${R}/commits/${SHA}/check-suites` },
      { method: "GET", path: `${R}/commits/${SHA}/status` },
      { method: "GET", path: `${R}/commits/${SHA}/statuses` },
      { method: "GET", path: `${R}/check-runs/12` },
      { method: "GET", path: `${R}/check-runs/12/annotations` },
      { method: "GET", path: `${R}/actions/runs/12/logs` },
      { method: "GET", path: `${R}/issues/12/events` },
      { method: "GET", path: `${R}/issues/12/timeline` },
      { method: "GET", path: `${R}/issues/12/labels` },
      { method: "GET", path: `${R}/issues/12` },
      { method: "GET", path: `${R}/issues/events/1` },
    ];
    for (const req of cases) expect(await through(req), `${req.method} ${req.path}`).toEqual({ result: NOT, reached: false });
  });

  it("Gate1CheckRuns selects name, status, conclusion, startedAt and the app id on one commit by sha, and no output text and no status context", () => {
    const doc = G.Gate1CheckRuns;
    expect(doc).toMatch(/^query Gate1CheckRuns\(/);
    expect(doc).toContain("object(oid: $sha)");
    expect([...doc.matchAll(/\.\.\. on (\w+)/g)].map((m) => m[1])).toEqual(["Commit", "CheckRun"]);
    expect(doc).toContain("... on CheckRun { name status conclusion startedAt checkSuite { app { databaseId } } }");
    for (const word of ["output", "summary", "text", "title", "annotations", "details", "detailsUrl", "url", "permalink", "description", "context", "state", "login", "author", "message", "body", "blob", "tree", "patch", "diff", "contents", "workflowRun", "StatusContext"]) {
      expect(doc, `selects ${word}`).not.toMatch(new RegExp(`\\b${word}\\b`, "i"));
    }
  });

  it("Gate1LabelEvents selects labeled and unlabeled events with the label's name and createdAt, and no actor or text", () => {
    const doc = G.Gate1LabelEvents;
    expect(doc).toMatch(/^query Gate1LabelEvents\(/);
    expect(doc).toContain("itemTypes: [LABELED_EVENT, UNLABELED_EVENT]");
    expect([...doc.matchAll(/\.\.\. on (\w+)/g)].map((m) => m[1])).toEqual(["LabeledEvent", "UnlabeledEvent"]);
    expect(doc).toContain("... on LabeledEvent { createdAt label { name } }");
    expect(doc).toContain("... on UnlabeledEvent { createdAt label { name } }");
    for (const word of ["actor", "login", "author", "body", "bodyText", "text", "message", "description", "url", "files", "commits", "comments", "object", "blob", "patch", "diff", "contents", "title"]) {
      expect(doc, `selects ${word}`).not.toMatch(new RegExp(`\\b${word}\\b`, "i"));
    }
    expect(Object.keys(G)).toEqual(["Gate1CheckRuns", "Gate1LabelEvents"]);
    expect(Object.isFrozen(G)).toBe(true);
    expect(Object.isFrozen(FX_GATE1_DESCRIPTIONS) && Object.isFrozen(FX_GATE1_DESCRIPTIONS.failure)).toBe(true);
  });
});

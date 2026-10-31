import { beforeEach, describe, expect, it } from "vitest";
import { clearMergeQueueModeCache, createGitHubMergeGatePort, MERGE_QUEUE_MODE_CACHE_MAX, MERGE_QUEUE_MODE_TTL_MS, type GitHubHttp, type GitHubHttpRequest } from "../../src/build/githubMergePort.js";
import {
  ENABLE_AUTO_MERGE_DOCUMENT,
  ENQUEUE_PULL_REQUEST_DOCUMENT,
  MERGE_QUEUE_READ_DOCUMENT,
  pinnedMergeGateBody,
} from "../../../github/src/mergeGateGraphql.js";

/**
 * D#694 B5: the port's queue read and enqueue against a strict fake of GitHub's wire format. The fake refuses a `POST /graphql` exactly as the hosted
 * `merge_gate` client does (it asks the same `pinnedMergeGateBody` the client asks), so these tests also prove the three documents the port sends are
 * the pinned ones, and that a refusal reaches the port as a thrown error, never as an answer.
 */
const HEAD = "a".repeat(40);
const NEW = "c".repeat(40);
const PR = { repoId: "repo-1", prNumber: 7 };
const DOCS = { read: MERGE_QUEUE_READ_DOCUMENT, enqueue: ENQUEUE_PULL_REQUEST_DOCUMENT, autoMerge: ENABLE_AUTO_MERGE_DOCUMENT };

interface Fake {
  /** `Repository.mergeQueue` answer for the read document. */
  queue: null | { id: string };
  rules: unknown[];
  graphqlStatus: number;
  rulesStatus: number;
  graphqlErrors: unknown[] | undefined;
  nodeId: unknown;
  /** Answers per mutation document: a GraphQL `errors` list or data. */
  enqueue: { errors?: unknown[]; data?: unknown };
  autoMerge: { errors?: unknown[]; data?: unknown };
  owner: string;
  name: string;
  requests: GitHubHttpRequest[];
  /** Requests that reached "GitHub" (a refused one never does). */
  reached: GitHubHttpRequest[];
}

const fresh = (): Fake => ({
  queue: { id: "MQ_kwDOqueue" },
  rules: [{ type: "merge_queue", enforcement: "active" }],
  graphqlStatus: 200,
  rulesStatus: 200,
  graphqlErrors: undefined,
  nodeId: "PR_kwDOabc123",
  enqueue: { data: { enqueuePullRequest: { mergeQueueEntry: { id: "MQE_kwDOentry1", position: 3 } } } },
  autoMerge: { data: { enablePullRequestAutoMerge: { pullRequest: { id: "PR_kwDOabc123" } } } },
  owner: "acme",
  name: "widgets",
  requests: [],
  reached: [],
});

function httpFor(f: Fake): GitHubHttp {
  return {
    async request(req) {
      f.requests.push(req);
      if (req.method === "POST" && req.path === "/graphql") {
        // The hosted client's rule, by the same function: anything but a pinned document with well-formed variables is refused before a request is made.
        if (pinnedMergeGateBody(req.body, { owner: f.owner, name: f.name }) === undefined) throw new Error("path_refused");
        f.reached.push(req);
        const query = (req.body as { query: string }).query;
        if (f.graphqlStatus !== 200) return { status: f.graphqlStatus, body: { message: "Server Error" } };
        if (f.graphqlErrors !== undefined) return { status: 200, body: { errors: f.graphqlErrors } };
        if (query === DOCS.read) return { status: 200, body: { data: { repository: { mergeQueue: f.queue } } } };
        if (query === DOCS.enqueue) return { status: 200, body: f.enqueue };
        return { status: 200, body: f.autoMerge };
      }
      f.reached.push(req);
      if (req.method === "GET" && /\/pulls\/7$/.test(req.path)) {
        return { status: 200, body: { node_id: f.nodeId, state: "open", merged: false, draft: false, mergeable: true, mergeable_state: "clean", head: { sha: HEAD }, base: { ref: "main", repo: { default_branch: "main" } } } };
      }
      if (req.method === "GET" && req.path.includes("/rules/branches/")) {
        return f.rulesStatus === 200 ? { status: 200, body: f.rules } : { status: f.rulesStatus, body: { message: "Server Error" } };
      }
      return { status: 404, body: { message: "Not Found" } };
    },
  };
}

function portFor(f: Fake, over: { queueDocuments?: typeof DOCS | undefined; now?: () => number; local?: boolean } = {}) {
  return createGitHubMergeGatePort({
    http: httpFor(f),
    resolveRepo: async () => ({ owner: "acme", name: "widgets" }),
    markReadyForHumanMerge: async () => undefined,
    ...("queueDocuments" in over ? (over.queueDocuments === undefined ? {} : { queueDocuments: over.queueDocuments }) : { queueDocuments: DOCS }),
    ...(over.now !== undefined ? { now: over.now } : {}),
  });
}

const reads = (f: Fake) => f.reached.length;

beforeEach(() => clearMergeQueueModeCache());

describe("getMergeQueueMode", () => {
  it("queue on: the GraphQL read and the branch rules agree", async () => {
    const f = fresh();
    expect(await portFor(f).getMergeQueueMode!(PR, "main")).toEqual({ mode: "queue", source: "graphql_and_rules" });
    const gql = f.reached.find((r) => r.path === "/graphql")!;
    expect(gql.body).toEqual({ query: MERGE_QUEUE_READ_DOCUMENT, variables: { owner: "acme", name: "widgets", branch: "main" } });
  });

  it("queue off: both say there is none", async () => {
    const f = fresh();
    f.queue = null;
    f.rules = [{ type: "pull_request" }];
    expect(await portFor(f).getMergeQueueMode!(PR, "main")).toEqual({ mode: "direct", source: "graphql_and_rules" });
  });

  it("a rule of a queue that is not active does not count as a queue", async () => {
    const f = fresh();
    f.queue = null;
    f.rules = [{ type: "merge_queue", enforcement: "evaluate" }];
    expect((await portFor(f).getMergeQueueMode!(PR, "main")).mode).toBe("direct");
  });

  it.each([
    ["GraphQL says a queue, the rules do not", { queue: { id: "MQ_x" }, rules: [] }],
    ["the rules say a queue, GraphQL does not", { queue: null, rules: [{ type: "merge_queue" }] }],
  ])("%s: unknown, not cached", async (_n, over) => {
    const f = Object.assign(fresh(), over);
    const port = portFor(f);
    expect(await port.getMergeQueueMode!(PR, "main")).toMatchObject({ mode: "unknown" });
    const before = reads(f);
    await port.getMergeQueueMode!(PR, "main");
    expect(reads(f)).toBeGreaterThan(before);
  });

  it.each([
    ["GraphQL answers 500", (f: Fake) => void (f.graphqlStatus = 500)],
    ["GraphQL answers errors", (f: Fake) => void (f.graphqlErrors = [{ message: "boom" }])],
    ["the rules answer 500", (f: Fake) => void (f.rulesStatus = 500)],
  ])("a failed read (%s) is unknown, never direct", async (_name, breakIt) => {
    const f = fresh();
    breakIt(f);
    expect(await portFor(f).getMergeQueueMode!(PR, "main")).toMatchObject({ mode: "unknown" });
  });

  it("the hosted client refusing the document is a failed read: unknown, and nothing reached GitHub", async () => {
    const f = fresh();
    expect(await portFor(f, { queueDocuments: { ...DOCS, read: `${DOCS.read} ` } }).getMergeQueueMode!(PR, "main")).toMatchObject({ mode: "unknown", source: "read_failed" });
    expect(f.reached).toEqual([]);
  });

  it("makes at most two reads per refresh, and none inside the five minutes", async () => {
    const f = fresh();
    let clock = 1_000_000;
    const port = portFor(f, { now: () => clock });
    await port.getMergeQueueMode!(PR, "main");
    expect(f.reached.map((r) => (r.path === "/graphql" ? "graphql" : "rules"))).toEqual(["graphql", "rules"]);
    f.requests.length = 0;
    f.reached.length = 0;
    clock += MERGE_QUEUE_MODE_TTL_MS - 1;
    expect(await port.getMergeQueueMode!(PR, "main")).toMatchObject({ mode: "queue" });
    expect(f.requests).toEqual([]);
    // Past the TTL the answer is not used: GitHub is asked again, and a changed answer shows.
    clock += 1;
    f.queue = null;
    f.rules = [];
    expect(await port.getMergeQueueMode!(PR, "main")).toMatchObject({ mode: "direct" });
    expect(f.reached).toHaveLength(2);
  });

  it("the cache is per repository: two repositories with the same base branch name each read for themselves and get their own mode; the same repository spelled in another case shares one entry", async () => {
    const withQueue = fresh();
    const without = fresh();
    without.owner = "other";
    without.name = "gadgets";
    without.queue = null;
    without.rules = [];
    const byRepo = new Map([
      ["repo-a", { owner: "acme", name: "widgets", fake: withQueue }],
      ["repo-b", { owner: "other", name: "gadgets", fake: without }],
      ["repo-c", { owner: "ACME", name: "Widgets", fake: withQueue }],
    ]);
    // One process-wide cache, one http that routes by the repository the request names.
    const http: GitHubHttp = {
      request: async (req) => {
        const vars = (req.body as { variables?: { owner?: string; name?: string } } | undefined)?.variables;
        const owner = vars?.owner ?? /^\/repos\/([^/]+)\//.exec(req.path)?.[1];
        const target = [...byRepo.values()].find((r) => r.owner === owner)!.fake;
        return httpFor(target).request(req);
      },
    };
    const port = createGitHubMergeGatePort({ http, resolveRepo: async (id) => byRepo.get(id)!, markReadyForHumanMerge: async () => undefined, queueDocuments: DOCS });
    expect(await port.getMergeQueueMode!({ repoId: "repo-a", prNumber: 7 }, "main")).toMatchObject({ mode: "queue" });
    expect(await port.getMergeQueueMode!({ repoId: "repo-b", prNumber: 7 }, "main")).toMatchObject({ mode: "direct" });
    expect(reads(without)).toBe(2);
    // Each answer is its own, and a repeat is served from the cache for the right repository.
    expect(await port.getMergeQueueMode!({ repoId: "repo-a", prNumber: 7 }, "main")).toMatchObject({ mode: "queue" });
    expect(await port.getMergeQueueMode!({ repoId: "repo-b", prNumber: 7 }, "main")).toMatchObject({ mode: "direct" });
    expect(reads(withQueue)).toBe(2);
    expect(reads(without)).toBe(2);
    // The same repository named in another case is the same cache entry: no new read.
    expect(await port.getMergeQueueMode!({ repoId: "repo-c", prNumber: 7 }, "main")).toMatchObject({ mode: "queue" });
    expect(reads(withQueue)).toBe(2);
  });

  it("keeps one answer per repository and base branch, and drops the oldest past the cap", async () => {
    const f = fresh();
    const port = portFor(f);
    await port.getMergeQueueMode!(PR, "main");
    await port.getMergeQueueMode!(PR, "release");
    expect(f.reached.filter((r) => r.path === "/graphql")).toHaveLength(2);
    for (let i = 0; i < MERGE_QUEUE_MODE_CACHE_MAX; i++) await port.getMergeQueueMode!(PR, `b${i}`);
    f.reached.length = 0;
    await port.getMergeQueueMode!(PR, "main"); // the oldest went out
    expect(f.reached.length).toBe(2);
    f.reached.length = 0;
    await port.getMergeQueueMode!(PR, `b${MERGE_QUEUE_MODE_CACHE_MAX - 1}`); // the newest stays
    expect(f.reached).toEqual([]);
  });

  it("a port with no documents is direct (today's behaviour); a runner_local port is direct and reads nothing", async () => {
    const f = fresh();
    expect(await portFor(f, { queueDocuments: undefined }).getMergeQueueMode!(PR, "main")).toMatchObject({ mode: "direct", source: "queue_not_configured" });
    expect(f.requests).toEqual([]);
    const local = createGitHubMergeGatePort({
      http: httpFor(f),
      resolveRepo: async () => ({ owner: "acme", name: "widgets" }),
      markReadyForHumanMerge: async () => undefined,
      queueDocuments: DOCS,
      local: { http: { ...httpFor(f), graphql: async () => ({ status: 200, body: {} }) }, recordedBranch: async () => "b" },
    });
    expect(await local.getMergeQueueMode!(PR, "main")).toMatchObject({ mode: "direct", source: "runner_local" });
    expect(f.requests).toEqual([]);
  });
});

describe("enqueuePullRequest", () => {
  it("sends the pinned mutation bound to the head and returns the entry GitHub made", async () => {
    const f = fresh();
    expect(await portFor(f).enqueuePullRequest!(PR, { expectedHeadOid: HEAD })).toEqual({ enqueued: true, via: "queue", entryId: "MQE_kwDOentry1", position: 3 });
    const gql = f.reached.filter((r) => r.path === "/graphql");
    expect(gql.map((r) => r.body)).toEqual([{ query: ENQUEUE_PULL_REQUEST_DOCUMENT, variables: { pullRequestId: "PR_kwDOabc123", expectedHeadOid: HEAD } }]);
  });

  it.each(["", "not-a-sha", "A".repeat(40), "a".repeat(39), ` ${HEAD}`])("a malformed head (%j) throws before any call", async (bad) => {
    const f = fresh();
    await expect(portFor(f).enqueuePullRequest!(PR, { expectedHeadOid: bad })).rejects.toThrow("malformed expected head");
    expect(f.requests).toEqual([]);
  });

  it("a pull request answered without a usable node id throws before the mutation", async () => {
    const f = fresh();
    f.nodeId = "has space";
    await expect(portFor(f).enqueuePullRequest!(PR, { expectedHeadOid: HEAD })).rejects.toThrow("malformed");
    expect(f.reached.some((r) => r.path === "/graphql")).toBe(false);
  });

  it("head moved: GitHub names the head, the answer is head_moved, and the cached queue answer for the branch is dropped", async () => {
    const f = fresh();
    const port = portFor(f);
    await port.getMergeQueueMode!(PR, "main");
    f.enqueue = { errors: [{ type: "UNPROCESSABLE", message: "Head branch was modified. Review and try the merge again." }] };
    expect(await port.enqueuePullRequest!(PR, { expectedHeadOid: NEW })).toEqual({ enqueued: false, reason: "head_moved" });
    f.reached.length = 0;
    await port.getMergeQueueMode!(PR, "main");
    expect(f.reached.filter((r) => r.path === "/graphql")).toHaveLength(1);
  });

  it("permission refused: auto-merge is tried with SQUASH, bound to the same head, and reported as auto_merge", async () => {
    const f = fresh();
    f.enqueue = { errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] };
    expect(await portFor(f).enqueuePullRequest!(PR, { expectedHeadOid: HEAD })).toEqual({ enqueued: true, via: "auto_merge", entryId: null, position: null });
    const bodies = f.reached.filter((r) => r.path === "/graphql").map((r) => r.body);
    expect(bodies[1]).toEqual({ query: ENABLE_AUTO_MERGE_DOCUMENT, variables: { pullRequestId: "PR_kwDOabc123", expectedHeadOid: HEAD, mergeMethod: "SQUASH" } });
  });

  it("permission refused twice: unavailable, and nothing else is tried", async () => {
    const f = fresh();
    f.enqueue = { errors: [{ message: "Resource not accessible by integration" }] };
    f.autoMerge = { errors: [{ message: "Resource not accessible by integration" }] };
    expect(await portFor(f).enqueuePullRequest!(PR, { expectedHeadOid: HEAD })).toEqual({ enqueued: false, reason: "unavailable" });
    expect(f.reached.filter((r) => r.path === "/graphql")).toHaveLength(2);
  });

  it("any other GraphQL error throws and does not fall back to auto-merge", async () => {
    const f = fresh();
    f.enqueue = { errors: [{ type: "UNPROCESSABLE", message: "Pull request is not mergeable" }] };
    await expect(portFor(f).enqueuePullRequest!(PR, { expectedHeadOid: HEAD })).rejects.toThrow("GraphQL error");
    expect(f.reached.filter((r) => r.path === "/graphql")).toHaveLength(1);
  });

  it("a malformed success (no entry id) throws; an HTTP 500 throws", async () => {
    const f = fresh();
    f.enqueue = { data: { enqueuePullRequest: { mergeQueueEntry: null } } };
    await expect(portFor(f).enqueuePullRequest!(PR, { expectedHeadOid: HEAD })).rejects.toThrow("malformed");
    const g = fresh();
    g.graphqlStatus = 500;
    await expect(portFor(g).enqueuePullRequest!(PR, { expectedHeadOid: HEAD })).rejects.toThrow("unexpected status 500");
  });

  it("the hosted client's refusal of a document is a throw, never an answer", async () => {
    const f = fresh();
    await expect(portFor(f, { queueDocuments: { ...DOCS, enqueue: `${DOCS.enqueue}\n` } }).enqueuePullRequest!(PR, { expectedHeadOid: HEAD })).rejects.toThrow("path_refused");
    expect(f.reached.some((r) => r.path === "/graphql")).toBe(false);
  });
});

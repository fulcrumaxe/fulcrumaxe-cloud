import { beforeEach, describe, expect, it } from "vitest";
import { clearMergeQueueModeCache, createGitHubMergeGatePort, MERGE_QUEUE_MODE_CACHE_MAX, MERGE_QUEUE_MODE_TTL_MS, type GitHubHttp, type GitHubHttpRequest } from "../../src/build/githubMergePort.js";
import {
  DEQUEUE_PULL_REQUEST_DOCUMENT,
  ENABLE_AUTO_MERGE_DOCUMENT,
  ENQUEUE_PULL_REQUEST_DOCUMENT,
  MERGE_QUEUE_ENTRY_DOCUMENT,
  MERGE_QUEUE_READ_DOCUMENT,
  MERGE_QUEUE_REMOVAL_DOCUMENT,
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
const DOCS = { read: MERGE_QUEUE_READ_DOCUMENT, enqueue: ENQUEUE_PULL_REQUEST_DOCUMENT, autoMerge: ENABLE_AUTO_MERGE_DOCUMENT, dequeue: DEQUEUE_PULL_REQUEST_DOCUMENT, entry: MERGE_QUEUE_ENTRY_DOCUMENT, removal: MERGE_QUEUE_REMOVAL_DOCUMENT };

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
  /** B6-1: the dequeue mutation's answer, and the entry read's `pullRequest` answer. */
  dequeue: { errors?: unknown[]; data?: unknown };
  pullRequest: unknown;
  /** B6-6: the removal read's `pullRequest` answer. */
  removalPr: unknown;
  /** The direct merge call's answer. */
  mergeAnswer: { status: number; body: unknown };
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
  dequeue: { data: { dequeuePullRequest: { mergeQueueEntry: { id: "MQE_kwDOentry1" } } } },
  pullRequest: { state: "OPEN", merged: false, headRefOid: HEAD, mergeQueueEntry: { id: "MQE_kwDOentry1", state: "AWAITING_CHECKS", position: 2 } },
  removalPr: { timelineItems: { nodes: [] } },
  mergeAnswer: { status: 200, body: { merged: true, sha: "f".repeat(40) } },
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
        if (query === DOCS.dequeue) return { status: 200, body: f.dequeue };
        if (query === DOCS.entry) return { status: 200, body: { data: { repository: { pullRequest: f.pullRequest } } } };
        if (query === DOCS.removal) return { status: 200, body: { data: { repository: { pullRequest: f.removalPr } } } };
        return { status: 200, body: f.autoMerge };
      }
      f.reached.push(req);
      if (req.method === "PUT" && /\/pulls\/7\/merge$/.test(req.path)) return f.mergeAnswer;
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

describe("dequeuePullRequest (B6-1)", () => {
  it("sends the pinned mutation with the pull request's node id and returns the entry the host removed", async () => {
    const f = fresh();
    expect(await portFor(f).dequeuePullRequest!(PR)).toEqual({ dequeued: true, entryId: "MQE_kwDOentry1" });
    expect(f.reached.filter((r) => r.path === "/graphql").map((r) => r.body)).toEqual([{ query: DEQUEUE_PULL_REQUEST_DOCUMENT, variables: { pullRequestId: "PR_kwDOabc123" } }]);
  });

  it("a pull request that is not in the queue is not_queued, whether the host says so in words or answers a null entry", async () => {
    const words = fresh();
    words.dequeue = { errors: [{ type: "UNPROCESSABLE", message: "Pull request is not in the merge queue" }] };
    expect(await portFor(words).dequeuePullRequest!(PR)).toEqual({ dequeued: false, reason: "not_queued" });
    const empty = fresh();
    empty.dequeue = { data: { dequeuePullRequest: { mergeQueueEntry: null } } };
    expect(await portFor(empty).dequeuePullRequest!(PR)).toEqual({ dequeued: false, reason: "not_queued" });
  });

  it("a permission refusal is unavailable, and nothing else is tried (no auto-merge fallback)", async () => {
    const f = fresh();
    f.dequeue = { errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] };
    expect(await portFor(f).dequeuePullRequest!(PR)).toEqual({ dequeued: false, reason: "unavailable" });
    expect(f.reached.filter((r) => r.path === "/graphql")).toHaveLength(1);
  });

  it.each([
    ["any other GraphQL error", (f: Fake) => void (f.dequeue = { errors: [{ type: "UNPROCESSABLE", message: "Something else broke" }] }), "GraphQL error"],
    ["a mix of not-in-queue and another error", (f: Fake) => void (f.dequeue = { errors: [{ message: "not in the merge queue" }, { message: "boom" }] }), "GraphQL error"],
    ["an HTTP 500", (f: Fake) => void (f.graphqlStatus = 500), "unexpected status 500"],
    ["an entry without a usable id", (f: Fake) => void (f.dequeue = { data: { dequeuePullRequest: { mergeQueueEntry: { id: "has space" } } } }), "malformed"],
    ["a pull request without a usable node id", (f: Fake) => void (f.nodeId = "has space"), "malformed"],
  ])("%s throws, never an answer", async (_n, breakIt, message) => {
    const f = fresh();
    breakIt(f);
    await expect(portFor(f).dequeuePullRequest!(PR)).rejects.toThrow(message);
  });

  it("the hosted client's refusal of the document is a throw and nothing reaches the host; no documents or a runner_local port throw before any call", async () => {
    const f = fresh();
    await expect(portFor(f, { queueDocuments: { ...DOCS, dequeue: `${DOCS.dequeue} ` } }).dequeuePullRequest!(PR)).rejects.toThrow("path_refused");
    expect(f.reached.some((r) => r.path === "/graphql")).toBe(false);
    await expect(portFor(f, { queueDocuments: undefined }).dequeuePullRequest!(PR)).rejects.toThrow("no queue documents");
    const local = createGitHubMergeGatePort({ http: httpFor(f), resolveRepo: async () => ({ owner: "acme", name: "widgets" }), markReadyForHumanMerge: async () => undefined, queueDocuments: DOCS, local: { http: { ...httpFor(f), graphql: async () => ({ status: 200, body: {} }) }, recordedBranch: async () => "b" } });
    await expect(local.dequeuePullRequest!(PR)).rejects.toThrow("allowlist");
    expect(f.reached.filter((r) => r.path === "/graphql")).toEqual([]);
  });
});

describe("getQueueEntry (B6-1)", () => {
  it("reads the pull request by number inside the repository and maps the entry's state and position", async () => {
    const f = fresh();
    expect(await portFor(f).getQueueEntry!(PR)).toEqual({ state: "open", merged: false, headSha: HEAD, entry: { id: "MQE_kwDOentry1", state: "awaiting_checks", position: 2 } });
    expect(f.reached.filter((r) => r.path === "/graphql").map((r) => r.body)).toEqual([{ query: MERGE_QUEUE_ENTRY_DOCUMENT, variables: { owner: "acme", name: "widgets", number: 7 } }]);
  });

  it.each(["AWAITING_CHECKS", "LOCKED", "MERGEABLE", "QUEUED", "UNMERGEABLE"])("the entry state %s is read as its lower-case name", async (state) => {
    const f = fresh();
    f.pullRequest = { state: "OPEN", merged: false, headRefOid: HEAD, mergeQueueEntry: { id: "MQE_kwDOentry1", state, position: null } };
    expect((await portFor(f).getQueueEntry!(PR)).entry).toEqual({ id: "MQE_kwDOentry1", state: state.toLowerCase(), position: null });
  });

  it("not queued is a null entry on an open pull request; merged and closed are both closed, told apart by the flag", async () => {
    const f = fresh();
    f.pullRequest = { state: "OPEN", merged: false, headRefOid: NEW, mergeQueueEntry: null };
    expect(await portFor(f).getQueueEntry!(PR)).toEqual({ state: "open", merged: false, headSha: NEW, entry: null });
    f.pullRequest = { state: "MERGED", merged: true, headRefOid: NEW, mergeQueueEntry: null };
    expect(await portFor(f).getQueueEntry!(PR)).toEqual({ state: "closed", merged: true, headSha: NEW, entry: null });
    f.pullRequest = { state: "CLOSED", merged: false, headRefOid: NEW, mergeQueueEntry: null };
    expect(await portFor(f).getQueueEntry!(PR)).toEqual({ state: "closed", merged: false, headSha: NEW, entry: null });
  });

  it.each([
    ["no pull request", null],
    ["a state the host does not define", { state: "DRAFT", merged: false, headRefOid: HEAD, mergeQueueEntry: null }],
    ["merged not a boolean", { state: "OPEN", merged: "no", headRefOid: HEAD, mergeQueueEntry: null }],
    ["a malformed head", { state: "OPEN", merged: false, headRefOid: "main", mergeQueueEntry: null }],
    ["an entry state the host does not define", { state: "OPEN", merged: false, headRefOid: HEAD, mergeQueueEntry: { id: "MQE_x", state: "PAUSED", position: 1 } }],
    ["an entry without a usable id", { state: "OPEN", merged: false, headRefOid: HEAD, mergeQueueEntry: { id: "has space", state: "QUEUED", position: 1 } }],
    ["a fractional position", { state: "OPEN", merged: false, headRefOid: HEAD, mergeQueueEntry: { id: "MQE_x", state: "QUEUED", position: 1.5 } }],
  ])("a malformed answer (%s) throws, never a reading", async (_n, pullRequest) => {
    const f = fresh();
    f.pullRequest = pullRequest;
    await expect(portFor(f).getQueueEntry!(PR)).rejects.toThrow("malformed");
  });

  it("GraphQL errors and an HTTP 500 throw", async () => {
    const e = fresh();
    e.graphqlErrors = [{ message: "boom" }];
    await expect(portFor(e).getQueueEntry!(PR)).rejects.toThrow("GraphQL error");
    const g = fresh();
    g.graphqlStatus = 500;
    await expect(portFor(g).getQueueEntry!(PR)).rejects.toThrow("unexpected status 500");
  });

  it("a refused document, a bad PR number, no documents and a runner_local port throw before any answer", async () => {
    const f = fresh();
    await expect(portFor(f, { queueDocuments: { ...DOCS, entry: `${DOCS.entry}\n` } }).getQueueEntry!(PR)).rejects.toThrow("path_refused");
    await expect(portFor(f).getQueueEntry!({ repoId: "repo-1", prNumber: 0 })).rejects.toThrow("invalid PR number");
    await expect(portFor(f, { queueDocuments: undefined }).getQueueEntry!(PR)).rejects.toThrow("no queue documents");
    expect(f.reached).toEqual([]);
    const local = createGitHubMergeGatePort({ http: httpFor(f), resolveRepo: async () => ({ owner: "acme", name: "widgets" }), markReadyForHumanMerge: async () => undefined, queueDocuments: DOCS, local: { http: { ...httpFor(f), graphql: async () => ({ status: 200, body: {} }) }, recordedBranch: async () => "b" } });
    await expect(local.getQueueEntry!(PR)).rejects.toThrow("allowlist");
    expect(f.reached).toEqual([]);
  });
});

describe("a direct-merge refusal that names the queue evicts the stale direct answer (B6-DIRECT-CACHE-EVICT)", () => {
  const warm = async (f: Fake) => {
    f.queue = null;
    f.rules = [];
    const port = portFor(f);
    expect(await port.getMergeQueueMode!(PR, "main")).toMatchObject({ mode: "direct" });
    expect(await port.getMergeQueueMode!(PR, "release")).toMatchObject({ mode: "direct" });
    // Served from the cache: nothing new reaches the host.
    const before = reads(f);
    await port.getMergeQueueMode!(PR, "main");
    expect(reads(f)).toBe(before);
    return port;
  };
  const queueRefusal = { status: 405, body: { message: "Repository rule violations found\n\nChanges must be made through the merge queue.\n" } };

  it("the next mode read asks the host again (every base branch of the repository), and now sees the queue", async () => {
    const f = fresh();
    const port = await warm(f);
    f.queue = { id: "MQ_kwDOqueue" };
    f.rules = [{ type: "merge_queue", enforcement: "active" }];
    f.mergeAnswer = queueRefusal;
    expect(await port.mergePullRequest(PR, { sha: HEAD })).toEqual({ merged: false, httpStatus: 405 });
    expect(await port.getMergeQueueMode!(PR, "main")).toMatchObject({ mode: "queue" });
    expect(await port.getMergeQueueMode!(PR, "release")).toMatchObject({ mode: "queue" });
  });

  it("another repository's cached answer is untouched", async () => {
    const widgets = fresh();
    const gadgets = fresh();
    gadgets.owner = "acme";
    gadgets.name = "gadgets";
    gadgets.queue = null;
    gadgets.rules = [];
    widgets.queue = null;
    widgets.rules = [];
    const byRepo = new Map([
      ["repo-1", { owner: "acme", name: "widgets", fake: widgets }],
      ["repo-2", { owner: "acme", name: "gadgets", fake: gadgets }],
    ]);
    const http: GitHubHttp = {
      request: async (req) => {
        const vars = (req.body as { variables?: { name?: string } } | undefined)?.variables;
        const name = vars?.name ?? /^\/repos\/[^/]+\/([^/]+)\//.exec(req.path)?.[1];
        return httpFor([...byRepo.values()].find((r) => r.name === name)!.fake).request(req);
      },
    };
    const port = createGitHubMergeGatePort({ http, resolveRepo: async (id) => byRepo.get(id)!, markReadyForHumanMerge: async () => undefined, queueDocuments: DOCS });
    await port.getMergeQueueMode!(PR, "main");
    await port.getMergeQueueMode!({ repoId: "repo-2", prNumber: 7 }, "main");
    widgets.mergeAnswer = queueRefusal;
    await port.mergePullRequest(PR, { sha: HEAD });
    const before = reads(gadgets);
    await port.getMergeQueueMode!({ repoId: "repo-2", prNumber: 7 }, "main");
    expect(reads(gadgets)).toBe(before);
    const beforeW = reads(widgets);
    await port.getMergeQueueMode!(PR, "main");
    expect(reads(widgets)).toBeGreaterThan(beforeW);
  });

  it.each([
    ["a stale sha (409)", { status: 409, body: { message: "Head branch was modified. Review and try the merge again." } }],
    ["a failing required check (405 without the queue)", { status: 405, body: { message: 'Required status check "ci" is expected.' } }],
    ["a body without a message", { status: 405, body: {} }],
    ["a server error", { status: 500, body: { message: "Server Error" } }],
  ])("%s keeps the cached answer", async (_n, answer) => {
    const f = fresh();
    const port = await warm(f);
    f.mergeAnswer = answer;
    expect((await port.mergePullRequest(PR, { sha: HEAD })).merged).toBe(false);
    const before = reads(f);
    expect(await port.getMergeQueueMode!(PR, "main")).toMatchObject({ mode: "direct" });
    expect(reads(f)).toBe(before);
  });

  it("a merge that succeeds keeps the cache", async () => {
    const f = fresh();
    const port = await warm(f);
    expect(await port.mergePullRequest(PR, { sha: HEAD })).toEqual({ merged: true });
    const before = reads(f);
    await port.getMergeQueueMode!(PR, "main");
    expect(reads(f)).toBe(before);
  });
});

describe("D#694 B6-3: getMergeQueueInfo (the product queue's bound)", () => {
  const rule = (parameters?: unknown) => [{ type: "merge_queue", enforcement: "active", ...(parameters === undefined ? {} : { parameters }) }];
  const info = (f: Fake, over?: Parameters<typeof portFor>[1]) => portFor(f, over).getMergeQueueInfo!(PR);

  it("the batch size is the active rule's max_entries_to_build", async () => {
    const f = fresh();
    f.rules = rule({ max_entries_to_build: 3 });
    expect(await info(f)).toEqual({ mode: "queue", maxEntries: 3 });
  });

  it.each([
    ["missing", rule({})],
    ["no parameters", rule()],
    ["not an integer", rule({ max_entries_to_build: 2.5 })],
    ["a string", rule({ max_entries_to_build: "3" })],
    ["zero", rule({ max_entries_to_build: 0 })],
    ["above GitHub's limit", rule({ max_entries_to_build: 101 })],
  ])("a batch size that is %s is 1", async (_n, rules) => {
    const f = fresh();
    f.rules = rules;
    expect(await info(f)).toEqual({ mode: "queue", maxEntries: 1 });
  });

  it("the rule that counts is an active one", async () => {
    const f = fresh();
    f.rules = [{ type: "merge_queue", enforcement: "evaluate", parameters: { max_entries_to_build: 9 } }, ...rule({ max_entries_to_build: 4 })];
    expect(await info(f)).toEqual({ mode: "queue", maxEntries: 4 });
  });

  it("a branch with no queue is direct with a bound of 1; a failed read is unknown with a bound of 1, never direct", async () => {
    const off = fresh();
    off.queue = null;
    off.rules = [];
    expect(await info(off)).toEqual({ mode: "direct", maxEntries: 1 });
    clearMergeQueueModeCache();
    const bad = fresh();
    bad.graphqlStatus = 500;
    expect(await info(bad)).toEqual({ mode: "unknown", maxEntries: 1 });
  });

  it("without the pinned documents the port is direct whatever the rule says (the default the wiring test guards against)", async () => {
    const f = fresh();
    f.rules = rule({ max_entries_to_build: 3 });
    expect(await info(f, { queueDocuments: undefined })).toEqual({ mode: "direct", maxEntries: 1 });
  });

  it("one read of the pull request per call, and the queue answer is cached", async () => {
    const f = fresh();
    f.rules = rule({ max_entries_to_build: 2 });
    const port = portFor(f);
    await port.getMergeQueueInfo!(PR);
    const pulls = () => f.reached.filter((r) => /\/pulls\/7$/.test(r.path)).length;
    const gql = () => f.reached.filter((r) => r.path === "/graphql").length;
    expect([pulls(), gql()]).toEqual([1, 1]);
    await port.getMergeQueueInfo!(PR);
    expect([pulls(), gql()]).toEqual([2, 1]);
  });
});

describe("getLastQueueRemoval (B6-6)", () => {
  const node = { createdAt: "2026-11-01T10:00:00Z", reason: "MANUAL", actor: { __typename: "User" }, beforeCommit: { oid: HEAD } };
  const withNodes = (nodes: unknown) => ({ timelineItems: { nodes } });

  it("reads the newest removal by number inside the repository with the pinned document and maps its facts", async () => {
    const f = fresh();
    f.removalPr = withNodes([node]);
    expect(await portFor(f).getLastQueueRemoval!(PR)).toEqual({ createdAt: node.createdAt, reason: "MANUAL", actorType: "User", beforeCommitOid: HEAD });
    expect(f.reached.filter((r) => r.path === "/graphql").map((r) => r.body)).toEqual([{ query: MERGE_QUEUE_REMOVAL_DOCUMENT, variables: { owner: "acme", name: "widgets", number: 7 } }]);
  });

  it("no event is null; a null reason, actor or commit is kept as null, never invented", async () => {
    const f = fresh();
    expect(await portFor(f).getLastQueueRemoval!(PR)).toBeNull();
    f.removalPr = withNodes([{ createdAt: node.createdAt, reason: null, actor: null, beforeCommit: null }]);
    expect(await portFor(f).getLastQueueRemoval!(PR)).toEqual({ createdAt: node.createdAt, reason: null, actorType: null, beforeCommitOid: null });
  });

  it.each([
    ["no pull request", null],
    ["nodes not a list", { timelineItems: { nodes: {} } }],
    ["a node without createdAt", withNodes([{ ...node, createdAt: 5 }])],
    ["a reason that is not text", withNodes([{ ...node, reason: 5 }])],
    ["an actor without a type", withNodes([{ ...node, actor: {} }])],
    ["a commit id that is not a sha", withNodes([{ ...node, beforeCommit: { oid: "main" } }])],
  ])("a malformed answer (%s) throws, never a reading", async (_n, removalPr) => {
    const f = fresh();
    f.removalPr = removalPr;
    await expect(portFor(f).getLastQueueRemoval!(PR)).rejects.toThrow("malformed");
  });

  it("GraphQL errors and an HTTP 500 throw; no removal document, a changed document and a runner_local port refuse", async () => {
    const e = fresh();
    e.graphqlErrors = [{ message: "boom" }];
    await expect(portFor(e).getLastQueueRemoval!(PR)).rejects.toThrow("GraphQL error");
    const g = fresh();
    g.graphqlStatus = 500;
    await expect(portFor(g).getLastQueueRemoval!(PR)).rejects.toThrow("unexpected status 500");
    await expect(portFor(fresh(), { queueDocuments: { ...DOCS, removal: undefined as unknown as string } }).getLastQueueRemoval!(PR)).rejects.toThrow("no removal document");
    const changed = fresh();
    await expect(portFor(changed, { queueDocuments: { ...DOCS, removal: `${DOCS.removal} ` } }).getLastQueueRemoval!(PR)).rejects.toThrow("path_refused");
    expect(changed.reached).toEqual([]);
    const local = createGitHubMergeGatePort({ http: httpFor(fresh()), resolveRepo: async () => ({ owner: "acme", name: "widgets" }), markReadyForHumanMerge: async () => undefined, queueDocuments: DOCS, local: { http: { ...httpFor(fresh()), graphql: async () => ({ status: 200, body: {} }) }, recordedBranch: async () => "b" } });
    await expect(local.getLastQueueRemoval!(PR)).rejects.toThrow("allowlist");
  });
});

import { GATE1_ATTEST_DOCUMENTS, GATE1_STATUS_DOCUMENTS, GITHUB_GRAPHQL_DOCUMENTS, LocalOnlyGithubError, localOnlyGithub, type GithubClient, type GithubRequest, type GithubResponse } from "@fx/runner-cloud";
import type { LocalGitHubHttp } from "../../../src/build/githubMergePort.js";
import { defaultGhId, type FakeRepoState } from "./fakeGitHubRest.js";

/**
 * D#6 R3c: the GitHub a `runner_local` repo's review and merge path talks to, as a strict fake, over the same `FakeRepoState` the
 * REST fake uses (so a test's assertions on `merges`, `posts` and `statuses` read the same).
 *
 * It is the INNER client of the real `localOnlyGithub`: the only way to reach it from a test is through the wrapper. It is written
 * without the production allowlist (its own table below), so a wrong wrapper cannot hide behind a lenient fake:
 *
 *   - exactly the calls A1 to A10 of the Specs, and nothing else: any other method or path throws `StrictLocalFakeError` and is
 *     counted in `denied`;
 *   - `Accept: application/vnd.github+json` on every call;
 *   - GraphQL: the query text must equal one of the fixed documents byte for byte, errors come as status 200 with `errors`, and the
 *     check state is one connection (`statusCheckRollup.contexts`) paged 100 at a time with a cursor, in GitHub's upper-case enums;
 *   - the files document returns paths and change types, never a `patch` (a test asserts no answer carries one);
 *   - branch protection is the classic rule only: a ruleset is invisible through this allowlist (`rulesetRules` is ignored on purpose);
 *   - statuses, the merge and the pull request list answer as the REST fake does (40-hex sha, state enum, 140-character description,
 *     409 on a moved head, merged_at set after a merge).
 *
 * What it cannot fake faithfully: that GitHub's schema accepts the CommitChecks document as written (a live run is the first check),
 * rate limits, and the exact wording of error messages.
 */
export class StrictLocalFakeError extends Error {
  constructor(message: string) {
    super(`strict local-only GitHub fake: ${message}`);
    this.name = "StrictLocalFakeError";
  }
}

const json = (status: number, body: unknown): GithubResponse => ({ status, body });
const SHA40 = /^[0-9a-f]{40}$/;
const STATES = ["error", "failure", "pending", "success"];
const MERGE_METHODS = ["merge", "squash", "rebase"];
const FILES_PAGE = 100;
const DOCS = GITHUB_GRAPHQL_DOCUMENTS as Record<string, string>;
/** D#694 B7-0 (A11 to A13): the two queue-read documents, written out here so a wrong fence cannot hide behind a lenient fake. */
export const QUEUE_DOCS: Record<string, string> = {
  MergeQueueRead: "query($owner: String!, $name: String!, $branch: String!) { repository(owner: $owner, name: $name) { mergeQueue(branch: $branch) { id } } }",
  MergeQueueEntry: "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { state merged headRefOid mergeQueueEntry { id state position } } } }",
};
/** How the code repository merges, for the queue reads: the queue read and the branch rules are separate facts; `fail` makes both answer 500. */
export interface QueueState {
  graphql: boolean;
  rules: boolean;
  fail?: boolean;
  entry?: { id: string; state: string; position: number } | null;
}

export interface LocalFake {
  /** The client the code under test gets: the real wrapper around the strict inner client. */
  http: LocalGitHubHttp;
  /** Every call that reached the inner client (i.e. passed the wrapper), labelled A1 to A10. */
  calls: Array<{ label: string; method: string; path: string; op?: string }>;
  /** Calls the inner client refused as outside A1 to A10 (the wrapper should have refused them first). */
  denied: string[];
  /** Calls the wrapper refused before they reached the inner client. */
  refused: string[];
  /** Every answer given, to assert none carries a patch. */
  answers: unknown[];
}

/**
 * D#6 CLOUD-POSTS-FX-GATE1: the code repository's side the attester reads (A14 to A17), on the review round's client (`gate1Attest`). Given, the fence is
 * built with `gate1Attest: true`. GitHub's shapes: a label add answers 200 with the labels and adds a `labeled` event only when the label was not on;
 * events come oldest first, paged backwards (`last`/`before`); check runs carry `startedAt` and upper-case enums, status contexts in the rollup arrive as a
 * bare `__typename` (the document selects nothing of them); `Status.context(name:)` is the newest status of that context, and GraphQL names an App's bot
 * by its slug without `[bot]`, typed `Bot`. Not faithful: GitHub's own ordering of same-second events, and permissions (probe 6 checks those).
 */
export interface Gate1World {
  labels: string[];
  labelEvents: Array<{ event: "labeled" | "unlabeled"; label: string; createdAt: string }>;
  /** The time a label add is stamped with. */
  now: string;
  appSlug: string;
  /** Who posted `fx-gate1` on a sha. A post through this fake is our App's bot. */
  creators: Record<string, { __typename: string; login: string }>;
  labelAdds: number;
}
/** PR 1c: `gate1Fence: "status"` builds the fence as the go phase's client is built (A17 only), over the same gate1 world. */
export const gate1World = (over: Partial<Gate1World> = {}): Gate1World => ({ labels: [], labelEvents: [], now: "2026-11-07T10:00:00Z", appSlug: "fx-cloud-app", creators: {}, labelAdds: 0, ...over });
const G1_DOCS: Record<string, string> = { ...GATE1_ATTEST_DOCUMENTS, ...GATE1_STATUS_DOCUMENTS };
const page = <T>(all: T[], cursor: unknown, back: boolean) => {
  const n = all.length;
  if (back) {
    const end = typeof cursor === "string" ? Number(Buffer.from(cursor, "base64url").toString()) : n;
    const start = Math.max(0, end - FILES_PAGE);
    return { nodes: all.slice(start, end), pageInfo: { hasPreviousPage: start > 0, startCursor: start > 0 ? Buffer.from(String(start)).toString("base64url") : null } };
  }
  const start = typeof cursor === "string" ? Number(Buffer.from(cursor, "base64url").toString()) : 0;
  const end = Math.min(n, start + FILES_PAGE);
  return { nodes: all.slice(start, end), pageInfo: { hasNextPage: end < n, endCursor: end < n ? Buffer.from(String(end)).toString("base64url") : null } };
};

export function fakeGitHubLocal(s: FakeRepoState & { runBranch?: string }, opts: { exclude?: readonly string[]; queue?: QueueState; transport?: (inner: GithubClient) => GithubClient; gate1?: Gate1World; gate1Fence?: "attest" | "status" } = {}): LocalFake {
  const g1 = opts.gate1;
  const base = `/repos/${s.owner}/${s.name}`;
  const branch = s.runBranch ?? "fx/run-g1";
  const calls: LocalFake["calls"] = [];
  const denied: string[] = [];
  const refused: string[] = [];
  const answers: unknown[] = [];

  const deny = (why: string): never => {
    denied.push(why);
    throw new StrictLocalFakeError(`outside A1 to A10: ${why}`);
  };
  const full = `${s.owner}/${s.name}`;

  function listPulls(query: Readonly<Record<string, string | number>>): GithubResponse {
    for (const k of Object.keys(query)) if (!["head", "base", "state", "per_page"].includes(k)) deny(`A3 query key ${k}`);
    const head = String(query.head ?? "");
    if (query.head !== undefined && !/^[^:]+:.+$/.test(head)) throw new StrictLocalFakeError("A3: head must be written user:branch, or GitHub ignores it");
    const state = String(query.state ?? "open");
    const merged = s.merged;
    const closed = s.state === "closed" || merged;
    const listed = state === "all" || (state === "open" && !closed) || (state === "closed" && closed);
    const headFits = query.head === undefined || (head.slice(head.indexOf(":") + 1) === branch && head.slice(0, head.indexOf(":")).toLowerCase() === s.owner.toLowerCase());
    if (!listed || !headFits) return json(200, []);
    return json(200, [
      {
        number: s.prNumber,
        state: closed ? "closed" : "open",
        draft: s.draft,
        merged_at: merged ? "2026-10-09T00:00:00Z" : null,
        title: "A pull request title, never read",
        body: "A pull request body, never read",
        head: { sha: s.headSha, ref: branch, repo: { full_name: full } },
        base: { ref: s.baseRef, repo: { full_name: full, default_branch: s.defaultBranch ?? "main", private: s.isPublic !== true } },
        user: s.authorLogin === null ? null : { login: s.authorLogin ?? "fixture-author" },
      },
    ]);
  }

  function protection(): GithubResponse {
    if (s.protectionStatus !== undefined) return json(s.protectionStatus, { message: s.protectionStatus === 403 ? "Resource not accessible by integration" : "Not Found" });
    if (s.requiredContexts.length > 0) return json(200, { url: "x", required_status_checks: { contexts: s.requiredContexts, checks: s.requiredContexts.map((context) => ({ context, app_id: null })) } });
    if (s.protectedWithoutChecks) return json(200, { url: "x", enforce_admins: { enabled: false } });
    return json(404, { message: "Branch not protected" });
  }

  function postStatus(sha: string, body: unknown): GithubResponse {
    if (!SHA40.test(sha)) return json(404, { message: `No commit found for SHA: ${sha}` });
    const b = (body ?? {}) as Record<string, unknown>;
    if (Object.keys(b).sort().join(",") !== "context,description,state") deny("A7 body keys");
    // D#6 CLOUD-POSTS-FX-GATE1: `fx-gate1` only with a gate1 world (the attester's client), only on a full 40-hex sha, and the poster is our App's bot.
    if (b.context !== "fulcrumaxe/review" && !(b.context === "fx-gate1" && g1 !== undefined)) deny("A7 context");
    if (!STATES.includes(b.state as string) || typeof b.description !== "string" || b.description.length > 140) return json(422, { message: "Validation Failed" });
    if (s.statusPostFails) return json(s.statusPostFails, { message: "Server Error" });
    s.posts.push({ sha, body: b });
    (s.statuses[sha] ??= {})[b.context as string] = b.state as string;
    if (b.context === "fx-gate1" && g1 !== undefined) g1.creators[sha] = { __typename: "Bot", login: g1.appSlug };
    return json(201, { state: b.state, context: b.context });
  }

  function mergePull(body: unknown): GithubResponse {
    const b = (body ?? {}) as { sha?: unknown; merge_method?: unknown };
    if (Object.keys(b).sort().join(",") !== "merge_method,sha") deny("A10 body keys");
    if (b.merge_method !== "squash" || typeof b.sha !== "string") deny("A10 body values");
    if (!MERGE_METHODS.includes(b.merge_method as string)) return json(422, { message: "Validation Failed" });
    s.onMerge?.(s);
    s.merges.push({ sha: b.sha as string, method: b.merge_method });
    if (s.mergeStatus) return json(s.mergeStatus, { message: "Pull Request is not mergeable" });
    if (b.sha !== s.headSha) return json(409, { message: "Head branch was modified. Review and try the merge again." });
    s.merged = true;
    s.state = "closed";
    return json(200, { merged: true, sha: "f".repeat(40) });
  }

  function graphql(body: unknown): { label: string; op: string; reply: () => GithubResponse } {
    const b = body as { query?: unknown; variables?: Record<string, unknown> };
    if (typeof body !== "object" || body === null || Object.keys(b).sort().join(",") !== "query,variables") deny("graphql body keys");
    const queueOp = Object.keys(QUEUE_DOCS).find((k) => QUEUE_DOCS[k] === b.query);
    const v = b.variables ?? {};
    const g1Op = Object.keys(G1_DOCS).find((k) => G1_DOCS[k] === b.query);
    if (g1Op !== undefined) {
      if (g1 === undefined) deny(`graphql document ${g1Op} without a gate1 world`);
      const w = g1!;
      const label = g1Op === "Gate1CheckRuns" ? "A15" : g1Op === "Gate1LabelEvents" ? "A16" : "A17";
      return {
        label,
        op: g1Op,
        reply: () => {
          if (v.owner !== s.owner || v.name !== s.name) return json(200, { data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository." }] });
          if (g1Op === "Gate1LabelEvents") {
            if (v.number !== s.prNumber) return json(200, { data: { repository: { pullRequest: null } }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a PullRequest." }] });
            const all = w.labelEvents.map((e) => ({ __typename: e.event === "labeled" ? "LabeledEvent" : "UnlabeledEvent", createdAt: e.createdAt, label: { name: e.label } }));
            return json(200, { data: { repository: { pullRequest: { timelineItems: { totalCount: all.length, ...page(all, v.cursor, true) } } } } });
          }
          const sha = v.sha as string;
          // An unknown oid is `object: null`, as GitHub answers.
          if (sha !== s.headSha && s.checks[sha] === undefined && s.statuses[sha] === undefined) return json(200, { data: { repository: { object: null } } });
          if (g1Op === "Gate1Status") {
            const state = s.statuses[sha]?.["fx-gate1"];
            const creator = w.creators[sha] ?? null;
            return json(200, { data: { repository: { object: { oid: sha, status: s.statuses[sha] === undefined ? null : { context: state === undefined ? null : { state: state.toUpperCase(), creator } } } } } });
          }
          const runs = (s.checks[sha] ?? []).map((c) => ({ __typename: "CheckRun", name: c.name, status: c.status.toUpperCase(), conclusion: c.conclusion === null ? null : c.conclusion.toUpperCase(), startedAt: c.startedAt ?? "2026-11-07T09:00:00Z", checkSuite: { app: c.app === null ? null : { databaseId: c.app?.id ?? 1 } } }));
          const all = [...runs, ...Object.keys(s.statuses[sha] ?? {}).map(() => ({ __typename: "StatusContext" }))];
          return json(200, { data: { repository: { object: { oid: sha, statusCheckRollup: all.length === 0 ? null : { contexts: { totalCount: all.length, ...page(all, v.cursor, false) } } } } } });
        },
      };
    }
    if (queueOp !== undefined) {
      const q = opts.queue ?? { graphql: false, rules: false };
      return {
        label: queueOp === "MergeQueueRead" ? "A12" : "A13",
        op: queueOp,
        reply: () => {
          if (q.fail) return json(502, { message: "Bad Gateway" });
          if (queueOp === "MergeQueueRead") return json(200, { data: { repository: { mergeQueue: q.graphql ? { id: "MQ_kwDOAAAAAQ" } : null } } });
          const closed = s.state === "closed" || s.merged;
          return json(200, { data: { repository: { pullRequest: { state: s.merged ? "MERGED" : closed ? "CLOSED" : "OPEN", merged: s.merged, headRefOid: s.headSha, mergeQueueEntry: q.entry ?? null } } } });
        },
      };
    }
    const op = Object.keys(DOCS).find((k) => DOCS[k] === b.query);
    if (op === undefined) return deny("graphql query text is not one of the fixed documents");
    if (op === "PullRequestFiles") {
      return {
        label: "A1 PullRequestFiles",
        op,
        reply: () => {
          if (v.owner !== s.owner || v.name !== s.name) return json(200, { data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository." }] });
          if (v.number !== s.prNumber) return json(200, { data: { repository: { pullRequest: null } }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a PullRequest." }] });
          if (s.filesFail) return json(s.filesFail, { message: "Server Error" });
          const start = typeof v.cursor === "string" ? Number(Buffer.from(v.cursor, "base64url").toString()) : 0;
          const slice = s.files.slice(start, start + FILES_PAGE);
          const end = start + slice.length;
          const nodes = slice.map((f) => ({ path: f.filename, changeType: f.previous_filename ? "RENAMED" : "MODIFIED" }));
          return json(200, { data: { repository: { pullRequest: { files: { totalCount: s.files.length, pageInfo: { hasNextPage: end < s.files.length, endCursor: end < s.files.length ? Buffer.from(String(end)).toString("base64url") : null }, nodes } } } } });
        },
      };
    }
    if (op === "CommitChecks") {
      return {
        label: "A9 CommitChecks",
        op,
        reply: () => {
          if (v.owner !== s.owner || v.name !== s.name || v.number !== s.prNumber) return json(200, { data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve." }] });
          const runs = (s.checks[s.headSha] ?? []).map((c) => ({ __typename: "CheckRun", name: c.name, status: c.status.toUpperCase(), conclusion: c.conclusion === null ? null : c.conclusion.toUpperCase(), checkSuite: { app: { databaseId: c.app?.id ?? 1 } } }));
          const sts = Object.entries(s.statuses[s.headSha] ?? {}).map(([context, state]) => ({ __typename: "StatusContext", context, state: state.toUpperCase() }));
          const all = [...runs, ...sts];
          const start = typeof v.cursor === "string" ? Number(Buffer.from(v.cursor, "base64url").toString()) : 0;
          const slice = all.slice(start, start + FILES_PAGE);
          const end = start + slice.length;
          const contexts = { totalCount: all.length, pageInfo: { hasNextPage: end < all.length, endCursor: end < all.length ? Buffer.from(String(end)).toString("base64url") : null }, nodes: slice };
          return json(200, { data: { repository: { pullRequest: { commits: { nodes: [{ commit: { oid: s.headSha, statusCheckRollup: all.length === 0 ? null : { contexts } } }] } } } } });
        },
      };
    }
    return deny(`graphql document ${op} is not part of the review path`);
  }

  const inner: GithubClient = {
    async request(req: GithubRequest): Promise<GithubResponse> {
      const accept = Object.entries(req.headers ?? {}).filter(([k]) => k.toLowerCase() === "accept");
      if (accept.length !== 1 || accept[0]![1] !== "application/vnd.github+json") throw new StrictLocalFakeError(`${req.method} ${req.path}: Accept: application/vnd.github+json is required`);
      const { method, path } = req;
      const query = req.query ?? {};
      let label: string;
      let op: string | undefined;
      let reply: () => GithubResponse;
      let m: RegExpExecArray | null;
      if (method === "POST" && path === "/graphql") {
        const g = graphql(req.body);
        ({ label, op, reply } = g);
      } else if (method === "GET" && path === base) {
        // A2: the repository itself. Only the fields the gate reads are served (id, names, default branch); never contents.
        if (Object.keys(query).length > 0 || req.body !== undefined) deny("A2 query or body");
        label = "A2";
        reply = () => json(200, { id: s.ghId ?? defaultGhId(s.owner, s.name), full_name: full, default_branch: s.defaultBranch ?? "main", private: false });
      } else if (method === "GET" && path === `${base}/rules/branches/${s.baseRef}`) {
        // A11: the branch's rules, paged. Only the paging keys, no body.
        for (const k of Object.keys(query)) if (!["per_page", "page"].includes(k)) deny(`A11 query key ${k}`);
        if (req.body !== undefined) deny("A11 body");
        label = "A11";
        reply = () => (opts.queue?.fail ? json(500, { message: "Server Error" }) : json(200, opts.queue?.rules ? [{ type: "merge_queue", parameters: { max_entries_to_build: 5 } }] : [{ type: "pull_request", parameters: {} }]));
      } else if (method === "GET" && path === `${base}/pulls`) {
        if (req.body !== undefined) deny("body on GET");
        label = "A3";
        reply = () => listPulls(query);
      } else if (method === "GET" && (m = new RegExp(`^${base}/branches/([A-Za-z0-9_.-]+)/protection$`).exec(path))) {
        if (Object.keys(query).length > 0 || req.body !== undefined) deny("A8 query or body");
        label = "A8";
        reply = () => (m![1] === s.baseRef ? protection() : json(404, { message: "Branch not found" }));
      } else if (method === "POST" && (m = new RegExp(`^${base}/statuses/([0-9a-fA-F]+)$`).exec(path))) {
        if (Object.keys(query).length > 0) deny("A7 query");
        label = "A7";
        reply = () => postStatus(m![1]!, req.body);
      } else if (method === "PUT" && path === `${base}/pulls/${s.prNumber}/merge`) {
        if (Object.keys(query).length > 0) deny("A10 query");
        label = "A10";
        reply = () => mergePull(req.body);
      } else if (g1 !== undefined && method === "POST" && path === `${base}/issues/${s.prNumber}/labels`) {
        // A14: exactly ci:full, added (never replaced): GitHub answers 200 with every label now on the pull request.
        if (Object.keys(query).length > 0 || JSON.stringify(req.body) !== JSON.stringify({ labels: ["ci:full"] })) deny("A14 body or query");
        label = "A14";
        reply = () => {
          g1.labelAdds += 1;
          if (!g1.labels.includes("ci:full")) {
            g1.labels.push("ci:full");
            g1.labelEvents.push({ event: "labeled", label: "ci:full", createdAt: g1.now });
          }
          return json(200, g1.labels.map((name) => ({ name })));
        };
      } else {
        return deny(`${method} ${path}`);
      }
      calls.push({ label, method, path, ...(op ? { op } : {}) });
      const out = reply();
      answers.push(out.body);
      return out;
    },
  };

  const fenced = localOnlyGithub(opts.transport ? opts.transport(inner) : inner, { ...(opts.exclude === undefined ? {} : { exclude: opts.exclude }), ...(g1 !== undefined ? (opts.gate1Fence === "status" ? { gate1Status: true } : { gate1Attest: true }) : {}) });
  const note = (e: unknown): never => {
    if (e instanceof LocalOnlyGithubError) refused.push(e.rule);
    throw e;
  };
  const http: LocalGitHubHttp = {
    request: async (req) => {
      const out = await fenced.request({ method: req.method, path: req.path, query: req.query, body: req.body }).catch(note);
      return out;
    },
    graphql: (op, variables) => fenced.graphql(op, variables).catch(note),
  };
  return { http, calls, denied, refused, answers };
}

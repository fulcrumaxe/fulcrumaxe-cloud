import { MERGE_QUEUE_ENTRY_DOCUMENT, pinnedMergeGateBody } from "../../../../github/src/mergeGateGraphql.js";
import type { GitHubHttp, GitHubHttpResponse } from "../../../src/build/githubMergePort.js";
import type { Gate1World } from "./fakeGitHubLocal.js";
import { fakeGitHubRest, type FakeRepoState } from "./fakeGitHubRest.js";

/**
 * D#6 CLOUD-POSTS-FX-GATE1 PR 1e: the hosted code repository's merge queue as the plain `merge_gate` client can read it, in front of `fakeGitHubRest` (which
 * answers the statuses list, the check runs and the status post). GitHub's shapes:
 *  - a queue branch is `gh-readonly-queue/<base>/pr-<n>-<sha>` where `<sha>` is the commit the entry was built on (the base), and it points at the entry
 *    commit (the tests give each entry commit that base as its first parent, through `commitParents`);
 *  - `GET git/matching-refs/{ref}` is a PREFIX match (`heads/gh-readonly-queue/main` also lists `heads/gh-readonly-queue/main-x/...`), answering every match as
 *    `{ ref, node_id, object: { sha, type } }`, an empty list when none match; it takes no query;
 *  - `POST /graphql` takes only a pinned document (the hosted client's own rule, `pinnedMergeGateBody`, here pinned to this repository); anything else throws.
 *    The entry document answers one pull request's `state` (OPEN, CLOSED, MERGED), `headRefOid` and `mergeQueueEntry { id state position }` (null when it is
 *    not queued); an unknown number is `pullRequest: null`;
 *  - `GET git/ref/heads/<base>` answers the base tip (`baseTip`), 404 for any other branch.
 * Not faithful: who may create a `gh-readonly-queue` branch (GitHub reserves the prefix), and whether matching-refs pages (the docs name no paging).
 */
export interface HostedQueueWorld {
  refs: Array<{ ref: string; sha: string }>;
  prs: Record<number, { state: string; headRefOid: string; entry: { id: string; state: string; position: number } | null }>;
  /** Answer the refs read with this status instead. */
  refsStatus?: number;
  /** The base branch's tip, answered by `GET git/ref/heads/<base>` as GitHub does (`{ ref, node_id, object: { sha, type } }`); null answers 404. */
  baseTip?: string | null;
  /** Every pinned document the fake answered, by pull request number. */
  entryReads: number[];
}

export function fakeGitHubQueueRest(s: FakeRepoState, g1: Gate1World, q: HostedQueueWorld): GitHubHttp {
  const inner = fakeGitHubRest(s, { gate1: g1 });
  const base = `/repos/${s.owner}/${s.name}`;
  const json = (status: number, body: unknown): GitHubHttpResponse => ({ status, body });
  return {
    async request(req) {
      const refs = `${base}/git/matching-refs/`;
      if (req.method === "GET" && req.path.startsWith(refs)) {
        s.requests.push(req);
        if (req.query !== undefined || req.body !== undefined) throw new Error("fake: matching-refs takes no query or body");
        if (q.refsStatus !== undefined) return json(q.refsStatus, { message: "Server Error" });
        const prefix = `refs/${req.path.slice(refs.length)}`;
        return json(200, q.refs.filter((r) => r.ref.startsWith(prefix)).map((r, i) => ({ ref: r.ref, node_id: `REF_${i}`, url: "https://api.github.com/x", object: { sha: r.sha, type: "commit", url: "https://api.github.com/y" } })));
      }
      if (req.method === "GET" && q.baseTip !== undefined && req.path.startsWith(`${base}/git/ref/heads/`)) {
        s.requests.push(req);
        if (req.query !== undefined || req.body !== undefined) throw new Error("fake: a ref read takes no query or body");
        const branch = req.path.slice(`${base}/git/ref/heads/`.length);
        if (q.baseTip === null || branch !== s.baseRef) return json(404, { message: "Not Found" });
        return json(200, { ref: `refs/heads/${branch}`, node_id: "REF_BASE", url: "https://api.github.com/z", object: { sha: q.baseTip, type: "commit", url: "https://api.github.com/w" } });
      }
      if (req.method === "POST" && req.path === "/graphql") {
        s.requests.push(req);
        const pinned = pinnedMergeGateBody(req.body, { owner: s.owner, name: s.name });
        if (pinned === undefined || pinned.query !== MERGE_QUEUE_ENTRY_DOCUMENT || req.query !== undefined) throw new Error("fake: only the pinned entry document");
        const n = (pinned.variables as { number: number }).number;
        q.entryReads.push(n);
        const pr = q.prs[n];
        return json(200, { data: { repository: { pullRequest: pr === undefined ? null : { state: pr.state, merged: pr.state === "MERGED", headRefOid: pr.headRefOid, mergeQueueEntry: pr.entry } } } });
      }
      return inner.request(req);
    },
  };
}

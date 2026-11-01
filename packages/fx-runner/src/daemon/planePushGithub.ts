/**
 * D#598 P1f-3: the three GitHub API calls the run-end hook makes to the paired PUBLIC repository with its one restricted token, and nothing else:
 *
 *   branchExists     `GET /repos/<o>/<n>/git/ref/heads/<branch>`: a branch that exists is never pushed over.
 *   branchHead       the same read, answering the head: an update of a branch the platform pushed checks it before and after.
 *   openPullRequest  `POST /repos/<o>/<n>/pulls`: the one call that makes the pushed branch a pull request.
 *   revokeToken      `DELETE /installation/token` with the token itself as the bearer: 204, and the token answers 401 afterwards.
 *
 * D#6 PUBLIC-MERGE PR3 adds the two calls of a merge order, made with the order's single-use write token:
 *   getPull          `GET /repos/<o>/<n>/pulls/<number>`: the head, base, state and draft flag the merge decision is re-read from.
 *   mergePull        `PUT /repos/<o>/<n>/pulls/<number>/merge` with `{ sha, merge_method: "squash" }`: GitHub itself refuses (409) when the head is not `sha`.
 *
 * D#694 B7-1 adds the two calls of a merge order whose code repository merges through GitHub's merge queue, with the same write token:
 *   getMergeQueueMode  the `mergeQueue(branch)` GraphQL read and `GET /repos/<o>/<n>/rules/branches/<branch>` (all pages); `queue` or `direct` only when the two agree, else `unknown`.
 *   enqueuePull        the `enqueuePullRequest` mutation, held to the head by `expectedHeadOid`. There is no auto-merge fallback.
 *
 * The token is minted on the cloud side and travels here in the token reply; it is used as a bearer for these calls and, through the transport, as
 * the push header, and for nothing else. Every path is built here from a validated owner, name and branch. Redirects are an error, every call has a
 * timeout, and no error carries a token, a header, a request body or GitHub's text: a failure carries a closed `code` from the route's refusal list.
 *
 * The host is `https://api.github.com`. An origin can be given for a test server only, and only as `http://` on loopback (the same allowance the
 * push transport makes).
 */

import { ENQUEUE_PULL_REQUEST_DOCUMENT, MERGE_QUEUE_READ_DOCUMENT } from "@fulcrumaxe/runner-protocol/planePush";

export type GithubFailure = "public_unavailable" | "pr_failed";

/** A failure with a closed code and a fixed message. `code` is what the push route reads (`failure()` in the route). */
export class PlanePushGithubError extends Error {
  constructor(readonly code: GithubFailure) {
    super(`planePushGithub: ${code}`);
    this.name = "PlanePushGithubError";
  }
}

export interface PlanePushGithubDeps {
  fetchFn?: typeof fetch;
  /** Default `https://api.github.com`. Anything else is for a test: https, or http on loopback, with no credentials, path or query. */
  apiOrigin?: string;
  timeoutMs?: number;
  /** The clock of the queue-mode cache (a test moves it). */
  now?: () => number;
}

/** How long a queue-mode answer is kept: five minutes, per code repository and branch. Only a `queue` or `direct` answer is kept. */
const QUEUE_MODE_TTL_MS = 5 * 60_000;
const RULES_PER_PAGE = 100;
const RULES_MAX_PAGES = 10;
/** GitHub's wording for an enqueue held to a head that moved; the only text read from an answer, and only to tell this refusal from any other. */
const HEAD_MOVED_MESSAGE = /head (branch|commit|sha|oid|ref)\b.*(modified|differ|changed|match|moved)|expected.*head|head.*expected/i;
export type QueueMode = "queue" | "direct" | "unknown";
export type EnqueueResult = { outcome: "enqueued" } | { outcome: "head_moved" } | { outcome: "refused"; status: number };

const CALL_TIMEOUT_MS = 15_000;
const MAX_REPLY_BYTES = 256 * 1024;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,330}$/;
const OWNER = /^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

function split(codeRepo: string): { owner: string; name: string } {
  const [owner, name, extra] = codeRepo.split("/");
  if (extra !== undefined || !owner || !name || !OWNER.test(owner) || !NAME.test(name) || name === "." || name === "..") throw new PlanePushGithubError("public_unavailable");
  return { owner, name };
}

function checkOrigin(input: string): URL {
  const url = new URL(input);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("planePushGithub: the API origin must be a plain https origin, or http on loopback");
  }
  return url;
}

/** At most `MAX_REPLY_BYTES` of a reply body; the rest is cancelled unread. */
async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < MAX_REPLY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined); // fx-swallow-ok: the body is already read or abandoned
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** What a merge decision reads of a pull request. `defaultBranch` is the base repository's own setting, not the pull request's say-so. */
export interface PullState {
  number: number;
  state: string;
  merged: boolean;
  draft: boolean;
  headSha: string;
  headRef: string;
  headRepo: string;
  baseRef: string;
  baseRepo: string;
  defaultBranch: string;
  /** The pull request's GraphQL node id (what the enqueue mutation names); empty when the answer carried none. */
  nodeId: string;
}

export interface PlanePushGithub {
  branchExists(input: { codeRepo: string; branch: string; token: string }): Promise<boolean>;
  openPullRequest(input: { codeRepo: string; branch: string; base: string; title: string; body: string; token: string }): Promise<{ number: number; url: string }>;
  /** The branch's head (a full commit id), or null when it does not exist. */
  branchHead(input: { codeRepo: string; branch: string; token: string }): Promise<string | null>;
  /** The pull request as GitHub has it now; throws `public_unavailable` on anything but a 200 with the expected shape. */
  getPull(input: { codeRepo: string; number: number; token: string }): Promise<PullState>;
  /** The code repository's merge mode on `branch`, from the queue read and the branch rules, which must agree. Never throws: anything unreadable is `unknown`. */
  getMergeQueueMode(input: { codeRepo: string; branch: string; token: string }): Promise<QueueMode>;
  /** Puts the pull request in the merge queue, held to `expectedHeadOid`. A permission refusal is `refused` (403); throws `public_unavailable` when no usable answer arrived. */
  enqueuePull(input: { codeRepo: string; pullRequestId: string; expectedHeadOid: string; token: string }): Promise<EnqueueResult>;
  /** One squash merge naming the head it expects. Never throws for a refusal: GitHub's status comes back; throws `public_unavailable` only when no answer arrived. */
  mergePull(input: { codeRepo: string; number: number; sha: string; token: string }): Promise<{ status: number; merged: boolean }>;
  /** True on GitHub's 204 and on a 401 (already gone). Anything else, or no answer, is false: the token then lapses at its own expiry. Never throws. */
  revokeToken(token: string): Promise<boolean>;
}

export function createPlanePushGithub(deps: PlanePushGithubDeps = {}): PlanePushGithub {
  const fetchFn = deps.fetchFn ?? fetch;
  const origin = checkOrigin(deps.apiOrigin ?? "https://api.github.com");
  const timeoutMs = deps.timeoutMs ?? CALL_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  const modes = new Map<string, { at: number; mode: QueueMode }>();

  async function call(method: "GET" | "POST" | "PUT" | "DELETE", path: string, token: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await fetchFn(new URL(path, origin), {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "user-agent": "fulcrumaxe-runner",
          "x-github-api-version": "2022-11-28",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // fx-swallow-ok: replaced by a closed code; the original's text can carry the request address
      throw new PlanePushGithubError("public_unavailable");
    }
    let parsed: unknown = null;
    try {
      const text = await readCapped(res);
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // fx-swallow-ok: a body that is not JSON reads as null, which every caller treats as "not the shape expected"
      parsed = null;
    }
    return { status: res.status, body: parsed };
  }

  return {
    async branchExists({ codeRepo, branch, token }) {
      const { owner, name } = split(codeRepo);
      if (!BRANCH.test(branch) || branch.includes("..")) throw new PlanePushGithubError("public_unavailable");
      const res = await call("GET", `/repos/${owner}/${name}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`, token);
      if (res.status === 200) return true;
      if (res.status === 404) return false;
      throw new PlanePushGithubError("public_unavailable");
    },

    async branchHead({ codeRepo, branch, token }) {
      const { owner, name } = split(codeRepo);
      if (!BRANCH.test(branch) || branch.includes("..")) throw new PlanePushGithubError("public_unavailable");
      const res = await call("GET", `/repos/${owner}/${name}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`, token);
      if (res.status === 404) return null;
      const object = res.body !== null && typeof res.body === "object" ? (res.body as { object?: { sha?: unknown } }).object : undefined;
      if (res.status !== 200 || typeof object?.sha !== "string" || !/^[0-9a-f]{40}$/.test(object.sha)) throw new PlanePushGithubError("public_unavailable");
      return object.sha;
    },

    async openPullRequest({ codeRepo, branch, base, title, body, token }) {
      const { owner, name } = split(codeRepo);
      const res = await call("POST", `/repos/${owner}/${name}/pulls`, token, { title, head: branch, base, body, maintainer_can_modify: false });
      const b = res.body !== null && typeof res.body === "object" ? (res.body as { number?: unknown; html_url?: unknown }) : {};
      const expectedUrl = new RegExp(`^https://github\\.com/${owner}/${name.replace(/[.]/g, "\\.")}/pull/(\\d+)$`, "i");
      if (res.status !== 201 || typeof b.number !== "number" || !Number.isSafeInteger(b.number) || typeof b.html_url !== "string" || b.html_url.match(expectedUrl)?.[1] !== String(b.number)) {
        throw new PlanePushGithubError(res.status >= 500 || res.status === 429 ? "public_unavailable" : "pr_failed");
      }
      return { number: b.number, url: b.html_url };
    },

    async getPull({ codeRepo, number, token }) {
      const { owner, name } = split(codeRepo);
      if (!Number.isSafeInteger(number) || number < 1) throw new PlanePushGithubError("public_unavailable");
      const res = await call("GET", `/repos/${owner}/${name}/pulls/${number}`, token);
      const b = res.body;
      const obj = (v: unknown): Record<string, unknown> | undefined => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
      const root = obj(b);
      const head = obj(root?.head);
      const base = obj(root?.base);
      const headRepo = obj(head?.repo);
      const baseRepo = obj(base?.repo);
      if (
        res.status !== 200 || root === undefined || typeof root.number !== "number" || typeof root.state !== "string" || typeof root.draft !== "boolean" || typeof root.merged !== "boolean" ||
        typeof head?.sha !== "string" || !/^[0-9a-f]{40}$/.test(head.sha) || typeof head.ref !== "string" || typeof base?.ref !== "string" ||
        typeof headRepo?.full_name !== "string" || typeof baseRepo?.full_name !== "string" || typeof baseRepo.default_branch !== "string"
      ) {
        throw new PlanePushGithubError("public_unavailable");
      }
      return { number: root.number, state: root.state, merged: root.merged, draft: root.draft, headSha: head.sha, headRef: head.ref, headRepo: headRepo.full_name, baseRef: base.ref, baseRepo: baseRepo.full_name, defaultBranch: baseRepo.default_branch, nodeId: typeof root.node_id === "string" && /^[A-Za-z0-9_=-]{1,100}$/.test(root.node_id) ? root.node_id : "" };
    },

    async getMergeQueueMode({ codeRepo, branch, token }) {
      try {
        const { owner, name } = split(codeRepo);
        if (!BRANCH.test(branch) || branch.includes("..")) return "unknown";
        const key = `${codeRepo.toLowerCase()}#${branch}`;
        const hit = modes.get(key);
        if (hit !== undefined && now() - hit.at >= 0 && now() - hit.at < QUEUE_MODE_TTL_MS) return hit.mode;
        modes.delete(key);
        const read = await call("POST", "/graphql", token, { query: MERGE_QUEUE_READ_DOCUMENT, variables: { owner, name, branch } });
        const root = read.body as { errors?: unknown; data?: { repository?: { mergeQueue?: unknown } } } | null;
        const repository = root?.data?.repository;
        if (read.status !== 200 || root?.errors !== undefined || repository === null || typeof repository !== "object" || !("mergeQueue" in repository)) return "unknown";
        const queue = repository.mergeQueue;
        if (queue !== null && (typeof queue !== "object" || Array.isArray(queue))) return "unknown";
        let ruleQueue = false;
        for (let page = 1; page <= RULES_MAX_PAGES; page++) {
          const res = await call("GET", `/repos/${owner}/${name}/rules/branches/${encodeURIComponent(branch)}?per_page=${RULES_PER_PAGE}&page=${page}`, token);
          if (res.status !== 200 || !Array.isArray(res.body)) return "unknown";
          for (const rule of res.body) {
            if (rule === null || typeof rule !== "object" || Array.isArray(rule)) return "unknown";
            const r = rule as { type?: unknown; enforcement?: unknown };
            if (r.type === "merge_queue" && !(typeof r.enforcement === "string" && r.enforcement !== "active")) ruleQueue = true;
          }
          if (res.body.length < RULES_PER_PAGE) break;
          if (page === RULES_MAX_PAGES) return "unknown";
        }
        const mode: QueueMode = queue !== null && ruleQueue ? "queue" : queue === null && !ruleQueue ? "direct" : "unknown";
        if (mode !== "unknown") modes.set(key, { at: now(), mode });
        return mode;
      } catch {
        // fx-swallow-ok: a read that could not be made is `unknown`, which stops the order; it is never read as `direct`
        return "unknown";
      }
    },

    async enqueuePull({ codeRepo, pullRequestId, expectedHeadOid, token }) {
      split(codeRepo);
      if (!/^[A-Za-z0-9_=-]{1,100}$/.test(pullRequestId) || !/^[0-9a-f]{40}$/.test(expectedHeadOid)) throw new PlanePushGithubError("public_unavailable");
      const res = await call("POST", "/graphql", token, { query: ENQUEUE_PULL_REQUEST_DOCUMENT, variables: { pullRequestId, expectedHeadOid } });
      if (res.status === 403) return { outcome: "refused", status: 403 };
      const root = res.body as { errors?: unknown; data?: { enqueuePullRequest?: { mergeQueueEntry?: { id?: unknown } | null } | null } } | null;
      if (res.status === 200 && root !== null && typeof root === "object" && root.errors === undefined) {
        const id = root.data?.enqueuePullRequest?.mergeQueueEntry?.id;
        if (typeof id === "string" && id !== "") return { outcome: "enqueued" };
      }
      const errors = res.status === 200 && Array.isArray(root?.errors) ? (root.errors as unknown[]) : [];
      const field = (e: unknown, key: string): string => (e !== null && typeof e === "object" && typeof (e as Record<string, unknown>)[key] === "string" ? ((e as Record<string, string>)[key] as string) : "");
      if (errors.some((e) => field(e, "type") === "FORBIDDEN" || /resource not accessible by integration/i.test(field(e, "message")))) return { outcome: "refused", status: 403 };
      if (errors.some((e) => HEAD_MOVED_MESSAGE.test(field(e, "message")))) return { outcome: "head_moved" };
      throw new PlanePushGithubError("public_unavailable");
    },

    async mergePull({ codeRepo, number, sha, token }) {
      const { owner, name } = split(codeRepo);
      if (!Number.isSafeInteger(number) || number < 1 || !/^[0-9a-f]{40}$/.test(sha)) throw new PlanePushGithubError("public_unavailable");
      const res = await call("PUT", `/repos/${owner}/${name}/pulls/${number}/merge`, token, { sha, merge_method: "squash" });
      const merged = res.status === 200 && res.body !== null && typeof res.body === "object" && (res.body as { merged?: unknown }).merged === true;
      return { status: res.status, merged };
    },

    async revokeToken(token) {
      try {
        const res = await call("DELETE", "/installation/token", token);
        return res.status === 204 || res.status === 401;
      } catch {
        // fx-swallow-ok: a revoke that cannot be made is reported as false; the token lapses at the host's fixed expiry
        return false;
      }
    },
  };
}

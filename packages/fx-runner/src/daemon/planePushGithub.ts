/**
 * D#598 P1f-3: the three GitHub API calls the run-end hook makes to the paired PUBLIC repository with its one restricted token, and nothing else:
 *
 *   branchExists     `GET /repos/<o>/<n>/git/ref/heads/<branch>`: a branch that exists is never pushed over.
 *   branchHead       the same read, answering the head: an update of a branch the platform pushed checks it before and after.
 *   openPullRequest  `POST /repos/<o>/<n>/pulls`: the one call that makes the pushed branch a pull request.
 *   revokeToken      `DELETE /installation/token` with the token itself as the bearer: 204, and the token answers 401 afterwards.
 *
 * The token is minted on the cloud side and travels here in the token reply; it is used as a bearer for these calls and, through the transport, as
 * the push header, and for nothing else. Every path is built here from a validated owner, name and branch. Redirects are an error, every call has a
 * timeout, and no error carries a token, a header, a request body or GitHub's text: a failure carries a closed `code` from the route's refusal list.
 *
 * The host is `https://api.github.com`. An origin can be given for a test server only, and only as `http://` on loopback (the same allowance the
 * push transport makes).
 */

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
}

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

export interface PlanePushGithub {
  branchExists(input: { codeRepo: string; branch: string; token: string }): Promise<boolean>;
  openPullRequest(input: { codeRepo: string; branch: string; base: string; title: string; body: string; token: string }): Promise<{ number: number; url: string }>;
  /** The branch's head (a full commit id), or null when it does not exist. */
  branchHead(input: { codeRepo: string; branch: string; token: string }): Promise<string | null>;
  /** True on GitHub's 204 and on a 401 (already gone). Anything else, or no answer, is false: the token then lapses at its own expiry. Never throws. */
  revokeToken(token: string): Promise<boolean>;
}

export function createPlanePushGithub(deps: PlanePushGithubDeps = {}): PlanePushGithub {
  const fetchFn = deps.fetchFn ?? fetch;
  const origin = checkOrigin(deps.apiOrigin ?? "https://api.github.com");
  const timeoutMs = deps.timeoutMs ?? CALL_TIMEOUT_MS;

  async function call(method: "GET" | "POST" | "DELETE", path: string, token: string, body?: unknown): Promise<{ status: number; body: unknown }> {
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

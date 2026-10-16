/**
 * D#598 P5b: the GitHub calls the plan write-back makes on the repo that holds the plan file, and nothing else. REST only, no clone: the
 * write-back is one file, so it is made with GitHub's contents API from the hosted side (R-598-P5b-5).
 *
 * Transport is injected (`WritebackHttp`): the composition root owns the App installation token (contents and pull_requests write on this
 * one repository) and the real `fetch`, as for the merge gate's port. This file reads no environment and adds no dependency. It is its
 * own interface, not `GitHubHttp`, because closing a pull request is a PATCH and removing the platform's own branch is a DELETE.
 *
 * Every method fails closed: an unexpected status, or a response of the wrong shape, throws a `WritebackGitHubError` with a fixed `code`.
 * No error carries GitHub's text, a path, a header or a body, and no response field is read except the structured ones named below.
 * Nothing here ever writes to the default branch: the write methods (createBranch, putFile, openPull's head, deleteBranch) accept only a
 * branch under PLAN_UPDATE_BRANCH_PREFIX, never the default branch, and refuse anything else with `bad_input` before any request is made.
 */

/** The only namespace the platform writes to. The column check on `plan_writebacks.branch` (migration 0825) is the same prefix. */
export const PLAN_UPDATE_BRANCH_PREFIX = "fulcrumaxe/plan-update-";

export interface WritebackHttpRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Readonly<Record<string, string | number>>;
  body?: unknown;
}

export interface WritebackHttp {
  /** Resolves for ANY HTTP status; rejects only on a transport failure. */
  request(req: WritebackHttpRequest): Promise<{ status: number; body: unknown }>;
}

export type WritebackGitHubFailure = "unavailable" | "bad_response" | "branch_exists" | "conflict" | "rejected" | "file_too_large" | "bad_input";

export class WritebackGitHubError extends Error {
  constructor(readonly code: WritebackGitHubFailure) {
    super(`plan write-back github: ${code}`);
    this.name = "WritebackGitHubError";
  }
}

export interface WritebackPull {
  number: number;
  open: boolean;
  merged: boolean;
  draft: boolean;
  headSha: string;
  headRef: string;
  baseRef: string;
  /** True when the head branch lives in the base repository (not a fork). */
  sameRepo: boolean;
}

/** What GitHub says about the commits `head` has that `base` does not (the three-dot compare). */
export interface WritebackComparison {
  /** The best common ancestor of the two. */
  mergeBaseSha: string;
  aheadBy: number;
  behindBy: number;
  /** The paths that differ between the merge base and `head`. */
  files: string[];
  /** The commit messages of the commits `head` has on top of the merge base, oldest first. */
  messages: string[];
  /**
   * Who made those commits, in the same order: the author's and the committer's email as the compare response gives them (lower-cased),
   * or null when a field is missing or not a string. A null never matches the platform's identity.
   */
  identities: Array<{ authorEmail: string | null; committerEmail: string | null }>;
}

export interface WritebackFile {
  text: string;
  /** The file's blob sha, which the contents API needs to replace it. */
  blobSha: string;
}

export interface WritebackGitHub {
  /** A file at a ref, or null when it is not there. Over `maxBytes`, or too large for the contents API to inline, is `file_too_large`. */
  readFile(path: string, ref: string, maxBytes: number): Promise<WritebackFile | null>;
  /** The head sha of `refs/heads/<branch>`, or null when there is no such branch. */
  readBranchHead(branch: string): Promise<string | null>;
  /** Creates `refs/heads/<branch>` at `sha`. A branch that already exists is `branch_exists`; nothing is moved. */
  createBranch(branch: string, sha: string): Promise<void>;
  /**
   * Replaces one file on a branch with one new commit and answers that commit's sha and its PARENT's sha. `blobSha` must be the file's
   * current blob. The contents API checks only the file's blob, not the branch tip, so the caller compares `parentSha` with the head it
   * expected: a different parent means another identity pushed first and this commit sits on top of theirs.
   */
  putFile(input: { path: string; branch: string; text: string; blobSha: string; message: string }): Promise<{ commitSha: string; parentSha: string }>;
  /** Compares two commit shas (`base...head`). Read only. */
  compare(base: string, head: string): Promise<WritebackComparison>;
  openPull(input: { branch: string; base: string; title: string; body: string }): Promise<{ number: number }>;
  readPull(number: number): Promise<WritebackPull>;
  /** The pull request whose head is this branch of the same repository (any state), or null. */
  findPullByBranch(branch: string): Promise<WritebackPull | null>;
  closePull(number: number): Promise<void>;
  /** Deletes `refs/heads/<branch>`; a branch that is already gone is fine. */
  deleteBranch(branch: string): Promise<void>;
}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;
const SHA = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const REPO_PATH = /^[A-Za-z0-9._-][A-Za-z0-9._/-]{0,199}$/;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const segments = (s: string): string => s.split("/").map(encodeURIComponent).join("/");

function bad(): never {
  throw new WritebackGitHubError("bad_response");
}

export function createWritebackGitHub(deps: { http: WritebackHttp; owner: string; name: string; defaultBranch?: string }): WritebackGitHub {
  const { http, owner, name } = deps;
  if (!NAME.test(owner) || !NAME.test(name) || name === "." || name === "..") throw new WritebackGitHubError("bad_input");
  const repo = `/repos/${owner}/${name}`;
  const fullName = `${owner}/${name}`.toLowerCase();

  const branchOk = (b: string): void => {
    if (!BRANCH.test(b) || b.includes("..") || b.endsWith("/") || b.endsWith(".lock")) throw new WritebackGitHubError("bad_input");
  };
  // Write allowlist: the platform's own namespace, and never the default branch (whose name the caller may pass in `defaultBranch`).
  const writeBranchOk = (b: string): void => {
    branchOk(b);
    if (!b.startsWith(PLAN_UPDATE_BRANCH_PREFIX) || b === deps.defaultBranch) throw new WritebackGitHubError("bad_input");
  };
  const shaOk = (s: string): void => {
    if (!SHA.test(s)) throw new WritebackGitHubError("bad_input");
  };
  const pathOk = (p: string): void => {
    if (!REPO_PATH.test(p) || p.split("/").some((s) => s === "" || s === "." || s === "..")) throw new WritebackGitHubError("bad_input");
  };

  async function send(req: WritebackHttpRequest): Promise<{ status: number; body: unknown }> {
    try {
      return await http.request(req);
    } catch {
      // fx-swallow-ok: replaced by a fixed code; the transport's own error text can carry the request URL
      throw new WritebackGitHubError("unavailable");
    }
  }

  // A 403 is either a refusal (no permission, protected branch) or GitHub's secondary rate limit, which clears by itself. Only the
  // structured `message` of a 403 is looked at, to tell the two apart; it is never kept.
  const isSecondaryRateLimit = (res: { status: number; body: unknown }): boolean =>
    res.status === 403 && isObj(res.body) && typeof res.body.message === "string" && /rate limit/i.test(res.body.message);
  const unexpected = (res: { status: number; body: unknown }): never => {
    throw new WritebackGitHubError(res.status >= 500 || res.status === 429 || isSecondaryRateLimit(res) ? "unavailable" : "rejected");
  };

  function toPull(b: unknown, merged?: boolean): WritebackPull {
    if (!isObj(b) || typeof b.number !== "number" || !Number.isSafeInteger(b.number)) return bad();
    const head = b.head;
    const base = b.base;
    if (!isObj(head) || typeof head.sha !== "string" || !SHA.test(head.sha) || typeof head.ref !== "string") return bad();
    if (!isObj(base) || typeof base.ref !== "string" || base.ref === "") return bad();
    if (b.state !== "open" && b.state !== "closed") return bad();
    const headRepo = isObj(head.repo) && typeof head.repo.full_name === "string" ? head.repo.full_name.toLowerCase() : null;
    const baseRepo = isObj(base.repo) && typeof base.repo.full_name === "string" ? base.repo.full_name.toLowerCase() : null;
    const wasMerged = merged ?? (b.merged === true || typeof b.merged_at === "string");
    return {
      number: b.number,
      open: b.state === "open",
      merged: wasMerged,
      // Anything other than an explicit false reads as a draft.
      draft: b.draft !== false,
      headSha: head.sha,
      headRef: head.ref,
      baseRef: base.ref,
      sameRepo: headRepo !== null && headRepo === baseRepo && baseRepo === fullName,
    };
  }

  return {
    async readFile(path, ref, maxBytes) {
      pathOk(path);
      if (!(SHA.test(ref) || BRANCH.test(ref))) throw new WritebackGitHubError("bad_input");
      const res = await send({ method: "GET", path: `${repo}/contents/${segments(path)}`, query: { ref } });
      if (res.status === 404) return null;
      if (res.status !== 200) return unexpected(res);
      const b = res.body;
      if (!isObj(b) || b.type !== "file" || typeof b.sha !== "string" || typeof b.size !== "number") return bad();
      if (b.size > maxBytes) throw new WritebackGitHubError("file_too_large");
      // A file the contents API will not inline (about 1 MB and up) answers an empty body with encoding "none": read as too large.
      if (b.encoding !== "base64" || typeof b.content !== "string") throw new WritebackGitHubError("file_too_large");
      const bytes = Buffer.from(b.content.replace(/\n/g, ""), "base64");
      if (bytes.length !== b.size) return bad();
      return { text: bytes.toString("utf8"), blobSha: b.sha };
    },

    async readBranchHead(branch) {
      branchOk(branch);
      const res = await send({ method: "GET", path: `${repo}/git/ref/heads/${segments(branch)}` });
      if (res.status === 404) return null;
      if (res.status !== 200) return unexpected(res);
      const obj = isObj(res.body) ? res.body.object : undefined;
      if (!isObj(obj) || typeof obj.sha !== "string" || !SHA.test(obj.sha)) return bad();
      return obj.sha;
    },

    async createBranch(branch, sha) {
      writeBranchOk(branch);
      shaOk(sha);
      const res = await send({ method: "POST", path: `${repo}/git/refs`, body: { ref: `refs/heads/${branch}`, sha } });
      if (res.status === 201) return;
      if (res.status === 422) throw new WritebackGitHubError("branch_exists");
      return unexpected(res);
    },

    async putFile(input) {
      writeBranchOk(input.branch);
      pathOk(input.path);
      shaOk(input.blobSha);
      const res = await send({
        method: "PUT",
        path: `${repo}/contents/${segments(input.path)}`,
        body: { message: input.message, content: Buffer.from(input.text, "utf8").toString("base64"), branch: input.branch, sha: input.blobSha },
      });
      if (res.status === 409 || res.status === 422) throw new WritebackGitHubError("conflict");
      if (res.status !== 200 && res.status !== 201) return unexpected(res);
      const commit = isObj(res.body) ? res.body.commit : undefined;
      if (!isObj(commit) || typeof commit.sha !== "string" || !SHA.test(commit.sha)) return bad();
      const parent = Array.isArray(commit.parents) ? commit.parents[0] : undefined;
      if (!isObj(parent) || typeof parent.sha !== "string" || !SHA.test(parent.sha)) return bad();
      return { commitSha: commit.sha, parentSha: parent.sha };
    },

    async compare(base, head) {
      shaOk(base);
      shaOk(head);
      const res = await send({ method: "GET", path: `${repo}/compare/${base}...${head}` });
      if (res.status !== 200) return unexpected(res);
      const b = res.body;
      const mb = isObj(b) ? b.merge_base_commit : undefined;
      if (!isObj(b) || !isObj(mb) || typeof mb.sha !== "string" || !SHA.test(mb.sha)) return bad();
      if (typeof b.ahead_by !== "number" || typeof b.behind_by !== "number" || !Array.isArray(b.files) || !Array.isArray(b.commits)) return bad();
      const files = b.files.map((f) => (isObj(f) && typeof f.filename === "string" ? f.filename : bad()));
      const messages = b.commits.map((c) => (isObj(c) && isObj(c.commit) && typeof c.commit.message === "string" ? c.commit.message : bad()));
      const email = (who: unknown): string | null => (isObj(who) && typeof who.email === "string" && who.email !== "" ? who.email.toLowerCase() : null);
      const identities = b.commits.map((c) =>
        isObj(c) && isObj(c.commit) ? { authorEmail: email(c.commit.author), committerEmail: email(c.commit.committer) } : bad(),
      );
      return { mergeBaseSha: mb.sha, aheadBy: b.ahead_by, behindBy: b.behind_by, files, messages, identities };
    },

    async openPull(input) {
      writeBranchOk(input.branch);
      branchOk(input.base);
      const res = await send({
        method: "POST",
        path: `${repo}/pulls`,
        body: { title: input.title, head: input.branch, base: input.base, body: input.body, maintainer_can_modify: false, draft: false },
      });
      if (res.status !== 201) return unexpected(res);
      const n = isObj(res.body) ? res.body.number : undefined;
      if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) return bad();
      return { number: n };
    },

    async readPull(number) {
      if (!Number.isSafeInteger(number) || number < 1) throw new WritebackGitHubError("bad_input");
      const res = await send({ method: "GET", path: `${repo}/pulls/${number}` });
      if (res.status !== 200) return unexpected(res);
      return toPull(res.body);
    },

    async findPullByBranch(branch) {
      branchOk(branch);
      const res = await send({ method: "GET", path: `${repo}/pulls`, query: { head: `${owner}:${branch}`, state: "all", per_page: 5 } });
      if (res.status !== 200 || !Array.isArray(res.body)) return unexpected(res);
      const found = res.body.map((p) => toPull(p)).filter((p) => p.headRef === branch && p.sameRepo);
      return found[0] ?? null;
    },

    async closePull(number) {
      if (!Number.isSafeInteger(number) || number < 1) throw new WritebackGitHubError("bad_input");
      const res = await send({ method: "PATCH", path: `${repo}/pulls/${number}`, body: { state: "closed" } });
      if (res.status !== 200) return unexpected(res);
    },

    async deleteBranch(branch) {
      writeBranchOk(branch);
      const res = await send({ method: "DELETE", path: `${repo}/git/refs/heads/${segments(branch)}` });
      if (res.status === 204 || res.status === 404 || res.status === 422) return;
      return unexpected(res);
    },
  };
}

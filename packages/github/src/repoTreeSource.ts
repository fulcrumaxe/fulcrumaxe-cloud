import type { InstallationHttp } from "./installationHttp.js";

/**
 * D#600 CX-3a: the GitHub reads behind the prompt's repository map, over a `repo_map` client (installationHttp.ts): the default
 * branch's head commit, the recursive tree at a commit, and a manifest's text. Nothing here reads a commit, a pull request or a file by
 * path; the client's own exact list refuses those before a token is used.
 *
 * Answers are structured fields only. A response of the wrong shape is "nothing" (null), never a guess; an unexpected status THROWS a
 * fixed-message error (no body, no token). `truncated: true` from the trees API is passed on, not hidden: GitHub cuts a very large tree.
 */
export interface RepoTreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  /** A blob's size in bytes as the trees API reports it (D#600 CX-5a: the pins budget check). Absent for a tree or commit entry, or when GitHub sent no whole number. */
  size?: number;
}
export interface RepoTree {
  /** GitHub cut the listing (more than about 100,000 entries or 7 MB). */
  truncated: boolean;
  entries: RepoTreeEntry[];
}
export interface RepoTreeSource {
  /** The head commit of the default branch, or null (empty repository, odd branch name). */
  headSha(): Promise<string | null>;
  /** The whole tree at `sha` (a commit or tree id), or null when GitHub has none. */
  tree(sha: string): Promise<RepoTree | null>;
  /** A blob's text, or null when it is missing, over `BLOB_MAX_BYTES` or not UTF-8. */
  blob(sha: string): Promise<string | null>;
}

export const BLOB_MAX_BYTES = 65_536;
const SHA_RE = /^[0-9a-f]{40}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export function createRepoTreeSource(http: InstallationHttp, repo: { owner: string; name: string }): RepoTreeSource {
  const root = `/repos/${repo.owner}/${repo.name}`;
  const get = async (path: string, query?: Record<string, string | number>) => {
    const res = await http.request({ method: "GET", path, ...(query ? { query } : {}) });
    if (res.status === 404 || res.status === 409 || res.status === 422) return null;
    if (res.status !== 200) throw new Error(`repoTreeSource: status_${res.status}`);
    return res.body;
  };

  return {
    async headSha() {
      const info = await get(root);
      const branch = isObj(info) ? info.default_branch : undefined;
      if (typeof branch !== "string" || !BRANCH_RE.test(branch) || branch.includes("..")) return null;
      const ref = await get(`${root}/git/ref/heads/${branch}`);
      const sha = isObj(ref) && isObj(ref.object) ? ref.object.sha : undefined;
      return typeof sha === "string" && SHA_RE.test(sha) ? sha : null;
    },
    async tree(sha) {
      if (!SHA_RE.test(sha)) return null;
      const body = await get(`${root}/git/trees/${sha}`, { recursive: 1 });
      if (!isObj(body) || !Array.isArray(body.tree)) return null;
      const entries: RepoTreeEntry[] = [];
      for (const e of body.tree as unknown[]) {
        if (isObj(e) && typeof e.path === "string" && (e.type === "blob" || e.type === "tree" || e.type === "commit") && typeof e.sha === "string" && SHA_RE.test(e.sha)) {
          const size = e.type === "blob" && typeof e.size === "number" && Number.isSafeInteger(e.size) && e.size >= 0 ? e.size : undefined;
          entries.push(size === undefined ? { path: e.path, type: e.type, sha: e.sha } : { path: e.path, type: e.type, sha: e.sha, size });
        }
      }
      return { truncated: body.truncated === true, entries };
    },
    async blob(sha) {
      if (!SHA_RE.test(sha)) return null;
      const body = await get(`${root}/git/blobs/${sha}`);
      if (!isObj(body) || body.encoding !== "base64" || typeof body.content !== "string" || typeof body.size !== "number" || body.size > BLOB_MAX_BYTES) return null;
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(body.content, "base64"));
      } catch {
        // fx-swallow-ok: a blob that is not UTF-8 text reads as null, which the map treats as "no manifest here"
        return null;
      }
    },
  };
}

/**
 * The branch cleanup sweep's second job: close the private copy of a paired item's pull request once the public pull request is done.
 *
 * A paired item's run branch (`fx/<run>-g<n>`) is opened as a pull request on the private repository so the reviewers have something to judge; the
 * pull request that merges is the public one. When the public one has merged or closed, the private copy has no further purpose and must not stay open.
 * This file decides and acts for ONE recorded private pull request; the sweep (branchCleanup.ts) supplies the facts from the database.
 *
 * What is closed: the pull request the run recorded at `done` (its number), only when GitHub shows it open with exactly the head the cloud recorded for the
 * run (the same head the branch delete requires). A head that moved is a person's or a later push's work and is left. An item whose public branch a person
 * took over is left whole. A public pull request that is still open is never a reason to close the copy.
 *
 * Which client: the same one for both modes, opened by the caller. For a `runner_local` repository the caller wraps it in the local-only fence, so the only
 * calls made are the fence's A3 (list the pull requests of one head, which returns numbers, states and shas, never a patch) and A5 (close). Nothing outside
 * the allowlist is ever asked of such a repository. The cloud-mode client is the cloud's pull-request installation client (the one that may PATCH a pull request;
 * the `merge_gate` client may not).
 */

export interface PrCloseHttp {
  request(req: { method: "GET" | "PATCH"; path: string; query?: Readonly<Record<string, string | number>>; body?: unknown }): Promise<{ status: number; body: unknown }>;
}
/** Opens that client. `executionMode` is the side that built the pull request (it decides the fence). */
export type PrCloseOpen = (executionMode: string, target: { repoId: string; owner: string; name: string }) => Promise<PrCloseHttp>;

export type PrCloseOutcome = "private_pr_closed" | "private_pr_already_closed" | "private_pr_left_head_moved" | "private_pr_left_person_managed" | "private_pr_not_found";

/** The state of the public pull request, from the push record (`plane_pushes`). */
export type PublicPrState = "open" | "done" | "person_managed";

export interface PrCloseTarget {
  repo: { id: string; owner: string; name: string };
  number: number;
  branch: string;
  /** The head the cloud recorded for the run. */
  sha: string;
  /** The side that built the pull request. */
  executionMode: string;
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

/** Thrown when the public pull request is still open: not an error, the item is looked at again after the backoff. */
export class PublicPrStillOpen extends Error {
  constructor() {
    super("public pull request still open");
    this.name = "PublicPrStillOpen";
  }
}

/** Any answer that cannot be trusted. A fixed code only; GitHub's text is never kept. */
export class PrCloseError extends Error {
  constructor(readonly code: "github_unavailable" | "malformed") {
    super(`private pr close: ${code}`);
    this.name = "PrCloseError";
  }
}

export async function closePrivateCopy(open: PrCloseOpen, publicState: PublicPrState, t: PrCloseTarget): Promise<PrCloseOutcome> {
  if (publicState === "person_managed") return "private_pr_left_person_managed";
  if (publicState === "open") throw new PublicPrStillOpen();
  if (!OWNER_RE.test(t.repo.owner) || !NAME_RE.test(t.repo.name) || !SHA.test(t.sha) || !Number.isSafeInteger(t.number) || t.number <= 0) throw new PrCloseError("malformed");
  const http = await open(t.executionMode, { repoId: t.repo.id, owner: t.repo.owner, name: t.repo.name });
  const base = `/repos/${t.repo.owner}/${t.repo.name}`;
  const list = await http.request({ method: "GET", path: `${base}/pulls`, query: { state: "all", head: `${t.repo.owner}:${t.branch}`, per_page: 30 } });
  if (list.status !== 200) throw new PrCloseError("github_unavailable");
  if (!Array.isArray(list.body)) throw new PrCloseError("malformed");
  const here = `${t.repo.owner}/${t.repo.name}`.toLowerCase();
  let found: Json | null = null;
  for (const p of list.body) {
    if (!isObj(p) || !isObj(p.head)) throw new PrCloseError("malformed");
    const headRepo = p.head.repo;
    // Only a branch of this repository with exactly this name, and only the recorded number.
    if (!isObj(headRepo) || typeof headRepo.full_name !== "string" || headRepo.full_name.toLowerCase() !== here || p.head.ref !== t.branch) continue;
    if (p.number === t.number) found = p;
  }
  if (found === null) return "private_pr_not_found";
  if (found.state === "closed") return "private_pr_already_closed";
  if (found.state !== "open") throw new PrCloseError("malformed");
  const head = isObj(found.head) ? found.head.sha : undefined;
  if (typeof head !== "string" || !SHA.test(head)) throw new PrCloseError("malformed");
  if (head !== t.sha) return "private_pr_left_head_moved";
  const res = await http.request({ method: "PATCH", path: `${base}/pulls/${t.number}`, body: { state: "closed" } });
  if (res.status !== 200) throw new PrCloseError("github_unavailable");
  if (!isObj(res.body) || res.body.number !== t.number || res.body.state !== "closed") throw new PrCloseError("malformed");
  return "private_pr_closed";
}

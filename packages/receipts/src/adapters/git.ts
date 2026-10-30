import { DELETABLE_BRANCH, openRevertPullRequest, type InstallationHttp, type InstallationHttpKind, type InstallationHttpTarget } from "@fx/github";
import type { GitPort, GitRefusal, GitResult, PullRequestRef } from "../ports.js";

/**
 * The real GitPort (D#7 DP7-2d), for ONE item's repository. It deletes no branch and writes no ref: it closes a pull request, or opens a revert.
 *
 * `rerunAfterBuild` closes the item's pull request only while GitHub shows it open at exactly the head the run recorded, the guard the branch sweep's
 * private-copy close applies (packages/worker/src/privatePrClose.ts, which this package cannot import): the pull request is found by listing its head
 * branch, so the only calls are a list and a close, which is what the local-only fence admits for a `runner_local` repository. A head that moved is a
 * person's or a later push's work, and an item whose public branch a person took over is left whole; neither is closed. The branch is kept.
 *
 * `openRevertPr` is `openRevertPullRequest` (packages/github/src/revertPr.ts) over the revert installation client: a draft revert for the customer to review.
 *
 * Every refusal is a fixed code; no GitHub text is kept. A shape that cannot be trusted is `unavailable`.
 */

/** The pull-request client: list one head branch's pull requests, and close one. */
export interface PullsHttp {
  request(req: { method: "GET" | "PATCH"; path: string; query?: Readonly<Record<string, string | number>>; body?: unknown }): Promise<{ status: number; body: unknown }>;
  close?(): Promise<void>;
}

export interface GitPortDeps {
  repo: { id: string; owner: string; name: string };
  /** The head branch of the item's pull request, as its run recorded it; null when none was recorded. */
  branch: string | null;
  /** Opens this repository's pull-request client (the cloud's pull-request installation client, behind the local-only fence for `runner_local`). */
  openPulls: () => Promise<PullsHttp>;
  /** The installation client opener `openRevertPullRequest` asks for its one revert client (packages/github `createInstallationHttp`). */
  openRevert: (kind: InstallationHttpKind, target: InstallationHttpTarget) => Promise<InstallationHttp>;
  /** Whether a person took the item's public branch over: `readPersonManaged`, read when the reversal runs. */
  personManaged: () => Promise<boolean>;
}

/** The item's newest push record, read as the branch sweep reads it: a takeover stamp, or the takeover state. */
export const PERSON_MANAGED_SQL = `SELECT (p.managed_by_person_at IS NOT NULL OR p.state = 'managed_by_person') AS managed
  FROM plane_pushes p WHERE p.account_id = $1 AND p.work_item_id = $2 ORDER BY p.created_at DESC, p.id DESC LIMIT 1`;

/** True when a person took the item's public branch over. `client` is a `withTenant` client of the item's account. An item with no push record: false. */
export async function readPersonManaged(client: { query<R>(sql: string, params: unknown[]): Promise<{ rows: R[] }> }, accountId: string, workItemId: string): Promise<boolean> {
  const { rows } = await client.query<{ managed: boolean }>(PERSON_MANAGED_SQL, [accountId, workItemId]);
  return rows[0]?.managed === true;
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const refuse = (code: GitRefusal): { ok: false; code: GitRefusal } => ({ ok: false, code });

export function createGitPort(deps: GitPortDeps): GitPort {
  const { owner, name } = deps.repo;
  if (!OWNER_RE.test(owner) || !NAME_RE.test(name)) throw new TypeError("repository is not a valid owner/name");
  const here = `${owner}/${name}`.toLowerCase();
  const base = `/repos/${owner}/${name}`;
  const check = (ref: PullRequestRef): void => {
    if (ref.repo.toLowerCase() !== here) throw new TypeError("pull request is not of this repository");
    if (!Number.isSafeInteger(ref.number) || ref.number <= 0) throw new TypeError("pull request number is not a positive integer");
  };

  return {
    async rerunAfterBuild(input): Promise<GitResult<{ closed: true }>> {
      check(input);
      if (!SHA.test(input.headSha)) throw new TypeError("headSha is not a 40 character sha");
      if (await deps.personManaged()) return refuse("person_managed");
      const branch = deps.branch;
      if (branch === null || !DELETABLE_BRANCH.test(branch)) return refuse("unavailable");
      let http: PullsHttp;
      try {
        http = await deps.openPulls();
      } catch {
        // fx-swallow-ok: no installation, a refused mint or a transport failure is one fixed code; its text is never passed on
        return refuse("unavailable");
      }
      try {
        const list = await http.request({ method: "GET", path: `${base}/pulls`, query: { state: "all", head: `${owner}:${branch}`, per_page: 30 } });
        if (list.status !== 200 || !Array.isArray(list.body)) return refuse("unavailable");
        let found: Json | null = null;
        for (const p of list.body) {
          if (!isObj(p) || !isObj(p.head)) return refuse("unavailable");
          const headRepo = p.head.repo;
          // Only a branch of this repository with exactly this name, and only the recorded number.
          if (!isObj(headRepo) || typeof headRepo.full_name !== "string" || headRepo.full_name.toLowerCase() !== here || p.head.ref !== branch) continue;
          if (p.number === input.number) found = p;
        }
        if (found === null || found.state === "closed") return refuse("not_open");
        if (found.state !== "open") return refuse("unavailable");
        const head = isObj(found.head) ? found.head.sha : undefined;
        if (typeof head !== "string" || !SHA.test(head)) return refuse("unavailable");
        if (head !== input.headSha) return refuse("stale_head");
        const res = await http.request({ method: "PATCH", path: `${base}/pulls/${input.number}`, body: { state: "closed" } });
        if (res.status !== 200 || !isObj(res.body) || res.body.number !== input.number || res.body.state !== "closed") return refuse("unavailable");
        return { ok: true, closed: true };
      } catch {
        // fx-swallow-ok: a refused request or a transport failure is one fixed code; the error's text can carry request details
        return refuse("unavailable");
      } finally {
        await http.close?.();
      }
    },

    async openRevertPr(input): Promise<GitResult<{ number: number }>> {
      check(input);
      const r = await openRevertPullRequest({ open: deps.openRevert }, { repo: deps.repo, prNumber: input.number });
      if (r.ok) return { ok: true, number: r.number };
      return refuse(r.code === "not_merged" || r.code === "revert_refused" ? r.code : "unavailable");
    },
  };
}

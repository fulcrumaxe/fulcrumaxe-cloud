/**
 * D#7 DP7-2g: where a revert pull request stands on GitHub right now, read when the receipts are listed and never stored. The customer may close, reopen or
 * merge the revert at any time, so the compensation row's `done` (a one-time stamp: the revert was opened) is never the answer to "is it still there".
 *
 *   - one `GET /repos/<owner>/<name>/pulls/<n>` per revert row, through the read-only installation client (the `read` kind: metadata and pull requests, GET only);
 *   - the answer is one of four fixed words. A merged pull request is `merged`, an open one `open`, a closed one that never merged `closed_unmerged`;
 *     anything else (a missing repository, a bad status, a body that is not a pull request, a timeout, a thrown error) is `unknown`, never a guess;
 *   - nothing GitHub says is passed on: not its title, its body, its message or its URL.
 */
export type RevertPrState = "open" | "merged" | "closed_unmerged" | "unknown";

/** What the list asks of the web app: one revert pull request of one of the account's repositories. */
export interface PrStateReader {
  stateOf(input: { accountId: string; repoId: string; prNumber: number }): Promise<RevertPrState>;
}

/** The one call the reader makes. Narrower than the installation client on purpose. */
export interface PullReadHttp {
  request(req: { method: "GET"; path: string }): Promise<{ status: number; body: unknown }>;
}

/** How long one read may take before the card is told `unknown`. The list waits for all of them in parallel, so this is also the most a list adds. */
export const PR_STATE_TIMEOUT_MS = 3000;

/** Pure: the answer for a GitHub pull request response. */
export function prStateFromPull(status: number, body: unknown): RevertPrState {
  if (status !== 200 || typeof body !== "object" || body === null) return "unknown";
  const pr = body as { state?: unknown; merged?: unknown; merged_at?: unknown };
  if (pr.merged === true || (typeof pr.merged_at === "string" && pr.merged_at.length > 0)) return "merged";
  if (pr.state === "open") return "open";
  if (pr.state === "closed") return "closed_unmerged";
  return "unknown";
}

/** Bounds a read: it never rejects, and a read that outlives `ms` is `unknown`. */
export async function boundedPrState(read: () => Promise<RevertPrState>, ms: number = PR_STATE_TIMEOUT_MS): Promise<RevertPrState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read().catch((): RevertPrState => "unknown"),
      new Promise<RevertPrState>((resolve) => { timer = setTimeout(() => resolve("unknown"), ms); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * The reader behind the list. `resolveRepo` gives the repository's owner and name from our own row, matched on the account as well as the id (null when it
 * is gone); `open` gives the read client for it. Both are the web app's.
 */
export function createPrStateReader(deps: {
  resolveRepo(input: { accountId: string; repoId: string }): Promise<{ owner: string; name: string } | null>;
  open(repo: { repoId: string; owner: string; name: string }): Promise<PullReadHttp>;
  timeoutMs?: number;
}): PrStateReader {
  return {
    stateOf: ({ accountId, repoId, prNumber }) =>
      boundedPrState(async () => {
        if (!Number.isSafeInteger(prNumber) || prNumber < 1) return "unknown";
        const repo = await deps.resolveRepo({ accountId, repoId });
        if (repo === null || !OWNER_RE.test(repo.owner) || !NAME_RE.test(repo.name)) return "unknown";
        const http = await deps.open({ repoId, owner: repo.owner, name: repo.name });
        const res = await http.request({ method: "GET", path: `/repos/${repo.owner}/${repo.name}/pulls/${prNumber}` });
        return prStateFromPull(res.status, res.body);
      }, deps.timeoutMs),
  };
}

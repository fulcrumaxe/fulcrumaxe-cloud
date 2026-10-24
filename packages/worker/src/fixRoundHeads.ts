import type { Pool } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { recordDriverEvent } from "@fx/core/src/work-items/driverEvents.js";
import { PUBLIC_BRANCH_MOVED, PUBLIC_HEAD_UNAVAILABLE, readPlanePush, type BranchHeadPort } from "@fx/core/src/repos/planePushRecord.js";

/**
 * FIXROUND-REFRESH-HEAD: what a fix round checks on GitHub before it starts anything.
 *
 * A pull request's branch can move while the cloud is not looking (a person presses "Update branch", and the webhook that would have told us is lost).
 * A round built on the head the cloud last recorded would then start from a stale commit, and its push would not be a fast-forward.
 *
 *  - The private pull request: its branch head is read through the same port the job issuer uses for a continuation's base (`ContinuationBasePort`, the
 *    runner pull-request installation token). A head that differs from the one the round was asked for is recorded as the webhook would have recorded it (a
 *    `pr_head_pushed` fact, code `observed`), and the round goes on: the issuer reads the branch again at dispatch, and the runner resumes a kept workspace
 *    only when it is exactly at that tip (fx-runner gitPath `resume`), so the round starts from the latest commit. Asked for runner rounds only: those are
 *    the rounds that continue a branch through that port.
 *  - The paired public pull request (a repository with a pairing, whose item already pushed): the public branch is read (a `plane_push`
 *    token minted and revoked around the read, outside any transaction) and compared with the stamp, as `derivePlanePush` does. A head that is not the one the platform pushed means someone changed the public branch outside the cloud;
 *    the cloud cannot push over it, so the round is refused `public_branch_moved` and nothing starts. The live head is recorded on a `stopped` fact; the
 *    stamp in `plane_pushes` is left alone (only a verified push moves it), so resetting the branch to the pushed head clears the refusal.
 *
 * Either read failing refuses the round with a named code; nothing ever falls back to the recorded head.
 */
export interface FixRoundHeadPorts {
  /** The private branch's head now, or null when the branch does not exist. A throw is "GitHub could not be asked". */
  privateHead?: (input: { repo: { id: string; owner: string; name: string }; branch: string }) => Promise<string | null>;
  /** The paired public branch's head now, or null when the branch does not exist. A throw is "GitHub could not be asked". */
  publicHead?: BranchHeadPort["branchHead"];
}

export const PR_HEAD_UNAVAILABLE = "pr_head_unavailable";
export const PR_BRANCH_MISSING = "pr_branch_missing";
/** The run line a round that found its branch moved carries (`run.stage`, see @fx/core previewProgress `lineFor`). */
export const BRANCH_MOVED_STAGE = "branch_moved";

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
type Who = { accountId: string; workItemId: string };

/**
 * The public side. Null when the round may go on: the item has no pairing row, has not pushed yet, or a person took the public branch over (the platform
 * pushes nothing then), or the public branch is exactly where the platform left it. Otherwise the refusal code.
 */
export async function checkPublicBranch(pool: Pool, ports: FixRoundHeadPorts | null | undefined, who: Who): Promise<string | null> {
  const row = await withTenant(pool, who.accountId, (client) => readPlanePush(client, who.accountId, who.workItemId));
  if (row === null || row.headSha === null || row.managedByPersonAt !== null) return null;
  const publicHead = ports?.publicHead;
  if (!publicHead) return PUBLIC_HEAD_UNAVAILABLE;
  // The GitHub read happens outside any transaction (no connection is held while a token is minted, used and revoked). It is the comparison
  // `derivePlanePush` makes: GitHub's head against the stamp, and the stamp is never written over.
  let live: string | null;
  try {
    live = await publicHead({ codeRepo: row.codeRepo, branch: row.branch });
  } catch {
    // fx-swallow-ok: the cause can carry a repository name or a token; only the fixed code survives
    console.warn(JSON.stringify({ event: "advance.public_head_unavailable", work_item_id: who.workItemId }));
    return PUBLIC_HEAD_UNAVAILABLE;
  }
  // Anything that is neither a commit id nor "no such branch" is not an answer: fail closed.
  if (live !== null && !SHA.test(live)) return PUBLIC_HEAD_UNAVAILABLE;
  if (live === row.headSha) return null;
  await withTenant(pool, who.accountId, (client) =>
    recordDriverEvent(client, who.accountId, {
      workItemId: who.workItemId,
      kind: "stopped",
      // One fact per change seen (pushed head to live head), so a second refusal of the same change writes nothing new.
      dedupeKey: `public_moved:${row.headSha}..${live ?? "none"}`,
      code: PUBLIC_BRANCH_MOVED,
      ...(live !== null ? { headSha: live } : {}),
      ...(row.prNumber !== null ? { prNumber: row.prNumber } : {}),
    }),
  );
  console.info(JSON.stringify({ event: "advance.public_branch_moved", work_item_id: who.workItemId }));
  return PUBLIC_BRANCH_MOVED;
}

/**
 * The private side. `{ moved }` when the round may go on (true: the head on GitHub was not the one asked for, and the move is recorded); otherwise a refusal.
 * `pr` is the pull request the round continues (number and branch); `askedHead` the head the round was asked for.
 */
export async function checkPrivateHead(
  pool: Pool,
  ports: FixRoundHeadPorts | null | undefined,
  who: Who,
  input: { repo: { id: string; owner: string; name: string }; pr: { number: number; branch: string }; askedHead: string },
): Promise<{ ok: true; moved: boolean } | { ok: false; reason: string }> {
  const privateHead = ports?.privateHead;
  if (!privateHead) return { ok: false, reason: PR_HEAD_UNAVAILABLE };
  let live: string | null;
  try {
    live = await privateHead({ repo: input.repo, branch: input.pr.branch });
  } catch {
    // fx-swallow-ok: the cause can carry a repository name or a token; only the fixed code survives
    console.warn(JSON.stringify({ event: "advance.pr_head_unavailable", work_item_id: who.workItemId }));
    return { ok: false, reason: PR_HEAD_UNAVAILABLE };
  }
  if (live === null) return { ok: false, reason: PR_BRANCH_MISSING };
  if (!SHA.test(live)) return { ok: false, reason: PR_HEAD_UNAVAILABLE };
  if (live === input.askedHead) return { ok: true, moved: false };
  // The synchronize webhook's own fact, as the verified-review gate records a push it saw itself: keyed on the change, so A, B, A is two pushes.
  await withTenant(pool, who.accountId, (client) =>
    recordDriverEvent(client, who.accountId, { workItemId: who.workItemId, kind: "pr_head_pushed", dedupeKey: `observed:${input.askedHead}..${live}`, code: "observed", headSha: live, prNumber: input.pr.number }),
  );
  console.info(JSON.stringify({ event: "advance.pr_head_moved", work_item_id: who.workItemId }));
  return { ok: true, moved: true };
}

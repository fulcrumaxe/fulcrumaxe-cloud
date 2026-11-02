import type { PlatformPush } from "./conflict.js";

/**
 * D#519 MQ5-b2: the two pure checks behind the end of a renumber round (`judgeRenumberRound` binds them to the reads). Neither reads GitHub or the database.
 */

/** The most pushes one renumber run may make between `from_sha` and the head. A longer chain fails closed. */
export const RENUMBER_PUSH_HOPS_MAX = 8;

/**
 * Rule (a) at the round's end (S-4): every commit after `from_sha` is the round's own when the push records of the round's OWN run chain from the head back to `from_sha`
 * (each record's old tip is the next record's new tip). `pushesTo(sha)` answers the platform's records whose new tip is `sha`, or null while they cannot be read.
 * A person's commit anywhere in the range leaves a break in the chain; a record of another run, or one that created the branch, is no link.
 */
export async function roundOwnPushes(
  pushesTo: (sha: string) => Promise<readonly PlatformPush[] | null>,
  round: { fromSha: string; runId: string },
  head: string,
): Promise<"ok" | "foreign" | "unread"> {
  let tip = head;
  for (let hop = 0; hop < RENUMBER_PUSH_HOPS_MAX; hop++) {
    const pushes = await pushesTo(tip);
    if (pushes === null) return "unread";
    const link = pushes.find((p) => p.newSha === tip && p.runId === round.runId && p.oldSha !== null);
    if (!link) return "foreign";
    if (link.oldSha === round.fromSha) return "ok";
    tip = link.oldSha!;
  }
  return "foreign";
}

const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/**
 * The scope test (C16-3). `changed`: the paths of the diff `from_sha..head` (a rename under both names). `renamed`: the resource files the round was asked to rename, as
 * stored when it started. `prFiles`: the paths the pull request already changed against the default branch, the only place a reference to its own new files can be.
 * In scope means: every renamed file is touched; there is exactly one new resource file for each, in the same directory as one of them; and every other changed path is one
 * the pull request already changed. A path outside that set, or an extra resource file, is out of scope.
 */
export function renumberInScope(input: { changed: readonly string[]; renamed: readonly string[]; prFiles: readonly string[]; isResource(path: string): boolean }): boolean {
  const old = new Set(input.renamed);
  const changed = new Set(input.changed);
  const pr = new Set(input.prFiles);
  const dirs = new Set(input.renamed.map(dirOf));
  const fresh = [...changed].filter((p) => input.isResource(p) && !old.has(p));
  if (old.size === 0 || ![...old].every((p) => changed.has(p)) || fresh.length !== old.size || !fresh.every((p) => dirs.has(dirOf(p)))) return false;
  return [...changed].every((p) => old.has(p) || fresh.includes(p) || pr.has(p));
}

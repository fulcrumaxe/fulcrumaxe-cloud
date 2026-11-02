/**
 * D#519 MQ4-e2-c1 (C18): the runner's attestation at the end of a merge-conflict round.
 *
 * Computed in the mirror, after the round's push, only for a job whose signed form carried `conflict_round`. Every anchor is a value the cloud signed (`from_sha`, `base_sha`), never
 * the runner's own record of where the round began. The output is closed: ids, two enums, two booleans and at most 100 paths (names, never content). Every git or log failure reads as a
 * closed negative or "unknown", never as a pass, and the function does not throw. The cloud checks what it can and judges nothing from this alone (that is MQ4-e2-c2).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ConflictAttestation, MAX_CONFLICT_ATTEST_PATHS, type JobConflictRound } from "@fulcrumaxe/runner-protocol";
import { planePushGit } from "@fulcrumaxe/runner-protocol/planePush";
import type { FactsGit } from "./conflictFacts.js";
import type { PushLog } from "./pushLog.js";

const OBJECT_ID = /^[0-9a-f]{40}$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export interface ConflictAttestInput {
  /** The daemon's mirror of the private repository: its `HEAD` is the default branch, and the round's pushed commits are in it. */
  mirrorDir: string;
  /** A directory the caller owns (the daemon's state dir); the throwaway object store is made under it and removed again. */
  scratchRoot: string;
  head: string;
  jobId: string;
  round: JobConflictRound;
  pushLog: Pick<PushLog, "records"> | undefined;
  git?: FactsGit;
}

class Unreadable extends Error {}

function names(raw: Buffer): string[] {
  const out: string[] = [];
  for (const piece of raw.toString("latin1").split("\0")) {
    if (piece === "") continue;
    try {
      out.push(UTF8.decode(Buffer.from(piece, "latin1")));
    } catch {
      // fx-swallow-ok: a name that is not UTF-8 makes the path list unreadable (truncated), never a guess
      throw new Unreadable();
    }
  }
  return out;
}

/** The attestation, or undefined when nothing could be established at all (the cloud then reads "attestation missing"). */
export async function computeConflictAttestation(input: ConflictAttestInput): Promise<ConflictAttestation | undefined> {
  const git = input.git ?? planePushGit;
  mkdirSync(input.scratchRoot, { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(path.join(input.scratchRoot, "attest-"));
  try {
    return await attest(input, git, scratch);
  } catch {
    // fx-swallow-ok: every failure is the closed answer "nothing attested"; no text of the failure is kept or sent
    return undefined;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** True on exit 0, false on exit 1 (git's "no"); anything else is unreadable. */
async function yesNo(run: () => Promise<Buffer>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (error) {
    // fx-swallow-ok: exit 1 is the "no" answer and is read from the error; any other failure is unreadable
    if ((error as { exitCode?: number | null }).exitCode === 1) return false;
    throw new Unreadable();
  }
}

async function attest(input: ConflictAttestInput, git: FactsGit, scratch: string): Promise<ConflictAttestation | undefined> {
  const { head, round } = input;
  if (!OBJECT_ID.test(head)) return undefined;
  const text = async (args: string[]): Promise<string> => (await git(input.mirrorDir, args)).toString("utf8").trim();
  const parents = (await text(["rev-list", "--parents", "-n", "1", "--end-of-options", head])).split(" ").slice(1);
  if (parents.length < 1 || parents.length > 2 || !parents.every((p) => OBJECT_ID.test(p))) return undefined;

  const descends = await yesNo(() => git(input.mirrorDir, ["merge-base", "--is-ancestor", round.from_sha, head]));
  // The log is "unknown" (null) when damaged, and a record counts only when it is this job's push of exactly this head from exactly the signed start.
  const records = input.pushLog?.records() ?? null;
  const pushed = records !== null && records.some((r) => r.job_id === input.jobId && r.new_sha === head && r.old_sha === round.from_sha);
  const defaultTip = await text(["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]);
  const onDefault = parents.length === 2 ? await yesNo(() => git(input.mirrorDir, ["merge-base", "--is-ancestor", parents[1]!, defaultTip])) : false;

  // Does the head still conflict with the default branch's tip now? A throwaway store that borrows the mirror's objects, so nothing lands in the mirror.
  let still: "yes" | "no" | "unknown" = "unknown";
  try {
    const objects = path.join(await text(["rev-parse", "--absolute-git-dir"]), "objects");
    if (!/[\r\n]/.test(objects) && OBJECT_ID.test(defaultTip)) {
      await git(scratch, ["init", "--bare", "--quiet", "--template="]);
      mkdirSync(path.join(scratch, "objects", "info"), { recursive: true });
      writeFileSync(path.join(scratch, "objects", "info", "alternates"), `${objects}\n`, { mode: 0o600 });
      still = (await yesNo(() => git(scratch, ["merge-tree", "--write-tree", "--no-messages", "--end-of-options", defaultTip, head]))) ? "no" : "yes";
    }
  } catch {
    // fx-swallow-ok: a failed probe is "unknown" and waits to the cloud's timeout; it is never read as "no"
    still = "unknown";
  }

  // The merge commit's own file list (against its first parent). Names only; more than the cap, or a name that is not plain, is `truncated` and never a pass.
  let paths: string[] = [];
  let truncated = false;
  try {
    paths = names(await git(input.mirrorDir, ["diff-tree", "-r", "-z", "--name-only", "--no-renames", "--no-commit-id", parents[0]!, head]));
    if (paths.length > MAX_CONFLICT_ATTEST_PATHS) {
      truncated = true;
      paths = paths.slice(0, MAX_CONFLICT_ATTEST_PATHS);
    }
  } catch {
    // fx-swallow-ok: an unreadable list is the closed `truncated` with no paths
    paths = [];
    truncated = true;
  }

  const body = ConflictAttestation.safeParse({
    head,
    parents,
    from_sha: round.from_sha,
    base_sha: round.base_sha,
    history: descends ? "descendant" : "not",
    pushed_by_round: pushed,
    second_parent_on_default: onDefault,
    still_conflicting: still,
    touched_paths: paths,
    truncated,
  });
  // A list the protocol refuses (a path it will not carry) is the closed `truncated` with no paths, not a dropped attestation.
  if (body.success) return body.data;
  const closed = ConflictAttestation.safeParse({ head, parents, from_sha: round.from_sha, base_sha: round.base_sha, history: descends ? "descendant" : "not", pushed_by_round: pushed, second_parent_on_default: onDefault, still_conflicting: still, touched_paths: [], truncated: true });
  return closed.success ? closed.data : undefined;
}

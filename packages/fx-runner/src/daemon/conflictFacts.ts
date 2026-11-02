/**
 * D#519 MQ4-e2-a: the runner's conflict facts for a merge call GitHub refused with 405.
 *
 * Asked only after that refusal. The fact pair is the PRIVATE pull request: the reviewed head against the private default branch (the mirror's `HEAD`).
 * `merge-tree --write-tree` runs in a throwaway object store that borrows the mirror's objects as an alternate, so nothing it writes lands in the customer's
 * mirror. The conflict paths come from its "Conflicted file info" section (`--name-only`), and rule (a) of C10 then asks, for each commit of the pull request that
 * touches a conflict path, whether a push THIS RUNNER made covers it (the push log of MQ4-RUNNER-PUSH-LOG, through the one shared `coveredCommits` walk).
 * A record says "pushed by the runner", not "authored by the runner": the commit may have been written by a person and pushed through a run.
 *
 *   conflict_platform   every commit that touches a conflict path was covered by a recorded push
 *   conflict_foreign    at least one such commit was not (a person's, or one the log no longer holds)
 *   unknown             anything this machine could not establish; nothing else is sent with it
 *   null                the merge is clean: the 405 had another cause, no field is sent and the stop stays as it is
 *
 * Nothing here reads blob content to report it: names and ids only. Every failure is `unknown`, never a guess, and the function does not throw.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PlaneMergeConflictFacts, MAX_CONFLICT_FACT_PATHS } from "@fulcrumaxe/runner-protocol";
import { coveredCommits, planePushGit } from "@fulcrumaxe/runner-protocol/planePush";
import { gitVersionAllowed } from "./git.js";
import type { PushLog } from "./pushLog.js";

/** How this module runs git: the shared pinned runner by default; a test may wrap it. A non-zero exit rejects with `exitCode` and `stdout`. */
export type FactsGit = (dir: string, args: string[], input?: string | Buffer, extraEnv?: Readonly<Record<string, string>>) => Promise<Buffer>;

export interface ConflictFactsInput {
  /** The daemon's mirror of the private repository: its `HEAD` is the private default branch. */
  privateDir: string;
  reviewedHead: string;
  /** An empty directory this call may fill; the caller removes it. */
  scratch: string;
  /** The runner's push log; undefined or closed answers `unknown`. */
  pushLog: Pick<PushLog, "records"> | undefined;
  git?: FactsGit;
}

const OBJECT_ID = /^[0-9a-f]{40}$/;
const UNKNOWN: PlaneMergeConflictFacts = { verdict: "unknown", paths: [] };
const UTF8 = new TextDecoder("utf-8", { fatal: true });

class Unknown extends Error {}

/** NUL-separated names, strictly decoded: a name that is not valid UTF-8 cannot be told apart from GitHub's reading of it. */
function names(raw: Buffer): string[] {
  const out: string[] = [];
  for (const piece of raw.toString("latin1").split("\0")) {
    if (piece === "") continue;
    try {
      out.push(UTF8.decode(Buffer.from(piece, "latin1")));
    } catch {
      // fx-swallow-ok: a name that is not UTF-8 makes the whole answer unknown
      throw new Unknown();
    }
  }
  return out;
}

export async function computeConflictFacts(input: ConflictFactsInput): Promise<PlaneMergeConflictFacts | null> {
  const git = input.git ?? planePushGit;
  try {
    return await facts(input, git);
  } catch {
    // fx-swallow-ok: every failure is the closed answer "unknown"; no text of the failure is kept or sent
    return UNKNOWN;
  }
}

async function facts(input: ConflictFactsInput, git: FactsGit): Promise<PlaneMergeConflictFacts | null> {
  const records = input.pushLog?.records();
  if (records === undefined || records === null || !OBJECT_ID.test(input.reviewedHead)) return UNKNOWN;
  // `merge-tree --write-tree` needs git 2.38; the runner's floor (MIN_GIT_VERSION) is above it, and an older git is "unknown" rather than a wrong answer.
  if (!gitVersionAllowed((await git(input.privateDir, ["--version"])).toString("utf8"))) return UNKNOWN;
  const text = async (dir: string, args: string[]): Promise<string> => (await git(dir, args)).toString("utf8").trim();
  const baseSha = await text(input.privateDir, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]);
  const baseRef = await text(input.privateDir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const objects = path.join(await text(input.privateDir, ["rev-parse", "--absolute-git-dir"]), "objects");
  if (!OBJECT_ID.test(baseSha) || baseRef === "" || /[\r\n]/.test(objects)) return UNKNOWN;

  // The throwaway store: empty, with the mirror's objects as its only alternate. Objects the merge writes stay here.
  await git(input.scratch, ["init", "--bare", "--quiet", "--template="]);
  mkdirSync(path.join(input.scratch, "objects", "info"), { recursive: true });
  writeFileSync(path.join(input.scratch, "objects", "info", "alternates"), `${objects}\n`, { mode: 0o600 });

  let conflicted: string[];
  try {
    await git(input.scratch, ["merge-tree", "--write-tree", "-z", "--name-only", "--no-messages", "--end-of-options", baseSha, input.reviewedHead]);
    return null;
  } catch (error) {
    // fx-swallow-ok: exit 1 is the conflict answer and is read from the error; any other failure is the closed answer "unknown"
    const { exitCode, stdout } = error as { exitCode?: number | null; stdout?: Buffer };
    // 1 is a conflict; anything else (no merge base, a missing object, a git that does not know the flag) is not an answer.
    if (exitCode !== 1 || stdout === undefined) return UNKNOWN;
    const [tree, ...rest] = stdout.toString("latin1").split("\0");
    if (!/^[0-9a-f]{40}$/.test(tree ?? "")) return UNKNOWN;
    conflicted = names(Buffer.from(rest.join("\0"), "latin1"));
  }
  if (conflicted.length === 0 || conflicted.length > MAX_CONFLICT_FACT_PATHS) return UNKNOWN;
  const wanted = new Set(conflicted);

  // The pull request's own commits: reachable from the reviewed head, not from the default. More than one decision reads fails closed.
  const listed = (await text(input.scratch, ["rev-list", "--parents", "--topo-order", "--max-count=101", "--end-of-options", input.reviewedHead, `^${baseSha}`])).split("\n").filter((l) => l !== "");
  const parents = new Map<string, string[]>();
  for (const line of listed) {
    const [sha, ...ps] = line.split(" ");
    if (sha === undefined || !OBJECT_ID.test(sha) || !ps.every((p) => OBJECT_ID.test(p))) return UNKNOWN;
    parents.set(sha, ps);
  }
  const shas = [...parents.keys()];
  const covered = coveredCommits(shas, parents, { pushes: records.map((r) => ({ oldSha: r.old_sha, newSha: r.new_sha, startSha: r.start })) });
  if (covered === "unreadable") return UNKNOWN;

  // Only a commit no push covers can make the verdict foreign, so only those are read for the paths they touch.
  let foreign = false;
  for (const sha of shas) {
    if (covered.has(sha)) continue;
    const touched = names(await git(input.scratch, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "-m", "--root", "--no-renames", sha]));
    if (touched.some((p) => wanted.has(p))) {
      foreign = true;
      break;
    }
  }
  const verdict = PlaneMergeConflictFacts.safeParse({ verdict: foreign ? "conflict_foreign" : "conflict_platform", paths: [...wanted].sort(), base_sha: baseSha, base_ref: baseRef });
  return verdict.success ? verdict.data : UNKNOWN;
}

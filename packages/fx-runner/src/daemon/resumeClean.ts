/**
 * D#6 RUNNER-RESUME-CLEAN: a fix round that resumes the kept workspace starts with the first round's ignored build output still in it
 * (an `apps/web/.next`, a `dist/`), and the check's guards then read stale generated files. Before a resumed run starts, this removes what git
 * itself reports as ignored, except the keep-list in `resumePurge.ts`. The list of what to remove is git's (`ls-files --others --ignored --exclude-standard
 * --directory`), not a hand-kept one; only what to KEEP is named. Untracked files that are NOT ignored are never listed by that command and are left
 * alone: they may be the agent's own work.
 *
 * The removal itself is `resumePurge.ts` (no link is followed; every entry's parent must resolve exactly under the workspace's real root; nothing outside it
 * is touched). Failures leave the entry as it is. Nothing here reaches the cloud; the log lines hold counts only.
 *
 * Linux runs it in this process (CWE-367 narrowed, not closed: Node has no unlinkat, so a live process could swap a directory for a link between the check
 * and the removal; on Linux nothing of the previous run can still be alive, because the shell sandbox's bubblewrap runs with `--unshare-pid` and
 * `--die-with-parent`). On macOS (`sandbox-exec`, no pid namespace) a process of the previous run that called setsid can outlive the engine's stop, stay
 * Seatbelt-confined to the workspace and swap a directory for a link, and this unsandboxed runner's unlink would then delete outside the workspace on its
 * behalf. So on darwin the purge runs in a child under a profile that allows writes below the workspace only (`resumePurgeSandbox.ts`): the kernel refuses
 * a redirected unlink. Without that sandboxed purge (no `sandbox-exec`, or the child failing) nothing is removed and one count-free line says so, which is how
 * a resume behaved before the clean-up existed.
 *
 * The listing is read through the large capture where the caller has one. A listing that reached its cap is cleaned, then listed again (up to
 * MAX_PASSES) as long as a pass removed something; a listing still capped after that is reported by a count-only line.
 */
import { realpathSync } from "node:fs";
import path from "node:path";
import type { Git } from "./git.js";
import { purgeListed, relOf, type CleanCounts } from "./resumePurge.js";

export type { CleanCounts } from "./resumePurge.js";

/** Listing passes, at most, when the output keeps reaching the capture's cap. */
export const MAX_PASSES = 8;

/** Purges `entries` below `realRoot` in a sandboxed child and returns the counts, or undefined when that could not be done. Never throws. */
export type SandboxedPurge = (realRoot: string, entries: readonly string[]) => Promise<CleanCounts | undefined>;

/** Ignored entries git lists for `workspace`, as repository-relative paths (a trailing slash marks a whole ignored directory). */
async function ignoredEntries(git: Git, workspace: string, capChars: number): Promise<{ entries: string[]; capped: boolean }> {
  const out = await git.run("workspace_failed", ["-C", workspace, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]);
  const parts = out.split("\0");
  const tail = parts.pop(); // after the last NUL: empty, or the cut-off tail of an output that hit the capture's limit
  return { entries: parts.filter((entry) => entry !== ""), capped: (tail ?? "") !== "" || out.length >= capChars };
}

/**
 * Removes the ignored build output from a resumed workspace and returns what was removed. A git that cannot list leaves the workspace unchanged.
 * On darwin the removal goes through `sandboxed` and does nothing without it (see the header). `capChars` is the output limit of the capture `git` runs
 * through. `log` gets a count-only line when anything was removed, and another when the listing was still cut off after the last pass.
 */
export async function cleanResumedWorkspace(git: Git, workspace: string, log: ((line: string) => void) | undefined, capChars: number, platform: NodeJS.Platform, sandboxed?: SandboxedPurge): Promise<CleanCounts> {
  const counts: CleanCounts = { files: 0, dirs: 0 };
  if (platform === "darwin" && sandboxed === undefined) {
    log?.("fx-runner: resume clean-up skipped on macOS");
    return counts;
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(path.resolve(workspace));
  } catch {
    // fx-swallow-ok: this is a clean-up before a resumed run; a workspace that cannot be resolved is left as kept
    return counts;
  }
  let capped = false;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    let listing: { entries: string[]; capped: boolean };
    try {
      listing = await ignoredEntries(git, realRoot, capChars);
    } catch {
      // fx-swallow-ok: if git cannot answer, the run goes on with the workspace as kept
      break;
    }
    capped = listing.capped;
    const before = counts.files + counts.dirs;
    // Lexical containment: only a listed path that stays below the root is handed on (the purge checks it again).
    const entries = listing.entries.filter((entry) => relOf(entry) !== undefined);
    let removed: CleanCounts | undefined;
    if (platform === "darwin") {
      removed = entries.length === 0 ? { files: 0, dirs: 0 } : await sandboxed!(realRoot, entries);
      if (removed === undefined) {
        log?.("fx-runner: resume clean-up under the macOS sandbox did not complete");
        return counts;
      }
    } else {
      removed = purgeListed(realRoot, entries);
    }
    counts.files += removed.files;
    counts.dirs += removed.dirs;
    // One pass is enough unless the listing was cut off and this pass made room (entries kept for good alone cannot make a second pass useful).
    if (!capped || counts.files + counts.dirs === before) break;
  }
  if (log !== undefined) {
    if (counts.files > 0 || counts.dirs > 0) log(`fx-runner: resumed workspace: removed ${counts.files} ignored files and ${counts.dirs} directories of build output`);
    if (capped) log("fx-runner: resumed workspace: the list of ignored files was cut off; some build output may remain");
  }
  return counts;
}

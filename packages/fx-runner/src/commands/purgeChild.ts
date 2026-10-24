/**
 * `fx-runner __purge <list file> <workspace root>`: the child the resumed-workspace purge starts under `sandbox-exec` on macOS (D#6 RESUME-CLEAN-MAC,
 * `daemon/resumePurgeSandbox.ts`). Not in --help. It reads the NUL-separated relative paths the parent got from git, requires the root to already be
 * its own real path, runs the same checks and removals as the Linux in-process purge, and prints `<files> <dirs>`. It makes no other output.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { CliError } from "../cliError.js";
import type { CommandContext } from "../context.js";
import { purgeListed } from "../daemon/resumePurge.js";

/** The longest list file read: the parent's own listing is far smaller. */
const LIST_MAX_BYTES = 16 * 1024 * 1024;

export function purgeChildCommand(listFile: string | undefined, root: string | undefined, ctx: CommandContext): number {
  if (listFile === undefined || root === undefined || !path.isAbsolute(listFile) || !path.isAbsolute(root)) throw new CliError("__purge needs a list file and a workspace root, both absolute", 2);
  let realRoot: string;
  let text: string;
  try {
    // The root is given as its real path already: a link there, or one swapped in since the parent resolved it, ends the run before anything is removed.
    realRoot = realpathSync(root);
    if (realRoot !== root) throw new CliError("__purge: the root or the list is not usable");
    // No-follow open, judged on the open handle: a regular file of ours that nobody else can write.
    const fd = openSync(listFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > LIST_MAX_BYTES || (info.mode & 0o077) !== 0 || (ctx.uid !== undefined && info.uid !== ctx.uid)) throw new CliError("__purge: the root or the list is not usable");
      text = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("__purge: the root or the list cannot be read");
  }
  const counts = purgeListed(realRoot, text === "" ? [] : text.split("\0"));
  ctx.out(`${counts.files} ${counts.dirs}`);
  return 0;
}

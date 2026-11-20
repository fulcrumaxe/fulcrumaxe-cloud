/**
 * The host half of "the repository goes into the guest" (D#587 B-5b): builds the read-only archive of one commit from a repository the runner owns (its mirror, or,
 * for the check's fresh VM, the job's host workspace once a verified bundle has been brought into it).
 *
 *  - The commit is a full hex id the caller already holds; it is turned into its tree with the daemon's guarded git, and the archive is made of that TREE, so
 *    nothing the commit says (a message, a header) rides along.
 *  - The archive is attribute-free. `git archive` honours `export-ignore`, `export-subst`, `text`/`eol`, `ident`, `filter` and `working-tree-encoding` from the tree's
 *    own `.gitattributes`, and a `filter` names a program the runner's own git configuration may define. So the archive is made from a scratch git directory that holds no
 *    object of its own (its `objects/info/alternates` names the repository's objects) and whose `info/attributes` switches every one of those off. That file outranks the
 *    tree's `.gitattributes`, so the bytes written are the blobs' own and no filter driver ever starts.
 *  - The tree's blob sizes are summed (`ls-tree -r -l`) BEFORE git writes anything, so a tree of huge compressible blobs is refused without filling the disk.
 *  - `git archive` writes to a file in a private scratch directory the caller owns (0700); the file is opened without following a link, size-checked, read, and
 *    removed. Its entries are read by `readTar` and held against git's own listing of the tree (`verifyTree`): a path, a mode or a byte that differs refuses the archive.
 *  - No host path is in the result: every name is relative to the tree.
 * A refusal is `ArchiveRefused` (a closed code); a git failure is the daemon's own `GitPathError("workspace_failed")`.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { Git } from "./git.js";
import { ArchiveRefused, MAX_ENTRIES, readTar } from "../vm/workspace/tar.js";
import { assertTreeSize, commitOid, parseTreeListing, verifyTree } from "../vm/workspace/tree.js";
import type { WorkspaceArchive } from "../vm/workspace/guestWorkspace.js";

/** The most all file bodies may hold, and the most the compressed archive may be (its base64 must fit one guest file frame, 256 MiB). */
export const MAX_ARCHIVE_BODY_BYTES = 512 * 1024 * 1024;
export const MAX_ARCHIVE_GZ_BYTES = 96 * 1024 * 1024;

/** Switches off every attribute `git archive` acts on. Written to the scratch git directory's `info/attributes`, which outranks the tree's own `.gitattributes`. */
export const NEUTRAL_ARCHIVE_ATTRIBUTES = "* -export-ignore -export-subst -text -eol -ident -filter -working-tree-encoding\n";

const FULL_COMMIT = /^[0-9a-f]{40}$/;

export interface ArchiveDeps {
  /** The daemon's guarded git, and one whose output limit fits a whole tree listing (`captureLarge`). */
  git: Git;
  gitLarge: Git;
  /** A directory only this process writes (0700), for the temporary files. Never taken from a job. */
  scratchDir: string;
  /** The most all file bodies may hold; the default is `MAX_ARCHIVE_BODY_BYTES` (a test sets a small one). */
  maxBodyBytes?: number;
}

/** `repoDir` is a bare mirror or a work tree of a repository the runner owns; `commit` is a full id in it. */
export async function buildWorkspaceArchive(deps: ArchiveDeps, repoDir: string, commit: string): Promise<WorkspaceArchive> {
  if (!FULL_COMMIT.test(commit)) throw new ArchiveRefused("archive_mismatch");
  const maxBody = deps.maxBodyBytes ?? MAX_ARCHIVE_BODY_BYTES;
  const tree = (await deps.git.run("workspace_failed", ["-C", repoDir, "rev-parse", "--verify", `${commit}^{tree}`])).trim();
  if (!FULL_COMMIT.test(tree)) throw new ArchiveRefused("archive_mismatch");
  // The commit's own text goes to the guest so its repository holds the real commit. It is hashed back here: text that git's capture altered or cut (a commit over the capture's
  // limit, or one in an encoding that is not UTF-8) does not hash to the id, and the job is refused rather than started from a commit that only looks like it.
  const commitText = Buffer.from(await deps.git.run("workspace_failed", ["-C", repoDir, "cat-file", "commit", commit]), "utf8");
  if (commitOid(commitText) !== commit) throw new ArchiveRefused("archive_mismatch");
  const items = parseTreeListing(await deps.gitLarge.run("workspace_failed", ["-C", repoDir, "ls-tree", "-r", "-l", "-z", "--full-tree", tree]), MAX_ENTRIES);
  assertTreeSize(items, maxBody);
  const gitDir = (await deps.git.run("workspace_failed", ["-C", repoDir, "rev-parse", "--absolute-git-dir"])).trim();
  if (!path.isAbsolute(gitDir)) throw new ArchiveRefused("archive_mismatch");
  const dir = mkdtempSync(path.join(deps.scratchDir, `a-${randomBytes(4).toString("hex")}-`), { encoding: "utf8" });
  const scratchGit = path.join(dir, "g");
  const file = path.join(dir, "out.tar");
  try {
    await deps.git.run("workspace_failed", ["init", "-q", "--bare", "--template=", scratchGit]);
    mkdirSync(path.join(scratchGit, "info"), { recursive: true });
    writeFileSync(path.join(scratchGit, "info", "attributes"), NEUTRAL_ARCHIVE_ATTRIBUTES, { mode: 0o600 });
    mkdirSync(path.join(scratchGit, "objects", "info"), { recursive: true });
    writeFileSync(path.join(scratchGit, "objects", "info", "alternates"), `${path.join(gitDir, "objects")}\n`, { mode: 0o600 });
    await deps.git.run("workspace_failed", ["--git-dir", scratchGit, "archive", "--format=tar", "-o", file, tree]);
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let tar: Buffer;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > maxBody + items.length * 1024 + 4096) throw new ArchiveRefused("archive_too_large");
      tar = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
    verifyTree(readTar(tar, { maxEntries: MAX_ENTRIES, maxTotalBytes: maxBody }), items);
    const gz = gzipSync(tar, { level: 6 });
    if (gz.length > MAX_ARCHIVE_GZ_BYTES) throw new ArchiveRefused("archive_too_large");
    return { gz, commit, commitText, tree, items };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

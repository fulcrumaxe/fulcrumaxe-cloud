/**
 * The host half of "the agent's commits come back out of the guest" (D#587 B-5b). The bundle is untrusted: a guest, or whatever ran in it, made every byte.
 * Nothing is written to the job's workspace until all of this has passed, in this order:
 *
 *  1. The bundle's header is parsed as text (`parseBundleHeader`): its size is within the cap, it has one prerequisite (the commit the guest was started from)
 *     and one reference (`HEAD`), and a pack follows. A guest cannot name a ref or a base of its own.
 *  1b. The pack is walked here as data (`scanPack`), before git reads it: the cap on a bundle's size is on its COMPRESSED bytes, and a few hundred KB of zlib, or a small
 *     delta that copies one block thousands of times, stands for gigabytes. A pack with one object over the per-object cap, or objects that add up to more than the total cap
 *     (by their declared sizes, and each delta's declared result size), is refused (`bundle_too_large`) with nothing written anywhere.
 *  2. It is fetched into a throwaway bare repository in a 0700 directory the daemon makes, which borrows the mirror's objects (so the prerequisite and the
 *     start tree are there) and writes none of them back. Every object is checked as it arrives (`transfer.fsckObjects`): git itself refuses a tree entry
 *     named `..` or `.git`, a bad mode and the symlinked-config tricks. The fetch has a time limit and runs on one thread (`pack.threads=1`): git resolves deltas on several
 *     threads at once, each holding a whole result.
 *  3. The new commits are a straight line from the start commit: at most `MAX_COMMITS`, one parent each, no merge, no new root.
 *  4. The tip's tree is listed and every entry is checked again here: a plain relative path, a regular file or a link (a submodule, or a mode git does not
 *     write, is refused), and each link's target is relative, stays inside the tree and has no `.git` part. The blob sizes of the listing (`ls-tree -r -l`) are summed against
 *     the same total cap, because a tree can name many large blobs the pack holds once. This is the layer that does not depend on git's own checks.
 *  5. Only then the workspace changes: it must still be at the start commit; the attributes of the guest's tree are switched off for the checkout (a filter
 *     named in a guest-made `.gitattributes` must never run a program the host has configured); the objects are fetched in and the tree is checked out
 *     with `reset --hard`, which never writes through a link and never leaves the workspace.
 * A refusal at 1 to 4 changes nothing outside the throwaway directory, which is removed either way.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Git } from "./git.js";
import { hostGit, hostGitWrite, runWorkspaceGit } from "./hostRead.js";
import { BundleRefused, MAX_BUNDLE_BYTES, parseBundleHeader } from "../vm/workspace/bundleHeader.js";
import { DEFAULT_PACK_LIMITS, scanPack, type PackLimits } from "../vm/workspace/packScan.js";
import { ArchiveRefused, linkStaysInside, MAX_ENTRIES } from "../vm/workspace/tar.js";
import { assertTreeSize, parseTreeListing } from "../vm/workspace/tree.js";

export const MAX_COMMITS = 500;
const MAX_LINKS = 5000;
const FULL = /^[0-9a-f]{40}$/;
const FETCH_MS = 120_000;
/** Switches off, for the checkout, every attribute that can run a program or rewrite bytes: filters, line-ending and encoding conversion, ident expansion. It outranks the tree's own `.gitattributes`. */
const NEUTRAL_ATTRIBUTES = "* -filter -text -eol -ident -working-tree-encoding\n";

export interface BundleDeps {
  git: Git;
  gitLarge: Git;
  /** A directory only this process writes (0700): the throwaway repositories are made below it. Never taken from a job. */
  scratchDir: string;
  /** What a pack may hold (tests set small ones; a runner takes the defaults). */
  limits?: Partial<PackLimits>;
  /** A caller's own rule on the verified tip, run after the tree checks and before the workspace changes. It throws `BundleRefused` to refuse. */
  policy?: (input: { repo: string; base: string; tip: string }) => Promise<void>;
}

/** What the fetches run with besides the guard config: one thread, because git resolves deltas on several at once and each holds a whole result. */
const FETCH_CONFIG: ReadonlyArray<readonly [string, string]> = [["fetch.fsckObjects", "true"], ["pack.threads", "1"]];

export interface AppliedBundle {
  tip: string;
  commits: number;
}

const refuse = (code: ConstructorParameters<typeof BundleRefused>[0], detail?: "symlink" | "path"): never => {
  throw new BundleRefused(code, detail);
};

/** Step 4: the tip's tree, listed and checked here whatever git's own checks did. Throws `bundle_tree`. */
export async function checkTipTree(deps: Pick<BundleDeps, "git" | "gitLarge"> & { limits?: Partial<PackLimits> }, repo: string, tip: string): Promise<void> {
  try {
    const items = parseTreeListing(await deps.gitLarge.run("workspace_failed", ["-C", repo, "ls-tree", "-r", "-l", "-z", "--full-tree", `${tip}^{tree}`]), MAX_ENTRIES);
    assertTreeSize(items, deps.limits?.total ?? DEFAULT_PACK_LIMITS.total);
    const links = items.filter((i) => i.mode === "120000");
    if (links.length > MAX_LINKS) return refuse("bundle_tree", "symlink");
    for (const link of links) {
      const target = await deps.git.run("workspace_failed", ["-C", repo, "cat-file", "blob", link.oid]);
      if (!linkStaysInside(link.path, target)) return refuse("bundle_tree", "symlink");
    }
  } catch (error) {
    if (error instanceof ArchiveRefused) return error.code === "archive_too_large" ? refuse("bundle_too_large") : refuse("bundle_tree", error.code === "archive_link" ? "symlink" : "path");
    throw error;
  }
}

export async function applyBundle(deps: BundleDeps, input: { bundle: Buffer; base: string; mirrorDir: string; workspace: string }): Promise<AppliedBundle> {
  const header = parseBundleHeader(input.bundle, input.base, MAX_BUNDLE_BYTES);
  const limits: PackLimits = { ...DEFAULT_PACK_LIMITS, ...deps.limits };
  await scanPack(input.bundle, header.packAt, limits);
  const dir = mkdtempSync(path.join(deps.scratchDir, `b-${randomBytes(4).toString("hex")}-`), { encoding: "utf8" });
  const repo = path.join(dir, "r");
  const file = path.join(dir, "in.bundle");
  const run = (code: "workspace_failed", args: string[], config?: ReadonlyArray<readonly [string, string]>, ms?: number): Promise<string> => deps.git.run(code, args, config, ms);
  try {
    const out = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(out, input.bundle);
    } finally {
      closeSync(out);
    }
    await run("workspace_failed", ["init", "-q", "--bare", repo]);
    mkdirSync(path.join(repo, "objects", "info"), { recursive: true });
    writeFileSync(path.join(repo, "objects", "info", "alternates"), `${path.join(input.mirrorDir, "objects")}\n`, { mode: 0o600 });
    try {
      await run("workspace_failed", ["-C", repo, "fetch", "--no-tags", "--no-recurse-submodules", file, "HEAD:refs/fx/in"], FETCH_CONFIG, FETCH_MS);
    } catch {
      // fx-swallow-ok: replaced by the closed code; git's own text could hold a path
      return refuse("bundle_fetch_failed");
    }
    const tip = (await run("workspace_failed", ["-C", repo, "rev-parse", "--verify", "refs/fx/in^{commit}"])).trim();
    if (tip !== header.tip) return refuse("bundle_malformed");

    const listed = (await run("workspace_failed", ["-C", repo, "rev-list", "--parents", "--topo-order", "refs/fx/in", `^${input.base}`])).split("\n").filter((l) => l !== "");
    if (listed.length === 0 || listed.length > MAX_COMMITS) return refuse("bundle_commits");
    const parentOf = new Map<string, string>();
    for (const line of listed) {
      const parts = line.split(" ");
      if (parts.length !== 2 || !FULL.test(parts[0] as string) || !FULL.test(parts[1] as string)) return refuse("bundle_commits");
      parentOf.set(parts[0] as string, parts[1] as string);
    }
    let walk = tip;
    for (let i = 0; i < listed.length; i++) {
      const parent = parentOf.get(walk);
      if (parent === undefined) return refuse("bundle_commits");
      walk = parent;
    }
    if (walk !== input.base) return refuse("bundle_commits");

    await checkTipTree({ git: deps.git, gitLarge: deps.gitLarge, limits }, repo, tip);
    await deps.policy?.({ repo, base: input.base, tip });

    // From here the workspace changes. It must still be exactly where the run started, or the checkout would mix two states.
    const head = (await runWorkspaceGit(deps.git, "workspace_failed", input.workspace, hostGit("rev-parse", "--verify", "HEAD^{commit}"))).trim();
    if (head !== input.base) return refuse("bundle_base_moved");
    const attributes = path.join(input.workspace, ".git", "info", "attributes");
    mkdirSync(path.dirname(attributes), { recursive: true });
    const fd = openSync(attributes, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o644);
    try {
      writeFileSync(fd, NEUTRAL_ATTRIBUTES);
    } finally {
      closeSync(fd);
    }
    await runWorkspaceGit(deps.git, "workspace_failed", input.workspace, hostGitWrite("fetch", "--no-tags", "--no-recurse-submodules", repo, "+refs/fx/in:refs/fx/in"), { config: [["pack.threads", "1"]], timeoutMs: FETCH_MS });
    await runWorkspaceGit(deps.git, "workspace_failed", input.workspace, hostGitWrite("reset", "-q", "--hard", "refs/fx/in"));
    await runWorkspaceGit(deps.git, "workspace_failed", input.workspace, hostGitWrite("update-ref", "-d", "refs/fx/in"));
    return { tip, commits: listed.length };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

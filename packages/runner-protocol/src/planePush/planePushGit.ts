import { spawn } from "node:child_process";
import { graftFileExists } from "./planePushGrafts.js";
import { SourceRefusal, type ChangedPath, type PlanePushSource } from "./planePush.js";

/**
 * Reads a commit's changes from a repository's git objects for `scanPlanePush`.
 * Only `git rev-list`, `git diff` and `git cat-file` run, against the two commits named: the
 * working tree and the index are never read, so an untracked or overlay file
 * sitting next to the repository cannot change the answer, and nothing in the
 * commit can hide behind a clean checkout. Any git failure rejects; it is never
 * read as an empty diff.
 */

const MAX_OUTPUT = 256 * 1024 * 1024;

/**
 * The environment every child runs in. Everything git reads from `GIT_*` is
 * dropped first (a redirected GIT_DIR or GIT_WORK_TREE, injected config through
 * GIT_CONFIG_PARAMETERS or GIT_CONFIG_COUNT, an alternate object store), then our
 * own settings are set. GIT_NO_REPLACE_OBJECTS makes every read see the objects
 * a push sends, not what a replace ref says they should be.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))) as NodeJS.ProcessEnv;
  return { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1" } as NodeJS.ProcessEnv;
}

/**
 * Repository-local settings outrank the user and system files that are switched
 * off above, so every setting that changes what a diff reports is pinned on the
 * command line, which outranks every config file. External diff drivers and
 * textconv are refused by flag in `changes()`.
 */
const PINNED_CONFIG = [
  "core.quotepath=off",
  "core.useReplaceRefs=false",
  "core.attributesFile=/dev/null",
  "diff.renames=false",
  "diff.ignoreSubmodules=none",
  "diff.relative=false",
  "diff.noprefix=false",
  "diff.mnemonicPrefix=false",
  "diff.srcPrefix=a/",
  "diff.dstPrefix=b/",
  "diff.submodule=short",
  "diff.algorithm=myers",
  "diff.interHunkContext=0",
  "diff.context=0",
  "core.alternateRefsCommand=",
  // Code that a clone can plant and git would then run as the harness: hooks (reference-transaction fires on every update-ref) and an fsmonitor command.
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
];

/**
 * Runs git in `repoDir` with the pinned environment and config above. `extraEnv` is added after the `GIT_*` scrub, so the
 * only `GIT_*` variables a child sees are the ones its caller names (a temporary index, an author identity).
 */
export function git(repoDir: string, args: string[], input?: string | Buffer, extraEnv?: Readonly<Record<string, string>>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pinned = PINNED_CONFIG.flatMap((c) => ["-c", c]);
    const child = spawn("git", ["--no-replace-objects", "-C", repoDir, ...pinned, ...args], { env: { ...childEnv(), ...extraEnv } as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (b: Buffer) => {
      size += b.length;
      if (size > MAX_OUTPUT) child.kill();
      else out.push(b);
    });
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 && size <= MAX_OUTPUT) resolve(Buffer.concat(out));
      else reject(new Error(`git ${args[0] ?? ""} failed: ${Buffer.concat(err).toString("utf8").split("\n")[0] ?? ""}`));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input ?? "");
  });
}

const OBJECT_ID = /^[0-9a-f]{40}$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * The scan takes exactly one commit whose only parent is exactly the base, named by
 * full 40-hex ids. A name, a ref, a short id or a range is refused (a name can
 * resolve to something other than what is later pushed); a merge commit, a root
 * commit and a commit whose parent is not the base are refused (the push would
 * also send history the scan never read). Reads the commit through `rev-list`,
 * which also proves the id names a commit.
 */
async function verifyIdentity(repoDir: string, commit: string, base: string): Promise<void> {
  if (!OBJECT_ID.test(commit)) throw new SourceRefusal("bad_identity", "the commit must be given as a full 40-hex object id, not a name, ref or range");
  if (!OBJECT_ID.test(base)) throw new SourceRefusal("bad_identity", "the base must be given as a full 40-hex object id, not a name, ref or range");
  // A graft file rewrites parents for rev-list even with replace objects off, so the parents are read from the
  // commit object's own header, and a repository that has grafts is refused outright.
  const graftPath = (await git(repoDir, ["rev-parse", "--git-path", "info/grafts"])).toString("utf8").trim();
  if (graftFileExists(repoDir, graftPath)) throw new SourceRefusal("bad_ancestry", "the repository has an info/grafts file, which rewrites parents; ancestry cannot be trusted");
  const ids = (await git(repoDir, ["rev-list", "--parents", "-n1", "--end-of-options", commit])).toString("utf8").trim().split(" ");
  if (ids[0] !== commit) throw new SourceRefusal("bad_identity", "the id does not name a commit itself (it is a tag or another object)");
  const header = (await git(repoDir, ["cat-file", "commit", commit])).toString("latin1").split("\n\n")[0] ?? "";
  const parents = header.split("\n").filter((l) => l.startsWith("parent ")).map((l) => l.slice(7));
  if (parents.length > 1) throw new SourceRefusal("bad_ancestry", "the commit is a merge commit; only a commit with a single parent is scanned");
  if (parents.length === 0) throw new SourceRefusal("bad_ancestry", "the commit has no parent; only a commit directly on the base is scanned");
  if (parents[0] !== base) throw new SourceRefusal("bad_ancestry", "the commit's parent is not the base; the push would send commits that were not scanned");
}

/** 1-based added line numbers per path, from the -U0 hunk headers. A path git quotes is skipped; it is refused as malformed anyway. */
function addedLineMap(diff: string): Map<string, number[]> {
  const result = new Map<string, number[]>();
  let current: string | null = null;
  let inHunks = false;
  for (const line of diff.split("\n")) {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- comma sequence kept as moved; rewriting it is outside a move-only change
    if (line.startsWith("diff --git ")) (current = null), (inHunks = false);
    else if (!inHunks && line.startsWith("+++ b/")) current = line.slice(6).replace(/\t$/, "");
    else if (!inHunks && line.startsWith("+++ ")) current = null;
    else {
      const m = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      inHunks = true;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      if (current !== null && count > 0) {
        const lines = result.get(current) ?? [];
        for (let n = start; n < start + count; n++) lines.push(n);
        result.set(current, lines);
      }
    }
  }
  return result;
}

export function gitCommitSource(opts: { repoDir: string; commit: string; base: string }): PlanePushSource {
  let blobShas: Array<string | undefined> | undefined;
  let scanned: { commit: string; base: string } | undefined;
  return {
    async changes(): Promise<ChangedPath[]> {
      const { commit, base } = opts;
      await verifyIdentity(opts.repoDir, commit, base);
      scanned = { commit, base };
      const common = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-relative", "--ignore-submodules=none", "--submodule=short", base, commit, "--"];
      // Everything is parsed as latin1 so that every byte string is a distinct key (a UTF-8 decode would fold
      // different invalid names into one); the display name is decoded strictly afterwards.
      const raw = (await git(opts.repoDir, ["diff", "--raw", "-z", "--no-abbrev", ...common])).toString("latin1").split("\0");
      const numstat = (await git(opts.repoDir, ["diff", "--numstat", "-z", ...common])).toString("latin1").split("\0");
      const binary = new Set(numstat.filter((r) => r.startsWith("-\t-\t")).map((r) => r.slice(4)));
      const added = addedLineMap((await git(opts.repoDir, ["diff", "-U0", "--src-prefix=a/", "--dst-prefix=b/", ...common])).toString("latin1"));
      const entries: Array<Omit<ChangedPath, "size" | "addedLines"> & { sha: string; key: string }> = [];
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const meta = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) (\w)$/.exec(raw[i] ?? "");
        const key = raw[i + 1] as string;
        if (!meta) throw new Error("git diff --raw output is not understood");
        let path: string;
        let nameInvalid = false;
        try {
          path = UTF8.decode(Buffer.from(key, "latin1"));
        } catch {
          // fx-swallow-ok: an undecodable name is recorded on the entry (nameInvalid) with a placeholder path, and the scan refuses it
          path = `invalid-utf-8-name-${entries.length + 1}`;
          nameInvalid = true;
        }
        entries.push({ path, key, ...(nameInvalid ? { nameInvalid } : {}), mode: meta[2] as string, deleted: meta[5] === "D", existedAtBase: meta[1] !== "000000", binary: binary.has(key), sha: meta[4] as string });
      }
      // A gitlink names a commit in another repository that this one need not hold, so it has no size to look up.
      const live = entries.filter((e) => !e.deleted && e.mode !== "160000");
      const sizes = (await git(opts.repoDir, ["cat-file", "--batch-check=%(objectsize)"], live.map((e) => `${e.sha}\n`).join(""))).toString("utf8").split("\n");
      blobShas = entries.map((e) => (e.deleted || e.mode === "160000" ? undefined : e.sha));
      const sizeOf = new Map(live.map((e, i) => [e, Number(sizes[i])]));
      return entries.map((e) => {
        const { sha: _sha, key, ...rest } = e;
        const size = e.deleted || e.mode === "160000" ? 0 : (sizeOf.get(e) as number);
        if (!Number.isInteger(size)) throw new Error("git cat-file size output is not understood");
        return { ...rest, size, addedLines: added.get(key) ?? [] };
      });
    },
    async readBlob(index: number): Promise<Uint8Array> {
      const sha = blobShas?.[index];
      if (sha === undefined) throw new Error("blob read before the changes were listed");
      return git(opts.repoDir, ["cat-file", "blob", sha]);
    },
    scanned: () => scanned,
  };
}

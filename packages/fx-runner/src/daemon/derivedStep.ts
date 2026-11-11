import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, writeSync } from "node:fs";
import path from "node:path";
import { parseAcceptanceScope, parseDerivedFileRules, pathInScope, type DerivedFileRule } from "@fulcrumaxe/runner-protocol";

/** Where a repository keeps its table of derived files (see `derivedFiles.ts` in the protocol). */
export const DERIVED_FILES_TABLE_PATH = ".fulcrumaxe/derived-files.json";

/**
 * #751: the repository's table, read from the default branch's copy at the job's pin (`baseFile`: the mirror's blob, byte-exact), never from the workspace, which the agent can write.
 * No table, a copy that cannot be read exactly, or one the parser refuses is the empty table: nothing is verified and nothing lifted, which is how a run went before the table existed.
 */
export async function readDerivedRules(baseFile: (dir: string, base: string, relative: string) => Promise<Buffer | null>, baseDir: string, base: string): Promise<DerivedFileRule[]> {
  try {
    const bytes = await baseFile(baseDir, base, DERIVED_FILES_TABLE_PATH);
    if (bytes === null || bytes.length > 64 * 1024) return [];
    return parseDerivedFileRules(JSON.parse(bytes.toString("utf8"))) ?? [];
  } catch {
    // fx-swallow-ok: an unreadable table is no table; the run goes on without lifting anything
    return [];
  }
}

/** How a generator that did not succeed ended: a non-zero exit, the time limit, or not started (refused by the sandbox or thrown). */
export type GeneratorFailure = "nonzero" | "timeout" | "refused";

/** The largest generated file read for the comparison; a bigger one is never vouched for. */
const MAX_DERIVED_BYTES = 8 * 1024 * 1024;

/**
 * #751: the bytes of `relative` in `workspace`, or null when it is not a plain file the runner may touch: missing, a link, not a file, over the cap, or reached through a link
 * (the real path of the file must be the workspace's real path plus `relative`, so no directory on the way points elsewhere). `O_NOFOLLOW` closes the last-component race.
 */
function readPlain(workspace: string, relative: string): Buffer | null {
  try {
    const root = realpathSync(workspace);
    const file = path.join(root, relative);
    if (realpathSync(file) !== file) return null;
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_DERIVED_BYTES) return null;
      const bytes = Buffer.alloc(stat.size);
      let read = 0;
      while (read < bytes.length) {
        const n = readSync(fd, bytes, read, bytes.length - read, read);
        if (n === 0) break;
        read += n;
      }
      return read === bytes.length ? bytes : null;
    } finally {
      closeSync(fd);
    }
  } catch {
    // fx-swallow-ok: a file that cannot be read exactly is not vouched for
    return null;
  }
}

/** Puts `bytes` back in a file `readPlain` just read (same checks, no creation), so a generator's rewrite of a stale output is undone. False when it could not be. */
function writeBack(workspace: string, relative: string, bytes: Buffer): boolean {
  try {
    const root = realpathSync(workspace);
    const file = path.join(root, relative);
    if (realpathSync(file) !== file) return false;
    const fd = openSync(file, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
    try {
      let at = 0;
      while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at);
      return true;
    } finally {
      closeSync(fd);
    }
  } catch {
    // fx-swallow-ok: the caller treats a file it could not put back as not vouched for
    return false;
  }
}

/**
 * #751: of the generated `paths` (outputs of `rules`), the ones that equal a fresh run of the rules' generators on the workspace AND are what the branch's HEAD commits. The runner pushes
 * HEAD, never the working tree, so freshness of loose bytes means nothing (CWE-367): `dirty` lists what the working tree holds that HEAD does not (tracked edits and untracked files; the
 * daemon's guarded listing against HEAD), and it must be empty both before the generators run and after they and the put-back are done. Then the working tree is HEAD's content, the
 * generators read HEAD's inputs, and a file equal to their output is the file that is pushed. Anything else, or a listing that cannot be read, vouches for nothing.
 * The generators are the table's own argument vectors, run in order through `run` (the runner's check step: sandbox rules, approved time limit); `run` answers whether one exited 0.
 * Every output of the rules is read first and put back as it was if the generators rewrote it, so a stale or hand-edited output is neither vouched for nor silently repaired.
 * A generator that fails, a file that cannot be read or put back, or any throw vouches for nothing.
 */
export async function verifyDerivedOutputs(input: { workspace: string; rules: readonly DerivedFileRule[]; paths: readonly string[]; run: (argv: readonly string[]) => Promise<boolean | GeneratorFailure>; dirty: () => Promise<string[] | null>; changed: readonly string[]; headBlob: (relative: string) => Promise<Buffer | null>; hidden: () => Promise<boolean | null>; note?: (reason: string) => void }): Promise<string[]> {
  const no = (reason: string): string[] => {
    input.note?.(reason);
    return [];
  };
  const clean = async (): Promise<boolean> => {
    const listed = await input.dirty().catch(() => null);
    return listed !== null && listed.length === 0;
  };
  if (!(await clean())) return no("tree_dirty");
  // `git diff` and `git status` trust the index: an assume-unchanged or skip-worktree entry hides a changed file from them, so with any such entry the listing above proves nothing.
  if ((await input.hidden().catch(() => null)) !== false) return no("index_hides");
  const before = new Map<string, Buffer>();
  for (const p of input.paths) {
    const bytes = readPlain(input.workspace, p);
    if (bytes === null) return no("unreadable");
    before.set(p, bytes);
  }
  // Each file the verdict rests on is compared with the blob HEAD holds in the object database, which neither the index nor the working tree can fake: every path to be vouched (it must have a
  // blob: a path HEAD deletes, or never had, is never vouched, whatever hides its copy in the tree) and every changed input of the rules (both absent counts as equal).
  const inputScopes = input.rules.map((r) => parseAcceptanceScope([...r.inputs]));
  const inputs = input.changed.filter((p) => inputScopes.some((sc) => pathInScope(sc, p)));
  try {
    for (const p of input.paths) {
      const head = await input.headBlob(p);
      if (head === null) return no("no_head_blob");
      if (!head.equals(before.get(p)!)) return no("not_equal");
    }
    for (const p of inputs) {
      const head = await input.headBlob(p);
      const now = readPlain(input.workspace, p);
      if ((head === null) !== (now === null) || (head !== null && now !== null && !head.equals(now))) return no("not_equal");
    }
  } catch {
    // fx-swallow-ok: a blob that cannot be read exactly is a comparison that cannot be made; nothing is vouched
    return no("unreadable");
  }
  // The rules' other outputs are put back too (a generator may rewrite a sibling that is in scope), but are not vouched for.
  for (const rule of input.rules) for (const p of rule.outputs) if (!before.has(p)) { const bytes = readPlain(input.workspace, p); if (bytes !== null) before.set(p, bytes); }
  let ran = true;
  let failure: GeneratorFailure = "nonzero";
  for (const rule of input.rules) {
    for (const argv of rule.generators ?? []) {
      if (!ran) break;
      const outcome = await input.run(argv).catch((): GeneratorFailure => "refused");
      ran = outcome === true;
      if (typeof outcome === "string") failure = outcome;
    }
  }
  const fresh: string[] = [];
  let restored = true;
  for (const [p, bytes] of before) {
    const now = readPlain(input.workspace, p);
    if (now !== null && now.equals(bytes)) {
      if (input.paths.includes(p)) fresh.push(p);
      continue;
    }
    if (!writeBack(input.workspace, p, bytes)) restored = false;
  }
  if (!ran) return no(`generator_failed:${failure}`);
  if (!restored) return no("unreadable");
  if (!(await clean())) return no("tree_dirty");
  if (fresh.length === 0) return no("not_equal");
  return fresh;
}

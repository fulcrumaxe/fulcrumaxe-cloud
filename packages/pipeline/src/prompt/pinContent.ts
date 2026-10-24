/**
 * D#600 CX-5b: the content of the files a person pinned, read on the CLOUD side (never inside the sandbox) from GitHub at the commit the run starts from, and
 * put into the prompt's pinned section in full. The same outside-the-VM pattern as the repository map: the git trees API at the commit names each path's blob,
 * then the git blobs API (base64) answers it. Both calls go over the one-repository `repo_map` token, whose exact path list already allows exactly these.
 *
 * A pin is read or it is missing; it is never a reason to refuse or delay a run. A path that is not a file in the tree (deleted, renamed, a folder, a
 * submodule), a file over `PIN_FILE_MAX_BYTES`, one that is not UTF-8 text (or holds a NUL), and every pin when GitHub cannot be read, come back in `missing`
 * with a fixed word in the log, and the run starts without them. A pin that is READ is included in full whatever the budget says: pins are never cut.
 * Only the number of files read is bounded (`PINS_MAX_READ`), because each is a GitHub call; the rest are counted as missing.
 */

// The caps, the exclude match and the read loop are shared with the local runner (D#600 CX-5c2): one copy in the protocol package.
import { readPinFiles } from "@fulcrumaxe/runner-protocol";
export { PIN_FILE_MAX_BYTES, PIN_FILE_MAX_CHARS, PINS_MAX_READ, excludeCovers } from "@fulcrumaxe/runner-protocol";

/** The GitHub reads the pins need (structurally the `RepoTreeSource` of @fx/github). */
export interface PinSource {
  headSha(): Promise<string | null>;
  tree(sha: string): Promise<{ truncated: boolean; entries: ReadonlyArray<{ path: string; type: "blob" | "tree" | "commit"; sha: string; size?: number }> } | null>;
  blob(sha: string, maxBytes?: number): Promise<string | null>;
}

export interface PinRequest {
  accountId: string;
  repoId: string;
  owner: string;
  name: string;
  /** The pinned paths (exact, repository relative). */
  paths: readonly string[];
  /** The commit the run starts from (a stacked build's parent tip). Absent: the default branch's head now. */
  sha?: string;
}

export interface PinContent {
  /** The files read, in path order, with their full text. */
  items: Array<{ path: string; text: string }>;
  /** How many pinned paths could not be read (deleted, renamed, a folder, not text, GitHub unreachable, over the fetch cap or past the read count). */
  missing: number;
  /** How many were read and found over PIN_FILE_MAX_CHARS: skipped, never cut. */
  tooLarge: number;
}

/** What the build step asks for. A port that is absent, or throws, leaves every pin missing; the run still starts. */
export interface PinContentPort {
  forRun(request: PinRequest): Promise<PinContent>;
}

export function createPinContentPort(deps: { open: (request: PinRequest) => Promise<PinSource>; log?: (reason: string) => void }): PinContentPort {
  return {
    async forRun(request) {
      const paths = [...new Set(request.paths)].sort();
      if (paths.length === 0) return { items: [], missing: 0, tooLarge: 0 };
      const none = (reason: string): PinContent => {
        deps.log?.(reason);
        return { items: [], missing: paths.length, tooLarge: 0 };
      };
      try {
        const source = await deps.open(request);
        const sha = request.sha ?? (await source.headSha());
        if (sha === null) return none("no_head");
        const tree = await source.tree(sha);
        if (tree === null) return none("no_tree");
        // A tree GitHub cut cannot say a path is absent; the pin reads as missing and the reason is logged, the run is not held for it.
        if (tree.truncated) deps.log?.("tree_truncated");
        const blobs = new Map<string, { sha: string; size?: number }>();
        for (const e of tree.entries) if (e.type === "blob") blobs.set(e.path, { sha: e.sha, ...(e.size === undefined ? {} : { size: e.size }) });
        return await readPinFiles(paths, { stat: async (path) => blobs.get(path) ?? null, text: async (path, max) => source.blob(blobs.get(path)!.sha, max) }, deps.log);
      } catch {
        // fx-swallow-ok: pins that cannot be read are left out and counted as missing; the run starts and the reason is logged as a fixed word
        return none("unavailable");
      }
    },
  };
}

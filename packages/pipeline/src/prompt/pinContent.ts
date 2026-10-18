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

/** The most a single pinned file may be fetched at (the top of the repository budget's range, migration 0870): above it the file is not even downloaded. */
export const PIN_FILE_MAX_BYTES = 2_097_152;
/**
 * The run-time cap on one pinned file, in characters. The prompt fence (`sanitize`) takes 200,000 characters of input and silently cuts the rest, and pins are
 * never cut, so a larger file is skipped and recorded as too large instead (D#600 CX-5b ruling). The room under 200,000 is for the "path:" line in front.
 */
export const PIN_FILE_MAX_CHARS = 190_000;
/** The most pinned files read for one run. Further pins are counted as missing (never silently dropped). */
export const PINS_MAX_READ = 40;

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

/**
 * Whether an exclude pattern (a path, a folder, or a glob; gitignore-style, as the CLI matches it) covers a repository-relative path. An exclude wins over a pin, so
 * this errs towards covering: the match ignores case (the CLI refused `Secret/a.txt` under the exclude `secret`), a pattern without a slash matches at any depth as well as from the root, and a folder pattern covers everything under it.
 * `*` and `?` do not cross a `/`, `**` does, `[...]` is a character class; `{ }` and `( )` are ordinary characters.
 */
export function excludeCovers(pattern: string, path: string): boolean {
  const trimmed = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed === "") return false;
  let re = "";
  for (let i = 0; i < trimmed.length; i += 1) {
    const c = trimmed[i]!;
    if (c === "*") {
      if (trimmed[i + 1] === "*") {
        const slash = trimmed[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const close = trimmed.indexOf("]", i + 2);
      if (close === -1) re += "\\[";
      else {
        re += `[${trimmed.slice(i + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
        i = close;
      }
    } else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  try {
    const anchored = new RegExp(`^${re}(?:/.*)?$`, "i");
    if (anchored.test(path)) return true;
    return !trimmed.includes("/") && new RegExp(`^(?:.*/)?${re}(?:/.*)?$`, "i").test(path);
  } catch {
    // fx-swallow-ok: a pattern that is not a valid expression covers the path, the safe side for an exclude
    return true;
  }
}

/** What the build step asks for. A port that is absent, or throws, leaves every pin missing; the run still starts. */
export interface PinContentPort {
  forRun(request: PinRequest): Promise<PinContent>;
}

const bytesOf = (s: string): number => Buffer.byteLength(s, "utf8");

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
        const items: PinContent["items"] = [];
        let missing = Math.max(0, paths.length - PINS_MAX_READ);
        let tooLarge = 0;
        if (missing > 0) deps.log?.("pins_over_count");
        for (const path of paths.slice(0, PINS_MAX_READ)) {
          const blob = blobs.get(path);
          if (blob === undefined) {
            missing += 1;
            continue;
          }
          if (blob.size !== undefined && blob.size > PIN_FILE_MAX_BYTES) {
            tooLarge += 1;
            continue;
          }
          const text = await source.blob(blob.sha, PIN_FILE_MAX_BYTES);
          if (text === null || text.includes("\0") || bytesOf(text) > PIN_FILE_MAX_BYTES) {
            missing += 1;
            continue;
          }
          if (text.length > PIN_FILE_MAX_CHARS) {
            tooLarge += 1;
            continue;
          }
          items.push({ path, text });
        }
        return { items, missing, tooLarge };
      } catch {
        // fx-swallow-ok: pins that cannot be read are left out and counted as missing; the run starts and the reason is logged as a fixed word
        return none("unavailable");
      }
    },
  };
}

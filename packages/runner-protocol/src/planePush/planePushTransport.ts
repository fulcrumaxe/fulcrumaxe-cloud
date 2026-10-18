import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { git } from "./planePushGit.js";

/**
 * The two git calls that touch the paired public repo: fetch its main tip, and push one commit to a new branch.
 *
 *   - Fetch is anonymous. The paired repo is public, and nothing is sent that could identify the private one.
 *   - Push carries the restricted installation token in an `Authorization` header that is scoped to the repo's own URL, set through
 *     the environment: the token is never in an argument list, a URL, a config file or an error message.
 *   - Push is never forced. A refspec is built here from a validated commit id and branch name, `+` is not possible, and a branch
 *     that already exists on the remote makes git refuse the update unless it is a fast-forward of what is there.
 *   - Redirects are off, prompts are off, no credential helper runs, and only the one scheme of the origin is allowed.
 */

export interface PublicGitTransport {
  /** Fetches the public repo's main into `repoDir` and returns the 40-hex id of its tip, as the remote has it now. */
  fetchTip(repoDir: string, codeRepo: string): Promise<string>;
  /** Pushes `commit` to `refs/heads/<branch>` of the public repo with `token`. Never forced. */
  push(input: { repoDir: string; codeRepo: string; commit: string; branch: string; token: string }): Promise<void>;
}

export const PUBLIC_BASE_BRANCH = "main";
const OBJECT_ID = /^[0-9a-f]{40}$/;
const CODE_REPO = /^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/;
export const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}){0,3}$/;

/** A branch name the public repo may be sent: a plain word path, never the base branch, a ref prefix, `..` or a lock file. */
export function branchNameOk(name: string): boolean {
  return BRANCH_NAME.test(name) && !name.includes("..") && !name.startsWith("refs/") && !name.endsWith(".lock") && !name.endsWith(".") && !["main", "master", "head"].includes(name.toLowerCase());
}

/** `https://github.com` in production. Plain http is accepted only for a loopback host (a test server). */
function checkOrigin(origin: string): string {
  const url = new URL(origin);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, "") !== "") {
    throw new Error("transport origin must be an https origin, or http on loopback, with no credentials or path");
  }
  return url.origin;
}

/**
 * Thrown before any network call when the clone could redirect, weaken or run something during the transfer. Carries the fixed code
 * `unsafe_git_config`. The message names a key or a file kind, never a value.
 */
export class UnsafeGitConfigError extends Error {
  readonly code = "unsafe_git_config";
  constructor(what = "the clone's configuration") {
    super(`${what} is not on the allowed list for a transfer; nothing was sent`);
    this.name = "UnsafeGitConfigError";
  }
}

/**
 * The only settings a repository handed to the transfer may carry (an allowlist: anything else refuses): what `git init --bare`
 * writes, and nothing else. Names are compared lower-case. There is no `remote.*`, `branch.*` or `user.*` key, because the hook
 * never uses a clone. It builds in a repository it creates itself with `git init --bare` in a fresh directory and brings objects in
 * by explicit source (the daemon's mirror by local path, the private repo by URL through the proxy, the public tip through
 * `fetchTip`), so none of those keys ever exists. A clone's `remote.origin.url` is the private origin and on some setups holds a
 * credential; accepting it would mean validating a value, where this check only reads key names, and stripping `fetch` from a clone
 * still leaves that url. The commit identity travels in GIT_AUTHOR_* and GIT_COMMITTER_* (`buildCommit`), not in `user.*`.
 */
const ALLOWED_KEY = [/^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)$/];

/** Files in the git directory that change where objects, refs or config come from. Any of them refuses. */
const REFUSED_FILES: ReadonlyArray<{ base: "gitDir" | "commonDir"; path: string; what: string }> = [
  { base: "gitDir", path: "config.worktree", what: "a per-worktree config file" },
  { base: "commonDir", path: "objects/info/alternates", what: "an alternates file" },
  { base: "commonDir", path: "objects/info/http-alternates", what: "an http-alternates file" },
  { base: "commonDir", path: "info/grafts", what: "a grafts file" },
  { base: "commonDir", path: "shallow", what: "a shallow file" },
];

const safeName = (key: string): string => (/^[a-z0-9._-]{1,80}$/i.test(key) ? `the setting ${key}` : "a setting");

/**
 * Fails closed. Reads every config scope the helper leaves on (local and worktree; system and global are switched off, and the
 * harness's own `-c` pins are scope `command` and skipped), requires each key to be on ALLOWED_KEY, and refuses the files above.
 */
export async function assertSafeLocalConfig(repoDir: string): Promise<void> {
  let listing = "";
  try {
    listing = (await git(repoDir, ["config", "--no-includes", "--null", "--show-scope", "--show-origin", "--get-regexp", "."])).toString("utf8");
  } catch (err) {
    // `git config --get-regexp` exits 1 when nothing matches: an empty config is safe. Any other failure is not.
    if (!/failed:\s*$/.test((err as Error).message)) throw new UnsafeGitConfigError();
  }
  if (listing !== "") {
    // With --null each entry is three NUL-terminated fields: scope, origin, then "key\nvalue".
    const fields = listing.split("\0");
    if (fields[fields.length - 1] === "") fields.pop();
    if (fields.length % 3 !== 0) throw new UnsafeGitConfigError();
    for (let i = 0; i < fields.length; i += 3) {
      if (fields[i] === "command") continue;
      const key = (fields[i + 2] ?? "").split("\n", 1)[0]!.toLowerCase();
      if (!ALLOWED_KEY.some((rx) => rx.test(key))) throw new UnsafeGitConfigError(safeName(key));
    }
  }
  const dirs = {
    gitDir: (await git(repoDir, ["rev-parse", "--absolute-git-dir"])).toString("utf8").trim(),
    commonDir: resolve(repoDir, (await git(repoDir, ["rev-parse", "--git-common-dir"])).toString("utf8").trim()),
  };
  for (const f of REFUSED_FILES) {
    try {
      lstatSync(join(dirs[f.base], f.path));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new UnsafeGitConfigError();
    }
    throw new UnsafeGitConfigError(f.what);
  }
}

const HARDENING = [
  "-c", "protocol.allow=never",
  "-c", "http.proxy=",
  "-c", "http.sslVerify=true",
  "-c", "http.followRedirects=false",
  "-c", "credential.helper=",
  "-c", "core.askPass=",
  "-c", "transfer.fsckObjects=true",
  "-c", "core.hooksPath=/dev/null",
];
const NO_PROMPT = { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false", GIT_CONFIG_NOSYSTEM: "1" } as const;

export function createGitTransport(opts: { origin?: string; caInfo?: string } = {}): PublicGitTransport {
  const origin = checkOrigin(opts.origin ?? "https://github.com");
  // A caller that runs where git's compiled-in CA path is not certain (a sandbox image) names the bundle; the daemon on a customer machine leaves it out.
  if (opts.caInfo !== undefined && !/^\/[A-Za-z0-9._/-]{1,200}$/.test(opts.caInfo)) throw new Error("transport caInfo must be an absolute path");
  // Only the origin's own scheme is allowed, so a production transport can never speak plain http.
  const hardening = [...HARDENING, "-c", `protocol.${new URL(origin).protocol === "https:" ? "https" : "http"}.allow=always`, ...(opts.caInfo === undefined ? [] : ["-c", `http.sslCAInfo=${opts.caInfo}`])];
  const urlOf = (codeRepo: string): string => {
    if (!CODE_REPO.test(codeRepo)) throw new Error("the paired repo must be owner/name");
    return `${origin}/${codeRepo}.git`;
  };
  return {
    async fetchTip(repoDir, codeRepo) {
      await assertSafeLocalConfig(repoDir);
      // A unique ref per call so two fetches never share FETCH_HEAD; deleted again below, the objects stay.
      const ref = `refs/fx/plane-tip/${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      await git(repoDir, [...hardening, "fetch", "--no-tags", "--quiet", urlOf(codeRepo), `+refs/heads/${PUBLIC_BASE_BRANCH}:${ref}`], undefined, NO_PROMPT);
      const tip = (await git(repoDir, ["rev-parse", "--verify", "--end-of-options", ref])).toString("utf8").trim();
      await git(repoDir, ["update-ref", "-d", ref]);
      if (!OBJECT_ID.test(tip)) throw new Error("the fetched tip is not a full commit id");
      return tip;
    },
    async push({ repoDir, codeRepo, commit, branch, token }) {
      if (!OBJECT_ID.test(commit)) throw new Error("push: the commit must be a full 40-hex id");
      if (!branchNameOk(branch)) throw new Error("push: unusable branch name");
      await assertSafeLocalConfig(repoDir);
      const url = urlOf(codeRepo);
      const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
      // A bare commit id as the source is not fast-forward checked by the client; a ref is. So the commit is pointed at by a
      // throwaway local ref for the duration of the push, which keeps "never forced" true on the client side as well.
      const local = `refs/fx/plane-push/${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      await git(repoDir, ["update-ref", local, commit]);
      try {
        await git(repoDir, [...hardening, "push", "--quiet", "--no-verify", url, `${local}:refs/heads/${branch}`], undefined, {
          ...NO_PROMPT,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: `http.${origin}/.extraHeader`,
          GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
        });
      } finally {
        await git(repoDir, ["update-ref", "-d", local]).catch(() => undefined);
      }
    },
  };
}

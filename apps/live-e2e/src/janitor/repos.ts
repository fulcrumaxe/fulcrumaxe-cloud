/**
 * The stale-repo janitor (D#441 C2, D1): `live-e2e janitor repos --org <test org> [--apply]`. It lists the repositories
 * of one org that are named `e2e-tmp-*` and are more than a day old, and deletes exactly those. It never deletes
 * anything else.
 *
 * It runs only on a person's machine, with that person's own `gh` login. There is no CI credential for this: the run
 * is refused when CI is set or when a token is in the environment (`GH_TOKEN`, `GITHUB_TOKEN`), so the login `gh` uses
 * is the stored one and no variable of ours or CI's can stand in for it. GitHub is reached only through the injected
 * `gh` runner (tests drive a strict fake); this file reads no token and prints none.
 *
 * Order: org check, local-only check, `gh` login check, list (every row must belong to the org, else the whole run is
 * refused), then the plan. Dry-run is the default and prints "would delete ..." per repository. `--apply` first asks
 * the person to type the org name and deletes nothing unless the answer is exactly that name. A delete that fails
 * stops the run and names the repository; nothing after it is sent. State is derived from GitHub on every run.
 */
import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";

export const REPOS_REASONS = ["janitor-repos-org-missing", "janitor-repos-org-malformed", "janitor-repos-not-local", "janitor-repos-gh-not-logged-in", "janitor-repos-list-failed", "janitor-repos-outside-org", "janitor-repos-not-confirmed", "janitor-repos-delete-failed"] as const;
export type ReposReason = (typeof REPOS_REASONS)[number];
export type ReposResult = { status: "done"; repos: string[]; applied: boolean } | { status: "refused"; reason: ReposReason; detail?: string; done: number };

/** One `gh` call: the arguments after `gh`, and what came back. Never a shell string. */
export type GhRunner = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
export type Confirm = (question: string) => Promise<string>;

export interface ReposJanitorOptions {
  org: string | undefined;
  apply: boolean;
  env: Record<string, string | undefined>;
  now: number;
  gh?: GhRunner;
  confirm?: Confirm;
  say: (line: string) => void;
}

export const MIN_AGE_MS = 24 * 60 * 60 * 1000;
const ORG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const NAME = /^e2e-tmp-[A-Za-z0-9._-]+$/;
/** Variables that would let something other than the person's stored `gh` login (or CI) act. */
const CREDENTIAL_ENV = ["CI", "GITHUB_ACTIONS", "GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];

export const defaultGh: GhRunner = (args) =>
  new Promise((resolve) => {
    execFile("gh", args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      resolve({ code, stdout, stderr });
    });
  });

/** Reads one line from the terminal; with no terminal it answers "", which never matches the org. */
export const defaultConfirm: Confirm = async (question) => {
  if (!process.stdin.isTTY) return "";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
};

/** ASCII-only case fold: GitHub logins are ASCII, and `toLowerCase` would also fold U+212A (Kelvin) to "k". */
const fold = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
const sameOrg = (full: unknown, org: string): boolean => typeof full === "string" && fold(full.split("/")[0] ?? "") === fold(org);

interface Row {
  full_name?: unknown;
  created_at?: unknown;
}
const refuse = (reason: ReposReason, detail?: string, done = 0): ReposResult => ({ status: "refused", reason, done, ...(detail !== undefined ? { detail } : {}) });

/** The one test a repository must pass to be listed or deleted: in the org, `e2e-tmp-*`, and older than a day. */
export function isStale(row: Row, org: string, now: number): boolean {
  if (typeof row.full_name !== "string" || typeof row.created_at !== "string") return false;
  const [owner, name, ...extra] = row.full_name.split("/");
  if (!sameOrg(row.full_name, org) || owner === undefined || name === undefined || extra.length > 0 || !NAME.test(name)) return false;
  const created = Date.parse(row.created_at);
  return Number.isFinite(created) && now - created > MIN_AGE_MS;
}

export async function runReposJanitor(o: ReposJanitorOptions): Promise<ReposResult> {
  const org = o.org;
  if (org === undefined || org === "") return refuse("janitor-repos-org-missing");
  if (!ORG.test(org)) return refuse("janitor-repos-org-malformed");
  const present = CREDENTIAL_ENV.filter((k) => (o.env[k] ?? "") !== "");
  if (present.length > 0) return refuse("janitor-repos-not-local", `${present.join(", ")} is set; run this on your own machine with your own gh login`);
  const gh = o.gh ?? defaultGh;

  const auth = await gh(["auth", "status", "--hostname", "github.com"]);
  if (auth.code !== 0) return refuse("janitor-repos-gh-not-logged-in", "run gh auth login");

  const listed = await gh(["api", "--paginate", `orgs/${org}/repos?per_page=100&type=all`, "--jq", ".[] | {full_name, created_at}"]);
  if (listed.code !== 0) return refuse("janitor-repos-list-failed", `gh exited ${listed.code}`);
  let rows: Row[];
  try {
    rows = listed.stdout.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Row);
  } catch {
    return refuse("janitor-repos-list-failed", "unreadable listing");
  }
  if (rows.some((r) => typeof r !== "object" || r === null || Array.isArray(r))) return refuse("janitor-repos-list-failed", "unreadable listing");
  const outside = rows.find((r) => !sameOrg(r.full_name, org));
  if (outside !== undefined) return refuse("janitor-repos-outside-org", `the listing holds a repository outside ${org}`);

  const stale = rows.filter((r) => isStale(r, org, o.now));
  const repos = stale.map((r) => r.full_name as string);
  if (!o.apply) {
    for (const r of repos) o.say(`would delete ${r}`);
    if (repos.length === 0) o.say("nothing to do");
    return { status: "done", repos, applied: false };
  }
  if (repos.length === 0) {
    o.say("nothing to do");
    return { status: "done", repos, applied: true };
  }
  const answer = await (o.confirm ?? defaultConfirm)(`This deletes ${repos.length} repositories in ${org}. Type the org name to continue: `);
  if (answer !== org) return refuse("janitor-repos-not-confirmed", "the typed name did not match the org");

  let done = 0;
  for (const row of stale) {
    const r = row.full_name as string;
    // Re-read the repo itself and test it again: the listing may be stale, and this name goes into the path.
    const fresh = await gh(["api", `repos/${r}`, "--jq", "{full_name, created_at}"]);
    let now: Row | null = null;
    try {
      now = fresh.code === 0 ? (JSON.parse(fresh.stdout) as Row | null) : null;
    } catch {
      now = null;
    }
    if (typeof now !== "object" || now === null || now.full_name !== r || !isStale(now, org, o.now)) return refuse("janitor-repos-delete-failed", `${r} could not be re-checked or no longer qualifies`, done);
    const res = await gh(["api", "-X", "DELETE", `repos/${r}`]);
    if (res.code !== 0) return refuse("janitor-repos-delete-failed", `could not delete ${r} (gh exited ${res.code}; the login needs the delete_repo scope)`, done);
    done += 1;
    o.say(`done: delete ${r}`);
  }
  return { status: "done", repos, applied: true };
}

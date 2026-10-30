/**
 * The fixture-repo janitor (T6b): puts the one fixture repo back toward its baseline with the fixture token, and does
 * nothing else. It never lists or deletes repositories (no org-wide credential exists for CI).
 *
 * Order, after every read has succeeded (a failed read is a refusal and nothing is written):
 *  (a) the repo setting must match the pattern and the token must read the repo;
 *  (b) close every open issue and PR whose whole title is a run tag (`parseTag`), and every open PR whose head is an
 *      `fx/*` branch of the fixture repo itself;
 *  (c) delete the branches that are `fx/*` or a run tag, never the default branch and never a branch whose tip is the
 *      commit the `e2e-baseline` tag names;
 *  (d) force-move the default branch to that commit. A rejected move is `REFUSED janitor-repo-protected`, never a skip.
 *
 * Ownership is exact. A human's issue, PR or branch carries no run tag and no `fx/` prefix and is never touched.
 * Dry-run is the default: only GETs are sent and each action is printed as "would ...". Staging only, decided first.
 * State is derived from the repo on every run; nothing is stamped, and the baseline tag is never moved.
 *
 * A missing setting is `SKIPPED-NEED test-repo`; a malformed repo value is a usage error (exit 2). The token goes only
 * in the Authorization header (issues.ts `request`) and no line printed here carries it, a title or a response body.
 */
import { GithubError, pagedGet, request, type IssueOptions } from "../issues.js";
import { FIXTURE_BASELINE_TAG, FIXTURE_REPO_ENV, FIXTURE_REPO_PATTERN, FIXTURE_TOKEN_ENV } from "../needs-network.js";
import { parseTag } from "../tag.js";

export const REPO_REASONS = ["janitor-not-staging", "janitor-repo-unreadable", "janitor-repo-no-baseline", "janitor-repo-protected", "janitor-repo-write-failed"] as const;
export type RepoReason = (typeof REPO_REASONS)[number];

export interface RepoAction {
  kind: "close-issue" | "close-pr" | "delete-branch" | "reset-branch";
  /** Issue or PR number. */
  number?: number;
  /** Branch name. */
  name?: string;
}
export type RepoJanitorResult =
  | { status: "done"; actions: RepoAction[]; applied: boolean }
  | { status: "skipped"; need: "SKIPPED-NEED test-repo" }
  | { status: "usage"; message: string }
  | { status: "refused"; reason: RepoReason; detail?: string; done: number };

export interface RepoJanitorOptions {
  /** The target's name; anything but `staging` is refused before a request. */
  target: string;
  env: Record<string, string | undefined>;
  apply: boolean;
  say: (line: string) => void;
  /** Extra trust root for a local TLS fake. */
  ca?: string;
}

interface Row {
  number: number;
  title: string;
  pull_request?: unknown;
  head?: { ref?: string; repo?: { full_name?: string } | null };
}
interface Branch {
  name: string;
  commit: { sha: string };
}
const SHA = /^[0-9a-f]{40}$/;
const isTagged = (s: unknown): boolean => typeof s === "string" && parseTag(s) !== null;
const isFx = (s: unknown): boolean => typeof s === "string" && s.startsWith("fx/");
const refPath = (branch: string): string => branch.split("/").map(encodeURIComponent).join("/");
const refused = (reason: RepoReason, done = 0, detail?: string): RepoJanitorResult => ({ status: "refused", reason, done, ...(detail !== undefined ? { detail } : {}) });

export async function runRepoJanitor(o: RepoJanitorOptions): Promise<RepoJanitorResult> {
  if (o.target !== "staging") return refused("janitor-not-staging");
  const name = o.env[FIXTURE_REPO_ENV];
  const token = o.env[FIXTURE_TOKEN_ENV];
  if (name !== undefined && name !== "" && !FIXTURE_REPO_PATTERN.test(name)) return { status: "usage", message: `${FIXTURE_REPO_ENV} must be owner/name (letters, digits, dashes; the repo part may also have dots and underscores)` };
  if (name === undefined || name === "" || token === undefined || token === "") return { status: "skipped", need: "SKIPPED-NEED test-repo" };
  const api = o.env["GITHUB_API_URL"];
  const gh: Pick<IssueOptions, "token" | "apiBase" | "ca"> = { token, ...(api ? { apiBase: api } : {}), ...(o.ca !== undefined ? { ca: o.ca } : {}) };
  const base = `/repos/${name}`;

  // Reads. Nothing is written until all of them have succeeded.
  let defaultBranch: string;
  let baseSha: string;
  let issues: Row[];
  let pulls: Row[];
  let branches: Branch[];
  try {
    defaultBranch = ((await request(gh, "GET", base)) as { default_branch?: string }).default_branch ?? "";
    if (defaultBranch === "") return refused("janitor-repo-unreadable");
  } catch {
    return refused("janitor-repo-unreadable");
  }
  try {
    const ref = ((await request(gh, "GET", `${base}/git/ref/tags/${FIXTURE_BASELINE_TAG}`)) as { object?: { type?: string; sha?: string } }).object;
    // An annotated tag names a tag object; one more read gets the commit it points at.
    baseSha = (ref?.type === "tag" ? ((await request(gh, "GET", `${base}/git/tags/${ref.sha}`)) as { object?: { sha?: string } }).object?.sha : ref?.sha) ?? "";
  } catch (err) {
    return refused(err instanceof GithubError && err.status === 404 ? "janitor-repo-no-baseline" : "janitor-repo-unreadable");
  }
  if (!SHA.test(baseSha)) return refused("janitor-repo-unreadable");
  try {
    issues = ((await pagedGet(gh, `${base}/issues?state=open`)) as Row[]).filter((r) => r.pull_request === undefined);
    pulls = (await pagedGet(gh, `${base}/pulls?state=open`)) as Row[];
    branches = (await pagedGet(gh, `${base}/branches`)) as Branch[];
  } catch {
    return refused("janitor-repo-unreadable");
  }
  const tip = branches.find((b) => b.name === defaultBranch)?.commit.sha;
  if (tip === undefined) return refused("janitor-repo-unreadable");

  // The plan, in the order it runs.
  const mineFx = (p: Row): boolean => isFx(p.head?.ref) && p.head?.repo?.full_name?.toLowerCase() === name.toLowerCase();
  const actions: RepoAction[] = [
    ...issues.filter((i) => isTagged(i.title)).map((i): RepoAction => ({ kind: "close-issue", number: i.number })),
    ...pulls.filter((p) => isTagged(p.title) || mineFx(p)).map((p): RepoAction => ({ kind: "close-pr", number: p.number })),
    ...branches.filter((b) => (isFx(b.name) || isTagged(b.name)) && b.name !== defaultBranch && b.commit.sha !== baseSha).map((b): RepoAction => ({ kind: "delete-branch", name: b.name })),
    ...(tip !== baseSha ? [{ kind: "reset-branch", name: defaultBranch } satisfies RepoAction] : []),
  ];
  const label = (a: RepoAction): string => `${a.kind.replace("-", " ")} ${a.number !== undefined ? `#${a.number}` : JSON.stringify(a.name)}`;
  if (!o.apply) {
    for (const a of actions) o.say(`would ${label(a)}`);
    if (actions.length === 0) o.say("nothing to do");
    return { status: "done", actions, applied: false };
  }

  let done = 0;
  for (const a of actions) {
    try {
      if (a.kind === "close-issue") await request(gh, "PATCH", `${base}/issues/${a.number}`, { state: "closed", state_reason: "not_planned" });
      else if (a.kind === "close-pr") await request(gh, "PATCH", `${base}/pulls/${a.number}`, { state: "closed" });
      else if (a.kind === "delete-branch") await request(gh, "DELETE", `${base}/git/refs/heads/${refPath(a.name as string)}`);
      else await request(gh, "PATCH", `${base}/git/refs/heads/${refPath(defaultBranch)}`, { sha: baseSha, force: true });
    } catch (err) {
      const status = err instanceof GithubError ? err.status : 0;
      if (a.kind === "reset-branch") return refused("janitor-repo-protected", done, `branch ${defaultBranch} refused the move to ${FIXTURE_BASELINE_TAG} (GitHub answered ${status}); check its branch protection allows force pushes`);
      return refused("janitor-repo-write-failed", done, `could not ${label(a)} (GitHub answered ${status})`);
    }
    done += 1;
    o.say(`done: ${label(a)}`);
  }
  if (actions.length === 0) o.say("nothing to do");
  return { status: "done", actions, applied: true };
}

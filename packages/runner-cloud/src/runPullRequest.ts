import { COPY } from "@fulcrumaxe/runner-protocol";
import { safeChildTitle } from "@fx/core/src/work-items/childTitle.js";
import { cleanWorkItemTitle } from "@fx/core/src/work-items/title.js";
import type { TenantQueryable } from "./acceptanceScope.js";
import { LocalOnlyGithubError, SETUP_INSTALL_LABELS, TEAM_LOG_LABEL, TWIN_SYNC_LABEL, localOnlyGithub, type GithubClient, type GithubGraphqlOperation, type GithubResponse, type InstallMergePin, type LocalOnlyGithub } from "./localOnlyGithub.js";

/**
 * D#6 R2b-3e (C21 section 5, C22 section 6): the GitHub port the `done` route will use for a `runner_local` repo. There is no
 * route here. The port is the only thing that talks to GitHub about such a repo, and it does so only through `localOnlyGithub`,
 * which it applies itself to whatever client `open` returns, so a caller cannot hand it an unfenced one. Its calls are exactly the
 * allowlist's A1 to A5:
 *
 *   defaultBranch  A2  the repository's default branch, read at `done` (it is the pull request's base)
 *   branchState    A1  RunBranchState: does the run branch exist, its head oid, how far ahead of the base, the default branch
 *   openDraft      A3, A4  find the open pull request for the branch (on the run's base) and reuse it, or open a DRAFT one; where
 *                          the repository cannot have drafts, ONE retry as a ready pull request (C23 section 4)
 *   changedFiles   A1  PullRequestFiles: paths and change types only, every page, with the total
 *   markReady      A1  MarkReady
 *   close          A5  close the pull request (a scope violation)
 *
 * The order is the draft-first rule: GitHub's GraphQL gives the changed paths without patches only for a pull request, so the
 * pull request has to exist before its files can be read, and it must not be reviewable until they have been checked. So the only
 * way this port opens a pull request is as a draft, and the only way it makes one ready is `markReady`. The one exception is a
 * repository that cannot have drafts (GitHub Free, private): GitHub answers the draft with a 422 that says so, and the port then
 * retries once with `draft: false` and a fixed line in the body (`READY_FALLBACK_LINE`). That pull request is already ready, so its
 * ref says `draft: false` and `markReady` does nothing for it; the scope check still runs before the run can succeed, and a
 * violation still closes it. Any other 422, and a 422 on the retry, is `rejected`.
 * The caller reads `changedFiles`, holds them to the scope, and only then calls `markReady`.
 *
 * Failures: a transport error, a 5xx, a 429 and a rate-limit 403 are `unavailable` (retry later; the `done` route answers 503 and
 * writes nothing). Any other non-success status, a GraphQL error and a body of the wrong shape are `rejected` or `malformed`. No
 * error message holds a path, a name or a response body. Opening the client has two kinds of failure: no installation, or an App that
 * cannot write (a read-only one), is permanent and `rejected`; a token mint that failed or timed out, or a transport error, is `unavailable`. A `LocalOnlyGithubError` is a bug in this file, not a GitHub failure, and
 * is rethrown unchanged.
 */

export interface PullRequestRepo {
  /** From our own `repos` row (never from the job or the runner). `id` is what `open` uses to find the repository's installation. */
  id: string;
  owner: string;
  name: string;
}

export type RunPullRequestFailure = "unavailable" | "rejected" | "malformed";
/** What a failure may say about itself for the logs: names we chose and error type codes, never a GitHub message, a path or a body. */
export interface RunPullRequestErrorDetail {
  /** The GraphQL document (`PullRequestFiles`) or the port method (`close`) that failed. */
  op?: string;
  /** The `type` of each GraphQL error, each already held to `^[A-Z][A-Z_]{0,39}$`, at most 5. */
  graphqlTypes?: readonly string[];
  /** The pull request was asked for before GitHub could show it (a GraphQL NOT_FOUND, or a null `pullRequest`): worth a short wait, see `settle`. */
  notYetVisible?: boolean;
}
const GRAPHQL_TYPE = /^[A-Z][A-Z_]{0,39}$/;
export class RunPullRequestError extends Error {
  op: string | undefined;
  readonly graphqlTypes: readonly string[];
  readonly notYetVisible: boolean;
  /** `status` is the HTTP status GitHub answered, when the failure came from a response. A number only: never a GitHub message (C23 section 4). */
  constructor(
    readonly reason: RunPullRequestFailure,
    readonly status?: number,
    detail: RunPullRequestErrorDetail = {},
  ) {
    super(`run pull request: ${reason}`);
    this.name = "RunPullRequestError";
    this.op = detail.op;
    this.graphqlTypes = (detail.graphqlTypes ?? []).filter((t) => GRAPHQL_TYPE.test(t)).slice(0, 5);
    this.notYetVisible = detail.notYetVisible === true;
  }
  get retryable(): boolean {
    return this.reason === "unavailable";
  }
}

export interface BranchState {
  /** Whether the run branch exists on GitHub. */
  exists: boolean;
  headOid: string | null;
  /** How many commits the branch is ahead of the base; null when the branch is missing or the base could not be compared. A caller must read null as "no commit". */
  aheadBy: number | null;
  defaultBranch: string | null;
}
export interface PullRequestRef {
  number: number;
  /** The GraphQL node id `markReady` needs. */
  nodeId: string;
  /** False when the pull request was already ready (a repeat `done` after `markReady`, or a person marked it). */
  draft: boolean;
  /** True when an open pull request for the branch already existed and was reused. */
  reused: boolean;
  /** The pull request's head commit as GitHub showed it when the ref was read (D#845 ON-8f2b: the install step holds it to the commit the runner pushed); absent when GitHub gave none. */
  headSha?: string;
}
/** The change types GitHub documents. The port does not classify: `changeType` is passed through exactly as GitHub gave it, an unknown value included (the rename rule is the `done` route's). */
export const CHANGE_TYPES = ["ADDED", "DELETED", "RENAMED", "COPIED", "MODIFIED", "CHANGED"] as const;
export interface ChangedFiles {
  /** `path` is the file's path after the change; GraphQL does not give a renamed file's old path. `changeType` is GitHub's string, verbatim. */
  files: Array<{ path: string; changeType: string }>;
  totalCount: number;
  /** True only when every page was read and the files read are exactly `totalCount`. Anything else must be treated as a scope violation. */
  complete: boolean;
}
/** The one line a ready fallback adds to the pull request body (C23 section 4). */
export const READY_FALLBACK_LINE = "Opened as ready because this repository does not support draft pull requests.";
export interface RunPullRequestText {
  runId: string;
  workItemId: string;
  workItemTitle: string | null;
  /** The work item's issue number from our own row (never the job or the runner), or null/absent when it has none. */
  issueNumber?: number | null;
  /** D#483 S5-b2c-2: a planned PR child's parent issue number, from our own rows. The body then says `Refs #<n>` and never closes it: a child's merge must not close the parent's issue. */
  parentIssueNumber?: number | null;
}

/** A pull request's title and body as the caller wrote them (the install pull request's; never an agent's words). */
export interface PullRequestText {
  title: string;
  body: string;
}

/**
 * One commit's changes against its base (D#845 ON-27d3, A32). `path` is the file's path after the change; `previousPath` is the path before it for a rename or copy (GitHub's `previous_filename`) and null for any other change.
 * `status` is GitHub's own string (`added`, `removed`, `modified`, `renamed`, `copied`, `changed`, `unchanged`), verbatim: the port does not classify. `complete` is true only when the answer holds exactly one commit and fewer
 * files than GitHub's cap of 300, so a list that may have been cut short is never read as the whole change.
 */
export interface CommitChanges {
  files: Array<{ path: string; previousPath: string | null; status: string }>;
  complete: boolean;
}

/** The port the install step uses: the run port plus the one read of a commit's parents (A25, a client of its own that no other call shares). */
export interface SetupInstallPort extends RunPullRequestPort {
  /** The parent commit ids of the commit `sha` in the repository, or null when GitHub has no commit of that id. */
  commitParents(input: { repo: PullRequestRepo; sha: string }): Promise<string[] | null>;
  /** D#845 ON-8f2b (A26): makes the engine's labels in the repository, one call each; a label that already exists counts as made. It throws the first failure. */
  ensureLabels(input: { repo: PullRequestRepo }): Promise<void>;
  /** D#845 ON-20a (A30): the install pull request as GitHub shows it now (state, head commit, per-file line counts), or null when there is none of that number. The install merge route is its only caller. */
  installPullRequest(input: { repo: PullRequestRepo; number: number }): Promise<InstallPullRequest | null>;
  /** D#845 ON-27d3 (A32): the changes of commit `head` against `base` (REST compare, `base...head`; both 40 hex), with a renamed file's old path. The twin sync's scope check is its caller. */
  commitChanges(input: { repo: PullRequestRepo; base: string; head: string }): Promise<CommitChanges>;
  /** D#845 ON-27d3 (A26, A31): makes the twin sync label in the repository (one that exists counts as made) and puts it on pull request `number`, through the `setup_labels` client. */
  labelTwinSync(input: { repo: PullRequestRepo; number: number }): Promise<void>;
  /**
   * D#845 ON-20a (A10): squash-merges pull request `number` at head `sha`, on a client pinned to exactly that number and sha (any other call is refused before it is sent). `merged`; `changed` when GitHub says
   * the head moved (409); `blocked` when it will not merge yet (405: a required check or review, or a conflict). The install merge route is its ONLY caller: the install step, the watch and the reconcile never merge.
   */
  mergeInstall(input: { repo: PullRequestRepo; number: number; sha: string }): Promise<"merged" | "changed" | "blocked">;
}

/** The clients the install flow opens besides the pull request client: the one that creates labels, and the one that merges (the merge gate's token). */
export type InstallPurpose = "setup_labels" | "setup_finish" | "setup_merge" | "setup_ready";
export interface InstallPullRequest {
  state: "OPEN" | "CLOSED" | "MERGED";
  merged: boolean;
  /** Merged, and by our own App's login (GraphQL names a bot without the `[bot]` REST adds): false for a merge by a person, and for a pull request not merged. */
  mergedByApp: boolean;
  headSha: string;
  /** Every page of the file list, with GitHub's own total; `complete` only when the files read are exactly that total. */
  files: Array<{ path: string; changeType: string; additions: number; deletions: number }>;
  totalCount: number;
  complete: boolean;
}

/** D#845 ON-13a4: what the finish phase reads about a repository before it seeds: its node id, whether Discussions are on, and the categories (names and ids only). */
export interface SeedTarget {
  repositoryId: string;
  discussionsEnabled: boolean;
  categories: Array<{ id: string; name: string }>;
}

/** D#845 ON-13a4: the finish phase's calls (A27 to A29, a client of their own): Discussions and the team-log issue. */
export interface SetupFinishPort extends SetupInstallPort {
  discussionTarget(repo: PullRequestRepo): Promise<SeedTarget>;
  /** The seeded Discussions of this setup that exist: row key to Discussion number, found by our hidden marker in the newest 300 Discussions, and only in one OUR App made (the oldest wins when a row key appears twice). */
  findSeeded(input: { repo: PullRequestRepo; setupId: string }): Promise<Map<string, number>>;
  createDiscussion(input: { repo: PullRequestRepo; repositoryId: string; categoryId: string; title: string; body: string }): Promise<number>;
  /** The number of an open `team-log` issue of the repository made by OUR App (not a pull request, not a person's), or null. */
  findTeamLog(repo: PullRequestRepo): Promise<number | null>;
  createTeamLog(input: { repo: PullRequestRepo; title: string; body: string }): Promise<number>;
}

export interface RunPullRequestPort {
  defaultBranch(repo: PullRequestRepo): Promise<string>;
  branchState(input: { repo: PullRequestRepo; branch: string; base: string }): Promise<BranchState>;
  /** `run` fills the run pull request's fixed title and body; `text` (D#845 ON-8f2a, the install pull request) gives them directly. One of the two is required. */
  openDraft(input: { repo: PullRequestRepo; branch: string; base: string; run?: RunPullRequestText; text?: PullRequestText }): Promise<PullRequestRef>;
  changedFiles(input: { repo: PullRequestRepo; number: number }): Promise<ChangedFiles>;
  /**
   * `setup: true` (D#845 ON-24a, FU-322, Ruling 127) is the install pull request's and the engine update's: GitHub refuses the mutation to the pull request token (contents read), so it goes through a client of its
   * own (the `setup_ready` token, fenced to the one `MarkReady` document, revoked as soon as the call ends). Without it (the run's) the call is the pull request client's, as before.
   */
  markReady(input: { repo: PullRequestRepo; pullRequest: PullRequestRef; setup?: boolean }): Promise<void>;
  close(input: { repo: PullRequestRepo; number: number }): Promise<void>;
}

/**
 * The ids and title the pull request text is made from, read from our own tables for the run (never from the job or the runner).
 * Null when the run has no work item. `client` must be under the run's tenant.
 */
export async function loadRunPullRequestText(client: TenantQueryable, run: { accountId: string; runId: string }): Promise<RunPullRequestText | null> {
  const { rows } = await client.query<{ work_item_id: string; title: string | null; gh_number: string | null; parent_number: string | null; is_child: boolean }>(
    `SELECT ar.work_item_id, w.title, w.gh_number, p.gh_number AS parent_number, (w.planned_pr_key IS NOT NULL) AS is_child
       FROM agent_runs ar
       JOIN work_items w ON w.account_id = ar.account_id AND w.id = ar.work_item_id
       LEFT JOIN work_items p ON p.account_id = w.account_id AND p.id = w.parent_id
      WHERE ar.account_id = $1 AND ar.id = $2`,
    [run.accountId, run.runId],
  );
  const row = rows[0];
  if (rows.length !== 1 || !row) return null;
  const base = { runId: run.runId, workItemId: row.work_item_id, workItemTitle: row.title };
  // A planned PR child references its parent's issue and never closes it (it has no number of its own).
  // D#483 S5-b2c-4: its title is the one a person reads (`cleanWorkItemTitle`), on the private plane as on the public one.
  return row.is_child ? { ...base, workItemTitle: safeChildTitle(cleanWorkItemTitle(row.title)), issueNumber: null, parentIssueNumber: issueOf(row.parent_number) } : { ...base, issueNumber: issueOf(row.gh_number) };
}

/** An issue number a body may reference: a positive integer of at most 9 digits. Anything else (a huge bigint) is no reference, not a crash in `done`. */
const issueOf = (raw: string | null): number | null => (raw !== null && /^[1-9][0-9]{0,8}$/.test(raw) ? Number(raw) : null);

export const TITLE_MAX = 256;
export const MAX_FILE_PAGES = 30;
/** Pauses between looks at a pull request GitHub cannot show yet (about 2 s in all), then it is `unavailable`. */
export const VISIBILITY_WAITS_MS: readonly number[] = [300, 600, 1200];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HEX40 = /^[0-9a-f]{40}$/;
/** The most files GitHub lists in one compare answer. */
const COMPARE_FILES_CAP = 300;

/** The work item's title as a pull request title: whitespace and control characters collapsed, at most 256 characters (never half a surrogate pair), or the fixed fallback. */
export function pullRequestTitle(workItemTitle: string | null): string {
  const clean = (workItemTitle ?? "").replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
  let out = "";
  for (const ch of clean) {
    if (out.length + ch.length > TITLE_MAX) break;
    out += ch;
  }
  return out.trimEnd() || COPY.pullRequestTitleFallback;
}

/**
 * The pull request's description: the fixed template with the two ids, then (when the item has an issue) one `Closes #<n>` line so the
 * pull_request webhook moves the item at once. Nothing the agent wrote can reach it, because nothing else is an input. The number comes
 * from our own work item row and must be a positive integer of at most 9 digits.
 */
export function pullRequestBody(input: { runId: string; workItemId: string; issueNumber?: number | null; parentIssueNumber?: number | null }, options: { readyFallback?: boolean } = {}): string {
  if (!UUID.test(input.runId) || !UUID.test(input.workItemId)) throw new TypeError("pullRequestBody: ids must be UUIDs");
  const issue = input.issueNumber ?? null;
  const parent = input.parentIssueNumber ?? null;
  for (const n of [issue, parent]) if (n !== null && !(Number.isSafeInteger(n) && n >= 1 && n <= 999_999_999)) throw new TypeError("pullRequestBody: the issue number must be a positive integer of at most 9 digits");
  const template = COPY.pullRequestBody.replace("{run}", input.runId).replace("{item}", input.workItemId);
  const body = issue !== null ? `${template}\n\nCloses #${issue}` : parent !== null ? `${template}\n\nRefs #${parent}` : template;
  return options.readyFallback === true ? `${body}

${READY_FALLBACK_LINE}` : body;
}

/** How many pages of 100 Discussions the lookup before a create reads: the ones this step made are among the newest 300. */
const SEED_LOOKUP_PAGES = 3;
const stripBot = (login: string): string => login.toLowerCase().replace(/\[bot\]$/, "");
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const malformed = (): never => {
  throw new RunPullRequestError("malformed");
};
const need = <T>(value: T | null | undefined | false): T => (value ? value : malformed());

/** Maps a response's status to success or the failure it stands for. */
function checkStatus(res: GithubResponse, ok: readonly number[]): void {
  if (ok.includes(res.status)) return;
  const message = isObject(res.body) && typeof res.body.message === "string" ? res.body.message : "";
  if (res.status >= 500 || res.status === 429 || (res.status === 403 && /rate limit|abuse/i.test(message))) throw new RunPullRequestError("unavailable");
  throw new RunPullRequestError("rejected", res.status);
}

/**
 * Whether a 422 from `POST /pulls` says the repository cannot have draft pull requests: `draft` together with `not supported`,
 * case-insensitive, in GitHub's top-level `message` or in any `errors[].message` (or a bare string in `errors`).
 *
 * GitHub's wording, as users report it, inside the REST validation-failure shape (`message: "Validation Failed"`,
 * `errors: [{ resource, code: "custom", message }]`): "Draft pull requests are not supported in this repository." GitHub's own
 * pages state the cause but do not quote the string: draft pull requests exist in public repositories on Free and Pro and in public
 * and private repositories on Team and above (docs.github.com, "About pull requests", section "Draft pull requests"). The match is
 * loose on purpose, so a rewording that keeps both words still works; a different 422 (no commits, duplicate, bad head) says neither.
 */
export function isDraftUnsupported(body: unknown): boolean {
  const texts: unknown[] = [];
  if (isObject(body)) {
    texts.push(body.message);
    if (Array.isArray(body.errors)) for (const e of body.errors as unknown[]) texts.push(isObject(e) ? e.message : e);
  }
  return texts.some((t) => typeof t === "string" && /draft/i.test(t) && /not supported/i.test(t));
}

/** GitHub's answer to a label that is already there: a 422 whose every error says a Label already exists. Any other 422 is a refusal. */
function isLabelExists(body: unknown): boolean {
  return isObject(body) && Array.isArray(body.errors) && body.errors.length > 0 && body.errors.every((e) => isObject(e) && e.resource === "Label" && e.code === "already_exists");
}

async function guarded(call: () => Promise<GithubResponse>): Promise<GithubResponse> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof LocalOnlyGithubError || error instanceof RunPullRequestError) throw error;
    // fx-swallow-ok: a transport failure or timeout; the original's text can carry the request URL, so only a fixed reason survives
    throw new RunPullRequestError("unavailable");
  }
}

/** Runs a fixed document and answers its `data`. GraphQL errors arrive with status 200, so `errors` is read here. */
async function query(gh: LocalOnlyGithub, op: GithubGraphqlOperation, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await guarded(() => gh.graphql(op, variables));
  checkStatus(res, [200]);
  if (!isObject(res.body)) throw new RunPullRequestError("malformed", res.status, { op });
  if (Array.isArray(res.body.errors) && res.body.errors.length > 0) {
    const types = res.body.errors.map((e) => (isObject(e) && typeof e.type === "string" ? e.type : "UNTYPED"));
    const limited = types.some((t) => t === "RATE_LIMITED" || t === "SERVICE_UNAVAILABLE");
    // GraphQL reads a pull request from a replica that can be behind the REST call that created it: for a moment the number or the node id
    // is "not found". That is not a refusal. Only the type is looked at; the message (which names the repository) never is.
    const notYetVisible = !limited && types.includes("NOT_FOUND");
    throw new RunPullRequestError(limited ? "unavailable" : "rejected", res.status, { op, graphqlTypes: types, notYetVisible });
  }
  return isObject(res.body.data) ? res.body.data : malformed();
}

/** An `open` failure that no retry fixes: the repository has no installation, or its App cannot write. Read by the error's own code, so this package needs no import of @fx/github. */
function isPermanentOpenFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: unknown; reason?: unknown };
  return e.code === "installation_not_writable" || e.reason === "no_installation";
}

const repoPath = (repo: PullRequestRepo): string => `/repos/${repo.owner}/${repo.name}`;
const sameRepo = (fullName: unknown, repo: PullRequestRepo): boolean => typeof fullName === "string" && fullName.toLowerCase() === `${repo.owner}/${repo.name}`.toLowerCase();

function pullRequestRef(raw: unknown, branch: string, repo: PullRequestRepo, reused: boolean): PullRequestRef {
  if (!isObject(raw) || !isCount(raw.number) || raw.number < 1 || typeof raw.node_id !== "string" || typeof raw.draft !== "boolean" || raw.state !== "open") return malformed();
  const head = raw.head;
  if (!isObject(head) || head.ref !== branch || !isObject(head.repo) || !sameRepo(head.repo.full_name, repo)) return malformed();
  const sha = head.sha;
  return { number: raw.number, nodeId: raw.node_id, draft: raw.draft, reused, ...(typeof sha === "string" && OID.test(sha) ? { headSha: sha } : {}) };
}

/** Builds the port over `open`, which answers a client for one repository (the App's installation token for it; for the app, see apps/web). */
export function createRunPullRequestPort(deps: {
  /**
   * A client for one repository. With no `purpose` it is the pull request client (find, open, read, close, GraphQL). `"setup_labels"` asks for the one that may create labels: the pull request
   * client's token and path list hold no `issues` write and no `/labels`, so `ensureLabels` must NOT go through it (a fake that did not model the live path list hid exactly that).
   * `"setup_finish"` (D#845 ON-13a4) asks for the one that may make Discussions and the team-log issue (Discussions and Issues write, no contents).
   */
  open(repo: PullRequestRepo, purpose?: InstallPurpose): Promise<GithubClient>;
  /** Waits between looks at a pull request GitHub cannot show yet. Tests inject an instant one. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * The login GitHub gives pull requests opened by OUR App for this repository (`<app slug>[bot]`). An open pull request on the run's
   * branch is reused only if its author is this login and its type is `Bot`; any other author is `rejected` (fail closed: the branch is
   * kept and no second pull request is attempted). A throw is a failure to find out, so it is `unavailable`; an empty answer is `rejected`.
   */
  appLogin(repo: PullRequestRepo): Promise<string>;
}): SetupFinishPort {
  const client = async (repo: PullRequestRepo, options: { setupInstall?: boolean; setupFinish?: boolean; markReadyOnly?: boolean; purpose?: InstallPurpose; installMerge?: InstallMergePin } = {}): Promise<LocalOnlyGithub> => {
    let inner: GithubClient;
    try {
      inner = await (options.purpose === undefined ? deps.open(repo) : deps.open(repo, options.purpose));
    } catch (error) {
      // fx-swallow-ok: the cause can carry a name or a token, so only a fixed reason survives. No installation and a read-only App
      // are permanent (a retry cannot fix them); a token mint that failed or timed out, or a transport error, is worth retrying.
      throw new RunPullRequestError(isPermanentOpenFailure(error) ? "rejected" : "unavailable");
    }
    return localOnlyGithub(inner, options);
  };

  async function findOpen(gh: LocalOnlyGithub, repo: PullRequestRepo, branch: string, base: string): Promise<PullRequestRef | null> {
    const res = await guarded(() => gh.request({ method: "GET", path: `${repoPath(repo)}/pulls`, query: { head: `${repo.owner}:${branch}`, base, state: "open", per_page: 100 } }));
    checkStatus(res, [200]);
    if (!Array.isArray(res.body)) return malformed();
    // A pull request whose head is a fork's branch of the same name is not ours; only a head in this repository counts. A reused one
    // must also target the run's base (the query asks for it; this holds the answer to it too), or the scope check would read another diff.
    const mine = (res.body as unknown[]).filter(
      (item) => isObject(item) && isObject(item.head) && item.head.ref === branch && isObject(item.head.repo) && sameRepo(item.head.repo.full_name, repo) && isObject(item.base) && item.base.ref === base,
    );
    if (mine.length === 0) return null;
    // Reusing a pull request means the scope check reads ITS files and `markReady` publishes it: only one our App opened qualifies. Somebody
    // else's (a person's, or the agent's own with the customer's credentials) is never touched, and nothing replaces it.
    let login: string;
    try {
      login = await deps.appLogin(repo);
    } catch {
      // fx-swallow-ok: the cause can carry a name or a token; a failure to learn our own login is a failure to ask GitHub, so it is retried
      throw new RunPullRequestError("unavailable");
    }
    if (typeof login !== "string" || login.length === 0) throw new RunPullRequestError("rejected");
    const wanted = login.toLowerCase();
    for (const item of mine) {
      const user = (item as Record<string, unknown>).user;
      if (!isObject(user) || user.type !== "Bot" || typeof user.login !== "string" || user.login.toLowerCase() !== wanted) throw new RunPullRequestError("rejected");
    }
    return mine.map((item) => pullRequestRef(item, branch, repo, true)).sort((a, b) => a.number - b.number)[0]!;
  }

  /** Our own App's login for the repository, lower-cased and without GitHub's `[bot]` suffix (GraphQL names a bot by its slug, REST by `<slug>[bot]`). A failure to learn it is retried; an empty one is refused. */
  async function ownSlug(repo: PullRequestRepo): Promise<string> {
    let login: string;
    try {
      login = await deps.appLogin(repo);
    } catch {
      // fx-swallow-ok: the cause can carry a name or a token; a failure to learn our own login is a failure to ask GitHub, so it is retried
      throw new RunPullRequestError("unavailable");
    }
    if (typeof login !== "string" || login.length === 0) throw new RunPullRequestError("rejected");
    return stripBot(login);
  }

  /** Whether the actor GitHub names as a pull request's merger is our own App: a Bot whose login is the App's, compared without the `[bot]` suffix. A person, no actor or another App is false. */
  async function mergedByOurApp(repo: PullRequestRepo, mergedBy: unknown): Promise<boolean> {
    if (!isObject(mergedBy) || mergedBy.__typename !== "Bot" || typeof mergedBy.login !== "string") return false;
    return stripBot(mergedBy.login) === (await ownSlug(repo));
  }

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  /**
   * `changedFiles` and `markReady` ask GraphQL about a pull request the REST call created a moment ago. GraphQL can answer NOT_FOUND (or a
   * null `pullRequest`) for that moment, so the look is repeated a few times, shortly apart. A pull request still not visible after that is
   * `unavailable` (the `done` route answers 503 and writes nothing, the runner sends `done` again, and the open pull request is reused), not
   * a permanent failure: the pull request exists, so closing it and failing the run would throw away a good result.
   */
  async function settle<T>(look: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await look();
      } catch (error) {
        if (!(error instanceof RunPullRequestError) || !error.notYetVisible) throw error;
        const wait = VISIBILITY_WAITS_MS[attempt];
        if (wait === undefined) throw new RunPullRequestError("unavailable", error.status, { ...(error.op === undefined ? {} : { op: error.op }), graphqlTypes: error.graphqlTypes, notYetVisible: true });
        await sleep(wait);
      }
    }
  }

  const port: SetupFinishPort = {
    async defaultBranch(repo) {
      const gh = await client(repo);
      const res = await guarded(() => gh.request({ method: "GET", path: repoPath(repo) }));
      checkStatus(res, [200]);
      if (!isObject(res.body) || !sameRepo(res.body.full_name, repo)) return malformed();
      const name = res.body.default_branch;
      return typeof name === "string" && name.length > 0 ? name : malformed();
    },

    async branchState({ repo, branch, base }) {
      const gh = await client(repo);
      const data = await query(gh, "RunBranchState", { owner: repo.owner, name: repo.name, head: branch, base });
      const repository = need(isObject(data.repository) && data.repository);
      const defaultRef = repository.defaultBranchRef;
      const defaultBranch = isObject(defaultRef) && typeof defaultRef.name === "string" ? defaultRef.name : null;
      const ref = repository.ref;
      if (ref === null || ref === undefined) return { exists: false, headOid: null, aheadBy: null, defaultBranch };
      if (!isObject(ref) || ref.name !== branch || !isObject(ref.target) || typeof ref.target.oid !== "string" || !OID.test(ref.target.oid)) return malformed();
      const baseRef = repository.baseRef;
      const compare = isObject(baseRef) ? baseRef.compare : null;
      const aheadBy = isObject(compare) && isCount(compare.aheadBy) ? compare.aheadBy : null;
      return { exists: true, headOid: ref.target.oid, aheadBy, defaultBranch };
    },

    async openDraft({ repo, branch, base, run, text }) {
      if (run === undefined && text === undefined) return malformed();
      const ids = run === undefined ? null : { runId: run.runId, workItemId: run.workItemId, issueNumber: run.issueNumber ?? null, parentIssueNumber: run.parentIssueNumber ?? null };
      const title = text !== undefined ? pullRequestTitle(text.title) : pullRequestTitle(run!.workItemTitle);
      const bodyFor = (readyFallback: boolean): string => (text !== undefined ? (readyFallback ? `${text.body}\n\n${READY_FALLBACK_LINE}` : text.body) : pullRequestBody(ids!, { readyFallback }));
      const body = bodyFor(false);
      const gh = await client(repo);
      const existing = await findOpen(gh, repo, branch, base);
      if (existing) return existing;
      const create = (text: string, draft: boolean) => guarded(() => gh.request({ method: "POST", path: `${repoPath(repo)}/pulls`, body: { title, body: text, head: branch, base, draft } }));
      const res = await create(body, true);
      if (res.status === 422) {
        // Another attempt opened it between our look and our create: use theirs. If there is still none, GitHub refused for another reason.
        const raced = await findOpen(gh, repo, branch, base);
        if (raced) return raced;
        if (isDraftUnsupported(res.body)) {
          // The repository cannot have drafts: retry ONCE as a ready pull request. A 422 on the retry, like any other status, goes to checkStatus.
          const retry = await create(bodyFor(true), false);
          checkStatus(retry, [201]);
          return pullRequestRef(retry.body, branch, repo, false);
        }
      }
      checkStatus(res, [201]);
      return pullRequestRef(res.body, branch, repo, false);
    },

    async commitParents({ repo, sha }) {
      if (!OID.test(sha)) return malformed();
      const gh = await client(repo, { setupInstall: true });
      const data = await query(gh, "CommitParents", { owner: repo.owner, name: repo.name, sha });
      const repository = need(isObject(data.repository) && data.repository);
      const object = repository.object;
      if (object === null || object === undefined) return null;
      // An object that is not a commit (a tag, a tree) selects nothing under the commit fragment: it is no commit of that id.
      if (!isObject(object) || object.oid === undefined) return null;
      if (object.oid !== sha) return malformed();
      const parents = need(isObject(object.parents) && object.parents);
      if (!isCount(parents.totalCount) || !Array.isArray(parents.nodes) || parents.nodes.length !== parents.totalCount || parents.totalCount > 5) return malformed();
      return (parents.nodes as unknown[]).map((n) => (isObject(n) && typeof n.oid === "string" && OID.test(n.oid) ? n.oid : malformed()));
    },

    async commitChanges({ repo, base, head }) {
      if (!HEX40.test(base) || !HEX40.test(head)) return malformed();
      const gh = await client(repo, { setupInstall: true });
      const res = await guarded(() => gh.request({ method: "GET", path: `${repoPath(repo)}/compare/${base}...${head}` }));
      checkStatus(res, [200]);
      const body = res.body;
      if (!isObject(body) || !isCount(body.total_commits) || !Array.isArray(body.files)) return malformed();
      const files = (body.files as unknown[]).map((f) => {
        if (!isObject(f) || typeof f.filename !== "string" || f.filename.length === 0 || typeof f.status !== "string") return malformed();
        const prev = f.previous_filename;
        if (prev !== undefined && (typeof prev !== "string" || prev.length === 0)) return malformed();
        return { path: f.filename, previousPath: prev ?? null, status: f.status };
      });
      // GitHub lists at most 300 files of a compare; a list that long may be a cut one. More than one commit is not the one verified commit on its parent.
      return { files, complete: body.total_commits === 1 && files.length < COMPARE_FILES_CAP };
    },

    async labelTwinSync({ repo, number }) {
      if (!isCount(number) || number < 1) return malformed();
      const gh = await client(repo, { setupInstall: true, purpose: "setup_labels" });
      try {
        const made = await guarded(() => gh.request({ method: "POST", path: `${repoPath(repo)}/labels`, body: { name: TWIN_SYNC_LABEL.name, color: TWIN_SYNC_LABEL.color, description: TWIN_SYNC_LABEL.description } }));
        if (!(made.status === 422 && isLabelExists(made.body))) checkStatus(made, [201]);
        checkStatus(await guarded(() => gh.request({ method: "POST", path: `${repoPath(repo)}/issues/${number}/labels`, body: { labels: [TWIN_SYNC_LABEL.name] } })), [200]);
      } finally {
        // The `setup_labels` token holds an issues write: it is revoked as soon as the call ends, whatever its answer.
        await gh.close?.();
      }
    },

    async ensureLabels({ repo }) {
      const gh = await client(repo, { setupInstall: true, purpose: "setup_labels" });
      try {
        for (const row of SETUP_INSTALL_LABELS) {
          const res = await guarded(() => gh.request({ method: "POST", path: `${repoPath(repo)}/labels`, body: { name: row.name, color: row.color, description: row.description } }));
          if (res.status === 422 && isLabelExists(res.body)) continue;
          checkStatus(res, [201]);
        }
      } finally {
        // The `setup_labels` token holds an issues write: it is revoked as soon as the labels are made or the call fails, never left to lapse.
        await gh.close?.();
      }
    },

    async discussionTarget(repo) {
      const gh = await client(repo, { setupFinish: true, purpose: "setup_finish" });
      try {
        const data = await query(gh, "SeedTarget", { owner: repo.owner, name: repo.name });
        const r = need(isObject(data.repository) && data.repository);
        const cats = isObject(r.discussionCategories) && Array.isArray(r.discussionCategories.nodes) ? (r.discussionCategories.nodes as unknown[]) : malformed();
        if (typeof r.id !== "string" || r.id.length === 0 || typeof r.hasDiscussionsEnabled !== "boolean") return malformed();
        return { repositoryId: r.id, discussionsEnabled: r.hasDiscussionsEnabled, categories: cats.map((n) => (isObject(n) && typeof n.id === "string" && typeof n.name === "string" ? { id: n.id, name: n.name } : malformed())) };
      } finally {
        // The `setup_finish` token holds Discussions and Issues write: it is revoked as soon as the call ends, whatever its answer (FU-261).
        await gh.close?.();
      }
    },

    async findSeeded({ repo, setupId }) {
      if (!UUID.test(setupId)) return malformed();
      const gh = await client(repo, { setupFinish: true, purpose: "setup_finish" });
      try {
        const ours = await ownSlug(repo);
        const marker = new RegExp(`<!-- fx-seed:${setupId}:([A-Z][A-Z0-9-]{0,15}) -->\\s*$`);
        const found = new Map<string, number>();
        let cursor: string | null = null;
        for (let page = 0; page < SEED_LOOKUP_PAGES; page++) {
          const data = await query(gh, "SeedDiscussions", { owner: repo.owner, name: repo.name, ...(cursor === null ? {} : { cursor }) });
          const list = need(isObject(data.repository) && isObject(data.repository.discussions) && data.repository.discussions);
          const info = need(isObject(list.pageInfo) && list.pageInfo);
          if (!Array.isArray(list.nodes) || typeof info.hasNextPage !== "boolean") return malformed();
          // Only the number of a Discussion that carries our marker is kept; every other body is dropped here.
          for (const node of list.nodes as unknown[]) {
            if (!isObject(node) || !isCount(node.number) || typeof node.body !== "string") return malformed();
            // A marker is only a claim anybody can type: it counts only on a Discussion OUR App made (a Bot whose login is the App's), or a person could stand in for a row and have it never created.
            const author = node.author;
            const mine = isObject(author) && author.__typename === "Bot" && typeof author.login === "string" && stripBot(author.login) === ours;
            const m = mine ? marker.exec(node.body) : null;
            if (m !== null && node.number >= 1 && (!found.has(m[1]!) || node.number < found.get(m[1]!)!)) found.set(m[1]!, node.number);
          }
          if (!info.hasNextPage) break;
          if (typeof info.endCursor !== "string" || info.endCursor === cursor) return malformed();
          cursor = info.endCursor;
        }
        return found;
      } finally {
        // The `setup_finish` token holds Discussions and Issues write: it is revoked as soon as the call ends, whatever its answer (FU-261).
        await gh.close?.();
      }
    },

    async createDiscussion({ repo, repositoryId, categoryId, title, body }) {
      const gh = await client(repo, { setupFinish: true, purpose: "setup_finish" });
      try {
        const data = await query(gh, "SeedCreateDiscussion", { repositoryId, categoryId, title, body });
        const made = need(isObject(data.createDiscussion) && isObject(data.createDiscussion.discussion) && data.createDiscussion.discussion);
        return isCount(made.number) && made.number >= 1 ? made.number : malformed();
      } finally {
        // The `setup_finish` token holds Discussions and Issues write: it is revoked as soon as the call ends, whatever its answer (FU-261).
        await gh.close?.();
      }
    },

    async findTeamLog(repo) {
      const gh = await client(repo, { setupFinish: true, purpose: "setup_finish" });
      try {
        const ours = await ownSlug(repo);
        const res = await guarded(() => gh.request({ method: "GET", path: `${repoPath(repo)}/issues`, query: { labels: TEAM_LOG_LABEL, state: "open", per_page: 30 } }));
        checkStatus(res, [200]);
        if (!Array.isArray(res.body)) return malformed();
        // The list holds pull requests too (each has a `pull_request` key); the first issue is the newest one.
        // Only an issue OUR App made is ours to reuse: one a person opened with the label is theirs, and the finish phase makes its own beside it.
        for (const item of res.body as unknown[]) {
          const user = isObject(item) ? item.user : undefined;
          if (isObject(item) && item.pull_request === undefined && isCount(item.number) && item.number >= 1 && isObject(user) && user.type === "Bot" && typeof user.login === "string" && stripBot(user.login) === ours) return item.number;
        }
        return null;
      } finally {
        // The `setup_finish` token holds Discussions and Issues write: it is revoked as soon as the call ends, whatever its answer (FU-261).
        await gh.close?.();
      }
    },

    async createTeamLog({ repo, title, body }) {
      const gh = await client(repo, { setupFinish: true, purpose: "setup_finish" });
      try {
        const res = await guarded(() => gh.request({ method: "POST", path: `${repoPath(repo)}/issues`, body: { title, body, labels: [TEAM_LOG_LABEL] } }));
        checkStatus(res, [201]);
        return isObject(res.body) && isCount(res.body.number) && res.body.number >= 1 ? res.body.number : malformed();
      } finally {
        // The `setup_finish` token holds Discussions and Issues write: it is revoked as soon as the call ends, whatever its answer (FU-261).
        await gh.close?.();
      }
    },

    async installPullRequest({ repo, number }) {
      const gh = await client(repo, { setupInstall: true });
      const files: InstallPullRequest["files"] = [];
      let head = null as Omit<InstallPullRequest, "files" | "complete"> | null;
      let cursor: string | null = null;
      for (let page = 0; page < MAX_FILE_PAGES; page++) {
        let data: Record<string, unknown>;
        try {
          data = await query(gh, "InstallPullRequest", { owner: repo.owner, name: repo.name, number, ...(cursor === null ? {} : { cursor }) });
        } catch (error) {
          // GitHub answers a number it has no pull request for with NOT_FOUND: that is "there is none", not a failure
          if (error instanceof RunPullRequestError && error.notYetVisible) return null;
          throw error;
        }
        const pr = need(isObject(data.repository) && data.repository).pullRequest;
        if (pr === null || pr === undefined) return null;
        if (!isObject(pr) || pr.number !== number || (pr.state !== "OPEN" && pr.state !== "CLOSED" && pr.state !== "MERGED") || typeof pr.merged !== "boolean" || typeof pr.headRefOid !== "string" || !OID.test(pr.headRefOid)) return malformed();
        const list = need(isObject(pr.files) && pr.files);
        const info = need(isObject(list.pageInfo) && list.pageInfo);
        if (!isCount(list.totalCount) || !Array.isArray(list.nodes) || list.nodes.length > 100 || typeof info.hasNextPage !== "boolean") return malformed();
        // one head for every page: a pull request pushed to while it is read is not a list that means anything
        if (head !== null && head.headSha !== pr.headRefOid) return malformed();
        head = { state: pr.state, merged: pr.merged, mergedByApp: head?.mergedByApp ?? (pr.merged && (await mergedByOurApp(repo, pr.mergedBy))), headSha: pr.headRefOid, totalCount: list.totalCount };
        for (const n of list.nodes as unknown[]) {
          if (!isObject(n) || typeof n.path !== "string" || n.path.length === 0 || typeof n.changeType !== "string" || n.changeType.length === 0 || !isCount(n.additions) || !isCount(n.deletions)) return malformed();
          files.push({ path: n.path, changeType: n.changeType, additions: n.additions, deletions: n.deletions });
        }
        if (!info.hasNextPage) return { ...head, files, complete: files.length === head.totalCount };
        if (typeof info.endCursor !== "string" || info.endCursor === cursor) return malformed();
        cursor = info.endCursor;
      }
      return head === null ? malformed() : { ...head, files, complete: false };
    },

    async mergeInstall({ repo, number, sha }) {
      const gh = await client(repo, { purpose: "setup_merge", installMerge: { owner: repo.owner, name: repo.name, number, sha } });
      try {
        const res = await guarded(() => gh.request({ method: "PUT", path: `${repoPath(repo)}/pulls/${number}/merge`, body: { sha, merge_method: "squash" } }));
        if (res.status === 409) return "changed";
        if (res.status === 405) return "blocked";
        checkStatus(res, [200]);
        return isObject(res.body) && res.body.merged === true ? "merged" : malformed();
      } finally {
        await gh.close?.();
      }
    },

    changedFiles: ({ repo, number }) => settle(() => readChangedFiles(repo, number)),
    markReady: ({ repo, pullRequest, setup }) => (pullRequest.draft ? settle(() => markReadyOnce(repo, pullRequest, setup === true)) : Promise.resolve()),

    async close({ repo, number }) {
      const gh = await client(repo);
      const res = await guarded(() => gh.request({ method: "PATCH", path: `${repoPath(repo)}/pulls/${number}`, body: { state: "closed" } }));
      checkStatus(res, [200]);
      if (!isObject(res.body) || res.body.number !== number || res.body.state !== "closed") malformed();
    },
  };

  async function readChangedFiles(repo: PullRequestRepo, number: number): Promise<ChangedFiles> {
    const gh = await client(repo);
    const files: ChangedFiles["files"] = [];
    let totalCount = 0;
    let cursor: string | null = null;
    for (let page = 0; page < MAX_FILE_PAGES; page++) {
      const data = await query(gh, "PullRequestFiles", { owner: repo.owner, name: repo.name, number, ...(cursor === null ? {} : { cursor }) });
      // A null pull request (with or without an `errors` entry) is GitHub not showing the new pull request yet.
      if (isObject(data.repository) && data.repository.pullRequest === null) throw new RunPullRequestError("rejected", 200, { op: "PullRequestFiles", notYetVisible: true });
      const pr = need(isObject(data.repository) && isObject(data.repository.pullRequest) && data.repository.pullRequest);
      const list = need(isObject(pr.files) && pr.files);
      const info = need(isObject(list.pageInfo) && list.pageInfo);
      if (!isCount(list.totalCount) || !Array.isArray(list.nodes) || list.nodes.length > 100 || typeof info.hasNextPage !== "boolean") return malformed();
      totalCount = list.totalCount;
      for (const node of list.nodes as unknown[]) {
        if (!isObject(node) || typeof node.path !== "string" || node.path.length === 0 || typeof node.changeType !== "string" || node.changeType.length === 0) return malformed();
        files.push({ path: node.path, changeType: node.changeType });
      }
      if (!info.hasNextPage) return { files, totalCount, complete: files.length === totalCount };
      if (typeof info.endCursor !== "string" || info.endCursor === cursor) return malformed();
      cursor = info.endCursor;
    }
    // More pages than GitHub lists for one pull request: what was read is not all of it.
    return { files, totalCount, complete: false };
  }

  async function markReadyOnce(repo: PullRequestRepo, pullRequest: PullRequestRef, setup = false): Promise<void> {
    const gh = await (setup ? client(repo, { purpose: "setup_ready", markReadyOnly: true }) : client(repo));
    try {
      const data = await query(gh, "MarkReady", { id: pullRequest.nodeId });
      const result = need(isObject(data.markPullRequestReadyForReview) && data.markPullRequestReadyForReview);
      const pr = need(isObject(result.pullRequest) && result.pullRequest);
      if (pr.number !== pullRequest.number || pr.isDraft !== false) malformed();
    } finally {
      // The `setup_ready` token holds contents write: it is revoked as soon as the call ends, whatever its answer.
      if (setup) await gh.close?.().catch(() => undefined);
    }
  }

  // Every failure says which port call it came from, unless a GraphQL document already named itself.
  return Object.fromEntries(
    (Object.keys(port) as Array<keyof RunPullRequestPort>).map((name) => [
      name,
      async (...args: unknown[]) => {
        try {
          return await (port[name] as (...a: unknown[]) => Promise<unknown>)(...args);
        } catch (error) {
          if (error instanceof RunPullRequestError && error.op === undefined) error.op = name;
          throw error;
        }
      },
    ]),
  ) as unknown as SetupFinishPort;
}

import { withPlatformOps } from "@fx/core/src/tenancy/withPlatformOps.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import type { AppCredentialsSource } from "./appCredentials.js";
import { GH_OWNER_LOGIN_RE, GH_REPO_NAME_RE, issueNeedsIntake, type GithubWebhookDbDeps, type GithubWebhookPayload } from "./eventMapper.js";
import { getInstallationToken, type AccessTokenRequester, type InstallationTokenCache } from "./installationToken.js";
import { handleGithubWebhookEventForApp } from "./webhookGate.js";

/**
 * Brings in open issues whose `issues.opened` delivery was lost (GitHub does not retry a delivery that failed). Run by the reconciler's repo
 * re-sync job after it has synced an installation's repositories, so it adds no schedule and no database wake of its own.
 *
 * Nothing here decides who is trusted or what an issue becomes: each unknown issue is turned into the `issues.opened` payload GitHub would have
 * sent and handed to the webhook's own entry point (`handleGithubWebhookEventForApp`), so the author permission lookup, the proposal rule for
 * outsiders, the work item rule for trusted authors, the app kind gate and the idempotency are the opened path's, not a copy.
 *
 * Bounds, per installation and pass (the numbers are the exported constants):
 *  - at most MISSED_ISSUE_REPOS_PER_INSTALLATION repositories, a window that moves on each pass so every repository is reached in turn;
 *  - per repository ONE list request for the MISSED_ISSUE_PAGE newest-created open items (pull requests among them are dropped), one token;
 *  - of those, only issues with no work item and no proposal are looked at, at most MISSED_ISSUES_PER_REPO of them, oldest first;
 *  - an issue created before the repository's row existed (it was installed or added later) is never imported here. Those belong to the install
 *    discovery, which reads the most recently updated open issues itself and turns them into proposals a person approves; a reconcile pass
 *    must not start work on an old issue just because a repository was enabled. Closed issues are never listed (state=open).
 * Every GitHub request is metered through `gate`; when it says no the pass stops where it is and the next pass starts again.
 */
export const MISSED_ISSUE_REPOS_PER_INSTALLATION = 25;
export const MISSED_ISSUE_PAGE = 30;
export const MISSED_ISSUES_PER_REPO = 5;
/** GitHub calls charged per repository (the token and the list) and per issue taken in (the issue read, the permission read, a token). */
export const MISSED_ISSUE_CALLS_PER_REPO = 2;
export const MISSED_ISSUE_CALLS_PER_ISSUE = 3;
/** Charged each time the owner process is read for an outside author's issue (the default branch head, the marker file, a token). */
export const MISSED_ISSUE_CALLS_PER_OWNER_READ = 3;
const WINDOW_MS = 6 * 60 * 60 * 1000;
const CALL_TIMEOUT_MS = 10_000;

export interface MissedIssueImportDeps {
  /** The webhook's own deps: pools, allowlist, author permission lookup, engine loop reader. */
  webhook: GithubWebhookDbDeps;
  appCredentials: AppCredentialsSource;
  requester: AccessTokenRequester;
  cache: InstallationTokenCache;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface MissedIssueGate {
  /** Spend `n` GitHub calls; false (and nothing spent) when that would go over the run's allowance. */
  take(n: number): boolean;
  /** True once the run's time is up. */
  stopped(): boolean;
}

export interface MissedIssueImportResult {
  repos: number;
  /** Issues with no work item and no proposal that were handed to the opened path. */
  attempted: number;
  /** Of those, how many ended as a work item or a proposal. */
  imported: number;
  /** Repositories whose list or an issue's intake failed (not a rate limit). */
  failures: number;
  stop?: "budget";
}

interface RepoRow {
  id: string;
  gh_repo_id: string;
  gh_owner: string;
  gh_name: string;
  created_at: Date;
}

interface ListedIssue {
  number: number;
  created_at: string;
  [k: string]: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export async function importMissedIssues(deps: MissedIssueImportDeps, installationId: string, gate: MissedIssueGate): Promise<MissedIssueImportResult> {
  const result: MissedIssueImportResult = { repos: 0, attempted: 0, imported: 0, failures: 0 };
  const fetchImpl = deps.fetchImpl ?? fetch;
  // The owner process read of an outside author's issue makes GitHub reads of its own; they are drawn from the same allowance. Refused: it throws,
  // and the intake leaves the issue for a later pass (fail closed).
  const baseOwnerRead = deps.webhook.repoHasEngineLoop;
  const webhook: GithubWebhookDbDeps = baseOwnerRead
    ? {
        ...deps.webhook,
        repoHasEngineLoop: async (input) => {
          if (gate.stopped() || !gate.take(MISSED_ISSUE_CALLS_PER_OWNER_READ)) {
            result.stop = 'budget';
            throw new Error('missedIssueImport: budget');
          }
          return baseOwnerRead(input);
        },
      }
    : deps.webhook;
  const now = deps.now ?? Date.now;

  // The installation row says whose it is (platform_ops reads installations); the repositories are then read as that tenant.
  const inst = await withPlatformOps(deps.webhook.platformOpsPool, async (client) => {
    const res = await client.query<{ account_id: string; gh: string; app_kind: string }>(
      `SELECT account_id, gh_installation_id::text AS gh, app_kind FROM installations WHERE id = $1`,
      [installationId],
    );
    return res.rows.length === 1 && res.rows[0]!.app_kind === "team" ? res.rows[0]! : null;
  });
  const found = inst
    ? {
        accountId: inst.account_id,
        ghInstallationId: Number(inst.gh),
        repos: await withTenant(deps.webhook.appUserPool, inst.account_id, async (client) => {
          const res = await client.query<RepoRow>(
            `SELECT id, gh_repo_id::text AS gh_repo_id, gh_owner, gh_name, created_at FROM repos WHERE installation_id = $1 AND gh_owner IS NOT NULL AND gh_name IS NOT NULL ORDER BY id`,
            [installationId],
          );
          return res.rows;
        }),
      }
    : null;
  if (!found || found.repos.length === 0) return result;

  // The window moves by its own size every 6 hours, so a pass reaches every repository in ceil(n / size) passes without keeping any state.
  const all = found.repos;
  const take = Math.min(MISSED_ISSUE_REPOS_PER_INSTALLATION, all.length);
  const start = (Math.floor(now() / WINDOW_MS) * MISSED_ISSUE_REPOS_PER_INSTALLATION) % all.length;
  const window = Array.from({ length: take }, (_, i) => all[(start + i) % all.length]!);

  for (const repo of window) {
    if (gate.stopped() || !gate.take(MISSED_ISSUE_CALLS_PER_REPO)) {
      result.stop = "budget";
      return result;
    }
    if (!GH_OWNER_LOGIN_RE.test(repo.gh_owner) || !GH_REPO_NAME_RE.test(repo.gh_name)) continue;
    result.repos += 1;
    try {
      const token = await getInstallationToken({
        installationId: found.ghInstallationId,
        appKind: "team",
        purpose: "run",
        role: "author_check",
        scope: { repositories: [repo.gh_name], permissions: { metadata: "read", issues: "read" } },
        appCredentials: deps.appCredentials,
        requester: deps.requester,
        cache: deps.cache,
      });
      const res = await fetchImpl(
        `https://api.github.com/repos/${repo.gh_owner}/${repo.gh_name}/issues?state=open&sort=created&direction=desc&per_page=${MISSED_ISSUE_PAGE}`,
        {
          headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
          redirect: "error",
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        },
      );
      if (res.status === 404 || res.status === 410) continue; // the repository is gone from this installation; the repo sync's job
      if (res.status === 429 || (res.status === 403 && res.headers.has("retry-after"))) {
        throw Object.assign(new Error("missedIssueImport: rate_limited"), { rateLimited: true });
      }
      if (res.status !== 200) throw new Error(`missedIssueImport: list_failed (${res.status})`);
      const list: unknown = await res.json();
      if (!Array.isArray(list)) throw new Error("missedIssueImport: list_malformed");

      const since = repo.created_at.getTime();
      const candidates: ListedIssue[] = [];
      for (const item of list) {
        if (!isRecord(item) || typeof item.number !== "number" || !Number.isSafeInteger(item.number)) continue;
        if (item.pull_request != null || item.state !== "open") continue;
        const created = typeof item.created_at === "string" ? Date.parse(item.created_at) : NaN;
        if (!Number.isFinite(created) || created < since) continue;
        candidates.push(item as ListedIssue);
      }
      if (candidates.length === 0) continue;

      const unknown = await withTenant(deps.webhook.appUserPool, found.accountId, async (client) => {
        const out: ListedIssue[] = [];
        for (const c of candidates) if (await issueNeedsIntake(client, found.accountId, repo.id, c.number, c.created_at)) out.push(c);
        return out;
      });
      // Oldest first: the one that has waited longest is taken in first, and the rest wait for the next pass.
      unknown.sort((a, b) => a.number - b.number);
      for (const issue of unknown.slice(0, MISSED_ISSUES_PER_REPO)) {
        if (gate.stopped() || !gate.take(MISSED_ISSUE_CALLS_PER_ISSUE)) {
          result.stop = "budget";
          return result;
        }
        result.attempted += 1;
        const payload = {
          action: "opened",
          issue,
          repository: { id: Number(repo.gh_repo_id), full_name: `${repo.gh_owner}/${repo.gh_name}` },
          installation: { id: found.ghInstallationId },
        } as unknown as GithubWebhookPayload;
        const out = await handleGithubWebhookEventForApp(webhook, "issues", payload, `reconcile:${repo.id}:${issue.number}`, "team");
        if (out.handled && (out.result.applied === "created" || out.result.applied === "proposed")) result.imported += 1;
      }
    } catch (err) {
      if ((err as { rateLimited?: unknown } | null)?.rateLimited === true) throw err;
      // fx-swallow-ok: counted in the result, which the reconcile job reports as one fixed-text error; no repository or issue text is kept
      result.failures += 1;
    }
  }
  return result;
}

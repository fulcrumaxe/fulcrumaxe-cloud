import { reportSyncFailure } from './syncFailureTag.js';
import type { Pool, PoolClient } from 'pg';
import {
  canCreateWork,
  type AuthorTrust,
  type ClassifyAuthorInput,
  type RepoPermission,
  type Provenance,
} from '@fx/trust';
import { classifyAuthor } from '@fx/trust';
import { recordStage } from '@fx/core/src/work-items/recordStage.js';
import { cleanWorkItemTitle } from '@fx/core/src/work-items/title.js';
import { recordDriverEvent } from '@fx/core/src/work-items/driverEvents.js';
import { IllegalStageTransitionError } from '@fx/core/src/work-items/stages.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { queueDiscoveries, type QueuedDiscovery } from '@fx/db/src/discoveryRuns.js';
import { withPlatformOps } from '@fx/core/src/tenancy/withPlatformOps.js';
import { syncFailureTag } from './syncFailureTag.js';
import { installationDiscoveryRef } from './installDiscovery.js';
import { decideOwnerProcess } from '@fx/core/src/plan/ownerProcess.js';
import { applyIssueChange, fencedIssueSummary, proposalTitle, proposeFromIssue, type IssueChange, type ProposeOutcome } from './issueProposal.js';

/**
 * D#2 H13a body criterion 2: the 8 events this webhook handles.
 * `installation` is acknowledged but produces no work_items/run mapping --
 * installation provisioning is H06's, not this task's.
 */
export const HANDLED_EVENT_NAMES = [
  'installation',
  'installation_repositories',
  'issues',
  'issue_comment',
  'discussion',
  'discussion_comment',
  'pull_request',
  'pull_request_review',
  'push',
] as const;

export type GithubWebhookEventName = (typeof HANDLED_EVENT_NAMES)[number];

export function isHandledEventName(value: string): value is GithubWebhookEventName {
  return (HANDLED_EVENT_NAMES as readonly string[]).includes(value);
}

/**
 * GitHub's `author_association` enum, present on issue/comment/discussion/
 * pull_request payloads -- the only permission-shaped signal a webhook
 * payload carries without an extra GitHub API call (H13b's territory).
 * Conservative/fail-closed: only OWNER maps to a trusted tier. MEMBER
 * (org membership, not repo access) and COLLABORATOR (an unspecified
 * access level) both map to `read`, not assumed higher. Everything else
 * maps to `none`.
 */
export function authorAssociationToRepoPermission(
  association: string | null | undefined,
): RepoPermission {
  switch (association) {
    case 'OWNER':
      return 'admin';
    case 'MEMBER':
      return 'read';
    case 'COLLABORATOR':
      return 'read';
    default:
      return 'none';
  }
}

/** GitHub's own PR/commit closing keywords (case-insensitive) -- the ONLY
 * text H13a extracts from a PR body: a bounded digit reference, never
 * anything executed or stored as prose. */
const CLOSES_KEYWORD_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)\b/gi;

/**
 * D#2 H13c (correction C27, H13c-3): GitHub's own login grammar --
 * alphanumeric with single internal hyphens, never leading/trailing,
 * 1-39 characters. Covers both user and org logins (one grammar).
 * Application-layer mirror of migration 0619's `repos_gh_owner_format_check`
 * -- checked here too so a malformed entry is a safe skip, not a thrown
 * DB error mid-delivery.
 */
export const GH_OWNER_LOGIN_RE = /^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/**
 * Mirror of migration 0619's `repos_gh_name_format_check`, and of this
 * file's own `REPO_FULL_NAME_RE` per-segment grammar below.
 */
export const GH_REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** The issue number a PR body closes via GitHub's native linking keywords,
 * or null. Only the first match is used -- D#45: "one work item has at
 * most one open PR at a time". */
export function extractClosesIssueNumber(body: string | null | undefined): number | null {
  if (!body) return null;
  CLOSES_KEYWORD_RE.lastIndex = 0;
  const match = CLOSES_KEYWORD_RE.exec(body);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** D#483 P1: an author's real repository permission as GitHub reports it right now. Never stored. */
export interface LookedUpPermission {
  login: string;
  permission: RepoPermission;
}

export interface WebhookAuthor {
  login: string | null | undefined;
  authorAssociation: string | null | undefined;
}

export interface MapEventInput {
  /** Re-resolved fresh on every call (packages/trust/README.md rule 2) -- never cached across events. */
  allowlist: readonly string[];
  allowWritePermission?: boolean;
  /**
   * D#483 P1: for an `issues.opened` whose author is not the repository's OWNER, the author's real permission (see
   * `GithubWebhookDbDeps.issueAuthorPermission`). On an organization repo even the org owner's issue arrives as MEMBER, or
   * CONTRIBUTOR when the membership is private, so `author_association` alone could never trust anyone there. Whatever the
   * permission is, the usual rule decides: admin and maintain are trusted, write only with the `allowWritePermission` opt-in.
   *
   * D#483 S4-d: when a lookup is wired the answer is AUTHORITATIVE, in both directions. `undefined` means no lookup is wired (the
   * association decides, as for every other event); `null` means one is wired but gave no usable answer (an error, no answer, or a
   * different login than the payload's), which fails closed to no permission. The association text is then never what trusts an
   * author: an `OWNER` claim with a lookup answering `read` is an outsider.
   */
  authorPermission?: LookedUpPermission | null;
}

/** issue.opened / discussion.created: creates a work_items row, gated by canCreateWork. */
export interface CreateWorkItemEvent {
  kind: 'create_work_item';
  workItemKind: 'issue' | 'discussion';
  ghNumber: number;
  /** The issue's (or discussion's) title, cleaned and cut to 120 characters (untrusted text); null when it had none. */
  title: string | null;
  trust: AuthorTrust;
  canCreateWork: boolean;
}

/** pull_request.opened / .closed: transitions an existing, linked work item. */
export interface TransitionPrEvent {
  kind: 'transition_pr';
  toStage: 'pr_opened' | 'merged' | 'closed_unmerged';
  at: Date;
  prNumber: number;
  /** Issue number the PR body closes; null when unlinked -- applyMappedEvent
   * then finds no matching row and treats it as a safe no-op. */
  linkedIssueNumber: number | null;
  trust: AuthorTrust;
  /** CWE-863: true when pull_request.head.repo differs from base.repo (or is null) -- a fork or inaccessible head. */
  isFork: boolean;
}

/**
 * pull_request.synchronize (D#6 R5b-2a): the pull request's head moved to `headSha`. Recorded as a fact of the linked work item, which is
 * what restarts the quiet period of a cloud-verified review. Guarded exactly as `transition_pr` is.
 */
export interface RecordPrPushEvent {
  kind: 'record_pr_push';
  prNumber: number;
  headSha: string;
  linkedIssueNumber: number | null;
  trust: AuthorTrust;
  isFork: boolean;
}

/** push touching .mcp.json on the default branch: routes to the C25 hook point. */
export interface RouteMcpConfigEvent {
  kind: 'route_mcp_config';
}

/**
 * D#2 H13c (correction C27, H13c-3): `installation.created`'s own
 * `repositories` list, ready to write. `ownerLogin` is the installation's
 * single GitHub account login; `repos` is the subset of the payload's
 * list this event carries ids/names for at all (malformed entries are
 * dropped by mapEvent itself, never carried to the DB layer).
 */
export interface WriteRepoNamesEvent {
  kind: 'write_repo_names';
  ownerLogin: string;
  repos: ReadonlyArray<{ ghRepoId: number; name: string }>;
}

/** D#2 H17b-2: `installation_repositories`, ids only. Removed repos detach; any added repo asks for a post-commit sync. */
export interface InstallationReposEvent {
  kind: 'installation_repos';
  removedGhRepoIds: number[];
  addedCount: number;
}

/**
 * D#483 S4-d: `issues.opened` by an author without admin or maintain permission. The issue becomes a proposal (external, fenced,
 * verification pending), never a work item. `owner` is filled in by the delivery before it is applied (it needs a read of the
 * repository); a mapped event without it is not applied.
 */
export interface ProposeIssueEvent {
  kind: 'propose_issue';
  ghNumber: number;
  title: string;
  summary: string | null;
  owner?: 'product' | 'internal_loop';
}

/** D#483 S4-d: `issues.closed`, `.reopened` and `.edited` for the proposal an outside author's issue became (no proposal: nothing changes). */
export interface IssueProposalChangeEvent {
  kind: 'issue_proposal_change';
  change: IssueChange;
}

/** Every event mapped to "no work_items/run action" -- still a real
 * mapping decision (criterion 2), not an unhandled case. */
export interface IgnoredEvent {
  kind: 'ignored';
  reason: string;
}

export type MappedEvent =
  | CreateWorkItemEvent
  | ProposeIssueEvent
  | IssueProposalChangeEvent
  | TransitionPrEvent
  | RecordPrPushEvent
  | RouteMcpConfigEvent
  | WriteRepoNamesEvent
  | InstallationReposEvent
  | IgnoredEvent;

/** `{ login }` on an issue/comment/discussion/PR/review actor. */
type Actor = { login: string | null } | null;

/** Minimal shape read from each webhook payload -- ids, enums, booleans and
 * timestamps only; the one free-text field (a PR body) is only ever
 * regex-scanned for a bounded digit reference. */
export interface GithubIssuePayload {
  action: string;
  issue: { number: number; title?: unknown; body?: unknown; user: Actor; author_association: string | null };
}
export interface GithubIssueCommentPayload {
  action: string;
  comment: { user: Actor; author_association: string | null };
  issue: { number: number };
}
export interface GithubDiscussionPayload {
  action: string;
  discussion: { number: number; title?: unknown; user: Actor; author_association?: string | null };
}
export interface GithubDiscussionCommentPayload {
  action: string;
  comment: { user: Actor };
  discussion: { number: number };
}
export interface GithubPullRequestPayload {
  action: string;
  pull_request: {
    number: number;
    body: string | null;
    created_at: string;
    merged_at: string | null;
    merged: boolean;
    user: Actor;
    author_association: string | null;
    /** CWE-863: null/differing id vs base.repo.id means a fork. */
    head: { repo: { id: number } | null; sha?: string };
    base: { repo: { id: number } };
  };
}
export interface GithubPullRequestReviewPayload {
  action: string;
  review: { user: Actor; author_association: string | null };
}
export interface GithubInstallationPayload {
  action: string;
  /** Present on every `installation.*` delivery. `account.login` is the
   * single GitHub owner every repo in `repositories` shares -- a GitHub
   * App installation is always scoped to exactly one user or org. */
  installation?: { id: number; account: { login: string | null | undefined } };
  /** Present on `installation.created` (H13c-3's own fixture) and
   * `installation.deleted`; absent on `suspend`/`unsuspend`/
   * `new_permissions_accepted`. Only `id`/`name` are read. */
  repositories?: Array<{ id: number; name: string }>;
}
export interface GithubInstallationRepositoriesPayload {
  action: string;
  installation?: { id: number };
  repositories_added?: Array<{ id: number }>;
  repositories_removed?: Array<{ id: number }>;
}
export interface GithubPushPayload {
  ref: string;
  repository: { default_branch: string };
  commits: Array<{ added: string[]; removed: string[]; modified: string[] }>;
}

export type GithubWebhookPayload =
  | GithubIssuePayload
  | GithubIssueCommentPayload
  | GithubDiscussionPayload
  | GithubDiscussionCommentPayload
  | GithubPullRequestPayload
  | GithubPullRequestReviewPayload
  | GithubInstallationPayload
  | GithubInstallationRepositoriesPayload
  | GithubPushPayload;

function trustOf(
  author: WebhookAuthor,
  allowlist: readonly string[],
  allowWritePermission: boolean,
  lookedUp?: LookedUpPermission | null,
): { trust: AuthorTrust; canCreateWork: boolean } {
  // The author's REAL repository permission, asked of GitHub for this delivery. When a lookup was wired (not undefined) its answer decides, and
  // only for the very login the payload names (a mismatch, or no answer, is no permission at all). The association is the fallback only
  // where no lookup exists.
  const fromAssociation = authorAssociationToRepoPermission(author.authorAssociation);
  let permission: RepoPermission = fromAssociation;
  if (lookedUp !== undefined) {
    permission = lookedUp !== null && !!author.login && lookedUp.login.toLowerCase() === author.login.toLowerCase() ? lookedUp.permission : 'none';
  }
  const input: ClassifyAuthorInput = {
    login: author.login,
    repoPermission: permission,
    allowlist,
    allowWritePermission,
  };
  const trust = classifyAuthor(input);
  return { trust, canCreateWork: canCreateWork({ ...input, body: '' }) };
}

/**
 * D#2 H13a body criterion 2: pure decision layer, no I/O -- exhaustively
 * fixture-tested in test/eventMapper.test.ts. applyMappedEvent (below)
 * does the actual database work, using the decision this produces.
 */
export function mapEvent(
  eventName: GithubWebhookEventName,
  payload: GithubWebhookPayload,
  input: MapEventInput,
): MappedEvent {
  const allowWritePermission = input.allowWritePermission ?? false;

  switch (eventName) {
    case 'issues': {
      const p = payload as GithubIssuePayload;
      const n = p.issue.number;
      if (!Number.isSafeInteger(n) || n < 1 || n > 2147483647) {
        return { kind: 'ignored', reason: `issue.${String(p.action).slice(0, 40)}: no usable issue number` };
      }
      if (p.action === 'closed' || p.action === 'reopened') {
        return { kind: 'issue_proposal_change', change: { change: p.action, ghNumber: n } };
      }
      if (p.action === 'edited') {
        return { kind: 'issue_proposal_change', change: { change: 'edited', ghNumber: n, title: proposalTitle(p.issue.title, n), summary: fencedIssueSummary(p.issue.body) } };
      }
      if (p.action !== 'opened') {
        return { kind: 'ignored', reason: `issue.${String(p.action).slice(0, 40)}: only opened, edited, closed and reopened act` };
      }
      const { trust, canCreateWork: allowed } = trustOf(
        { login: p.issue.user?.login, authorAssociation: p.issue.author_association },
        input.allowlist,
        allowWritePermission,
        input.authorPermission,
      );
      if (!allowed) {
        // D#483 S4-d: an author without admin or maintain permission (by the permission lookup, never the association text) is a proposal.
        return { kind: 'propose_issue', ghNumber: n, title: proposalTitle(p.issue.title, n), summary: fencedIssueSummary(p.issue.body) };
      }
      return { kind: 'create_work_item', workItemKind: 'issue', ghNumber: n, title: cleanWorkItemTitle(p.issue.title), trust, canCreateWork: allowed };
    }

    case 'discussion': {
      const p = payload as GithubDiscussionPayload;
      if (p.action !== 'created') {
        return { kind: 'ignored', reason: `discussion.${p.action}: only 'created' creates a work item in H13a` };
      }
      const { trust, canCreateWork: allowed } = trustOf(
        { login: p.discussion.user?.login, authorAssociation: p.discussion.author_association ?? null },
        input.allowlist,
        allowWritePermission,
      );
      if (!allowed) {
        return { kind: 'ignored', reason: 'discussion.created: untrusted author, H07 gate refuses work creation' };
      }
      return { kind: 'create_work_item', workItemKind: 'discussion', ghNumber: p.discussion.number, title: cleanWorkItemTitle(p.discussion.title), trust, canCreateWork: allowed };
    }

    case 'issue_comment': {
      const p = payload as GithubIssueCommentPayload;
      // Classified for completeness (H07 rule 2), but H13a makes no
      // work_items/run decision from a comment -- H15 (triage) is the
      // consumer of comment activity, not this task.
      trustOf({ login: p.comment.user?.login, authorAssociation: p.comment.author_association }, input.allowlist, allowWritePermission);
      return { kind: 'ignored', reason: 'issue_comment: informational only, no work_items mutation in H13a' };
    }

    case 'discussion_comment': {
      return { kind: 'ignored', reason: 'discussion_comment: informational only, no work_items mutation in H13a' };
    }

    case 'pull_request': {
      const p = payload as GithubPullRequestPayload;
      const { trust } = trustOf(
        { login: p.pull_request.user?.login, authorAssociation: p.pull_request.author_association },
        input.allowlist,
        allowWritePermission,
      );
      const linkedIssueNumber = extractClosesIssueNumber(p.pull_request.body);
      const prNumber = p.pull_request.number;
      const headRepoId = p.pull_request.head.repo?.id ?? null;
      const isFork = headRepoId == null || headRepoId !== p.pull_request.base.repo.id;
      if (p.action === 'opened') {
        return { kind: 'transition_pr', toStage: 'pr_opened', at: new Date(p.pull_request.created_at), prNumber, linkedIssueNumber, trust, isFork };
      }
      if (p.action === 'closed') {
        const closedAt = p.pull_request.merged_at ?? p.pull_request.created_at;
        const toStage = p.pull_request.merged ? 'merged' : 'closed_unmerged';
        return { kind: 'transition_pr', toStage, at: new Date(closedAt), prNumber, linkedIssueNumber, trust, isFork };
      }
      if (p.action === 'synchronize') {
        const headSha = p.pull_request.head.sha;
        if (typeof headSha !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(headSha)) {
          return { kind: 'ignored', reason: 'pull_request.synchronize: no head commit id' };
        }
        return { kind: 'record_pr_push', prNumber, headSha, linkedIssueNumber, trust, isFork };
      }
      return { kind: 'ignored', reason: `pull_request.${p.action}: not opened/closed/synchronize, no stage change` };
    }

    case 'pull_request_review': {
      return { kind: 'ignored', reason: 'pull_request_review: native reviews never drive work_items.stage (only hosted reviewer runs do, via H14)' };
    }

    case 'installation': {
      // D#2 H13c (C27, H13c-3): installation provisioning (creating the
      // `installations` row itself) is still H06 scope. What H13a's own
      // intake now ALSO does for this event: when the delivery carries a
      // `repositories` list (installation.created; installation.deleted
      // also carries one but there is nothing useful to write from a
      // deletion), write the GitHub owner/repo-name strings the H13c
      // proxy resolver reads. `suspend`/`unsuspend`/
      // `new_permissions_accepted` carry no `repositories` field at all
      // and fall through to the same 'ignored' this case always returned.
      const p = payload as GithubInstallationPayload;
      const ownerLogin = p.installation?.account?.login;
      const repositories = p.repositories;
      if (p.action !== 'created' || !ownerLogin || !Array.isArray(repositories) || repositories.length === 0) {
        return { kind: 'ignored', reason: 'installation: no repositories list to write names for' };
      }
      if (!GH_OWNER_LOGIN_RE.test(ownerLogin)) {
        return { kind: 'ignored', reason: 'installation: owner login fails GitHub name grammar, no names written' };
      }
      const repos = repositories
        .filter((r) => typeof r?.id === 'number' && typeof r?.name === 'string' && GH_REPO_NAME_RE.test(r.name))
        .map((r) => ({ ghRepoId: r.id, name: r.name }));
      if (repos.length === 0) {
        return { kind: 'ignored', reason: 'installation: no repositories with a valid id/name to write' };
      }
      return { kind: 'write_repo_names', ownerLogin, repos };
    }

    case 'installation_repositories': {
      const p = payload as GithubInstallationRepositoriesPayload;
      const ids = (list: unknown): number[] =>
        Array.isArray(list)
          ? list.map((r) => (r as { id?: unknown } | null)?.id).filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0)
          : [];
      if (p.action === 'added' || p.action === 'removed') {
        return { kind: 'installation_repos', removedGhRepoIds: ids(p.repositories_removed), addedCount: ids(p.repositories_added).length };
      }
      return { kind: 'ignored', reason: `installation_repositories.${String(p.action).slice(0, 40)}: only added/removed act` };
    }

    case 'push': {
      const p = payload as GithubPushPayload;
      const isDefaultBranchPush = p.ref === `refs/heads/${p.repository.default_branch}`;
      const touchesMcpJson = p.commits.some(
        (c) => c.added.includes('.mcp.json') || c.modified.includes('.mcp.json') || c.removed.includes('.mcp.json'),
      );
      if (isDefaultBranchPush && touchesMcpJson) {
        return { kind: 'route_mcp_config' };
      }
      return {
        kind: 'ignored',
        reason: isDefaultBranchPush ? 'push: default branch, but no commit touches .mcp.json' : 'push: not the default branch',
      };
    }
  }
}

// ---------------------------------------------------------------------
// DB application layer. Touches Postgres through the `client` the caller
// already opened via withTenant -- this file never begins/commits/rolls
// back a transaction itself, same discipline as recordStage.ts.
// ---------------------------------------------------------------------

/** D#31 API-4's not-yet-landed shape (C26 section 3, C7) -- kept local,
 * not imported from packages/core/src/domain-events, which does not
 * exist on main yet. */
export interface DomainEvent {
  type: string;
  accountId: string;
  payload: Record<string, string | number | boolean | null>;
}
export type EmitDomainEvent = (client: PoolClient, event: DomainEvent) => Promise<void>;

/** D#47 M12's not-yet-landed shape (C26 section 3, C25 item 2). */
export interface RepoRef {
  accountId: string;
  repoId: string;
  ghRepoId: number;
  fullName: string;
}
export type SyncDefaultBranchMcpConfig = (repo: RepoRef) => Promise<void>;

export interface ApplyHooks {
  /** C7: called once, with the SAME client passed to recordStage, only
   * when recordStage returned `recorded: true`. Not wired until API-4
   * lands -- same documented-hook-point shape as
   * packages/runner/src/runStatusWriter.ts:153-156's precedent, plus the
   * addition C26 asks for: a spy test pinning the call site. */
  emitDomainEvent?: EmitDomainEvent;
  /** C25 item 2: called once for a verified default-branch push touching
   * .mcp.json. Production does not wire it until M12 lands. */
  syncDefaultBranchMcpConfig?: SyncDefaultBranchMcpConfig;
}

export interface ApplyEventCtx {
  accountId: string;
  /** S2 (fix round 1, D#2 C27): the `installations.id` of the installation
   * that sent THIS delivery, resolved by `resolveTenant` from the
   * verified `installation.id` on the webhook envelope. `write_repo_names`
   * binds its UPDATE to this, not just `(account_id, gh_repo_id)` -- an
   * account can have more than one GitHub App installation, and nothing
   * says two of them can never see the same `gh_repo_id` (S1's own
   * UNIQUE(gh_installation_id) is a different column and doesn't help
   * here either). Without this, one installation's delivery could rename
   * a repo row that actually belongs to a DIFFERENT installation under
   * the same account. */
  installationId: string;
  repoId: string;
  repo: RepoRef;
  /** X-GitHub-Delivery -- recordStage's source_ref; C18's dedup key. */
  deliveryId: string;
  hooks?: ApplyHooks;
}

export type ApplyResult =
  | { applied: 'created'; workItemId: string }
  | { applied: 'transitioned'; workItemId: string; recorded: boolean }
  | { applied: 'proposed'; created: boolean }
  | { applied: 'proposal_rate_limited' }
  | { applied: 'proposal_changed'; count: number }
  | { applied: 'pr_push_recorded'; workItemId: string; recorded: boolean }
  | { applied: 'mcp_config_routed' }
  | { applied: 'repo_names_written'; count: number }
  | { applied: 'repos_detached'; count: number; installationId: string; syncRequested: boolean }
  | { applied: 'skipped'; reason: string };

const PR_URL_BASE = 'https://github.com';
/** D#31 resolved disagreement 8's own pattern: a repo.full_name that
 * fails this is omitted from any emitted event payload. */
const REPO_FULL_NAME_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

/** Looks up the work_items row that carries a GitHub number in a repo --
 * the linkage a pull_request event transitions. Never creates a row: an
 * unlinked/unmatched PR is a safe no-op (see TransitionPrEvent).
 *
 * D#483 P1: matched on the NUMBER, not on the kind. The pipeline's root for an issue carries the issue's number but its
 * own kind (feature, bug, ...), not 'issue', and the webhook's own row for that issue is closed as superseded. Issues,
 * pull requests and Discussions share one number space per repo, so a number names at most one thing there. When more
 * than one work item carries it, the OPEN one wins (stage <> 'closed'), then the newest, so a PR that says "Closes #N"
 * moves the live card and never the retired one. */
async function findLinkedWorkItem(
  client: PoolClient,
  accountId: string,
  repoId: string,
  ghNumber: number,
): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM work_items WHERE account_id = $1 AND repo_id = $2 AND gh_number = $3
      ORDER BY (stage = 'closed') ASC, created_at DESC, id DESC LIMIT 1`,
    [accountId, repoId, ghNumber],
  );
  return rows[0]?.id ?? null;
}

/**
 * D#483 P1: the work item whose runner run opened this pull request, or null.
 *
 * The cloud opens a runner run's pull request itself, with fixed text and no "Closes #N" line, and records the number it opened on the run's own
 * verdict event (`viaRunnerDone`, `prNumber`, written in the transaction that finishes the run). That record is the platform's own binding of the
 * number to the item, so a close or merge of such a pull request moves its item whatever the body says. It is the ONLY binding read here: the number
 * must be one a succeeded runner executor run of an item in THIS repository recorded, so a pull request from anyone else (a number no run recorded)
 * finds nothing and stays a no-op. Nothing the pull request itself says, its author, its body or its branch, takes part. When more than one item
 * carries the number the open one wins, then the newest, as findLinkedWorkItem does.
 */
async function findRunnerOpenedPrItem(client: PoolClient, accountId: string, repoId: string, prNumber: number): Promise<string | null> {
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return null;
  const { rows } = await client.query<{ id: string }>(
    `SELECT w.id
       FROM work_items w
       JOIN agent_runs r ON r.account_id = w.account_id AND r.work_item_id = w.id AND r.runtime = 'runner' AND r.role = 'executor'
       JOIN run_events e ON e.account_id = r.account_id AND e.run_id = r.id AND e.kind = 'run.status_changed'
                        AND e.payload->>'viaRunnerDone' = 'true' AND e.payload->>'to' = 'succeeded' AND e.payload->>'prNumber' = $3::text
      WHERE w.account_id = $1 AND w.repo_id = $2
      ORDER BY (w.stage = 'closed') ASC, w.created_at DESC, w.id DESC LIMIT 1`,
    [accountId, repoId, String(prNumber)],
  );
  return rows[0]?.id ?? null;
}

const unlinkedReason = (linkedIssueNumber: number | null): string =>
  linkedIssueNumber == null
    ? 'pull_request: no Closes/Fixes/Resolves #N reference in body, and no run recorded this pull request'
    : `pull_request: no work item linked to issue #${linkedIssueNumber}`;

/** The item a pull request event acts on: the one a runner run recorded this pull request for, else the one its body closes. Null when neither names one. */
async function findPullRequestItem(
  client: PoolClient,
  accountId: string,
  repoId: string,
  prNumber: number,
  linkedIssueNumber: number | null,
): Promise<string | null> {
  const recorded = await findRunnerOpenedPrItem(client, accountId, repoId, prNumber);
  if (recorded) return recorded;
  return findBodyLinkedItem(client, accountId, repoId, linkedIssueNumber);
}

/** The item a pull request body closes ("Closes #N"), or null when it names none. */
async function findBodyLinkedItem(client: PoolClient, accountId: string, repoId: string, linkedIssueNumber: number | null): Promise<string | null> {
  return linkedIssueNumber == null ? null : findLinkedWorkItem(client, accountId, repoId, linkedIssueNumber);
}

/**
 * D#2 H13a body criterion 2 (INSERT), C18 (recordStage), C7 and C25 item
 * 2 (hook points), all in one place -- the orchestration a verified
 * webhook's transaction runs, given the pure decision mapEvent produced.
 */
export async function applyMappedEvent(client: PoolClient, ctx: ApplyEventCtx, mapped: MappedEvent): Promise<ApplyResult> {
  switch (mapped.kind) {
    case 'ignored':
      return { applied: 'skipped', reason: mapped.reason };

    case 'create_work_item': {
      // Idempotent against redelivery: work_items has no UNIQUE
      // constraint on (repo_id, kind, gh_number), so this existence
      // check is H13a's own dedup for the creation path (a repeat is a
      // no-op, not an error).
      const existing = await findLinkedWorkItem(client, ctx.accountId, ctx.repoId, mapped.ghNumber);
      if (existing) {
        return { applied: 'created', workItemId: existing };
      }
      // CWE-1188: derived from mapEvent's own trust decision, never a caller-suppliable default that could fail open.
      const provenance: Provenance = mapped.trust === 'trusted' ? 'internal' : 'external';
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO work_items (account_id, repo_id, kind, gh_number, provenance, title) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [ctx.accountId, ctx.repoId, mapped.workItemKind, mapped.ghNumber, provenance, mapped.title],
      );
      return { applied: 'created', workItemId: rows[0]!.id };
    }

    case 'propose_issue': {
      // Never reached without an owner: the delivery resolves it (a read of the repository) or ignores the event.
      if (!mapped.owner) return { applied: 'skipped', reason: 'issue.opened: owner process unknown, left for the next discovery' };
      const out: ProposeOutcome = await proposeFromIssue(client, ctx.accountId, ctx.repoId, { ghNumber: mapped.ghNumber, title: mapped.title, summary: mapped.summary, owner: mapped.owner });
      return out.outcome === 'proposal_rate_limited' ? { applied: 'proposal_rate_limited' } : { applied: 'proposed', created: out.created };
    }

    case 'issue_proposal_change':
      return { applied: 'proposal_changed', count: await applyIssueChange(client, ctx.repoId, mapped.change) };

    case 'transition_pr': {
      // CWE-863: a fork PR from an untrusted author must never drive a stage transition.
      if (mapped.isFork && mapped.trust !== 'trusted') {
        return { applied: 'skipped', reason: 'pull_request: fork or untrusted head repo, no stage transition' };
      }
      // D#483 P1: a close or merge also finds the item a runner run opened this pull request for (its body carries no "Closes #N"). An open or a push never does: those keep the body link.
      const closing = mapped.toStage === 'merged' || mapped.toStage === 'closed_unmerged';
      const workItemId = closing ? await findPullRequestItem(client, ctx.accountId, ctx.repoId, mapped.prNumber, mapped.linkedIssueNumber) : await findBodyLinkedItem(client, ctx.accountId, ctx.repoId, mapped.linkedIssueNumber);
      if (!workItemId) return { applied: 'skipped', reason: unlinkedReason(mapped.linkedIssueNumber) };

      let result;
      try {
        result = await recordStage(client, {
          workItemId,
          toStage: mapped.toStage,
          at: mapped.at,
          source: 'webhook',
          sourceRef: ctx.deliveryId,
        });
      } catch (err) {
        // A pull_request.opened that arrives after the item is already at a pull-request stage (the stage driver's
        // "Check the build" moved it first) is an idempotent no-op, not a failed delivery. recordStage refuses the
        // transition BEFORE writing anything (its only statement so far is the row lock), so the transaction is intact.
        if (
          err instanceof IllegalStageTransitionError &&
          mapped.toStage === 'pr_opened' &&
          (err.from === 'pr_opened' || err.from === 'changes_requested' || err.from === 'review_passed')
        ) {
          return { applied: 'transitioned', workItemId, recorded: false };
        }
        throw err;
      }

      // C7: only on a genuine (non-duplicate) pr_opened transition, the
      // SAME client recordStage was given, and only ids/enums (D#31
      // resolved disagreement 8).
      if (mapped.toStage === 'pr_opened' && result.recorded && ctx.hooks?.emitDomainEvent) {
        const fullName = REPO_FULL_NAME_RE.test(ctx.repo.fullName) ? ctx.repo.fullName : null;
        await ctx.hooks.emitDomainEvent(client, {
          type: 'pr.opened',
          accountId: ctx.accountId,
          payload: {
            ...(fullName ? { repoFullName: fullName } : {}),
            prNumber: mapped.prNumber,
            prUrl: `${PR_URL_BASE}/${fullName ?? ctx.repo.fullName}/pull/${mapped.prNumber}`,
            workItemId,
            stage: mapped.toStage,
          },
        });
      }

      return { applied: 'transitioned', workItemId, recorded: result.recorded };
    }

    case 'record_pr_push': {
      if (mapped.isFork && mapped.trust !== 'trusted') {
        return { applied: 'skipped', reason: 'pull_request: fork or untrusted head repo, no push recorded' };
      }
      const workItemId = await findBodyLinkedItem(client, ctx.accountId, ctx.repoId, mapped.linkedIssueNumber);
      if (!workItemId) return { applied: 'skipped', reason: unlinkedReason(mapped.linkedIssueNumber) };
      // One row per delivery (GitHub keeps the delivery id on a redelivery, so that stays a no-op). Keyed on the delivery, not the head: a push back
      // to a head seen before (A, B, A) is a new push and restarts the quiet period.
      const { recorded } = await recordDriverEvent(client, ctx.accountId, { workItemId, kind: 'pr_head_pushed', dedupeKey: `push:${ctx.deliveryId}`, code: 'synchronize', headSha: mapped.headSha, prNumber: mapped.prNumber });
      return { applied: 'pr_push_recorded', workItemId, recorded };
    }

    case 'route_mcp_config': {
      if (ctx.hooks?.syncDefaultBranchMcpConfig) {
        await ctx.hooks.syncDefaultBranchMcpConfig(ctx.repo);
      }
      return { applied: 'mcp_config_routed' };
    }

    case 'write_repo_names': {
      // D#2 H13c (C27, H13c-3): app_user already has table-wide UPDATE
      // on `repos` (0001_core.sql) -- no new grant needed for this
      // writer, unlike the resolver's own platform_ops read (migration
      // 0619). `ctx.repoId`/`ctx.repo` are meaningless for an
      // `installation` event (it carries a repositories LIST, not one
      // repo -- resolveTenant's own comment on `readEnvelope`) --
      // `ctx.accountId`/`ctx.installationId` are the only context fields
      // this case uses. Idempotent by construction: writing the same
      // owner/name twice (a redelivery) is just the same UPDATE again,
      // not a new row, so H13c-3's "a redelivery writes nothing new"
      // needs no separate dedup key the way work_items' INSERT path does.
      //
      // S2 (fix round 1, D#2 C27): scoped to `ctx.installationId`, not
      // just `(account_id, gh_repo_id)` -- an account can have more than
      // one installation, and this delivery only speaks for the ONE that
      // sent it. Without this, a repo row that actually belongs to a
      // different installation under the same account could get renamed
      // from this delivery's owner login.
      let written = 0;
      for (const repo of mapped.repos) {
        const { rowCount } = await client.query(
          `UPDATE repos SET gh_owner = $1, gh_name = $2, updated_at = now()
             WHERE account_id = $3 AND gh_repo_id = $4 AND installation_id = $5`,
          [mapped.ownerLogin, repo.name, ctx.accountId, repo.ghRepoId, ctx.installationId],
        );
        written += rowCount ?? 0;
      }
      return { applied: 'repo_names_written', count: written };
    }

    case 'installation_repos': {
      // H17b-2: never deletes. Only rows attached to THIS delivery's installation
      // (ctx.installationId, resolved from the verified envelope) are detached.
      let count = 0;
      if (mapped.removedGhRepoIds.length > 0) {
        const { rowCount, rows } = await client.query<{ id: string }>(
          `UPDATE repos SET installation_id = NULL, updated_at = now()
             WHERE account_id = $1 AND installation_id = $2 AND product = 'team' AND gh_repo_id = ANY($3::bigint[]) RETURNING id`,
          [ctx.accountId, ctx.installationId, mapped.removedGhRepoIds],
        );
        // D#600 CX-3a: a detached repository keeps no cached repository map (same transaction).
        await client.query('DELETE FROM repo_context_maps WHERE account_id = $1 AND repo_id = ANY($2::uuid[])', [ctx.accountId, rows.map((r) => r.id)]);
        count = rowCount ?? 0;
      }
      return { applied: 'repos_detached', count, installationId: ctx.installationId, syncRequested: mapped.addedCount > 0 };
    }
  }
}

// ---------------------------------------------------------------------
// Top-level orchestration: tenant resolution + mapEvent + applyMappedEvent
// in one call, so apps/web's handler.ts stays a thin NextRequest/
// NextResponse translation layer (matching the
// apps/web/app/api/stripe/webhook/handler.ts precedent).
// ---------------------------------------------------------------------

export interface GithubWebhookDbDeps {
  /** app_user pool -- every tenant-scoped read/write goes through withTenant on this. */
  appUserPool: Pool;
  /** platform_ops pool -- resolves gh_installation_id/gh_repo_id to
   * account_id/repo_id (migration 0613's new grant). */
  platformOpsPool: Pool;
  allowlist?: readonly string[];
  allowWritePermission?: boolean;
  hooks?: ApplyHooks;
  /** H17b-2: repo sync, run after the delivery's transaction commits. */
  syncRepos?: (installationId: string) => Promise<unknown>;
  warn?: (message: string) => void;
  /**
   * D#483 P1, S4-d: the issue author's real repository permission, asked of GitHub (the retry author check's lookup), for every
   * `issues.opened`, an OWNER claim included. Called after the tenant is resolved and before the event is mapped, for that delivery
   * only; nothing is stored or reused. When it is wired its answer decides in both directions (an association saying OWNER does not
   * outrank a lookup saying read). Any failure (a throw, no answer, a different login than the payload's) is no permission: the
   * author is not trusted and the issue becomes a proposal. Absent (no lookup wired, tests only): the association decides.
   */
  issueAuthorPermission?: (input: { repoId: string; owner: string; name: string; number: number }) => Promise<LookedUpPermission | null>;
  /**
   * D#483 S4-d: whether the repository's default branch holds the engine loop's project file, which decides who owns a proposal
   * (`internal_loop` or `product`, S3 rule E6). Asked only for an issue that is about to become a proposal. Absent, or any failure:
   * the proposal is not written now and the next discovery reads the issue.
   */
  repoHasEngineLoop?: (input: { repoId: string; owner: string; name: string }) => Promise<boolean>;
  /**
   * D#483 S4-c: called after the delivery's transaction (and, for added repositories, the repo sync) with the discoveries this
   * delivery queued, so a runner can start them. Queuing itself needs no hook: it is written by the delivery, once per repository and
   * delivery. A throw here never fails the delivery.
   */
  onDiscoveryQueued?: (accountId: string, runs: readonly QueuedDiscovery[]) => Promise<unknown>;
}

export type HandleWebhookResult =
  | { handled: true; result: ApplyResult }
  | { handled: false; reason: string };

interface WebhookEnvelope {
  installationId: number | null;
  ghRepoId: number | null;
  repoFullName: string | null;
}

/** The only fields read before the event's own shape is known -- every
 * webhook payload carries `installation`, and every payload except
 * installation.* itself carries `repository`. */
function readEnvelope(payload: unknown): WebhookEnvelope {
  const p = payload as { installation?: { id?: number }; repository?: { id?: number; full_name?: string } };
  return {
    installationId: typeof p.installation?.id === 'number' ? p.installation.id : null,
    ghRepoId: typeof p.repository?.id === 'number' ? p.repository.id : null,
    repoFullName: typeof p.repository?.full_name === 'string' ? p.repository.full_name : null,
  };
}

async function resolveTenant(
  platformOpsPool: Pool,
  envelope: WebhookEnvelope,
): Promise<{ accountId: string; installationId: string; repoId: string; repo: RepoRef } | null> {
  if (envelope.installationId == null) return null;

  return withPlatformOps(platformOpsPool, async (client: PoolClient) => {
    // CWE-639/706: no UNIQUE constraint on gh_installation_id yet, so an ambiguous match must fail closed, not pick rows[0].
    const { rows: installationRows } = await client.query<{ id: string; account_id: string }>(
      `SELECT id, account_id FROM installations WHERE gh_installation_id = $1`,
      [envelope.installationId],
    );
    if (installationRows.length !== 1) return null;
    const { id: installationId, account_id: accountId } = installationRows[0]!;

    // installation.* events carry no `repository` key -- mapEvent always
    // maps 'installation' to 'ignored', so this is never used for one.
    if (envelope.ghRepoId == null) {
      return { accountId, installationId, repoId: '', repo: { accountId, repoId: '', ghRepoId: 0, fullName: '' } };
    }

    const { rows: repoRows } = await client.query<{ id: string }>(
      `SELECT id FROM repos WHERE account_id = $1 AND gh_repo_id = $2`,
      [accountId, envelope.ghRepoId],
    );
    if (repoRows.length !== 1) return null;
    const repoId = repoRows[0]!.id;

    return {
      accountId,
      installationId,
      repoId,
      repo: { accountId, repoId, ghRepoId: envelope.ghRepoId, fullName: envelope.repoFullName ?? '' },
    };
  });
}

/**
 * D#2 H13a: the one function a verified webhook delivery drives end to
 * end -- resolve tenant, map the event, apply it inside one withTenant
 * transaction. `eventName` must already be a HANDLED_EVENT_NAMES member
 * (the caller checks isHandledEventName first).
 */
export async function handleGithubWebhookEvent(
  deps: GithubWebhookDbDeps,
  eventName: GithubWebhookEventName,
  payload: GithubWebhookPayload,
  deliveryId: string,
): Promise<HandleWebhookResult> {
  const envelope = readEnvelope(payload);
  const tenant = await resolveTenant(deps.platformOpsPool, envelope);
  if (!tenant) {
    return { handled: false, reason: 'unknown_tenant' };
  }

  const [repoOwner, repoName] = (envelope.repoFullName ?? '').split('/');
  let authorPermission: LookedUpPermission | null | undefined;
  if (eventName === 'issues' && deps.issueAuthorPermission) {
    const p = payload as GithubIssuePayload;
    authorPermission = null;
    if (p.action === 'opened' && repoOwner && repoName && tenant.repoId && Number.isSafeInteger(p.issue?.number)) {
      try {
        authorPermission = await deps.issueAuthorPermission({ repoId: tenant.repoId, owner: repoOwner, name: repoName, number: p.issue.number });
      } catch {
        // fx-swallow-ok: fail closed by design; a fixed line is logged (no login, no repository, no driver text) and the author is not trusted
        (deps.warn ?? console.warn)('github webhook: author permission lookup failed; the author is not trusted');
        authorPermission = null;
      }
    }
  }

  let mapped = mapEvent(eventName, payload, { allowlist: deps.allowlist ?? [], allowWritePermission: deps.allowWritePermission, authorPermission });
  if (mapped.kind === 'propose_issue') mapped = await withProposalOwner(deps, tenant.repoId, repoOwner, repoName, mapped);

  const result = await withTenant(deps.appUserPool, tenant.accountId, (client) =>
    applyMappedEvent(
      client,
      { accountId: tenant.accountId, installationId: tenant.installationId, repoId: tenant.repoId, repo: tenant.repo, deliveryId, hooks: deps.hooks },
      mapped,
    ),
  );

  // H17b-2: the transaction has committed. A sync failure never fails the delivery.
  if (result.applied === 'repos_detached' && result.syncRequested && deps.syncRepos) {
    try {
      await deps.syncRepos(result.installationId);
    } catch (err) {
      reportSyncFailure(err, "/api/github/webhook");
      (deps.warn ?? console.warn)(`github repo sync failed (${syncFailureTag(err)}); the next event retries`);
    }
  }

  await queueDiscoveryForDelivery(deps, tenant, eventName, payload, deliveryId);

  return { handled: true, result };
}

/** S4-d: fills in who owns the proposal (S3 rule E6), or turns the event into an ignored one when that cannot be read (fail closed). */
async function withProposalOwner(deps: GithubWebhookDbDeps, repoId: string, owner: string | undefined, name: string | undefined, mapped: ProposeIssueEvent): Promise<MappedEvent> {
  if (!deps.repoHasEngineLoop || !owner || !name || !repoId) return { kind: 'ignored', reason: 'issue.opened: owner process not readable, left for the next discovery' };
  try {
    const hasLoop = await deps.repoHasEngineLoop({ repoId, owner, name });
    return { ...mapped, owner: decideOwnerProcess({ repoHasEngineLoop: hasLoop, kind: 'issue' }) };
  } catch {
    // fx-swallow-ok: fail closed; a fixed line is logged (no repository, no issue text) and the next discovery reads the issue
    (deps.warn ?? console.warn)('github webhook: reading the repository owner process failed; left for the next discovery');
    return { kind: 'ignored', reason: 'issue.opened: owner process not readable, left for the next discovery' };
  }
}

/**
 * D#483 S4-c: `installation` created and `installation_repositories` added queue one discovery per product repository (a
 * replayed delivery has the same id and queues nothing). A failure here is logged as a fixed line and never fails the delivery.
 */
async function queueDiscoveryForDelivery(
  deps: GithubWebhookDbDeps,
  tenant: { accountId: string; installationId: string },
  eventName: GithubWebhookEventName,
  payload: GithubWebhookPayload,
  deliveryId: string,
): Promise<void> {
  const ids = (list: unknown): number[] =>
    Array.isArray(list) ? list.map((r) => (r as { id?: unknown } | null)?.id).filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0) : [];
  let trigger: 'installation_created' | 'repos_added';
  let ghRepoIds: number[] | undefined;
  if (eventName === 'installation' && (payload as GithubInstallationPayload).action === 'created') {
    trigger = 'installation_created';
    const listed = ids((payload as GithubInstallationPayload).repositories);
    ghRepoIds = listed.length > 0 ? listed : undefined;
  } else if (eventName === 'installation_repositories' && (payload as GithubInstallationRepositoriesPayload).action === 'added') {
    trigger = 'repos_added';
    ghRepoIds = ids((payload as GithubInstallationRepositoriesPayload).repositories_added);
    if (ghRepoIds.length === 0) return;
  } else {
    return;
  }
  try {
    // installation_created uses the installation's own reference, shared with the install callback (which queues after its repo sync),
    // so whichever of the two runs second queues nothing again. A repos_added delivery keeps its delivery id.
    const ghInstallationId = (payload as { installation?: { id?: unknown } }).installation?.id;
    const ref = trigger === 'installation_created' && typeof ghInstallationId === 'number' && Number.isSafeInteger(ghInstallationId) ? installationDiscoveryRef(ghInstallationId) : deliveryId;
    const runs = await queueDiscoveries(deps.appUserPool, tenant.accountId, { kind: 'installation', installationId: tenant.installationId, ...(ghRepoIds ? { ghRepoIds } : {}) }, trigger, ref);
    if (runs.length > 0 && deps.onDiscoveryQueued) await deps.onDiscoveryQueued(tenant.accountId, runs);
  } catch {
    // fx-swallow-ok: the delivery already committed; a fixed line is logged (no repository, no id) and the next trigger or sweep discovers
    (deps.warn ?? console.warn)('github webhook: queuing discovery failed');
  }
}

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
import { IllegalStageTransitionError } from '@fx/core/src/work-items/stages.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { withPlatformOps } from '@fx/core/src/tenancy/withPlatformOps.js';
import { syncFailureTag } from './syncFailureTag.js';

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

const PERMISSION_RANK: Readonly<Record<RepoPermission, number>> = { none: 0, read: 1, triage: 2, write: 3, maintain: 4, admin: 5 };

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
   */
  authorPermission?: LookedUpPermission | null;
}

/** issue.opened / discussion.created: creates a work_items row, gated by canCreateWork. */
export interface CreateWorkItemEvent {
  kind: 'create_work_item';
  workItemKind: 'issue' | 'discussion';
  ghNumber: number;
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

/** Every event mapped to "no work_items/run action" -- still a real
 * mapping decision (criterion 2), not an unhandled case. */
export interface IgnoredEvent {
  kind: 'ignored';
  reason: string;
}

export type MappedEvent =
  | CreateWorkItemEvent
  | TransitionPrEvent
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
  issue: { number: number; user: Actor; author_association: string | null };
}
export interface GithubIssueCommentPayload {
  action: string;
  comment: { user: Actor; author_association: string | null };
  issue: { number: number };
}
export interface GithubDiscussionPayload {
  action: string;
  discussion: { number: number; user: Actor; author_association?: string | null };
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
    head: { repo: { id: number } | null };
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
  // The author's REAL repository permission, asked of GitHub for this delivery, replaces the association's guess, but
  // only for the very login the payload names (a mismatch is ignored) and never to LOWER what the association says.
  const fromAssociation = authorAssociationToRepoPermission(author.authorAssociation);
  const useLookup = lookedUp != null && !!author.login && lookedUp.login.toLowerCase() === author.login.toLowerCase() && PERMISSION_RANK[lookedUp.permission] > PERMISSION_RANK[fromAssociation];
  const input: ClassifyAuthorInput = {
    login: author.login,
    repoPermission: useLookup ? lookedUp!.permission : fromAssociation,
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
      if (p.action !== 'opened') {
        return { kind: 'ignored', reason: `issue.${p.action}: only 'opened' creates a work item in H13a` };
      }
      const { trust, canCreateWork: allowed } = trustOf(
        { login: p.issue.user?.login, authorAssociation: p.issue.author_association },
        input.allowlist,
        allowWritePermission,
        input.authorPermission,
      );
      if (!allowed) {
        return { kind: 'ignored', reason: 'issue.opened: untrusted author, H07 gate refuses work creation' };
      }
      return { kind: 'create_work_item', workItemKind: 'issue', ghNumber: p.issue.number, trust, canCreateWork: allowed };
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
      return { kind: 'create_work_item', workItemKind: 'discussion', ghNumber: p.discussion.number, trust, canCreateWork: allowed };
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
      return { kind: 'ignored', reason: `pull_request.${p.action}: not opened/closed, no stage change` };
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
        `INSERT INTO work_items (account_id, repo_id, kind, gh_number, provenance) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [ctx.accountId, ctx.repoId, mapped.workItemKind, mapped.ghNumber, provenance],
      );
      return { applied: 'created', workItemId: rows[0]!.id };
    }

    case 'transition_pr': {
      // CWE-863: a fork PR from an untrusted author must never drive a stage transition.
      if (mapped.isFork && mapped.trust !== 'trusted') {
        return { applied: 'skipped', reason: 'pull_request: fork or untrusted head repo, no stage transition' };
      }
      if (mapped.linkedIssueNumber == null) {
        return { applied: 'skipped', reason: 'pull_request: no Closes/Fixes/Resolves #N reference in body' };
      }
      const workItemId = await findLinkedWorkItem(client, ctx.accountId, ctx.repoId, mapped.linkedIssueNumber);
      if (!workItemId) {
        return { applied: 'skipped', reason: `pull_request: no work item linked to issue #${mapped.linkedIssueNumber}` };
      }

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
        const { rowCount } = await client.query(
          `UPDATE repos SET installation_id = NULL, updated_at = now()
             WHERE account_id = $1 AND installation_id = $2 AND product = 'team' AND gh_repo_id = ANY($3::bigint[])`,
          [ctx.accountId, ctx.installationId, mapped.removedGhRepoIds],
        );
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
   * D#483 P1: the issue author's real repository permission, asked of GitHub (the retry author check's lookup), for an
   * `issues.opened` whose `author_association` is not OWNER. Called after the tenant is resolved and before the event is
   * mapped, for that delivery only; nothing is stored or reused. Absent, or any failure (a throw, no answer, a different
   * login than the payload's), changes nothing: the association alone decides, as before (fail closed).
   */
  issueAuthorPermission?: (input: { repoId: string; owner: string; name: string; number: number }) => Promise<LookedUpPermission | null>;
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

  let authorPermission: LookedUpPermission | null = null;
  if (eventName === 'issues' && deps.issueAuthorPermission) {
    const p = payload as GithubIssuePayload;
    const [owner, name] = (envelope.repoFullName ?? '').split('/');
    if (p.action === 'opened' && p.issue?.author_association !== 'OWNER' && owner && name && tenant.repoId && Number.isSafeInteger(p.issue?.number)) {
      try {
        authorPermission = await deps.issueAuthorPermission({ repoId: tenant.repoId, owner, name, number: p.issue.number });
      } catch {
        // fx-swallow-ok: fail closed by design; a fixed line is logged (no login, no repository, no driver text) and the association alone decides
        (deps.warn ?? console.warn)('github webhook: author permission lookup failed; the association decides');
        authorPermission = null;
      }
    }
  }

  const mapped = mapEvent(eventName, payload, { allowlist: deps.allowlist ?? [], allowWritePermission: deps.allowWritePermission, authorPermission });

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
      (deps.warn ?? console.warn)(`github repo sync failed (${syncFailureTag(err)}); the next event retries`);
    }
  }

  return { handled: true, result };
}

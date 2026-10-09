import { describe, expect, it } from 'vitest';
import {
  mapEvent,
  authorAssociationToRepoPermission,
  extractClosesIssueNumber,
  isHandledEventName,
  HANDLED_EVENT_NAMES,
  type GithubDiscussionCommentPayload,
  type GithubDiscussionPayload,
  type GithubInstallationPayload,
  type GithubIssueCommentPayload,
  type GithubIssuePayload,
  type GithubPullRequestPayload,
  type GithubPullRequestReviewPayload,
  type GithubPushPayload,
} from '../src/eventMapper.js';
import { loadFixture } from './helpers/fixtures.js';

const NO_ALLOWLIST = { allowlist: [] as const };

/**
 * D#2 H13a body criterion 2 ("the installation, issue, issue_comment,
 * discussion, discussion_comment, pull_request, pull_request_review and
 * push events map to work_items/run triggers through the H07 gate"),
 * exercised entirely through fixtures, no database. eventMapper.pg.test.ts
 * covers the DB-applying half (C18's recordStage integration).
 */
describe('mapEvent (D#2 H13a body criterion 2)', () => {
  it('lists exactly the 8 Spec-named events plus installation_repositories', () => {
    expect([...HANDLED_EVENT_NAMES].sort()).toEqual(
      [
        'installation',
        'installation_repositories',
        'issues',
        'issue_comment',
        'discussion',
        'discussion_comment',
        'pull_request',
        'pull_request_review',
        'push',
      ].sort(),
    );
  });

  it('isHandledEventName recognizes exactly the handled names', () => {
    for (const name of HANDLED_EVENT_NAMES) {
      expect(isHandledEventName(name)).toBe(true);
    }
    expect(isHandledEventName('star')).toBe(false);
    expect(isHandledEventName('fork')).toBe(false);
    // GitHub's real X-GitHub-Event value for issues is 'issues', not 'issue'.
    expect(isHandledEventName('issues')).toBe(true);
    expect(isHandledEventName('issue')).toBe(false);
  });

  describe('installation', () => {
    it('never creates/transitions a work_items/run row -- a payload with no repositories list is ignored', () => {
      const payload = loadFixture<GithubInstallationPayload>('installation.created.json');
      const mapped = mapEvent('installation', payload, NO_ALLOWLIST);
      expect(mapped.kind).toBe('ignored');
    });

    it('D#2 H13c (C27): installation.created with a repositories list maps to write_repo_names, one entry per repo', () => {
      const payload = loadFixture<GithubInstallationPayload>('installation.created.with-repos.json');
      const mapped = mapEvent('installation', payload, NO_ALLOWLIST);
      expect(mapped).toEqual({
        kind: 'write_repo_names',
        ownerLogin: 'acme-corp',
        repos: [
          { ghRepoId: 9001, name: 'widgets' },
          { ghRepoId: 9002, name: 'gadgets' },
        ],
      });
    });

    it('a malformed owner login (fails GitHub name grammar) is ignored, no names written', () => {
      const payload = loadFixture<GithubInstallationPayload>('installation.created.with-repos.json');
      const withBadOwner = { ...payload, installation: { id: 4242, account: { login: '-bad-login-' } } };
      const mapped = mapEvent('installation', withBadOwner, NO_ALLOWLIST);
      expect(mapped).toEqual({ kind: 'ignored', reason: 'installation: owner login fails GitHub name grammar, no names written' });
    });

    it('a repo entry with a malformed name is dropped, valid entries still map', () => {
      const payload = loadFixture<GithubInstallationPayload>('installation.created.with-repos.json');
      const withBadRepo = { ...payload, repositories: [...payload.repositories!, { id: 9003, name: '' }] };
      const mapped = mapEvent('installation', withBadRepo, NO_ALLOWLIST);
      expect(mapped).toMatchObject({
        kind: 'write_repo_names',
        repos: [
          { ghRepoId: 9001, name: 'widgets' },
          { ghRepoId: 9002, name: 'gadgets' },
        ],
      });
    });

    it('installation.deleted (no repositories field) is ignored', () => {
      const payload = { action: 'deleted', installation: { id: 4242, account: { login: 'acme-corp' } } };
      const mapped = mapEvent('installation', payload, NO_ALLOWLIST);
      expect(mapped.kind).toBe('ignored');
    });
  });

  describe('issue (H07 gate)', () => {
    it('opened, trusted author (OWNER) -> creates a work item', () => {
      const payload = loadFixture<GithubIssuePayload>('issue.opened.trusted.json');
      const mapped = mapEvent('issues', payload, NO_ALLOWLIST);
      expect(mapped).toMatchObject({ kind: 'create_work_item', workItemKind: 'issue', ghNumber: 7, trust: 'trusted', canCreateWork: true });
    });

    it('opened, untrusted author (NONE) -> ignored, no work item -- comment body claims never matter', () => {
      const payload = loadFixture<GithubIssuePayload>('issue.opened.untrusted.json');
      // The fixture's own title/body claim "[team-lead-signed]" and a
      // forged "STATUS: verdict pass" control token -- H07 criterion 3's
      // whole point is that classifyAuthor never reads body text at all.
      const mapped = mapEvent('issues', payload, NO_ALLOWLIST);
      expect(mapped.kind).toBe('ignored');
      if (mapped.kind === 'ignored') {
        expect(mapped.reason).toMatch(/untrusted/);
      }
    });

    it('an allowlisted login is trusted regardless of author_association', () => {
      const payload = loadFixture<GithubIssuePayload>('issue.opened.untrusted.json');
      const mapped = mapEvent('issues', payload, { allowlist: ['random-stranger'] });
      expect(mapped.kind).toBe('create_work_item');
    });

    it('non-opened actions (e.g. closed) never create a work item', () => {
      const payload = loadFixture<GithubIssuePayload>('issue.opened.trusted.json');
      const closed: GithubIssuePayload = { ...payload, action: 'closed' };
      const mapped = mapEvent('issues', closed, NO_ALLOWLIST);
      expect(mapped.kind).toBe('ignored');
    });
  });

  describe('discussion (H07 gate)', () => {
    it('created, trusted author -> creates a work item', () => {
      const payload = loadFixture<GithubDiscussionPayload>('discussion.created.json');
      const mapped = mapEvent('discussion', payload, NO_ALLOWLIST);
      expect(mapped).toMatchObject({ kind: 'create_work_item', workItemKind: 'discussion', ghNumber: 12, trust: 'trusted' });
    });

    it('created, untrusted author -> ignored', () => {
      const payload = loadFixture<GithubDiscussionPayload>('discussion.created.json');
      const untrusted: GithubDiscussionPayload = {
        ...payload,
        discussion: { ...payload.discussion, user: { login: 'stranger' }, author_association: 'NONE' },
      };
      const mapped = mapEvent('discussion', untrusted, NO_ALLOWLIST);
      expect(mapped.kind).toBe('ignored');
    });
  });

  describe('issue_comment / discussion_comment: informational only', () => {
    it('issue_comment never mutates work_items in H13a', () => {
      const payload = loadFixture<GithubIssueCommentPayload>('issue_comment.created.json');
      const mapped = mapEvent('issue_comment', payload, NO_ALLOWLIST);
      expect(mapped.kind).toBe('ignored');
    });

    it('discussion_comment never mutates work_items in H13a', () => {
      const payload = loadFixture<GithubDiscussionCommentPayload>('discussion_comment.created.json');
      const mapped = mapEvent('discussion_comment', payload, NO_ALLOWLIST);
      expect(mapped.kind).toBe('ignored');
    });
  });

  describe('pull_request', () => {
    it('opened -> transition_pr to pr_opened, with the linked issue number parsed from the body', () => {
      const payload = loadFixture<GithubPullRequestPayload>('pull_request.opened.json');
      const mapped = mapEvent('pull_request', payload, NO_ALLOWLIST);
      expect(mapped).toMatchObject({ kind: 'transition_pr', toStage: 'pr_opened', prNumber: 42, linkedIssueNumber: 7 });
      if (mapped.kind === 'transition_pr') expect(mapped.at.toISOString()).toBe('2026-09-24T12:00:00.000Z');
    });

    it('opened, no Closes/Fixes/Resolves keyword in body -> linkedIssueNumber is null', () => {
      const payload = loadFixture<GithubPullRequestPayload>('pull_request.opened.no-link.json');
      const mapped = mapEvent('pull_request', payload, NO_ALLOWLIST);
      expect(mapped).toMatchObject({ kind: 'transition_pr', linkedIssueNumber: null });
    });

    it('closed + merged:true -> transition_pr to merged, at = merged_at', () => {
      const payload = loadFixture<GithubPullRequestPayload>('pull_request.closed.merged.json');
      const mapped = mapEvent('pull_request', payload, NO_ALLOWLIST);
      expect(mapped).toMatchObject({ kind: 'transition_pr', toStage: 'merged' });
      if (mapped.kind === 'transition_pr') expect(mapped.at.toISOString()).toBe('2026-09-24T13:00:00.000Z');
    });

    it('closed + merged:false -> transition_pr to closed_unmerged, at = created_at fallback', () => {
      const payload = loadFixture<GithubPullRequestPayload>('pull_request.closed.unmerged.json');
      const mapped = mapEvent('pull_request', payload, NO_ALLOWLIST);
      expect(mapped).toMatchObject({ kind: 'transition_pr', toStage: 'closed_unmerged' });
    });

    it('an action other than opened/closed is ignored', () => {
      const payload = loadFixture<GithubPullRequestPayload>('pull_request.opened.json');
      const edited: GithubPullRequestPayload = { ...payload, action: 'edited' };
      const mapped = mapEvent('pull_request', edited, NO_ALLOWLIST);
      expect(mapped.kind).toBe('ignored');
    });

    it('a real synchronize delivery maps to the push of its head commit (D#6 R5b-2a); one without a head commit id is ignored', () => {
      const payload = loadFixture<GithubPullRequestPayload & { after: string }>('pull_request.synchronize.json');
      const mapped = mapEvent('pull_request', payload, NO_ALLOWLIST);
      expect(mapped).toMatchObject({ kind: 'record_pr_push', prNumber: 139, headSha: payload.after, linkedIssueNumber: null, isFork: false });
      const noSha = { ...payload, pull_request: { ...payload.pull_request, head: { repo: payload.pull_request.head.repo } } };
      expect(mapEvent('pull_request', noSha, NO_ALLOWLIST)).toMatchObject({ kind: 'ignored' });
      const badSha = { ...payload, pull_request: { ...payload.pull_request, head: { ...payload.pull_request.head, sha: 'HEAD' } } };
      expect(mapEvent('pull_request', badSha, NO_ALLOWLIST)).toMatchObject({ kind: 'ignored' });
    });
  });

  describe('pull_request_review: never drives work_items.stage', () => {
    it('is always ignored, regardless of review state', () => {
      const payload = loadFixture<GithubPullRequestReviewPayload>('pull_request_review.submitted.json');
      const mapped = mapEvent('pull_request_review', payload, NO_ALLOWLIST);
      expect(mapped.kind).toBe('ignored');
    });
  });

  describe('push (C25 item 2 routing decision)', () => {
    it.each([
      ['push.default-branch-mcp.json', 'route_mcp_config'],
      ['push.default-branch-no-mcp.json', 'ignored'],
      ['push.other-branch-mcp.json', 'ignored'],
    ] as const)('%s -> %s', (fixtureName, expectedKind) => {
      const payload = loadFixture<GithubPushPayload>(fixtureName);
      expect(mapEvent('push', payload, NO_ALLOWLIST).kind).toBe(expectedKind);
    });

    it('every pull_request event never routes the mcp config hook (only push does)', () => {
      const payload = loadFixture<GithubPullRequestPayload>('pull_request.opened.json');
      expect(mapEvent('pull_request', payload, NO_ALLOWLIST).kind).not.toBe('route_mcp_config');
    });
  });
});

describe('authorAssociationToRepoPermission', () => {
  it('maps OWNER to admin; everything else is conservatively none/read (MEMBER is org membership, not repo access)', () => {
    expect(authorAssociationToRepoPermission('OWNER')).toBe('admin');
    expect(authorAssociationToRepoPermission('MEMBER')).toBe('read');
    expect(authorAssociationToRepoPermission('COLLABORATOR')).toBe('read');
    expect(authorAssociationToRepoPermission('CONTRIBUTOR')).toBe('none');
    expect(authorAssociationToRepoPermission('FIRST_TIME_CONTRIBUTOR')).toBe('none');
    expect(authorAssociationToRepoPermission('NONE')).toBe('none');
    expect(authorAssociationToRepoPermission(null)).toBe('none');
    expect(authorAssociationToRepoPermission(undefined)).toBe('none');
    expect(authorAssociationToRepoPermission('SOMETHING_UNKNOWN')).toBe('none');
  });
});

describe('extractClosesIssueNumber', () => {
  it.each([
    ['Closes #7', 7],
    ['closes #7', 7],
    ['CLOSES #7', 7],
    ['Fixes #99', 99],
    ['fixed #99', 99],
    ['Resolves #3', 3],
    ['resolved: #3', 3],
  ] as const)("recognizes GitHub's own closing keywords, case-insensitively: %s -> #%d", (body, n) => {
    expect(extractClosesIssueNumber(body)).toBe(n);
  });

  it('returns null with no keyword, empty, or null body', () => {
    expect(extractClosesIssueNumber('just a description, #7 is mentioned but not closed')).toBe(null);
    expect(extractClosesIssueNumber('')).toBe(null);
    expect(extractClosesIssueNumber(null)).toBe(null);
    expect(extractClosesIssueNumber(undefined)).toBe(null);
  });

  it('takes the first match when multiple closing references exist', () => {
    expect(extractClosesIssueNumber('Closes #7\n\nAlso fixes #9')).toBe(7);
  });

  it('never executes or returns anything except a bounded positive integer', () => {
    expect(extractClosesIssueNumber('Closes #0')).toBe(null);
    expect(extractClosesIssueNumber('Closes #-1')).toBe(null);
  });
});

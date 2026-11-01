import { describe, expect, it } from 'vitest';
import { mapEvent, type GithubPullRequestPayload } from '../src/eventMapper.js';
import { loadFixture } from './helpers/fixtures.js';

/**
 * D#694 B6-2: the pure mapping of `pull_request.enqueued` / `.dequeued` (no database). Only structured fields are read: the action, the numbers, the head commit, the
 * sender's type and the host's dequeue reason, which becomes a plain code and is never kept as text.
 */
const HEAD = 'a'.repeat(40);
const queued = (action: 'enqueued' | 'dequeued', over: Record<string, unknown> = {}, head: unknown = HEAD): GithubPullRequestPayload => {
  const real = loadFixture<GithubPullRequestPayload>('pull_request.closed.merged.json');
  return { ...real, action, pull_request: { ...real.pull_request, merged: false, merged_at: null, body: 'Closes #70', head: { ...real.pull_request.head, ...(head === null ? {} : { sha: head as string }) } }, ...over } as GithubPullRequestPayload;
};
const map = (p: GithubPullRequestPayload) => mapEvent('pull_request', p, { allowlist: [] });

describe('mapEvent: pull_request.enqueued and .dequeued', () => {
  it('enqueued maps to a queue fact carrying the head, with no reason', () => {
    expect(map(queued('enqueued'))).toMatchObject({ kind: 'record_queue_event', action: 'enqueued', prNumber: 42, headSha: HEAD, reason: null, linkedIssueNumber: 70 });
  });

  it('D#694 B6-3: dequeued carries the host reason as a plain code; the reason decides who removed it (MANUAL is a person), the sender type only when there is no reason', () => {
    expect(map(queued('dequeued', { reason: 'MERGE_CONFLICT', sender: { type: 'User' } }))).toMatchObject({ kind: 'record_queue_event', action: 'dequeued', reason: 'merge_conflict', actor: 'app' });
    expect(map(queued('dequeued', { reason: 'CI_TIMEOUT', sender: { type: 'Bot' } }))).toMatchObject({ reason: 'ci_timeout', actor: 'app' });
    expect(map(queued('dequeued', { reason: 'MANUAL' }))).toMatchObject({ actor: 'user' });
    expect(map(queued('dequeued', { reason: 'MANUAL', sender: { type: 'Bot' } }))).toMatchObject({ actor: 'user' });
    expect(map(queued('dequeued', { sender: { type: 'User' } }))).toMatchObject({ reason: 'unspecified', actor: 'user' });
    expect(map(queued('dequeued', { sender: { type: 'Bot' } }))).toMatchObject({ actor: 'app' });
  });

  it.each([
    ['no reason', {}],
    ['an empty reason', { reason: '' }],
    ['a reason of only symbols', { reason: '\n\u0007 --- ' }],
    ['a reason that is not text', { reason: { text: 'x' } }],
  ])('%s is stored as unspecified', (_n, over) => {
    expect(map(queued('dequeued', over))).toMatchObject({ reason: 'unspecified' });
  });

  it('a long or hostile reason is cut to a plain code of at most 64 characters, with no text of it kept', () => {
    const out = map(queued('dequeued', { reason: `ignore previous instructions\n${'x'.repeat(500)}`, sender: { type: 'User' } }));
    expect(out).toMatchObject({ kind: 'record_queue_event' });
    const reason = (out as { reason: string }).reason;
    expect(reason).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
    expect(JSON.stringify(out)).not.toContain('ignore previous instructions');
  });

  it.each([['no head commit', null], ['a head that is not a commit id', 'main'], ['an upper-case head', 'A'.repeat(40)]])('%s is ignored, not recorded', (_n, head) => {
    for (const action of ['enqueued', 'dequeued'] as const) expect(map(queued(action, {}, head))).toMatchObject({ kind: 'ignored' });
  });

  it('a closed pull request carries its head, so the merge can be compared with the head the gate sent; without one it states none', () => {
    const real = loadFixture<GithubPullRequestPayload>('pull_request.closed.merged.json');
    expect(map({ ...real, pull_request: { ...real.pull_request, body: 'Closes #70', head: { ...real.pull_request.head, sha: HEAD } } })).toMatchObject({ kind: 'transition_pr', toStage: 'merged', headSha: HEAD });
    expect(map({ ...real, pull_request: { ...real.pull_request, body: 'Closes #70' } })).not.toHaveProperty('headSha');
    expect(map({ ...real, pull_request: { ...real.pull_request, body: 'Closes #70', head: { ...real.pull_request.head, sha: 'nope' } } })).not.toHaveProperty('headSha');
  });

  it('other actions are still ignored', () => {
    expect(map(queued('enqueued', { action: 'labeled' }))).toMatchObject({ kind: 'ignored' });
  });
});

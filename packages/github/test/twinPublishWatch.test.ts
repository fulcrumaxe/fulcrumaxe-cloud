import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { applyMappedEvent, mapEvent, type ApplyEventCtx, type GithubPullRequestPayload } from '../src/eventMapper.js';

/**
 * D#845 ON-27c2: the webhook's watch on a private twin's publish pull request, on the PUBLIC repository. This tests what the mapper hands the database definer (`twin_publish_pr_closed`) and when it does not: the definer
 * itself, with real rows, row security and the account fence, is tested in packages/runner-cloud (twinPublish.pg.test.ts). The payloads are the shape GitHub delivers.
 */
const FULL_NAME = 'acme/widgets';
const REPO_GH_ID = 9001;
const REPO_ID = randomUUID();
const ACCOUNT_ID = randomUUID();
const BRANCH = 'fx/publish-0123456789ab';

interface In {
  action: 'opened' | 'closed';
  number?: number;
  ref?: string;
  merged?: boolean;
  /** `null` is a deleted fork; a number is another repository's id (a fork). */
  headRepoId?: number | null;
  base?: string;
}

function pull(i: In): GithubPullRequestPayload {
  const merged = i.merged === true;
  const headRepo = i.headRepoId === null ? null : { id: i.headRepoId ?? REPO_GH_ID, full_name: i.headRepoId !== undefined && i.headRepoId !== REPO_GH_ID ? 'stranger/widgets' : FULL_NAME };
  return {
    action: i.action,
    number: i.number ?? 12,
    pull_request: {
      number: i.number ?? 12,
      state: i.action === 'closed' ? 'closed' : 'open',
      body: null,
      created_at: '2026-11-26T12:00:00Z',
      merged_at: merged ? '2026-11-26T13:00:00Z' : null,
      merged,
      user: { login: 'fulcrumaxe[bot]', type: 'Bot' },
      author_association: 'OWNER',
      head: { ref: i.ref ?? BRANCH, sha: 'c'.repeat(40), repo: headRepo },
      base: { ref: i.base ?? 'main', sha: 'd'.repeat(40), repo: { id: REPO_GH_ID, full_name: FULL_NAME } },
    },
    repository: { id: REPO_GH_ID, full_name: FULL_NAME, default_branch: 'main' },
    installation: { id: 4243 },
  } as unknown as GithubPullRequestPayload;
}

const ctx: ApplyEventCtx = { accountId: ACCOUNT_ID, installationId: randomUUID(), repoId: REPO_ID, repo: { accountId: ACCOUNT_ID, repoId: REPO_ID, ghRepoId: REPO_GH_ID, fullName: FULL_NAME }, deliveryId: 'd-1' };

/** A client that answers the watch's call with `answer` and every other query with no rows. It records every statement it is given. */
function client(answer: string) {
  const seen: Array<{ sql: string; values: unknown[] }> = [];
  const c = {
    query: async (sql: string, values: unknown[] = []) => {
      seen.push({ sql, values });
      return /twin_publish_pr_closed/.test(sql) ? { rows: [{ r: answer }] } : { rows: [] };
    },
  } as unknown as PoolClient;
  return { c, seen, watch: () => seen.filter((s) => /twin_publish_pr_closed/.test(s.sql)) };
}
const deliver = (c: PoolClient, p: GithubPullRequestPayload) => applyMappedEvent(c, ctx, mapEvent('pull_request', p, { allowlist: [] }));

describe('the twin publish pull request watch', () => {
  it('a merged publish pull request goes to the definer with the repository, the number, merged and the head branch; its answer ends the delivery', async () => {
    const { c, watch, seen } = client('merged');
    expect(await deliver(c, pull({ action: 'closed', merged: true, number: 31 }))).toEqual({ applied: 'twin_publish_pr_closed', outcome: 'merged' });
    expect(watch()).toHaveLength(1);
    expect(watch()[0]!.values).toEqual([REPO_ID, 31, true, BRANCH]);
    // nothing else was asked: the delivery is the twin's, not a work item's
    expect(seen).toHaveLength(1);
  });

  it('a pull request closed unmerged goes to the definer with merged false', async () => {
    const { c, watch } = client('closed');
    expect(await deliver(c, pull({ action: 'closed', merged: false }))).toEqual({ applied: 'twin_publish_pr_closed', outcome: 'closed' });
    expect(watch()[0]!.values).toEqual([REPO_ID, 12, false, BRANCH]);
  });

  it('a pull request the definer does not know goes on as any other pull request (an unlinked one is skipped)', async () => {
    const { c, watch, seen } = client('none');
    const out = await deliver(c, pull({ action: 'closed', merged: true }));
    expect(out.applied).toBe('skipped');
    expect(watch()).toHaveLength(1);
    expect(seen.length).toBeGreaterThan(1);
  });

  it('asks nothing for an opened delivery, a fork, a deleted fork, another base, or a branch that is not a publish branch', async () => {
    const cases: In[] = [
      { action: 'opened' },
      { action: 'closed', merged: true, headRepoId: 777 },
      { action: 'closed', merged: true, headRepoId: null },
      { action: 'closed', merged: true, base: 'develop' },
      { action: 'closed', merged: true, ref: 'fx/publish-0123456789a' },
      { action: 'closed', merged: true, ref: 'fx/publish-0123456789abc' },
      { action: 'closed', merged: true, ref: 'fx/publish-0123456789AB' },
      { action: 'closed', merged: true, ref: 'fx/publish-0123456789ab-x' },
      { action: 'closed', merged: true, ref: 'feature/fx/publish-0123456789ab' },
      { action: 'closed', merged: false, ref: 'main' },
    ];
    for (const input of cases) {
      const { c, watch } = client('merged');
      await deliver(c, pull(input));
      expect(watch(), JSON.stringify(input)).toEqual([]);
    }
  });

  it('an answer that is not merged or closed is not taken as handled', async () => {
    for (const answer of ['', 'none', 'DROP', 'merged; DROP', 'finished']) {
      const { c } = client(answer);
      const out = await deliver(c, pull({ action: 'closed', merged: true }));
      expect(out.applied, answer).toBe('skipped');
    }
  });
});

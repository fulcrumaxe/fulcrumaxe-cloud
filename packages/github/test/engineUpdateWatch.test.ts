import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { applyMappedEvent, mapEvent, type ApplyEventCtx, type GithubPullRequestPayload } from '../src/eventMapper.js';

/**
 * D#845 ON-15c: the webhook's watch on an engine update's pull request. This tests what the mapper hands the database definer (`engine_update_pr_closed`), and when it does not: the definer itself, with real rows, row
 * security and the account fence, is tested in packages/runner-cloud (engineUpdatePr.pg.test.ts).
 */
const FULL_NAME = 'acme/widgets';
const REPO_GH_ID = 9001;
const REPO_ID = randomUUID();
const ACCOUNT_ID = randomUUID();
const BRANCH = 'fx/engine-update-1.2.0';

function pull(i: { action: 'opened' | 'closed'; ref?: string; merged?: boolean; headRepoId?: number | null; base?: string; number?: number }): GithubPullRequestPayload {
  const merged = i.merged === true;
  const headRepo = i.headRepoId === null ? null : { id: i.headRepoId ?? REPO_GH_ID, full_name: i.headRepoId !== undefined && i.headRepoId !== REPO_GH_ID ? 'stranger/widgets' : FULL_NAME };
  return {
    action: i.action,
    number: i.number ?? 12,
    pull_request: {
      number: i.number ?? 12, state: i.action === 'closed' ? 'closed' : 'open', body: null, created_at: '2026-11-26T12:00:00Z', merged_at: merged ? '2026-11-26T13:00:00Z' : null, merged,
      user: { login: 'fulcrumaxe[bot]', type: 'Bot' }, author_association: 'OWNER',
      head: { ref: i.ref ?? BRANCH, sha: 'c'.repeat(40), repo: headRepo },
      base: { ref: i.base ?? 'main', sha: 'd'.repeat(40), repo: { id: REPO_GH_ID, full_name: FULL_NAME } },
    },
    repository: { id: REPO_GH_ID, full_name: FULL_NAME, default_branch: 'main' },
    installation: { id: 4243 },
  } as unknown as GithubPullRequestPayload;
}

const ctx: ApplyEventCtx = { accountId: ACCOUNT_ID, installationId: randomUUID(), repoId: REPO_ID, repo: { accountId: ACCOUNT_ID, repoId: REPO_ID, ghRepoId: REPO_GH_ID, fullName: FULL_NAME }, deliveryId: 'd-1' };

/** A client that answers the watch's call with `answer` and every other query with no rows. */
function client(answer: string) {
  const seen: Array<{ sql: string; values: unknown[] }> = [];
  const c = { query: async (sql: string, values: unknown[] = []) => (seen.push({ sql, values }), /engine_update_pr_closed/.test(sql) ? { rows: [{ r: answer }] } : { rows: [] }) } as unknown as PoolClient;
  return { c, seen, watch: () => seen.filter((s) => /engine_update_pr_closed/.test(s.sql)), install: () => seen.filter((s) => /setup_install_pr_closed/.test(s.sql)) };
}
const deliver = (c: PoolClient, p: GithubPullRequestPayload) => applyMappedEvent(c, ctx, mapEvent('pull_request', p, { allowlist: [] }));

describe('the engine update pull request watch', () => {
  it('a merged or closed update pull request goes to its own definer with the repository, the number, merged and the head branch; its answer ends the delivery, and the install definer is not asked', async () => {
    for (const outcome of ['finished', 'failed', 'recorded'] as const) {
      const { c, watch, install, seen } = client(outcome);
      expect(await deliver(c, pull({ action: 'closed', merged: true, number: 31 }))).toEqual({ applied: 'engine_update_pr_closed', outcome });
      expect(watch()[0]!.values).toEqual([REPO_ID, 31, true, BRANCH]);
      expect(install()).toEqual([]);
      expect(seen).toHaveLength(1);
    }
    const { c, watch } = client('failed');
    expect(await deliver(c, pull({ action: 'closed', merged: false }))).toEqual({ applied: 'engine_update_pr_closed', outcome: 'failed' });
    expect(watch()[0]!.values).toEqual([REPO_ID, 12, false, BRANCH]);
  });

  it('a pull request the definer does not know goes on as any other pull request (an unlinked one is skipped)', async () => {
    const { c, watch, seen } = client('none');
    expect((await deliver(c, pull({ action: 'closed', merged: true }))).applied).toBe('skipped');
    expect(watch()).toHaveLength(1);
    expect(seen.length).toBeGreaterThan(1);
  });

  it('asks nothing for an opened delivery, a fork, a deleted fork, another base, or a branch that is not the update branch', async () => {
    const cases = [
      { action: 'opened' as const },
      { action: 'closed' as const, merged: true, headRepoId: 777 },
      { action: 'closed' as const, merged: true, headRepoId: null },
      { action: 'closed' as const, merged: true, base: 'develop' },
      { action: 'closed' as const, merged: true, ref: 'fx/engine-update-1.2' },
      { action: 'closed' as const, merged: true, ref: 'fx/engine-update-1.2.0-x' },
      { action: 'closed' as const, merged: true, ref: 'fx/engine-update-1.2.x' },
      { action: 'closed' as const, merged: true, ref: 'feature/fx/engine-update-1.2.0' },
    ];
    for (const input of cases) {
      const { c, watch } = client('finished');
      await deliver(c, pull(input));
      expect(watch(), JSON.stringify(input)).toEqual([]);
    }
  });

  it('an answer that is not one of the three is not taken as handled', async () => {
    for (const answer of ['', 'none', 'DROP', 'finished; DROP']) {
      const { c } = client(answer);
      expect((await deliver(c, pull({ action: 'closed', merged: true }))).applied, answer).toBe('skipped');
    }
  });
});

import { describe, expect, it, vi } from 'vitest';
import { PR_STATE_TIMEOUT_MS, boundedPrState, createPrStateReader, prStateFromPull, type PullReadHttp } from '../src/routes/reversalPrState.js';

/**
 * D#7 DP7-2g: the derived revert state. The reader asks GitHub for one pull request and names it with one of four fixed words; whatever goes wrong is
 * `unknown`, and nothing GitHub says is passed on. The GitHub side here is a strict stand-in: it answers only the exact `GET /repos/<owner>/<name>/pulls/<n>`
 * path the real `read` client allows, and refuses everything else the way that client does.
 */
function strictGithub(pulls: Record<string, { status: number; body: unknown }>, seen: string[] = []): PullReadHttp {
  return {
    async request(req) {
      seen.push(`${req.method} ${req.path}`);
      if (req.method !== 'GET' || !/^\/repos\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/pulls\/[1-9][0-9]*$/.test(req.path)) throw new Error('path_refused');
      return pulls[req.path] ?? { status: 404, body: { message: 'Not Found' } };
    },
  };
}

describe('prStateFromPull', () => {
  it.each([
    [200, { state: 'open', merged: false }, 'open'],
    [200, { state: 'closed', merged: true }, 'merged'],
    [200, { state: 'closed', merged: false, merged_at: '2026-10-31T10:00:00Z' }, 'merged'],
    [200, { state: 'closed', merged: false, merged_at: null }, 'closed_unmerged'],
    [200, { state: 'closed' }, 'closed_unmerged'],
    [200, { state: 'draft' }, 'unknown'],
    [200, { state: 7 }, 'unknown'],
    [200, {}, 'unknown'],
    [200, null, 'unknown'],
    [200, 'closed', 'unknown'],
    [404, { state: 'closed' }, 'unknown'],
    [403, { state: 'open' }, 'unknown'],
    [500, { state: 'open' }, 'unknown'],
    [301, { state: 'open' }, 'unknown'],
  ] as const)('%i %j reads %s', (status, body, expected) => {
    expect(prStateFromPull(status, body)).toBe(expected);
  });
});

describe('boundedPrState', () => {
  it('passes the answer through, turns a throw into unknown, and gives up on a read that outlives the bound', async () => {
    expect(await boundedPrState(async () => 'merged', 50)).toBe('merged');
    expect(await boundedPrState(async () => { throw new Error('x'); }, 50)).toBe('unknown');
    const started = Date.now();
    expect(await boundedPrState(() => new Promise(() => undefined), 40)).toBe('unknown');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('the bound', () => {
  it('is 3 seconds by default: a read still pending at 2.999 s is waited for, and at 3 s it is unknown', async () => {
    vi.useFakeTimers();
    try {
      expect(PR_STATE_TIMEOUT_MS).toBe(3000);
      let out: string | undefined;
      void boundedPrState(() => new Promise(() => undefined)).then((v) => { out = v; });
      await vi.advanceTimersByTimeAsync(2999);
      expect(out).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(out).toBe('unknown');
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers with one of the four words and nothing else, whatever GitHub sent back', async () => {
    const hostile = { state: 'closed', merged: false, title: 'secret title', body: 'private text', html_url: 'https://x', message: 'm' };
    const out = prStateFromPull(200, hostile);
    expect(['open', 'merged', 'closed_unmerged', 'unknown']).toContain(out);
    expect(JSON.stringify(out)).not.toMatch(/secret|private|https/);
  });
});

describe('createPrStateReader', () => {
  const repo = { owner: 'acme', name: 'widgets' };
  const make = (http: PullReadHttp, over: Partial<Parameters<typeof createPrStateReader>[0]> = {}) =>
    createPrStateReader({ resolveRepo: async () => repo, open: async () => http, timeoutMs: 100, ...over });

  it('asks for exactly one GET of the pull request and names where it stands', async () => {
    const seen: string[] = [];
    const reader = make(strictGithub({
      '/repos/acme/widgets/pulls/5': { status: 200, body: { state: 'closed', merged: false, title: 'secret title', body: 'private text' } },
      '/repos/acme/widgets/pulls/6': { status: 200, body: { state: 'open' } },
      '/repos/acme/widgets/pulls/7': { status: 200, body: { state: 'closed', merged: true } },
    }, seen));
    const input = { accountId: 'a', repoId: 'r' };
    expect(await reader.stateOf({ ...input, prNumber: 5 })).toBe('closed_unmerged');
    expect(await reader.stateOf({ ...input, prNumber: 6 })).toBe('open');
    expect(await reader.stateOf({ ...input, prNumber: 7 })).toBe('merged');
    expect(await reader.stateOf({ ...input, prNumber: 8 })).toBe('unknown');
    expect(seen).toEqual(['GET /repos/acme/widgets/pulls/5', 'GET /repos/acme/widgets/pulls/6', 'GET /repos/acme/widgets/pulls/7', 'GET /repos/acme/widgets/pulls/8']);
  });

  it('is unknown, with no request, for a repository that is gone or has an unsafe name, and for a pull request number that is not a positive integer', async () => {
    const seen: string[] = [];
    const http = strictGithub({}, seen);
    const input = { accountId: 'a', repoId: 'r' };
    expect(await make(http, { resolveRepo: async () => null }).stateOf({ ...input, prNumber: 5 })).toBe('unknown');
    for (const bad of [{ owner: '../x', name: 'w' }, { owner: 'acme', name: 'a/../b' }, { owner: 'acme', name: 'w?x=1' }, { owner: '-a', name: 'w' }]) {
      expect(await make(http, { resolveRepo: async () => bad }).stateOf({ ...input, prNumber: 5 })).toBe('unknown');
    }
    for (const n of [0, -1, 1.5, Number.NaN, 2 ** 60]) expect(await make(http).stateOf({ ...input, prNumber: n })).toBe('unknown');
    expect(seen).toEqual([]);
  });

  it('is unknown when the client refuses, throws, is slow, or the repository lookup fails', async () => {
    const input = { accountId: 'a', repoId: 'r', prNumber: 5 };
    expect(await make({ request: async () => { throw new Error('no_installation'); } }).stateOf(input)).toBe('unknown');
    expect(await make({ request: () => new Promise(() => undefined) }).stateOf(input)).toBe('unknown');
    expect(await make(strictGithub({}), { resolveRepo: async () => { throw new Error('db down'); } }).stateOf(input)).toBe('unknown');
    expect(await make(strictGithub({}), { open: async () => { throw new Error('no_installation'); } }).stateOf(input)).toBe('unknown');
  });
});

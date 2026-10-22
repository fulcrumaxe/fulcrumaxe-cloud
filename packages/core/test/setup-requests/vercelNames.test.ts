import { describe, expect, it } from 'vitest';
import { createVercelNamesReader, NAMES_CACHE_MAX, NAMES_FAILURE_TTL_MS, NAMES_PROJECT_CAP, NAMES_TTL_MS } from '../../src/setup-requests/vercelNames.js';
import { FakeVercel } from '../support/vercelEnvFake.js';

/** D#598 P8d-3a: the names a stored token can see, read through the strict Vercel stand-in with the real reader. */
const A = 'a0000000-0000-4000-8000-00000000d3a1';
const TEAM = 'team_abc123';

function setup(opts: { teamId?: string } = {}) {
  const v = new FakeVercel().connect(A, opts);
  const clock = { t: 1_000_000 };
  const logs: string[] = [];
  const reader = createVercelNamesReader({ credentials: v.resolver(), fetch: v.fetchImpl(), now: () => clock.t, log: (l) => logs.push(l) });
  return { v, clock, logs, reader };
}

describe('createVercelNamesReader', () => {
  it('a team token: the team name and the project names, sorted, and nothing else (no ids, no token)', async () => {
    const { v, reader, logs } = setup({ teamId: TEAM });
    v.team(TEAM, 'Acme Studio').project('web-app', [], { teamId: TEAM }).project('api', [], { teamId: TEAM }).project('someone-elses', []);
    const names = await reader.read(A);
    expect(names).toEqual({ status: 'ok', teamName: 'Acme Studio', projects: ['api', 'web-app'], truncated: false });
    const text = JSON.stringify(names) + logs.join('\n');
    expect(text).not.toContain('prj_');
    expect(text).not.toContain(TEAM);
    expect(text).not.toContain(v.tokenOf(A));
    expect(v.calls.every((c) => c.accountId === A && c.userAgent !== null)).toBe(true);
  });

  it('a personal token has no team name and no team request', async () => {
    const { v, reader } = setup();
    v.project('solo');
    expect(await reader.read(A)).toEqual({ status: 'ok', teamName: null, projects: ['solo'], truncated: false });
    expect(v.calls.map((c) => c.project)).toEqual(['']);
  });

  it('more projects than the cap: the first page only, flagged truncated', async () => {
    const { v, reader } = setup();
    for (let i = 0; i < NAMES_PROJECT_CAP + 5; i += 1) v.project(`p${String(i).padStart(3, '0')}`);
    const names = await reader.read(A);
    expect(names).toMatchObject({ status: 'ok', truncated: true });
    expect(names.status === 'ok' && names.projects).toHaveLength(NAMES_PROJECT_CAP);
  });

  it.each(['http_401', 'http_403', 'http_404', 'http_429', 'http_500', 'bad_json', 'bad_body', 'throw'] as const)('%s on the projects read is names unavailable, never a partial answer', async (mode) => {
    const { v, reader } = setup({ teamId: TEAM });
    v.team(TEAM, 'Acme').project('web', [], { teamId: TEAM }).failNext(mode, 2);
    expect(await reader.read(A)).toEqual({ status: 'unavailable' });
  });

  it('a team the token is not scoped to (403) or that does not exist (404) is unavailable even though projects would list', async () => {
    const { v, reader } = setup({ teamId: TEAM });
    v.project('web', [], { teamId: TEAM }); // team() never called: Vercel answers 404 for the team
    expect(await reader.read(A)).toEqual({ status: 'unavailable' });
  });

  it('a team name that is not plain text is unavailable, not the id', async () => {
    const { v, reader } = setup({ teamId: TEAM });
    v.team(TEAM, 'bad\u0000name').project('web', [], { teamId: TEAM });
    expect(await reader.read(A)).toEqual({ status: 'unavailable' });
  });

  it('no connection, or a revoked token, is unavailable; a revoked token is asked about once at most and never leaks', async () => {
    const { v, reader } = setup();
    expect(await reader.read('b0000000-0000-4000-8000-00000000d3a2')).toEqual({ status: 'unavailable' });
    expect(v.calls).toHaveLength(0);
    v.revoke(A);
    expect(await reader.read(A)).toEqual({ status: 'unavailable' });
  });

  it('caches an answer for the TTL and a failure for a short while, and concurrent reads share one call', async () => {
    const { v, reader, clock } = setup();
    v.project('web');
    const [one, two] = await Promise.all([reader.read(A), reader.read(A)]);
    expect(one).toEqual(two);
    expect(v.calls).toHaveLength(1);
    clock.t += NAMES_TTL_MS - 1;
    await reader.read(A);
    expect(v.calls).toHaveLength(1);
    clock.t += 2;
    v.failNext('http_500');
    expect(await reader.read(A)).toEqual({ status: 'unavailable' });
    expect(v.calls).toHaveLength(2);
    clock.t += NAMES_FAILURE_TTL_MS - 1;
    expect(await reader.read(A)).toEqual({ status: 'unavailable' });
    expect(v.calls).toHaveLength(2); // the failure is remembered: Vercel is not hit again
    clock.t += 2;
    expect(await reader.read(A)).toMatchObject({ status: 'ok' });
    expect(v.calls).toHaveLength(3);
  });

  it('a replaced token is a new cache entry', async () => {
    const { v } = setup();
    v.project('web');
    const resolver = v.resolver();
    let ref = 'one';
    const r = createVercelNamesReader({ credentials: { configured: true, resolve: async (id) => ({ ...(await resolver.resolve(id)), ref }) as never }, fetch: v.fetchImpl(), log: () => undefined });
    await r.read(A);
    await r.read(A);
    expect(v.calls).toHaveLength(1);
    ref = 'two';
    await r.read(A);
    expect(v.calls).toHaveLength(2);
  });

  it('the cache is bounded: past the cap the oldest entry is evicted and fetched again, a recent one is not', async () => {
    const v = new FakeVercel();
    v.project('web');
    const accounts = Array.from({ length: NAMES_CACHE_MAX + 1 }, (_, i) => `acct-${i}`);
    for (const a of accounts) v.connect(a);
    const reader = createVercelNamesReader({ credentials: v.resolver(), fetch: v.fetchImpl(), log: () => undefined });
    for (const a of accounts) await reader.read(a);
    expect(v.calls).toHaveLength(accounts.length);
    await reader.read(accounts[accounts.length - 1]!);
    expect(v.calls).toHaveLength(accounts.length); // newest still cached
    await reader.read(accounts[0]!);
    expect(v.calls).toHaveLength(accounts.length + 1); // oldest was evicted
  });

  it('a call that never answers ends at the per-call timeout: unavailable, logged as a timeout, nothing else', async () => {
    const v = new FakeVercel().connect(A);
    v.project('web').failNext('hang', 1);
    const logs: string[] = [];
    const reader = createVercelNamesReader({ credentials: v.resolver(), fetch: v.fetchImpl(), callTimeoutMs: 25, log: (l) => logs.push(l) });
    expect(await reader.read(A)).toEqual({ status: 'unavailable' });
    expect(logs.map((l) => JSON.parse(l))).toEqual([{ event: 'vercel_names.failed', code: 'timeout' }]);
  });

  it('names that look like text but are not plain (C1 controls, bidi overrides, zero-width characters) make the read unavailable', async () => {
    for (const bad of ['Acme\u0085Corp', 'Acme\u202EpmoC', 'Acme\u200BCorp', 'Acme\u2066x', 'Acme\uFEFF']) {
      const { v, reader } = setup({ teamId: TEAM });
      v.team(TEAM, bad).project('web', [], { teamId: TEAM });
      expect(await reader.read(A), JSON.stringify(bad)).toEqual({ status: 'unavailable' });
    }
    const { v, reader } = setup({ teamId: TEAM });
    v.team(TEAM, 'Équipe Zoë 日本').project('web', [], { teamId: TEAM });
    expect(await reader.read(A)).toMatchObject({ status: 'ok', teamName: 'Équipe Zoë 日本' });
  });

  it('a revoked token (403 invalidToken) makes the read unavailable AND marks the connection through the same hook as the check; a project-level 403 does not', async () => {
    const { v } = setup();
    v.project('web');
    const marked: Array<[string, string | undefined]> = [];
    const resolver = v.resolver();
    const reader = createVercelNamesReader({ credentials: { ...resolver, resolve: (id) => resolver.resolve(id), markRejected: async (a, r) => void marked.push([a, r]) }, fetch: v.fetchImpl(), log: () => undefined });
    v.failNext('http_403', 1);
    expect(await reader.read(A)).toEqual({ status: 'unavailable' });
    expect(marked).toEqual([]); // 403 without invalidToken: the token is fine, it cannot see this
    const t = createVercelNamesReader({ credentials: { ...resolver, markRejected: async (a, r) => void marked.push([a, r]) }, fetch: v.fetchImpl(), log: () => undefined });
    v.revoke(A);
    expect(await t.read(A)).toEqual({ status: 'unavailable' });
    expect(marked).toHaveLength(1);
    expect(marked[0]![0]).toBe(A);
  });
});

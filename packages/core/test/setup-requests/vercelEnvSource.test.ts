import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setPendingHooks } from '../../src/pendingWork.js';
import { runSetupRequestCheck } from '../../src/setup-requests/checks.js';
import {
  bindVercelEnvSource,
  buildListUrl,
  createVercelEnvSource,
  unavailableVercelCredentials,
  VERCEL_USER_AGENT,
  type VercelCredentialResolver,
} from '../../src/setup-requests/vercelEnvSource.js';
import { FakeVercel } from '../support/vercelEnvFake.js';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const SECRET = 'sk_live_NEVER_KEEP_THIS_VALUE';
const TOKEN = `vtok_${ACCOUNT}`;
const noFetch = (async () => {
  throw new Error('no network in this test');
}) as unknown as typeof fetch;
const names = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `VAR_${i}`, value: SECRET, target: ['production'] }));

/** D#598 P8d-1: the real Vercel adapter, over a strict fake of the listing endpoint (in-process fetch and a real local socket). */
describe('Vercel env-name adapter (P8d-1)', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (closers.length > 0) await closers.pop()!();
    setPendingHooks(null);
  });
  const lines: string[] = [];
  const log = (line: string) => void lines.push(line);
  const fresh = () => {
    lines.length = 0;
    return new FakeVercel().connect(ACCOUNT);
  };
  const list = (source: { listEnvNames: (i: { accountId: string; project: string }) => Promise<unknown> }, project = 'cloud-staging') => source.listEnvNames({ accountId: ACCOUNT, project });

  it('lists every page, newest first, and keeps names and environments only', async () => {
    const v = fresh().project('cloud-staging', names(5));
    v.pageSize = 2;
    const result = await list(v.source({ log }));
    expect(result).toMatchObject({ ok: true });
    expect((result as { entries: Array<{ name: string }> }).entries.map((e) => e.name)).toEqual(['VAR_0', 'VAR_1', 'VAR_2', 'VAR_3', 'VAR_4']);
    expect(v.calls).toHaveLength(3);
    const queries = v.calls.map((c) => new URLSearchParams(c.query));
    expect(queries.map((q) => q.get('until'))).toEqual([null, expect.stringMatching(/^\d+$/), expect.stringMatching(/^\d+$/)]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('a page cap that is hit fails closed to unavailable, never a partial "missing"', async () => {
    const v = fresh().project('cloud-staging', names(5));
    v.pageSize = 2;
    expect(await list(v.source({ log, pageCap: 2 }))).toEqual({ ok: false });
    expect(lines.join('\n')).toContain('page_cap');
    expect(await list(v.source({ log, pageCap: 3 }))).toMatchObject({ ok: true });
    // and through the check: the variable sits on the page the cap cut off, which must not read as env_var_missing
    const request = { kind: 'env_var', checkKind: 'env_var_present', target: 'cloud-staging', envName: 'VAR_4', targetEnvironment: 'production' } as const;
    expect(await runSetupRequestCheck(v.source({ log, pageCap: 2 }), ACCOUNT, request)).toEqual({ pass: false, reason: 'check_unavailable' });
  });

  it('a cursor that does not move fails closed instead of looping', async () => {
    const page = { envs: [{ key: 'A', target: ['production'] }], pagination: { count: 1, next: 1_700_000_000_000 } };
    const calls: string[] = [];
    const source = createVercelEnvSource({
      credentials: new FakeVercel().connect(ACCOUNT).resolver(),
      log,
      fetch: (async (url: URL) => {
        calls.push(String(url));
        return new Response(JSON.stringify(page), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(await list(source)).toEqual({ ok: false });
    expect(calls).toHaveLength(2);
    expect(lines.join('\n')).toContain('cursor_stuck');
  });

  it('paging is assumed, not published: an API that ignores `until` fails closed; an answer with no pagination is the last page', async () => {
    const v = fresh().project('cloud-staging', names(5));
    v.pageSize = 2;
    v.ignoresPagingParams = true;
    expect(await list(v.source({ log }))).toEqual({ ok: false });
    expect(lines.join('')).toContain('cursor_stuck');
    const single = createVercelEnvSource({
      credentials: v.resolver(),
      log,
      fetch: (async () => new Response(JSON.stringify({ envs: [{ key: 'A', target: ['production'] }] }), { status: 200 })) as unknown as typeof fetch,
    });
    expect(await list(single)).toEqual({ ok: true, entries: [{ name: 'A', targets: ['production'] }] });
  });

  it('the body is read as a stream and cut off at the cap: an endless body is cancelled, not buffered', async () => {
    let pulled = 0;
    let cancelled = false;
    const chunk = new Uint8Array(100_000);
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const source = createVercelEnvSource({ credentials: fresh().resolver(), log, fetch: (async () => new Response(endless, { status: 200 })) as unknown as typeof fetch });
    expect(await list(source)).toEqual({ ok: false });
    expect(lines.join('')).toContain('body_too_large');
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(4_000_000);
    // a declared length over the cap is refused without reading
    const declared = createVercelEnvSource({ credentials: fresh().resolver(), log, fetch: (async () => new Response('{}', { status: 200, headers: { 'content-length': '9000000' } })) as unknown as typeof fetch });
    expect(await list(declared)).toEqual({ ok: false });
  });

  it('every call carries the User-Agent and the bearer token, and asks for names: decrypt=false, never true', async () => {
    const v = fresh().project('cloud-staging', names(3));
    v.pageSize = 1;
    await list(v.source({ log }));
    expect(v.calls).toHaveLength(3);
    for (const call of v.calls) {
      expect(call.userAgent).toBe(VERCEL_USER_AGENT);
      expect(call.accountId).toBe(ACCOUNT);
      expect(new URLSearchParams(call.query).getAll('decrypt')).toEqual(['false']);
    }
  });

  it('refuses to build a request that asks for decrypted values, whatever the caller supplies', () => {
    for (const extra of ['decrypt=true', 'decrypt=false', 'decrypt=', 'decrypt=1&decrypt=false']) {
      expect(() => buildListUrl('https://api.vercel.com', 'p', { extra: new URLSearchParams(extra) }), extra).toThrow(/decrypt is never requested/);
    }
    const url = buildListUrl('https://api.vercel.com', 'cloud-staging', { teamId: 'team_abc', until: 5 });
    expect(url.searchParams.getAll('decrypt')).toEqual(['false']);
    expect(url.searchParams.get('teamId')).toBe('team_abc');
    expect(url.pathname).toBe('/v10/projects/cloud-staging/env');
  });

  it('the fake itself refuses decrypt=true, so a regression that asked for values would fail here', () => {
    const v = fresh().project('cloud-staging', names(1));
    expect(v.rawRequest(ACCOUNT, 'cloud-staging', 'decrypt=true').status).toBe(400);
    expect(v.rawRequest(ACCOUNT, 'cloud-staging', 'decrypt=false').status).toBe(200);
  });

  it('fails closed on 401, 403, 404, 429, 500, a body that is not JSON, a body that is not the listing and a dropped connection; the log has a code only', async () => {
    const v = fresh().project('cloud-staging', names(2));
    for (const mode of ['http_401', 'http_403', 'http_404', 'http_429', 'http_500', 'bad_json', 'bad_body', 'throw'] as const) {
      lines.length = 0;
      expect(await list(v.failNext(mode).source({ log })), mode).toEqual({ ok: false });
      expect(lines, mode).toHaveLength(1);
      expect(JSON.parse(lines[0]!), mode).toMatchObject({ event: 'vercel_env_source.failed' });
    }
    expect(await list(v.source({ log }))).toMatchObject({ ok: true });
    // a failure on the second page does not return the first page alone
    v.pageSize = 1;
    const second = fresh().project('cloud-staging', names(3));
    second.pageSize = 1;
    const source = second.source({ log });
    second.failNext('http_500', 1);
    expect(await list(source)).toEqual({ ok: false });
  });

  it('a revoked token is 401 and a disconnected account never reaches the provider', async () => {
    const v = fresh().project('cloud-staging', names(1));
    expect(await list(v.revoke(ACCOUNT).source({ log }))).toEqual({ ok: false });
    expect(lines.join('')).toContain('http_401');
    v.calls.length = 0;
    expect(await list(v.disconnect(ACCOUNT).source({ log }))).toEqual({ ok: false });
    expect(v.calls).toHaveLength(0);
  });

  it('a team-scoped token sends its team id; a malformed project name is refused before any call', async () => {
    const v = fresh().connect(ACCOUNT, { teamId: 'team_Abc123' }).project('cloud-staging', names(1));
    expect(await list(v.source({ log }))).toMatchObject({ ok: true });
    expect(v.calls[0]!.query).toContain('teamId=team_Abc123');
    v.calls.length = 0;
    for (const bad of ['Cloud Staging', '../x', 'a/b', 'a---b', '', 'x'.repeat(101)]) expect(await list(v.source({ log }), bad), bad).toEqual({ ok: false });
    expect(v.calls).toHaveLength(0);
  });

  it('a malformed variable name is skipped and counted; the rest of the listing still answers', async () => {
    const v = fresh().project('cloud-staging', [
      { key: 'GOOD_ONE', value: SECRET, target: ['production'] },
      { key: 'bad name with spaces', value: SECRET, target: ['production'] },
      { key: '1STARTS_WITH_DIGIT', value: SECRET, target: ['production'] },
      { key: 'GOOD_TWO', value: SECRET, target: 'preview' },
    ]);
    const result = await list(v.source({ log }));
    expect(result).toEqual({ ok: true, entries: [{ name: 'GOOD_ONE', targets: ['production'] }, { name: 'GOOD_TWO', targets: ['preview'] }], skipped: 2 });
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ event: 'vercel_env_source.skipped_entries', count: 2 }]);
    expect(lines.join('')).not.toMatch(/bad name|STARTS_WITH|GOOD_ONE/);
  });

  it('no value, token or name reaches the result, the log or a failure line', async () => {
    const v = fresh().project('cloud-staging', [{ key: 'STRIPE_KEY', value: SECRET, target: ['production'], type: 'encrypted' }, { key: 'x y', value: SECRET, target: ['production'] }]);
    const all = [JSON.stringify(await list(v.source({ log })))];
    for (const mode of ['http_500', 'bad_body', 'throw'] as const) all.push(JSON.stringify(await list(v.failNext(mode).source({ log }))));
    all.push(...lines);
    const joined = all.join('\n');
    expect(joined).not.toContain(SECRET);
    expect(joined).not.toContain('enc:');
    expect(joined).not.toContain(TOKEN);
    expect(joined).not.toContain('Bearer');
    expect(joined).not.toContain('x y');
  });

  it('a credential that is unavailable, throws or is malformed fails closed and never calls out', async () => {
    const fetchSpy = vi.fn();
    const mk = (resolver: VercelCredentialResolver) => createVercelEnvSource({ credentials: resolver, fetch: fetchSpy as unknown as typeof fetch, log });
    expect(await list(mk(unavailableVercelCredentials))).toEqual({ ok: false });
    expect(await list(mk({ configured: true, resolve: async () => { throw new Error('db down host=secret.example'); } }))).toEqual({ ok: false });
    expect(lines.join('')).not.toContain('secret.example');
    for (const token of ['', 'has space', 'new\nline', 'x'.repeat(2001)]) expect(await list(mk({ configured: true, resolve: async () => ({ status: 'ok', token }) })), token).toEqual({ ok: false });
    expect(await list(mk({ configured: true, resolve: async () => ({ status: 'ok', token: 'tok', teamId: 'not-a-team' }) }))).toEqual({ ok: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the production binding has no credential: unavailable, and it makes no network call', async () => {
    const fetchSpy = vi.fn();
    const source = createVercelEnvSource({ credentials: unavailableVercelCredentials, fetch: fetchSpy as unknown as typeof fetch, log });
    expect(source.available).toBe(false);
    expect(await list(source)).toEqual({ ok: false });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(createVercelEnvSource({ credentials: fresh().resolver(), fetch: noFetch }).available).toBe(true);
  });

  it('over a real socket: a call that never answers times out, a dropped connection and a redirect fail closed', async () => {
    const v = fresh().project('cloud-staging', names(1));
    const server = await v.listen();
    closers.push(server.close);
    const over = (extra: object = {}) => v.source({ baseUrl: server.baseUrl, fetch: fetch, log, ...extra });
    expect(await list(over())).toMatchObject({ ok: true });
    const started = Date.now();
    v.failNext('hang');
    expect(await list(over({ callTimeoutMs: 150 }))).toEqual({ ok: false });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(lines.join('')).toContain('timeout');
    lines.length = 0;
    expect(await list(v.failNext('throw').source({ baseUrl: server.baseUrl, fetch, log }))).toEqual({ ok: false });
    expect(lines.join('')).toContain('network');

    // a redirect (to anywhere) is never followed: the token would travel with it
    const hits: string[] = [];
    const redirector = createServer((req, res) => {
      hits.push(`${req.method} ${req.url} auth=${req.headers.authorization ? 'yes' : 'no'}`);
      res.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' });
      res.end();
    });
    await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise<void>((resolve) => redirector.close(() => resolve())));
    const redirected = v.source({ baseUrl: `http://127.0.0.1:${(redirector.address() as AddressInfo).port}`, fetch, log });
    expect(await list(redirected)).toEqual({ ok: false });
    expect(hits).toHaveLength(1);
  });

  it('the whole listing has a deadline across pages', async () => {
    const v = fresh().project('cloud-staging', names(6));
    v.pageSize = 1;
    const slow = (async (url: URL, init: RequestInit) => {
      await new Promise((r) => setTimeout(r, 60));
      return v.fetchImpl()(url, init);
    }) as unknown as typeof fetch;
    expect(await list(v.source({ log, fetch: slow, deadlineMs: 150 }))).toEqual({ ok: false });
    expect(lines.join('')).toMatch(/deadline|timeout/);
  });

  it('binding a source that can answer marks the check sweep pending; one that cannot does not', async () => {
    const markers = new Map<string, number>();
    setPendingHooks({ store: { get: async (k) => markers.get(k) ?? null, set: async (k, v) => void markers.set(k, v), delete: async (k) => void markers.delete(k) } });
    bindVercelEnvSource(createVercelEnvSource({ credentials: unavailableVercelCredentials, fetch: noFetch }));
    await new Promise((r) => setTimeout(r, 50));
    expect(markers.size).toBe(0);
    const mark = vi.fn();
    const bound = createVercelEnvSource({ credentials: fresh().resolver(), fetch: noFetch });
    expect(bindVercelEnvSource(bound, mark)).toBe(bound);
    expect(mark).toHaveBeenCalledTimes(1);
    bindVercelEnvSource(createVercelEnvSource({ credentials: fresh().resolver(), fetch: noFetch }));
    await vi.waitFor(() => expect([...markers.keys()].some((k) => k.includes('setup-request-check'))).toBe(true));
  });
});

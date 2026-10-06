import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchValidationHttpClient } from '../src/httpClient.js';

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Security review finding 6 (CWE-200): `fetch`'s default is
 * `redirect: 'follow'`, and Node strips `Authorization` on a
 * cross-origin redirect but keeps custom headers (like `x-api-key`) --
 * so a redirect from the validation host would carry the key to
 * whatever the redirect points at. No Postgres needed here: httpClient.ts
 * never touches the database, and this exercises the real Node `fetch`
 * against two real local HTTP servers rather than asserting on a mocked
 * `init.redirect` value alone.
 */
describe('httpClient (security review finding 6): redirect is never followed', () => {
  let servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.map(close));
    servers = [];
  });

  it('a 302 from the validation host is refused, not followed -- and the header never reaches the redirect target', async () => {
    let targetHits = 0;
    let targetSawAuthHeader = false;
    const target = createServer((req, res) => {
      targetHits++;
      targetSawAuthHeader = Boolean(req.headers.authorization || req.headers['x-api-key']);
      res.writeHead(200);
      res.end();
    });
    servers.push(target);
    const targetPort = await listen(target);

    const redirector = createServer((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/` });
      res.end();
    });
    servers.push(redirector);
    const redirectorPort = await listen(redirector);

    // fetchValidationHttpClient() always targets the real
    // ai-gateway.vercel.sh / api.anthropic.com hosts -- global fetch is
    // replaced so the SAME call (same headers, same `redirect: 'error'`
    // option) lands on the local redirector instead of the network,
    // exactly like the plaintext-leak regression test above uses the
    // same trick to avoid a real network call.
    const realFetch = globalThis.fetch;
    let capturedRedirectOption: string | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedRedirectOption = init?.redirect;
      return realFetch(`http://127.0.0.1:${redirectorPort}/`, init);
    }) as typeof fetch;

    try {
      const outcome = await fetchValidationHttpClient().validate({
        provider: 'ai_gateway',
        plaintextKey: 'sk-test-redirect-key',
      });

      // The client asked for redirect: 'error' ...
      expect(capturedRedirectOption).toBe('error');
      // ... and real Node fetch honoured it: it never followed the 302,
      // so the target server (holding the redirect) was never hit, and
      // never saw the Authorization header.
      expect(targetHits).toBe(0);
      expect(targetSawAuthHeader).toBe(false);
      // A refused redirect surfaces as a network_error outcome, not a
      // thrown exception that could crash the caller.
      expect(outcome.kind).toBe('network_error');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('the anthropic (x-api-key) request shape also sets redirect: error', async () => {
    const realFetch = globalThis.fetch;
    let capturedRedirectOption: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedRedirectOption = init?.redirect;
      capturedHeaders = init?.headers as Record<string, string> | undefined;
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
      const outcome = await fetchValidationHttpClient().validate({
        provider: 'anthropic',
        plaintextKey: 'sk-ant-test-key',
      });
      expect(capturedRedirectOption).toBe('error');
      expect(capturedHeaders?.['x-api-key']).toBe('sk-ant-test-key');
      expect(outcome.kind).toBe('ok');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

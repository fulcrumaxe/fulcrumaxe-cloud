import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { generateSelfSignedCert } from './selfSignedCert.js';

/**
 * Local TLS servers that stand in for `ai-gateway.vercel.sh` and `api.anthropic.com`, and a `fetch`-shaped transport
 * that reaches them through Node's REAL connection path: real TLS with the server certificate as the explicit `ca`
 * (never `rejectUnauthorized: false`), the real hostname as SNI, and a pinned `lookup` that is called with
 * `{ all: true }` the way Node 20+ calls it (autoSelectFamily). The lookup answers 127.0.0.1 for the two provider
 * hostnames and refuses every other name, so nothing here can resolve, let alone reach, a real provider.
 *
 * What the fakes enforce (each has a test that a stricter fake catches what a lenient one would let through):
 *  - Only GET on the allowed paths: `/v1/credits` (gateway) and `/v1/models` (Anthropic). ANY other method or path is
 *    refused with 405 or 404 AND recorded in `refused`; a test asserts `refused` is empty, so a request that could
 *    generate (a POST, a chat-completions path) fails the test and never silently "works".
 *  - Gateway: `/v1/models` answers 200 whatever the auth, as the docs say; `/v1/credits` answers 401 unless the
 *    Authorization header is `Bearer <a known key>`.
 *  - Anthropic: `/v1/models` answers 401 unless `x-api-key` is a known key and `anthropic-version` is present.
 *  - Either answers 403, 429, 500, or never answers (a timeout) on demand, per request, through `mode`.
 *
 * Not faked faithfully (the PR says so): the response bodies (every answer is an empty body, since the client reads
 * none), the providers' real rate-limit thresholds, and the real 403 wording. Whether the real gateway answers 403 for
 * a plan restriction on /v1/credits is the live pre-merge probe's job, not a fake's.
 */
export type ProviderName = 'ai_gateway' | 'anthropic';
export type ProviderMode = { status: number } | 'hang' | null;

export interface SeenRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  servername: string | false | undefined;
}

export interface StrictProvider {
  host: string;
  port: number;
  ca: string;
  /** Every request received, accepted or not. */
  seen: SeenRequest[];
  /** The subset that broke a rule (wrong method or path). A test asserts this is empty. */
  refused: SeenRequest[];
  /** Keys this provider accepts. */
  knownKeys: Set<string>;
  /** When set, every request is answered with it (or never answered) instead of by the rules. */
  mode: ProviderMode;
  close(): Promise<void>;
}

const HOSTS: Record<ProviderName, string> = { ai_gateway: 'ai-gateway.vercel.sh', anthropic: 'api.anthropic.com' };
const ALLOWED_PATH: Record<ProviderName, string> = { ai_gateway: '/v1/credits', anthropic: '/v1/models' };

export async function startStrictProvider(name: ProviderName, knownKeys: string[] = []): Promise<StrictProvider> {
  const host = HOSTS[name];
  const { certPem, keyPem } = generateSelfSignedCert(host, 1, { dnsNames: [host], ipAddresses: ['127.0.0.1'] });
  const provider: StrictProvider = {
    host,
    port: 0,
    ca: certPem,
    seen: [],
    refused: [],
    knownKeys: new Set(knownKeys),
    mode: null,
    close: async () => undefined,
  };
  const hanging: Array<() => void> = [];

  const server = https.createServer({ cert: certPem, key: keyPem }, (req, res) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v;
    const path = new URL(req.url ?? '/', 'https://127.0.0.1').pathname;
    const seen: SeenRequest = { method: req.method ?? 'GET', path, headers, servername: (req.socket as unknown as { servername?: string | false }).servername };
    provider.seen.push(seen);
    req.resume();
    const reply = (status: number): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end('{}');
    };

    // The generation guard comes first, and applies in every mode.
    if (seen.method !== 'GET') {
      provider.refused.push(seen);
      return reply(405);
    }
    const generic = name === 'ai_gateway' && path === '/v1/models'; // documented: no auth needed
    if (path !== ALLOWED_PATH[name] && !generic) {
      provider.refused.push(seen);
      return reply(404);
    }
    if (provider.mode === 'hang') {
      hanging.push(() => res.destroy());
      return;
    }
    if (provider.mode) return reply(provider.mode.status);

    if (generic) return reply(200);
    if (name === 'ai_gateway') {
      const auth = headers['authorization'] ?? '';
      const key = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
      return reply(key && provider.knownKeys.has(key) ? 200 : 401);
    }
    const key = headers['x-api-key'] ?? '';
    return reply(key && provider.knownKeys.has(key) && headers['anthropic-version'] ? 200 : 401);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  provider.port = (server.address() as AddressInfo).port;
  provider.close = async () => {
    hanging.forEach((destroy) => destroy());
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return provider;
}

export interface StrictProviders {
  ai_gateway: StrictProvider;
  anthropic: StrictProvider;
  /** A `fetch`-shaped transport for `fetchValidationHttpClient(timeoutMs, transport)`. */
  transport: typeof fetch;
  /** All requests refused by either fake (wrong method or path). */
  refused(): SeenRequest[];
  /** All requests either fake received. */
  seen(): SeenRequest[];
  reset(): void;
  close(): Promise<void>;
}

export async function startStrictProviders(keys: { ai_gateway?: string[]; anthropic?: string[] } = {}): Promise<StrictProviders> {
  const ai_gateway = await startStrictProvider('ai_gateway', keys.ai_gateway ?? []);
  const anthropic = await startStrictProvider('anthropic', keys.anthropic ?? []);
  const byHost = new Map([ai_gateway, anthropic].map((p) => [p.host, p]));

  const transport = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const target = byHost.get(url.hostname);
    return new Promise<Response>((resolve, reject) => {
      if (!target) return reject(new TypeError('strict transport: refusing a host that is not a provider fake'));
      if (url.protocol !== 'https:') return reject(new TypeError('strict transport: https only'));
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      const req = https.request(
        {
          host: url.hostname,
          port: target.port,
          path: url.pathname + url.search,
          method: init?.method ?? 'GET',
          headers,
          ca: target.ca,
          servername: url.hostname,
          signal: init?.signal ?? undefined,
          // Called by Node's connect path with { all: true } on Node 20+. Answers the two fake names only.
          lookup: (hostname, options, callback) => {
            if (!byHost.has(hostname)) return callback(new Error('strict transport: lookup refused for ' + hostname) as NodeJS.ErrnoException, '', 4);
            if ((options as { all?: boolean }).all) {
              return (callback as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [{ address: '127.0.0.1', family: 4 }]);
            }
            return callback(null, '127.0.0.1', 4);
          },
        },
        (res) => {
          res.resume();
          const status = res.statusCode ?? 0;
          if (init?.redirect === 'error' && status >= 300 && status < 400) {
            return reject(new TypeError('strict transport: redirect refused'));
          }
          res.on('end', () => resolve(new Response(null, { status })));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }) as typeof fetch;

  return {
    ai_gateway,
    anthropic,
    transport,
    refused: () => [...ai_gateway.refused, ...anthropic.refused],
    seen: () => [...ai_gateway.seen, ...anthropic.seen],
    reset() {
      for (const p of [ai_gateway, anthropic]) {
        p.seen.length = 0;
        p.refused.length = 0;
        p.mode = null;
      }
    },
    close: async () => {
      await ai_gateway.close();
      await anthropic.close();
    },
  };
}

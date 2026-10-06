import https from 'node:https';
import type { LookupFunction } from 'node:net';

/**
 * The one way the installation reconciler talks to GitHub: a GET, as one App, over Node's own HTTPS connection path.
 * Nothing here is a `fetch` wrapper that a test could answer without TLS, so a test that points it at a local server
 * still exercises the certificate and hostname checks, the User-Agent GitHub requires, and the way Node calls a
 * `lookup` (with `{ all: true }`).
 *
 * The host is always api.github.com. `transport` exists for tests only (a port, the server's certificate as an explicit
 * `ca`, and a lookup that maps the name to a local address); production passes none, and no environment variable can
 * set one. It never turns certificate checking off.
 *
 * What a call returns is the status, the lower-cased headers and the parsed body. A body that is not JSON, or is over
 * 5 MB, reads as `null`. The App JWT is held only for the length of the request and is never part of an error.
 */
export interface GithubAppResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface GithubAppApi {
  /** Resolves for any HTTP status; rejects only on a transport failure (the message is a fixed word, never a URL). */
  get(path: string, options: { signal?: AbortSignal; timeoutMs: number }): Promise<GithubAppResponse>;
}

export interface GithubTransport {
  port?: number;
  ca?: string;
  lookup?: LookupFunction;
}

export const GITHUB_API_HOST = 'api.github.com';
export const GITHUB_API_VERSION = '2022-11-28';
export const RECONCILE_USER_AGENT = 'fulcrumaxe-cloud-reconciler';
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const PATH_RE = /^\/app\/installations(\/[0-9]+)?(\?[A-Za-z0-9_=&.-]*)?$/;

export class GithubTransportError extends Error {
  constructor(reason: 'request_failed' | 'timeout' | 'aborted' | 'path_refused') {
    super(`github transport: ${reason}`);
    this.name = 'GithubTransportError';
  }
}

/** `mintJwt` signs a fresh App JWT; it is called once per client, lazily, and the token is reused for the run. */
export function createGithubAppApi(mintJwt: () => Promise<string>, transport: GithubTransport = {}): GithubAppApi {
  let jwt: string | undefined;
  return {
    async get(path, options) {
      // Only the two installation endpoints this job reads, so a bug in the caller cannot widen what it can reach.
      if (!PATH_RE.test(path)) throw new GithubTransportError('path_refused');
      if (options.signal?.aborted) throw new GithubTransportError('aborted');
      jwt ??= await mintJwt();
      const token = jwt;
      return new Promise<GithubAppResponse>((resolve, reject) => {
        const req = https.request(
          {
            method: 'GET',
            host: GITHUB_API_HOST,
            servername: GITHUB_API_HOST,
            // One connection per call: a few calls a run, and no socket shared with anything else (nor reused past its lookup).
            agent: false,
            port: transport.port ?? 443,
            path,
            ...(transport.ca ? { ca: transport.ca } : {}),
            ...(transport.lookup ? { lookup: transport.lookup } : {}),
            headers: {
              accept: 'application/vnd.github+json',
              authorization: `Bearer ${token}`,
              'x-github-api-version': GITHUB_API_VERSION,
              'user-agent': RECONCILE_USER_AGENT,
            },
            timeout: options.timeoutMs,
          },
          (res) => {
            const chunks: Buffer[] = [];
            let size = 0;
            res.on('data', (c: Buffer) => {
              size += c.length;
              if (size <= MAX_BODY_BYTES) chunks.push(c);
            });
            res.on('error', () => reject(new GithubTransportError('request_failed')));
            res.on('end', () => {
              const headers: Record<string, string> = {};
              for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
              let body: unknown = null;
              if (size <= MAX_BODY_BYTES) {
                try {
                  body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                } catch {
                  // fx-swallow-ok: a body that is not JSON (GitHub's plain-text errors) reads as null by contract
                  body = null;
                }
              }
              resolve({ status: res.statusCode ?? 0, headers, body });
            });
          },
        );
        const onAbort = (): void => {
          req.destroy(new GithubTransportError('aborted'));
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });
        req.on('timeout', () => req.destroy(new GithubTransportError('timeout')));
        req.on('error', (err) => {
          options.signal?.removeEventListener('abort', onAbort);
          reject(err instanceof GithubTransportError ? err : new GithubTransportError('request_failed'));
        });
        req.on('close', () => options.signal?.removeEventListener('abort', onAbort));
        req.end();
      });
    },
  };
}

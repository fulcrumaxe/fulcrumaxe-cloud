import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Seen {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A loopback HTTP server standing in for a model provider. Zero real model tokens: nothing here leaves 127.0.0.1. */
export class FakeProvider {
  seen: Seen[] = [];
  /** Hosts the code under test asked for (before the rewrite to loopback). */
  requestedHosts: string[] = [];
  origin = '';
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_req, res) => res.end('{}');
  private server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      this.seen.push({ path: req.url ?? '', headers: req.headers, body });
      this.handler(req, res);
    });
  });

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }

  reply(json: unknown, status = 200): void {
    this.handler = (_req, res) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
  }

  /** A `fetch` that keeps the request's path and init (redirect, signal, headers, body) but sends it to this server. */
  fetchImpl = (onCall?: () => void): typeof fetch =>
    ((input: string | URL | Request, init?: RequestInit) => {
      onCall?.();
      const u = new URL(String(input));
      this.requestedHosts.push(u.host);
      return fetch(`${this.origin}${u.pathname}${u.search}`, init);
    }) as typeof fetch;
}

export const anthropicReply = (text: string) => ({ content: [{ type: 'text', text }], usage: { input_tokens: 11, output_tokens: 7 } });
export const gatewayReply = (text: string) => ({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 5, completion_tokens: 3 } });

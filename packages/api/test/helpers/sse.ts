import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool, PoolClient } from 'pg';

/**
 * Real-HTTP scaffolding for the SSE tests. `startServer` binds an actual
 * TCP listener and adapts each incoming request to the Fetch `Request`
 * the handlers take (aborting its signal when the socket closes, exactly
 * as Next does), then pipes the `Response` body out chunk by chunk -- so a
 * test's `openSse` is a genuine client on a genuine connection, not a
 * function call that returns a Response object.
 *
 * The pipe is DRAIN-AWARE, exactly like Next's `pipeToNodeResponse`
 * (node_modules/next/dist/server/pipe-readable.js): when `res.write`
 * returns false it stops pulling from the stream until `drain` (or
 * `close`), and a stream error destroys the response. A client that stops
 * reading therefore stalls the pipe here as it does in production, which
 * is what lets the slow-reader tests see the server-side queue.
 *
 * It also mirrors what the M1-r2 review measured under `next start`: the
 * pipe only notices a stream error once the client reads again (it is
 * parked on `drain` until then), and the close it then causes does NOT
 * reach the handler's `req.signal`. Only a socket that closes without a
 * stream error aborts the signal. A handler that waits for `req.signal`
 * to release a dropped stream's lease is therefore visible here.
 */
export interface TestServer {
  url: string;
  close(): Promise<void>;
  /** Bytes the pipe has handed to `res.write` (what Next's `pipeToNodeResponse` would have pulled out of the stream). */
  stats: { bytesWritten: number };
}

export async function startServer(handler: (req: Request) => Promise<Response>): Promise<TestServer> {
  const sockets = new Set<import('node:net').Socket>();
  const stats = { bytesWritten: 0 };
  const server = http.createServer((nodeReq, nodeRes) => {
    const controller = new AbortController();
    let pipeFailed = false;
    nodeRes.on('close', () => {
      if (!pipeFailed) controller.abort();
    });
    const host = nodeReq.headers.host ?? 'localhost';
    const headers = new Headers();
    for (const [name, value] of Object.entries(nodeReq.headers)) {
      if (Array.isArray(value)) for (const v of value) headers.append(name, v);
      else if (value !== undefined) headers.set(name, value);
    }
    const req = new Request(`http://${host}${nodeReq.url ?? '/'}`, {
      method: nodeReq.method ?? 'GET',
      headers,
      signal: controller.signal,
    });
    void (async () => {
      let res: Response;
      try {
        res = await handler(req);
      } catch (err) {
        nodeRes.writeHead(500);
        nodeRes.end(String(err));
        return;
      }
      const outHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        outHeaders[k] = v;
      });
      nodeRes.writeHead(res.status, outHeaders);
      nodeRes.flushHeaders();
      if (!res.body) {
        nodeRes.end();
        return;
      }
      const reader = res.body.getReader();
      let drained: (() => void) | undefined;
      nodeRes.on('drain', () => drained?.());
      nodeRes.on('close', () => {
        reader.cancel().catch(() => {});
        drained?.();
      });
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          stats.bytesWritten += value.byteLength;
          if (!nodeRes.write(value) && !nodeRes.destroyed) {
            await new Promise<void>((resolve) => {
              drained = resolve;
            });
          }
        }
      } catch (err) {
        // The stream errored (a dropped slow consumer): the response is destroyed, as Next's pipe does,
        // and the close it causes is not reported to the request's signal (see the header).
        pipeFailed = true;
        if (!nodeRes.destroyed) nodeRes.destroy(err instanceof Error ? err : undefined);
        return;
      }
      nodeRes.end();
    })();
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    stats,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

export interface SseFrame {
  id?: string;
  event?: string;
  data?: string;
  comment?: string;
  /** The raw text of the frame, for "this string never appears" assertions. */
  raw: string;
}

export function parseFrames(text: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  let rest = text;
  for (;;) {
    const end = rest.indexOf('\n\n');
    if (end === -1) break;
    const raw = rest.slice(0, end);
    rest = rest.slice(end + 2);
    const frame: SseFrame = { raw };
    for (const line of raw.split('\n')) {
      if (line.startsWith(':')) frame.comment = line.slice(1).trim();
      else if (line.startsWith('id: ')) frame.id = line.slice(4);
      else if (line.startsWith('event: ')) frame.event = line.slice(7);
      else if (line.startsWith('data: ')) frame.data = line.slice(6);
    }
    frames.push(frame);
  }
  return { frames, rest };
}

export interface SseConnection {
  status: number;
  headers: Headers;
  /** Every frame received so far (including comments and id-only frames). */
  frames: SseFrame[];
  /** Everything the server has written, raw. */
  text(): string;
  /** Resolves when `pred` matches a frame, or rejects on timeout. */
  waitFor(pred: (f: SseFrame) => boolean, timeoutMs?: number): Promise<SseFrame>;
  /** Resolves when the server has closed the stream. */
  closed: Promise<void>;
  isClosed(): boolean;
  /** The client goes away. */
  abort(): void;
  /** Non-comment, non-id-only frames. */
  events(): SseFrame[];
}

export async function openSse(url: string, headers: Record<string, string> = {}): Promise<SseConnection> {
  const controller = new AbortController();
  const res = await fetch(url, { headers: { accept: 'text/event-stream', ...headers }, signal: controller.signal });
  const frames: SseFrame[] = [];
  let buffer = '';
  let all = '';
  let closedFlag = false;
  const waiters: { pred: (f: SseFrame) => boolean; resolve: (f: SseFrame) => void }[] = [];
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  if (res.status !== 200 || !res.body) {
    // An error response: nothing to stream; expose the body text via frames-less connection.
    const text = await res.text();
    all = text;
    closedFlag = true;
    resolveClosed();
  } else {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          all += chunk;
          buffer += chunk;
          const parsed = parseFrames(buffer);
          buffer = parsed.rest;
          for (const f of parsed.frames) {
            frames.push(f);
            for (let i = waiters.length - 1; i >= 0; i--) {
              if (waiters[i]!.pred(f)) {
                waiters[i]!.resolve(f);
                waiters.splice(i, 1);
              }
            }
          }
        }
      } catch {
        // aborted
      } finally {
        closedFlag = true;
        resolveClosed();
      }
    })();
  }

  return {
    status: res.status,
    headers: res.headers,
    frames,
    text: () => all,
    waitFor(pred, timeoutMs = 8000) {
      const existing = frames.find(pred);
      if (existing) return Promise.resolve(existing);
      return new Promise<SseFrame>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timed out waiting for a frame; got: ${JSON.stringify(all)}`)), timeoutMs);
        waiters.push({
          pred,
          resolve: (f) => {
            clearTimeout(t);
            resolve(f);
          },
        });
      });
    },
    closed,
    isClosed: () => closedFlag,
    abort: () => controller.abort(),
    events: () => frames.filter((f) => f.event !== undefined),
  };
}

/** Resolves once `fn` returns truthy, polling in real time. */
export async function eventually<T>(fn: () => Promise<T | false | undefined> | T | false | undefined, timeoutMs = 8000, everyMs = 25): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('eventually: timed out');
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Wraps a pool so every statement sent through it (directly, or through a
 * client it hands out) is recorded -- the "query counter" of criteria 3
 * and 7. `sqls` holds the statement text and `params` the parameters, in
 * order.
 */
export interface CountingPool {
  pool: Pool;
  log: { sql: string; params: unknown[] | undefined }[];
  reset(): void;
  count(pattern: RegExp): number;
}

export function countingPool(inner: Pool): CountingPool {
  const log: { sql: string; params: unknown[] | undefined }[] = [];
  const record = (arg: unknown, params: unknown[] | undefined): void => {
    const sql = typeof arg === 'string' ? arg : ((arg as { text?: string })?.text ?? '');
    log.push({ sql, params });
  };
  const wrapClient = (client: PoolClient): PoolClient =>
    new Proxy(client, {
      get(target, prop, receiver) {
        if (prop === 'query') {
          return (...args: unknown[]) => {
            record(args[0], args[1] as unknown[] | undefined);
            return (target.query as (...a: unknown[]) => unknown)(...args);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  const proxy = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return (...args: unknown[]) => {
          record(args[0], args[1] as unknown[] | undefined);
          return (target.query as (...a: unknown[]) => unknown)(...args);
        };
      }
      if (prop === 'connect') {
        return async (...args: unknown[]) => {
          const client = await (target.connect as (...a: unknown[]) => Promise<PoolClient>)(...args);
          return wrapClient(client);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return {
    pool: proxy,
    log,
    reset: () => {
      log.length = 0;
    },
    count: (pattern) => log.filter((l) => pattern.test(l.sql)).length,
  };
}

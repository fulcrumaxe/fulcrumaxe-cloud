import http from "node:http";
import type { AddressInfo } from "node:net";
import { CLAIM_PATH, HEARTBEAT_PATH, claimRun, doneRun, heartbeatRun, ingestEvents, toResponse, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerHttpResponse } from "@fx/runner-cloud";

/**
 * D#6 R4d-6: the runner routes of the cloud (apps/web/app/api/runner/**) on a loopback port. apps/web adapts a Next `Request` to the framework-free
 * `RunnerHttpRequest` and sends the handler's answer back; this does the same over `node:http`, so the local runner talks to the REAL claim, heartbeat, events and
 * done handlers (signature check included) over a real HTTP connection with its own signed-request client.
 *
 * The routes are the ones the daemon uses for a local-mode job. The git-ticket route (cloud-verified jobs) is not served: a job of that mode ends `git_proxy_unpinned`
 * on the runner before it asks, and a request for it here is a 404 that the test would see.
 */
export interface CloudServer {
  origin: string;
  /** Every request path received, in order. */
  paths: string[];
  /** The answer to every request, in order: its path, status and body. */
  replies: Array<{ path: string; status: number; body: unknown }>;
  close: () => Promise<void>;
}

const EVENTS = /^\/api\/runner\/runs\/([0-9a-f-]{36})\/events$/;
const DONE = /^\/api\/runner\/runs\/([0-9a-f-]{36})\/done$/;

/** `deps` is a function because the server's origin (a deps field) is not known until it listens. */
export async function startCloudServer(deps: (origin: string) => RunnerCloudDeps): Promise<CloudServer> {
  const paths: string[] = [];
  const replies: CloudServer["replies"] = [];
  const state: { deps?: RunnerCloudDeps } = {};
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const path = (req.url ?? "/").split("?")[0]!;
        paths.push(path);
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(", ") : v;
        const request: RunnerHttpRequest = { method: req.method ?? "GET", headers, body: new Uint8Array(Buffer.concat(chunks)) };
        const d = state.deps!;
        let reply: RunnerHttpResponse;
        let m: RegExpExecArray | null;
        if (request.method === "POST" && path === CLAIM_PATH) reply = await toResponse(() => claimRun(d, request));
        else if (request.method === "POST" && path === HEARTBEAT_PATH) reply = await toResponse(() => heartbeatRun(d, request));
        else if (request.method === "POST" && (m = EVENTS.exec(path))) reply = await toResponse(() => ingestEvents(d, request, m![1]!));
        else if (request.method === "POST" && (m = DONE.exec(path))) reply = await toResponse(() => doneRun(d, request, m![1]!));
        else reply = { status: 404, body: { error: { code: "not_found", message: "not found" } } };
        replies.push({ path, status: reply.status, body: reply.body });
        res.writeHead(reply.status, { "content-type": "application/json", ...(reply.headers ?? {}) });
        res.end(JSON.stringify(reply.body));
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.deps = deps(origin);
  return {
    origin,
    paths,
    replies,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

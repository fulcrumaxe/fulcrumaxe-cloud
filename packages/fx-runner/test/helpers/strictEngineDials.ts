import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ENGINE_DIALS_PATH, EngineDialsReply, jwkThumbprint, verifyRunnerRequest, type Ed25519Jwk } from "@fulcrumaxe/runner-protocol";

/**
 * A stand-in for the cloud's `GET /api/runner/engine/dials?repo_gh_id=N`, over real HTTP, built to the route's specified contract rather than to what the
 * runner happens to send: only GET on the one path with exactly the canonical query; an empty body; the runner's RFC 9421 signature checked with the protocol's
 * `verifyRunnerRequest` against the full target (path and query) for a registered key; each nonce usable once; a repo the runner does not cover is the same 404
 * as one that does not exist. Replies are built with the protocol's reply schema. What it cannot do: the database, row security and the real catalogue.
 */
export interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: Record<string, string | undefined>;
  bodyBytes: number;
  status: number;
}

export type Fault = { status: number; body?: unknown } | { raw: string; status?: number } | "drop";

export interface StrictEngineDials {
  origin: string;
  seen: Seen[];
  /** repo_gh_id the runner covers. */
  covered: Set<number>;
  /** What the cloud answers for a covered repo; the reply's `repo_gh_id` and `fetched_at` are filled in unless the test sets them. */
  reply: Partial<EngineDialsReply>;
  faults: Fault[];
  now: () => Date;
  trust(jwk: Ed25519Jwk): void;
  close(): Promise<void>;
}

export async function startStrictEngineDials(): Promise<StrictEngineDials> {
  const keys = new Map<string, Ed25519Jwk>();
  const nonces = new Set<string>();
  const fake: StrictEngineDials = {
    origin: "",
    seen: [],
    covered: new Set(),
    reply: {},
    faults: [],
    now: () => new Date(),
    trust: (jwk) => void keys.set(jwkThumbprint(jwk), jwk),
    close: () => new Promise<void>((resolve) => (server as Server).close(() => resolve())),
  };
  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      res.statusCode = 500;
      res.end("{}");
    });
  });
  const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const entry: Seen = { method: req.method, url: req.url, headers: { ...req.headers } as Record<string, string | undefined>, bodyBytes: raw.length, status: 0 };
    fake.seen.push(entry);
    const done = (status: number, body: unknown): void => {
      entry.status = status;
      send(res, status, body);
    };
    const match = /^\/api\/runner\/engine\/dials\?repo_gh_id=([1-9][0-9]{0,15})$/.exec(req.url ?? "");
    if (req.method !== "GET" || match === null || !(req.url ?? "").startsWith(ENGINE_DIALS_PATH)) return done(404, { error: "not_found" });
    if (raw.length > 0) return done(400, { error: "invalid_message" });
    try {
      const verified = await verifyRunnerRequest({ method: "GET", url: `${fake.origin}${req.url}`, headers: entry.headers, body: "" }, (keyid) => keys.get(keyid), fake.now());
      if (verified.nonce === undefined || nonces.has(verified.nonce)) return done(401, { error: "nonce_reused" });
      nonces.add(verified.nonce);
    } catch {
      return done(401, { error: "unauthorized" });
    }
    const fault = fake.faults.shift();
    if (fault === "drop") return void req.socket.destroy();
    if (fault !== undefined && "raw" in fault) return done(fault.status ?? 200, fault.raw);
    if (fault !== undefined) return done(fault.status, fault.body ?? {});
    const repoGhId = Number(match[1]);
    if (!fake.covered.has(repoGhId)) return done(404, { error: { code: "not_found" } });
    done(
      200,
      EngineDialsReply.parse({
        repo_gh_id: repoGhId,
        catalogue_version: 11,
        dispositions: { engine_spawn: "ask", engine_merge: "announce", engine_spec_ready: "ask" },
        halt_epoch: 0,
        halted: false,
        fetched_at: fake.now().toISOString(),
        ...fake.reply,
      }),
    );
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ENGINE_EVENTS_BODY_MAX_BYTES, EngineEventsAcceptedReply, EngineEventsErrorReply, jwkThumbprint, parseEngineEventsMessage, verifyRunnerRequest, type Ed25519Jwk, type EngineEvent } from "@fulcrumaxe/runner-protocol";

/**
 * A stand-in for the cloud's `POST /api/runner/engine/events`, over real HTTP, built to the contract the ingest route is specified to (not to what the
 * runner happens to send): only POST on the one path; a body over 256 KiB of raw bytes is 413 before anything is read into a message; the runner's RFC 9421
 * signature checked with the protocol's `verifyRunnerRequest` for a registered key (401), each nonce usable once (401); the strict message schema
 * (400 `invalid_message` / `seq_order`); the account switch (403 `engine_bridge_off`) and the repo switch (403 `engine_repo_not_enabled`); a batch whose first
 * `seq` is at or below the session's last is 409 `seq_not_increasing` with `last_accepted_seq` and nothing stored; a gap is accepted and recorded; the day's
 * quota (429 `engine_event_quota`, nothing past the cap stored). Every reply is built with the protocol's reply schemas, so it cannot send a shape the
 * protocol does not describe. What it cannot do: the database, RLS, the real UTC-midnight clock and the read model.
 */
export interface Session {
  lastSeq: number | null;
  stored: EngineEvent[];
  gaps: Array<{ from: number; to: number }>;
}

export interface Seen {
  headers: Record<string, string | undefined>;
  rawBytes: number;
  status: number;
  seqs: number[];
  instance: string | undefined;
}

export type Fault = { status: number; body?: unknown; headers?: Record<string, string> } | "drop" | "store_then_drop";

export interface StrictEngineIngest {
  origin: string;
  sessions: Map<string, Session>;
  seen: Seen[];
  watchEnabled: boolean;
  repoEnabled: boolean;
  /** Events one UTC day may store across all sessions; null: no cap. */
  quota: number | null;
  quotaRetryAfterS: number;
  /** Consumed one per request, in order, before the contract's own answer. */
  faults: Fault[];
  /** The cloud's clock for the signature's created time; real time unless a test moves it. */
  now: () => Date;
  trust(jwk: Ed25519Jwk): void;
  /** Every seq stored for `instance`, in order. */
  seqsOf(instance: string): number[];
  close(): Promise<void>;
}

export async function startStrictEngineIngest(path = "/api/runner/engine/events"): Promise<StrictEngineIngest> {
  const keys = new Map<string, Ed25519Jwk>();
  const nonces = new Set<string>();
  let storedToday = 0;
  const fake: StrictEngineIngest = {
    origin: "",
    sessions: new Map(),
    seen: [],
    watchEnabled: true,
    repoEnabled: true,
    quota: null,
    quotaRetryAfterS: 3600,
    faults: [],
    now: () => new Date(),
    trust: (jwk) => void keys.set(jwkThumbprint(jwk), jwk),
    seqsOf: (instance) => (fake.sessions.get(instance)?.stored ?? []).map((e) => e.seq),
    close: () => new Promise<void>((resolve) => (server as Server).close(() => resolve())),
  };
  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      res.statusCode = 500;
      res.end("{}");
    });
  });
  const reply = (res: import("node:http").ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.end(JSON.stringify(body));
  };
  async function handle(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    let raw = 0;
    let over = false;
    for await (const chunk of req) {
      raw += (chunk as Buffer).length;
      if (raw > ENGINE_EVENTS_BODY_MAX_BYTES) over = true;
      else chunks.push(chunk as Buffer);
    }
    const entry: Seen = { headers: { ...req.headers } as Record<string, string | undefined>, rawBytes: raw, status: 0, seqs: [], instance: undefined };
    fake.seen.push(entry);
    const done = (status: number, body: unknown, headers?: Record<string, string>): void => {
      entry.status = status;
      reply(res, status, body, headers);
    };
    if (req.method !== "POST" || req.url !== path) return done(404, { error: "not_found" });
    if (over) return done(413, { error: "invalid_message" });
    const text = Buffer.concat(chunks).toString("utf8");
    try {
      const url = `${fake.origin}${path}`;
      const verified = await verifyRunnerRequest({ method: "POST", url, headers: entry.headers, body: text }, (keyid) => keys.get(keyid), fake.now());
      if (verified.nonce === undefined || nonces.has(verified.nonce)) return done(401, { error: "nonce_reused" });
      nonces.add(verified.nonce);
    } catch {
      return done(401, { error: "unauthorized" });
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return done(400, EngineEventsErrorReply.parse({ error: "invalid_message" }));
    }
    const parsed = parseEngineEventsMessage(json);
    if (!parsed.ok) return done(400, EngineEventsErrorReply.parse({ error: parsed.error }));
    const message = parsed.message;
    entry.seqs = message.events.map((e) => e.seq);
    entry.instance = message.session.engine_instance_id;
    const fault = fake.faults.shift();
    if (fault === "drop") return void req.socket.destroy();
    if (fault !== undefined && fault !== "store_then_drop") return done(fault.status, fault.body ?? {}, fault.headers);
    if (!fake.watchEnabled) return done(403, EngineEventsErrorReply.parse({ error: "engine_bridge_off" }));
    if (!fake.repoEnabled) return done(403, EngineEventsErrorReply.parse({ error: "engine_repo_not_enabled" }));
    const session = fake.sessions.get(message.session.engine_instance_id) ?? { lastSeq: null, stored: [], gaps: [] };
    if (session.lastSeq !== null && message.events[0]!.seq <= session.lastSeq) return done(409, EngineEventsErrorReply.parse({ error: "seq_not_increasing", last_accepted_seq: session.lastSeq }));
    let take = message.events;
    if (fake.quota !== null) {
      if (storedToday >= fake.quota) return done(429, EngineEventsErrorReply.parse({ error: "engine_event_quota", retry_after_s: fake.quotaRetryAfterS }));
      take = message.events.slice(0, fake.quota - storedToday);
    }
    for (const event of take) {
      if (session.lastSeq !== null && event.seq > session.lastSeq + 1) session.gaps.push({ from: session.lastSeq + 1, to: event.seq - 1 });
      session.stored.push(event);
      session.lastSeq = event.seq;
    }
    storedToday += take.length;
    fake.sessions.set(message.session.engine_instance_id, session);
    if (fault === "store_then_drop") return void req.socket.destroy();
    if (take.length < message.events.length) return done(429, EngineEventsErrorReply.parse({ error: "engine_event_quota", retry_after_s: fake.quotaRetryAfterS }));
    done(200, EngineEventsAcceptedReply.parse({ accepted: take.length, duplicates: 0, last_accepted_seq: session.lastSeq }));
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  CLAIM_IDLE_RETRY_AFTER_SECONDS, ClaimMessage, ClaimReply, DoneMessage, DoneReply, DoneRetryReply, EventsMessage, EventsReply, HeartbeatMessage, HelloMessage,
  HeartbeatReply, HelloReply, SeqNotIncreasingReply, StopReply, WAKE_CAPABILITY, WakeGrant, jwkThumbprint, verifyRunnerRequest, type Ed25519Jwk, type LocalOnlyEvent,
  type SignedJob, type StopReason,
} from "@fulcrumaxe/runner-protocol";

/**
 * D#6 RUNNER-WAKE: the wake half of the fake, against the contract the wake route is built to: `GET /api/runner/wake`, an empty body, the
 * runner's usual signature (method, full URI, digest of the empty body; no nonce is spent), `Accept: application/json` (anything else 406), the
 * token as `Authorization: Bearer <token>` and only a token this cloud minted (else 401), and the reply exactly `{epoch, due_at}`. With
 * `enabled` the hello and claim replies carry a grant for a runner whose latest hello listed `wake_v1`. With `oldCloud` the hello refuses
 * `wake_v1` as a cloud built before it does (its capability list is a strict enum: 400 invalid_message, nothing recorded).
 */
export interface FakeWake {
  enabled: boolean;
  oldCloud: boolean;
  epoch: number;
  dueAt: number | null;
  pollSeconds: number;
  /** Tokens minted so far; only these are accepted. */
  tokens: string[];
  /** Answer this many wake checks with 503 before answering normally. */
  failNext: number;
}

/**
 * A stand-in for the cloud's hello, claim, heartbeat, events and done routes (runner-cloud's claim, heartbeat and ingestEvents; `done`
 * is not built yet, so its half follows the reply set in runner-protocol/src/replies.ts alone), reached over real HTTP. It
 * refuses what the protocol does not allow, as the real routes do: only POST on the four paths (a run id in the path must be a
 * uuid and equal the body's); the 256 KiB body cap; the RFC 9421 signature, checked with the protocol's `verifyRunnerRequest`
 * for a registered key; the body parsed with the protocol's STRICT message schema (an unlisted key is 400); a nonce spent once on
 * claim, events and done (409 `nonce_reused`); events that do not strictly increase (400 `seq_order`); the fence on heartbeat,
 * events and done (409 stop); an events batch at or below the last accepted `seq` (409 `seq_not_increasing`, nothing stored); a
 * repeat `done` replays its outcome. Every reply body is built with the protocol's reply schema, so the fake cannot send a shape
 * the protocol does not describe. What it cannot do: the database, the 90-second lease clock, and the real `done` route's GitHub checks.
 */
export interface Seen {
  path: string;
  body: unknown;
  nonce: string | undefined;
}

/** A reply the test forces for the next request on a route, built through the reply schemas so it is still a protocol reply. */
export type Forced = { status: number; body: unknown; headers?: Record<string, string> };

interface RunState {
  generation: number;
  over: boolean;
  lastSeq: number;
  stop: StopReason | undefined;
  doneReply: DoneReply | undefined;
  events: LocalOnlyEvent[];
  /** The first event that ended the run, once one has. */
  endedBy: LocalOnlyEvent | undefined;
}

export interface StrictRunnerCloud {
  origin: string;
  seen: Seen[];
  /** Registers the runner key whose signatures are accepted. */
  trust(jwk: Ed25519Jwk): void;
  /** Queues a job for the next claim. */
  enqueue(signed: SignedJob): void;
  /** Forced replies per route name, consumed in order, before any real handling. */
  force: Record<"hello" | "claim" | "heartbeat" | "events" | "done", Forced[]>;
  runs: Map<string, RunState>;
  /** From now on this run's heartbeat, events and done answer the stop. */
  stopRun(runId: string, reason: StopReason): void;
  /** Where the next `done` for a run answers 503 `{retry_after}` and writes nothing: this many times. */
  githubDown: number;
  wake: FakeWake;
  close(): Promise<void>;
}

export const stopBody = (reason: StopReason): Forced => ({ status: 409, body: StopReply.parse({ continue: false, reason }) });
export const retryBody = (seconds: number): Forced => ({ status: 503, body: DoneRetryReply.parse({ retry_after: seconds }) });

const MAX_BODY = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function startStrictRunnerCloud(): Promise<StrictRunnerCloud> {
  const keys = new Set<string>();
  const jwks = new Map<string, Ed25519Jwk>();
  const nonces = new Set<string>();
  const queue: SignedJob[] = [];
  const state: StrictRunnerCloud = {
    origin: "",
    seen: [],
    trust(jwk) {
      keys.add(jwkThumbprint(jwk));
      jwks.set(jwkThumbprint(jwk), jwk);
    },
    enqueue: (signed) => void queue.push(signed),
    force: { hello: [], claim: [], heartbeat: [], events: [], done: [] },
    runs: new Map(),
    stopRun(runId, reason) {
      const run = state.runs.get(runId);
      if (run) run.stop = reason;
    },
    githubDown: 0,
    wake: { enabled: false, oldCloud: false, epoch: 0, dueAt: null, pollSeconds: 20, tokens: [], failNext: 0 },
    close: async () => undefined,
  };
  /** Whether the runner's latest accepted hello listed `wake_v1` (the real cloud keeps this in runner_capabilities). */
  let helloAskedWake = false;
  const grant = (): { wake?: WakeGrant } => {
    if (!state.wake.enabled || !helloAskedWake) return {};
    const token = `${randomBytes(24).toString("base64url")}.${randomBytes(32).toString("base64url")}`;
    state.wake.tokens.push(token);
    return { wake: WakeGrant.parse({ token, poll_s: state.wake.pollSeconds, transport: "poll" }) };
  };

  const server: Server = createServer((req, res) => {
    const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
      res.end(JSON.stringify(body));
    };
    const refuse = (status: number, code: string): void => send(status, { error: { code, message: code } });
    void (async () => {
      const path = req.url ?? "";
      if (path === "/api/runner/wake") {
        if (req.method !== "GET") return refuse(405, "method_not_allowed");
        const raw = await readBody(req);
        if (!raw || raw.length > 0) return refuse(400, "invalid_message");
        const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v]));
        let verified;
        try {
          verified = await verifyRunnerRequest({ method: "GET", url: `${state.origin}${path}`, headers: headers as Record<string, string | undefined>, body: "" }, (keyid) => jwks.get(keyid));
        } catch {
          return refuse(401, "unauthorized");
        }
        if (!keys.has(verified.keyid)) return refuse(401, "unauthorized");
        if (headers.accept !== "application/json") return refuse(406, "not_acceptable");
        const bearer = /^Bearer (\S+)$/.exec(headers.authorization ?? "")?.[1];
        if (bearer === undefined || !state.wake.tokens.includes(bearer)) return refuse(401, "unauthorized");
        state.seen.push({ path, body: undefined, nonce: verified.nonce });
        if (state.wake.failNext > 0) {
          state.wake.failNext -= 1;
          return refuse(503, "unavailable");
        }
        return send(200, { epoch: state.wake.epoch, due_at: state.wake.dueAt });
      }
      const match = /^\/api\/runner\/(?:(hello|claim|heartbeat)|runs\/([^/]+)\/(events|done))$/.exec(path);
      if (req.method !== "POST" || !match) return refuse(404, "not_found");
      const route = (match[1] ?? match[3]) as "hello" | "claim" | "heartbeat" | "events" | "done";
      const pathRunId = match[2];
      if (pathRunId !== undefined && !UUID.test(pathRunId)) return refuse(404, "not_found");
      const raw = await readBody(req);
      if (!raw) return refuse(413, "body_too_large");
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v]));
      let verified;
      try {
        verified = await verifyRunnerRequest({ method: "POST", url: `${state.origin}${path}`, headers: headers as Record<string, string | undefined>, body: raw.toString("utf8") }, (keyid) => jwks.get(keyid));
      } catch {
        return refuse(401, "unauthorized");
      }
      if (!keys.has(verified.keyid)) return refuse(401, "unauthorized");
      if (route !== "heartbeat" && route !== "hello") {
        if (!verified.nonce || nonces.has(verified.nonce)) return refuse(409, "nonce_reused");
        nonces.add(verified.nonce);
      }
      let json: unknown;
      try {
        json = JSON.parse(raw.toString("utf8"));
      } catch {
        // fx-swallow-ok: a body that is not JSON fails the schema parse below as invalid_message
        json = undefined;
      }
      state.seen.push({ path, body: json, nonce: verified.nonce });
      const forced = state.force[route].shift();
      if (forced) return send(forced.status, forced.body, forced.headers);

      const schemas = { hello: HelloMessage, claim: ClaimMessage, heartbeat: HeartbeatMessage, events: EventsMessage, done: DoneMessage } as const;
      const message = schemas[route].safeParse(json);
      if (!message.success) return refuse(400, "invalid_message");
      if (route === "hello") {
        const asked = ((message.data as { capabilities?: string[] }).capabilities ?? []).includes(WAKE_CAPABILITY);
        if (asked && state.wake.oldCloud) return refuse(400, "invalid_message");
        helloAskedWake = asked;
        return send(200, HelloReply.parse({ protocol_version: 1, ...grant() }));
      }
      if (route === "claim") {
        // As the real route: a poll that names `sandbox_unavailable` takes no job, whatever is queued, and answers retry_after only.
        if ((message.data as { sandbox_unavailable?: string }).sandbox_unavailable !== undefined) {
          return send(200, ClaimReply.parse({ retry_after: CLAIM_IDLE_RETRY_AFTER_SECONDS, ...grant() }), { "retry-after": String(CLAIM_IDLE_RETRY_AFTER_SECONDS) });
        }
        const next = queue.shift();
        if (!next) return send(200, ClaimReply.parse({ retry_after: CLAIM_IDLE_RETRY_AFTER_SECONDS, ...grant() }), { "retry-after": String(CLAIM_IDLE_RETRY_AFTER_SECONDS) });
        const run = state.runs.get(next.job.run_id) ?? { generation: 0, over: false, lastSeq: -1, stop: undefined, doneReply: undefined, events: [], endedBy: undefined };
        run.generation += 1;
        state.runs.set(next.job.run_id, run);
        return send(200, ClaimReply.parse({ signed_job: next, run_id: next.job.run_id, lease_generation: run.generation, ...grant() }));
      }

      const body = message.data as { run_id: string; lease_generation: number; events?: LocalOnlyEvent[] };
      if (pathRunId !== undefined && pathRunId.toLowerCase() !== body.run_id.toLowerCase()) return refuse(400, "invalid_message");
      const run = state.runs.get(body.run_id);
      const fence = (): StopReason | undefined => (!run || run.generation !== body.lease_generation ? "stale_generation" : run.stop ?? (run.over && route !== "done" ? "run_terminal" : undefined));
      if (route === "done" && run?.doneReply && run.generation === body.lease_generation) return send(200, run.doneReply);
      const stop = fence();
      if (stop) return send(409, StopReply.parse({ continue: false, reason: stop }));
      const lease_expires_at = new Date(Date.now() + 90_000).toISOString();
      if (route === "heartbeat") return send(200, HeartbeatReply.parse({ continue: true, lease_expires_at }));
      if (route === "events") {
        const events = body.events!;
        if (events.some((event, i) => i > 0 && event.seq <= events[i - 1]!.seq)) return refuse(400, "seq_order");
        if (events[0]!.seq <= run!.lastSeq) return send(409, SeqNotIncreasingReply.parse({ continue: true, error: "seq_not_increasing", last_accepted_seq: run!.lastSeq }));
        run!.lastSeq = events[events.length - 1]!.seq;
        run!.events.push(...events);
        // The events that end a run on the real route (usage_limit_reached, credential_mismatch, and run_ended of D#6 R4a-2): the first one
        // stored ends it, and what follows it on any route is answered run_terminal. `endedBy` keeps which one it was, for a test to read.
        const ending = events.find((event) => event.type === "usage_limit_reached" || event.type === "credential_mismatch" || event.type === "run_ended");
        if (ending) {
          run!.over = true;
          run!.endedBy = ending;
        }
        return send(200, EventsReply.parse({ continue: true, accepted: events.length, duplicates: 0, lease_expires_at }));
      }
      if (state.githubDown > 0) {
        state.githubDown -= 1;
        return send(503, DoneRetryReply.parse({ retry_after: 15 }));
      }
      run!.over = true;
      run!.doneReply = DoneReply.parse({ continue: false, outcome: "succeeded", failure_reason: null, pr_number: 7 });
      return send(200, run!.doneReply);
    })().catch(() => refuse(500, "internal"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}

import type { PoolClient } from "pg";
import { engineSeqOrderViolation, parseEngineEventsMessage } from "@fulcrumaxe/runner-protocol";
import { MAX_BODY_BYTES, RunnerHttpError, asRunner, parseJsonBody, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerHttpResponse } from "./http.js";
import { verifyRunnerRequest, withRunnerSession } from "./verifyRunnerRequest.js";

export const ENGINE_EVENTS_PATH = "/api/runner/engine/events";

/** One agent's or tick's token totals, as the ingest answers them, to be priced by the cloud's own code. */
export interface EngineUsageSubject {
  subject_kind: "agent" | "tick";
  subject_id: string;
  model: string | null;
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  cache_write_tokens: string;
}

/**
 * The pricing side of an engine batch (apps/web supplies the worker's `recordEngineUsage`, which calls `priceUsageTotals`: this package never prices anything). It runs on
 * the caller's tenant client, in the batch's transaction. Absent, the tokens are kept and no figure is recorded.
 */
export interface EngineUsagePort {
  record(client: PoolClient, input: { accountId: string; sessionId: string; subjects: readonly EngineUsageSubject[] }): Promise<void>;
}

interface Batch {
  repoGhId: number;
  instanceId: string;
  version: string;
  events: Array<{ seq: number; ts: string; kind: string; body: Record<string, unknown> }>;
}

/**
 * The batch, parsed by the runner-protocol schema (EB-1) and nothing else: the strict envelope, every event's own strict kind, the free-text and money key scan, the
 * instance id on every line equal to the session's, the order of the seq numbers and the 64 KiB plan chunk and 256 KiB request caps. A failure answers one fixed 400 and
 * echoes nothing of the message. The database's `engine_body_closed` (migration 1027) is only a backstop behind this and is never stricter than it.
 */
export function parseEngineBatch(value: unknown): Batch {
  const parsed = parseEngineEventsMessage(value);
  if (!parsed.ok) {
    if (parsed.error === "seq_order") throw new RunnerHttpError(400, "seq_order", "the events in a batch must have strictly increasing seq");
    throw new RunnerHttpError(400, "invalid_message", "the message does not match the protocol");
  }
  const { session, events } = parsed.message;
  return {
    repoGhId: session.repo_gh_id,
    instanceId: session.engine_instance_id.toLowerCase(),
    version: session.engine_version,
    events: events.map((event) => {
      const { v: _v, engine_instance_id: _instance, seq, ts, kind, ...body } = event;
      return { seq, ts, kind, body };
    }),
  };
}

/** True when the seq numbers strictly increase (EB-1's own check). */
export const engineSeqInOrder = (events: ReadonlyArray<{ seq: number }>): boolean => engineSeqOrderViolation(events) === null;

interface IngestRow {
  o_outcome: string;
  o_accepted: number;
  o_duplicates: number;
  o_last_seq: string | null;
  o_retry_after_s: number | null;
  o_session_id: string | null;
  o_usage: EngineUsageSubject[];
}

const REFUSALS: Readonly<Record<string, number>> = { engine_bridge_off: 403, engine_repo_not_enabled: 403, engine_instance_other_runner: 409 };

/**
 * POST /api/runner/engine/events. Signed by a registered runner (once-only nonce); the account and runner come from the verified key. The definer
 * `engine_events_ingest` does the rest in one transaction, in this order: a runner of an account that is not active is refused (401), the account's watch switch
 * (403 `engine_bridge_off`), the repo (403 `engine_repo_not_enabled`: not ticked, not `runner_local`, or not one of the runner's repos), the engine instance's
 * runner (409 `engine_instance_other_runner`), then the closed body of every event (400), the order of the seq numbers (400 `seq_order`; a first number at or below the
 * last stored one is 409 `seq_not_increasing` with `last_accepted_seq`) and the day's quotas (429 `engine_event_quota`: 5000 events a session and 20000 a repo per UTC
 * day). A refusal stores nothing. A hole in the numbers is accepted and recorded. Tokens an event reports are priced by the cloud afterwards, in the same transaction.
 * The `engine.changed` notice (ids only) is written by the definer itself, once per batch that stored something, in that same transaction.
 */
export async function ingestEngineEvents(deps: RunnerCloudDeps, req: RunnerHttpRequest): Promise<RunnerHttpResponse> {
  if (req.body.byteLength > MAX_BODY_BYTES) throw new RunnerHttpError(413, "body_too_large", "the request body is too large");
  const runner = await verifyRunnerRequest(deps, ENGINE_EVENTS_PATH, req, { replay: "once" });
  const batch = parseEngineBatch(parseJsonBody(req));

  const row = await asRunner(() =>
    withRunnerSession(deps.appUserPool, runner, async (client) => {
      const { rows } = await client.query<IngestRow>(
        "SELECT * FROM engine_events_ingest($1::uuid, $2::uuid, $3::bigint, $4::uuid, $5::text, $6::jsonb)",
        [runner.accountId, runner.runnerId, batch.repoGhId, batch.instanceId, batch.version, JSON.stringify(batch.events)],
      );
      const r = rows[0]!;
      if (r.o_session_id !== null && r.o_usage.length > 0) {
        await deps.engineUsage?.record(client, { accountId: runner.accountId, sessionId: r.o_session_id, subjects: r.o_usage });
      }
      return r;
    }),
  );

  const refusal = REFUSALS[row.o_outcome];
  if (refusal !== undefined) return { status: refusal, body: { error: row.o_outcome } };
  if (row.o_outcome === "invalid_message") throw new RunnerHttpError(400, "invalid_message", "the message does not match the protocol");
  if (row.o_outcome === "seq_order") throw new RunnerHttpError(400, "seq_order", "the events in a batch must have strictly increasing seq");
  if (row.o_outcome === "seq_not_increasing") return { status: 409, body: { error: "seq_not_increasing", last_accepted_seq: Number(row.o_last_seq) } };
  if (row.o_outcome === "quota") return { status: 429, body: { error: "engine_event_quota", retry_after_s: row.o_retry_after_s ?? 60 }, headers: { "retry-after": String(row.o_retry_after_s ?? 60) } };
  return { status: 200, body: { accepted: row.o_accepted, duplicates: row.o_duplicates, last_accepted_seq: row.o_last_seq === null ? null : Number(row.o_last_seq) } };
}

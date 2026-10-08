import { EventsMessage, EventsReply, SeqNotIncreasingReply } from "@fulcrumaxe/runner-protocol";
import { RunnerHttpError, asRunner, parseJsonBody, parseMessage, requireLeases, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerHttpResponse } from "./http.js";
import { stopReply } from "./heartbeat.js";
import { verifyRunnerRequest } from "./verifyRunnerRequest.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const eventsPath = (runId: string): string => `/api/runner/runs/${runId}/events`;

/**
 * POST /api/runner/runs/:id/events (D#6 R2b-3, body criterion 7, C21 section 2). The path names the run and the body must name
 * the same one. At most 100 events and 256 KiB a batch (the schema and the body cap), each event only the closed `LocalOnlyEvent`
 * fields: an event with a `text`, `output`, `content` or `message` key is 400 and nothing about it is logged. The numbers in a
 * batch must strictly increase, or the answer is 400 `seq_order`. The worker fences the batch like a heartbeat and compares its
 * first number with the last accepted one: at or below it is 409 `{continue:true, error:"seq_not_increasing", last_accepted_seq}`
 * and nothing is stored (the runner trims and resends). Otherwise each event is stored once after server-side redaction and the
 * answer is 200 `{continue:true, accepted, duplicates, lease_expires_at}`. A usage limit or a credential mismatch ends the run
 * and a usage limit makes the follow-up run, in the worker.
 */
export async function ingestEvents(deps: RunnerCloudDeps, req: RunnerHttpRequest, runId: string): Promise<RunnerHttpResponse> {
  if (!UUID.test(runId)) throw new RunnerHttpError(404, "not_found", "no such run");
  const runner = await verifyRunnerRequest(deps, eventsPath(runId), req, { replay: "once" });
  const message = parseMessage(EventsMessage, parseJsonBody(req));
  if (message.run_id.toLowerCase() !== runId.toLowerCase()) throw new RunnerHttpError(400, "invalid_message", "the message does not match the protocol");
  const leases = requireLeases(deps);
  const result = await asRunner(() =>
    leases.ingestRunnerEvents({ accountId: runner.accountId, runnerId: runner.runnerId, runId: message.run_id, leaseGeneration: message.lease_generation, events: message.events }),
  );
  if (result.outcome === "fenced") return stopReply(result.reason);
  if (result.outcome === "seq_order") throw new RunnerHttpError(400, "seq_order", "the events in a batch must have strictly increasing seq");
  if (result.outcome === "seq_not_increasing") {
    return { status: 409, body: SeqNotIncreasingReply.parse({ continue: true, error: "seq_not_increasing", last_accepted_seq: result.lastAcceptedSeq }) };
  }
  return { status: 200, body: EventsReply.parse({ continue: true, accepted: result.stored, duplicates: result.duplicates, lease_expires_at: result.leaseExpiresAt.toISOString() }) };
}

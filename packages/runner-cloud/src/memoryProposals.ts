import { createHash } from "node:crypto";
import { MEMORY_PROPOSALS_PATH, MemoryProposalsMessage, MemoryProposalsReply } from "@fulcrumaxe/runner-protocol";
import { RunnerHttpError, asRunner, parseJsonBody, parseMessage, requireLeases, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerHttpResponse } from "./http.js";
import { verifyRunnerRequest } from "./verifyRunnerRequest.js";

/**
 * D#601 MEM-6: POST /api/runner/memory-proposals. The memory proposals a person said yes to, on their own terminal, after a run of this runner ended.
 *
 * Verified like every signed runner route: the RFC 9421 signature with a single-use nonce, then the strict message. The run is named by the message, but it is
 * only believed when OUR row says it belongs to this runner and account (`run_not_yours`, 403) and has ended (`run_not_finished`, 409). The runner's own latest hello
 * must have listed `mem_proposal_v1` (`capability_missing`, 403). Nothing the runner sends names an account, a repository, a work item or a role: the scope's key is
 * resolved from our rows, exactly as for a hosted run, and the worker runs the same intake (secret scan, size cap, duplicate and pending-cap checks) with the author kind
 * `runner_agent`. The reply is counts only.
 *
 * The body hash is checked here, before the worker is asked: a proposal whose `body_sha256` is not the sha256 of its body is a 400, so a body that changed after the
 * person saw its hash never reaches the intake. This route does not extend a lease (the run is over) and writes only through the worker.
 */
const NO_STORE = { "cache-control": "no-store" } as const;

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export async function memoryProposalsRun(deps: RunnerCloudDeps, req: RunnerHttpRequest): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, MEMORY_PROPOSALS_PATH, req, { replay: "once" });
  const message = parseMessage(MemoryProposalsMessage, parseJsonBody(req));
  for (const proposal of message.proposals) {
    if (sha256Hex(proposal.body) !== proposal.body_sha256) throw new RunnerHttpError(400, "invalid_message", "the message does not match the protocol");
  }
  const leases = requireLeases(deps);
  if (!leases.memoryProposals) throw new RunnerHttpError(503, "not_configured", "the runner API has no worker configured");
  const found = await asRunner(() =>
    leases.memoryProposals!({ accountId: runner.accountId, runnerId: runner.runnerId, runId: message.run_id.toLowerCase(), proposals: message.proposals.map(({ scope, kind, body }) => ({ scope, kind, body })) }),
  );
  switch (found.kind) {
    case "run_not_yours":
      throw new RunnerHttpError(403, "run_not_yours", "this run does not belong to this runner");
    case "capability_missing":
      throw new RunnerHttpError(403, "capability_missing", "this runner did not say it sends memory proposals");
    case "run_not_finished":
      throw new RunnerHttpError(409, "run_not_finished", "this run has not ended");
    default:
      return { status: 200, body: MemoryProposalsReply.parse({ status: found.kind, stored: found.stored, refused: found.refused }), headers: NO_STORE };
  }
}

import { HelloMessage } from "@fulcrumaxe/runner-protocol";
import { CURRENT_PROTOCOL_VERSION, RunnerHttpError, parseJsonBody, parseMessage, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerHttpResponse } from "./http.js";
import { verifyRunnerRequest } from "./verifyRunnerRequest.js";

export const HELLO_PATH = "/api/runner/hello";

/**
 * True when a runner speaking `version` may talk to a cloud at `current`: the current version and the one before it.
 * `current` is a parameter (default: the constant) so the boundary can be tested; with the real value 1 nothing in
 * range could be refused.
 */
export const protocolVersionSupported = (version: number, current: number = CURRENT_PROTOCOL_VERSION): boolean => version >= current - 1;

/**
 * POST /api/runner/hello. Records the protocol and binary versions (and the display-only isolation tier) for
 * compatibility and the runner list; none of it is a security fact. A version below `current - 1` is 426
 * `upgrade_required`, and the response names no download location.
 */
export async function runnerHello(deps: RunnerCloudDeps, req: RunnerHttpRequest): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, HELLO_PATH, req, { replay: "none" });
  const message = parseMessage(HelloMessage, parseJsonBody(req));
  const current = deps.currentProtocolVersion ?? CURRENT_PROTOCOL_VERSION;
  if (!protocolVersionSupported(message.protocol_version, current)) {
    throw new RunnerHttpError(426, "upgrade_required", "this runner is too old to talk to the cloud", { current_protocol_version: current, minimum_protocol_version: current - 1 });
  }
  const updated = await deps.platformOpsPool.query(
    `UPDATE runners SET protocol_version = $3, binary_version = $4, isolation = $5, last_seen_at = now()
      WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL`,
    [runner.runnerId, runner.accountId, message.protocol_version, message.binary_version, message.isolation],
  );
  if (updated.rowCount === 0) throw new RunnerHttpError(401, "unauthorized", "the request is not signed by a registered runner");
  return { status: 200, body: { protocol_version: current } };
}

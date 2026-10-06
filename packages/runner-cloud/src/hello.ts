import { HelloMessage } from "@fulcrumaxe/runner-protocol";
import { CURRENT_PROTOCOL_VERSION, RunnerHttpError, parseJsonBody, parseMessage, pgCode, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerHttpResponse } from "./http.js";
import { verifyRunnerRequest, withRunnerSession } from "./verifyRunnerRequest.js";

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
  let recorded: boolean;
  try {
    recorded = await withRunnerSession(deps.appUserPool, runner, async (client) => {
      const { rows } = await client.query<{ ok: boolean }>("SELECT runner_hello_record($1, $2, $3) AS ok", [message.protocol_version, message.binary_version, message.isolation]);
      return rows[0]?.ok === true;
    });
  } catch (error) {
    // Revoked, or its account suspended, between the verification and here: the same answer as any later request.
    if (pgCode(error) === "42501") recorded = false;
    else throw error;
  }
  if (!recorded) throw new RunnerHttpError(401, "unauthorized", "the request is not signed by a registered runner");
  return { status: 200, body: { protocol_version: current } };
}

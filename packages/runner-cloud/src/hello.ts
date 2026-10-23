import { HelloMessage, HelloReply } from "@fulcrumaxe/runner-protocol";
import { configuredWakeKey, wakeGrantFor } from "./wakeToken.js";
import { CURRENT_PROTOCOL_VERSION, MIN_SUPPORTED_PROTOCOL_VERSION, RunnerHttpError, parseJsonBody, parseMessage, pgCode, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerHttpResponse } from "./http.js";
import { verifyRunnerRequest, withRunnerSession } from "./verifyRunnerRequest.js";

export const HELLO_PATH = "/api/runner/hello";

/**
 * True when a runner speaking `version` may talk to a cloud at `current`: any version from `min` (the fixed floor) up to `current`. A bump of
 * `current` therefore never cuts an older runner off; it only switches a capability on for the runners that declare the new version. A version
 * above `current` is refused too: this cloud has not been deployed with what that runner speaks. Both bounds are parameters (default: the
 * constants) so the edges can be tested.
 */
export const protocolVersionSupported = (version: number, current: number = CURRENT_PROTOCOL_VERSION, min: number = MIN_SUPPORTED_PROTOCOL_VERSION): boolean => version >= min && version <= current;

/**
 * POST /api/runner/hello. Records the protocol and binary versions (and the display-only isolation tier) for
 * compatibility and the runner list; none of it is a security fact. A version below the floor is 426 `upgrade_required`, one above the
 * current version is 426 `protocol_too_new`; neither response names a download location.
 */
export async function runnerHello(deps: RunnerCloudDeps, req: RunnerHttpRequest): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, HELLO_PATH, req, { replay: "none" });
  const message = parseMessage(HelloMessage, parseJsonBody(req));
  const current = deps.currentProtocolVersion ?? CURRENT_PROTOCOL_VERSION;
  const min = deps.minSupportedProtocolVersion ?? MIN_SUPPORTED_PROTOCOL_VERSION;
  if (!protocolVersionSupported(message.protocol_version, current, min)) {
    const tooNew = message.protocol_version > current;
    throw new RunnerHttpError(426, tooNew ? "protocol_too_new" : "upgrade_required", tooNew ? "this runner speaks a newer protocol than this cloud" : "this runner is too old to talk to the cloud", { current_protocol_version: current, minimum_protocol_version: min });
  }
  let recorded: boolean;
  try {
    recorded = await withRunnerSession(deps.appUserPool, runner, async (client) => {
      const { rows } = await client.query<{ ok: boolean }>("SELECT runner_hello_record($1, $2, $3) AS ok", [message.protocol_version, message.binary_version, message.isolation]);
      if (rows[0]?.ok !== true) return false;
      // D#605 FL-2: the machine's facts, when this runner sent them, through the definer that names the runner from the session. Same transaction as
      // the hello: a refusal rolls both back. No authorization path (request verification, the ticket, the job signer) reads them back.
      const facts = message.facts;
      if (facts !== undefined) await client.query("SELECT runner_facts_record($1, $2, $3::int, $4::int, $5)", [facts.os, facts.arch, facts.mem_gb_bucket, facts.cpus, facts.sandbox_engine]);
      // D#483 S4-b2c: the capabilities, rewritten on EVERY hello (none sent is none stored), so a runner that is downgraded stops being offered
      // what it can no longer run. Same definer shape and the same transaction.
      await client.query("SELECT runner_capabilities_record($1::text[])", [message.capabilities ?? []]);
      return true;
    });
  } catch (error) {
    // Revoked, or its account suspended, between the verification and here: the same answer as any later request.
    if (pgCode(error) === "42501") recorded = false;
    else throw error;
  }
  if (!recorded) throw new RunnerHttpError(401, "unauthorized", "the request is not signed by a registered runner");
  // D#6 RUNNER-WAKE R3a: a wake grant only for a runner that listed `wake_v1` on THIS hello, and only while a key is configured. Minted after the
  // hello committed, so a refused hello gets none.
  const wake = wakeGrantFor(configuredWakeKey(deps.wakeKey), runner, message.capabilities, deps.now?.() ?? new Date());
  return { status: 200, body: HelloReply.parse({ protocol_version: current, ...(wake ? { wake } : {}) }) };
}

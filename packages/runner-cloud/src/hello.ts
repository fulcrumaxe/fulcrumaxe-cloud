import { HelloMessage, HelloReply, WATCH_MIN_PROTOCOL, WATCH_MODE_CAPABILITY, WATCH_MODE_HELLO_CAPABILITY } from "@fulcrumaxe/runner-protocol";
import { allowRunnerWake } from "@fx/core/src/pendingWork.js";
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
      if (facts !== undefined) {
        await client.query("SELECT runner_facts_record($1, $2, $3::int, $4::int, $5)", [facts.os, facts.arch, facts.mem_gb_bucket, facts.cpus, facts.sandbox_engine]);
        // D#587 B-7a: the host limits and bootable templates, rewritten on every hello with facts (none sent is none stored). Routing and display only.
        await client.query("SELECT runner_sandbox_facts_record($1::int, $2::int, $3::int, $4::text[])", [facts.max_vms ?? null, facts.max_vcpus ?? null, facts.max_memory_mb ?? null, facts.bootable_templates ?? []]);
      }
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
  // D#6 RUNNER-WAKE R3b: the allow record the wake check requires (fail closed without it). Never throws.
  if (wake) await allowRunnerWake(runner, (deps.now?.() ?? new Date()).getTime());
  // D#845 watch mode: said only to a runner that DECLARED `watch_mode_v1` on this hello (a runner built before it parses the reply strictly and would lose its wake grant to an unknown key), at the
  // watch protocol or above, and only when this database can take what watch mode sends.
  const watchMode = message.protocol_version >= WATCH_MIN_PROTOCOL && (message.capabilities ?? []).includes(WATCH_MODE_HELLO_CAPABILITY) && (await ingestTakesWatchMode(deps));
  return { status: 200, body: HelloReply.parse({ protocol_version: current, ...(wake ? { wake } : {}), ...(watchMode ? { capabilities: [WATCH_MODE_CAPABILITY] } : {}) }) };
}

/**
 * True when migration 1043 is applied: the slim status is a known event kind and engine sessions can hold flagged holes. Read from the catalog (the held column is 1043's own), never assumed from
 * the code's version, so a cloud deployed before its migration does not tell a runner it can take what it would refuse.
 */
export async function ingestTakesWatchMode(deps: RunnerCloudDeps): Promise<boolean> {
  try {
    const { rows } = await deps.appUserPool.query<{ ok: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.engine_session_gaps') AND attname = 'held' AND NOT attisdropped) AS ok");
    return rows[0]?.ok === true;
  } catch {
    // fx-swallow-ok: a catalog read that fails says nothing about the ingest: the capability is simply not listed
    return false;
  }
}

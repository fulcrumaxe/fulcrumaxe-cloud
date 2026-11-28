import { ENGINE_LEASE_CAPABILITY, ENGINE_LEASE_HELLO_CAPABILITY, MACHINE_ONBOARDING_MIN_PROTOCOL, HEARTBEAT_INVENTORY_CAPABILITY, HEARTBEAT_INVENTORY_HELLO_CAPABILITY, SANDBOX_INVENTORY_MIN_PROTOCOL, HelloMessage, HelloReply, KVM_FACT_CAPABILITY, KVM_FACT_HELLO_CAPABILITY, PLATFORM_FACT_CAPABILITY, PLATFORM_FACT_HELLO_CAPABILITY, PREFLIGHT_CAPABILITY, PREFLIGHT_HELLO_CAPABILITY, WATCH_MIN_PROTOCOL, WATCH_MODE_CAPABILITY, WATCH_MODE_HELLO_CAPABILITY } from "@fulcrumaxe/runner-protocol";
import { allowRunnerWake } from "@fx/core/src/pendingWork.js";
import { runnersTakeEngineLease } from "./engineLease.js";
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
  // D#845 ON-21b: whether migration 1051's column and definer exist, read from the catalog before the transaction (a failed read says no). Decides both the write below and the reply's capability.
  const takesPreflight = await runnersTakePreflight(deps);
  // D#587 B-7c: whether migration 1122's column and definer exist, read from the catalog before the transaction (a failed read says no). Decides both the write below and the reply's capability.
  const takesPlatform = await runnersTakePlatform(deps);
  let recorded: boolean;
  try {
    recorded = await withRunnerSession(deps.appUserPool, runner, async (client) => {
      const { rows } = await client.query<{ ok: boolean }>("SELECT runner_hello_record($1, $2, $3, $4::boolean, $5::text) AS ok", [message.protocol_version, message.binary_version, message.isolation, message.model_auth_present, message.facts?.kvm ?? null]);
      if (rows[0]?.ok !== true) return false;
      // D#605 FL-2: the machine's facts, when this runner sent them, through the definer that names the runner from the session. Same transaction as
      // the hello: a refusal rolls both back. No authorization path (request verification, the ticket, the job signer) reads them back.
      const facts = message.facts;
      if (facts !== undefined) {
        await client.query("SELECT runner_facts_record($1, $2, $3::int, $4::int, $5)", [facts.os, facts.arch, facts.mem_gb_bucket, facts.cpus, facts.sandbox_engine]);
        // D#587 B-7c: the platform, rewritten on EVERY hello with facts when this database has the column (none sent is NULL, "not said"), so a downgraded runner stops being shown as WSL2. The definer ignores a platform that disagrees with the os.
        if (takesPlatform) await client.query("SELECT runner_facts_platform_record($1::text)", [facts.platform ?? null]);
        // D#587 B-7a: the host limits and bootable templates, rewritten on every hello with facts (none sent is none stored). Routing and display only.
        await client.query("SELECT runner_sandbox_facts_record($1::int, $2::int, $3::int, $4::text[])", [facts.max_vms ?? null, facts.max_vcpus ?? null, facts.max_memory_mb ?? null, facts.bootable_templates ?? []]);
      }
      // D#483 S4-b2c: the capabilities, rewritten on EVERY hello (none sent is none stored), so a runner that is downgraded stops being offered
      // what it can no longer run. Same definer shape and the same transaction.
      // D#587 B-7c: `platform_fact_v1` is stored only by a database that has migration 1122 (its capability list takes it), so a cloud deployed ahead of the migration still records the hello.
      await client.query("SELECT runner_capabilities_record($1::text[])", [(message.capabilities ?? []).filter((c) => takesPlatform || c !== PLATFORM_FACT_HELLO_CAPABILITY)]);
      // D#845 ON-21b: the preflight codes, rewritten on EVERY hello of a database that has them (none sent is NULL, "not said"), so a downgraded runner stops being credited. Same transaction, same session-named runner.
      if (takesPreflight) await client.query("SELECT runner_preflight_record($1::text[])", [message.facts?.preflight ?? null]);
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
  // D#845 ON-6c: said only to a runner that DECLARED `kvm_fact_v1` on this hello, and only when migration 1047's column exists (read from the catalog, the way 1043 is). The runner sends `facts.kvm` from its next hello on.
  const kvmFact = (message.capabilities ?? []).includes(KVM_FACT_HELLO_CAPABILITY) && (await runnersTakeKvm(deps));
  // D#845 ON-21b: said only to a runner that DECLARED `preflight_v1` on this hello, and only when migration 1051 is present. The runner sends `facts.preflight` from its next hello on.
  const preflight = (message.capabilities ?? []).includes(PREFLIGHT_HELLO_CAPABILITY) && takesPreflight;
  // D#587 FU-179: said only to a runner that DECLARED `heartbeat_inventory_v1` on this hello at protocol 21 or later, and only when the inventory definer (migration 1040) exists. The runner then puts `sandboxes` on its heartbeats.
  const heartbeatInventory = message.protocol_version >= SANDBOX_INVENTORY_MIN_PROTOCOL && (message.capabilities ?? []).includes(HEARTBEAT_INVENTORY_HELLO_CAPABILITY) && (await runnersTakeInventory(deps));
  // D#845 ON-13c3: said only to a runner that DECLARED `engine_lease_v1` on this hello at protocol 22 or later, and only when migration 1092's function exists. The claim and heartbeat replies then carry `engine_lease`.
  const engineLease = message.protocol_version >= MACHINE_ONBOARDING_MIN_PROTOCOL && (message.capabilities ?? []).includes(ENGINE_LEASE_HELLO_CAPABILITY) && (await runnersTakeEngineLease(deps));
  // D#587 B-7c: said only to a runner that DECLARED `platform_fact_v1` on this hello, and only when migration 1122 is present. The runner sends `facts.platform` from its next hello on.
  const platformFact = (message.capabilities ?? []).includes(PLATFORM_FACT_HELLO_CAPABILITY) && takesPlatform;
  const replyCapabilities = [...(watchMode ? [WATCH_MODE_CAPABILITY] : []), ...(kvmFact ? [KVM_FACT_CAPABILITY] : []), ...(preflight ? [PREFLIGHT_CAPABILITY] : []), ...(heartbeatInventory ? [HEARTBEAT_INVENTORY_CAPABILITY] : []), ...(engineLease ? [ENGINE_LEASE_CAPABILITY] : []), ...(platformFact ? [PLATFORM_FACT_CAPABILITY] : [])];
  return { status: 200, body: HelloReply.parse({ protocol_version: current, ...(wake ? { wake } : {}), ...(replyCapabilities.length > 0 ? { capabilities: replyCapabilities } : {}) }) };
}

/** True when migration 1051 is applied: `runners.preflight` exists. Read from the catalog, never assumed from the code's version; a failed read says no, so nothing is written and the capability is not listed. */
export async function runnersTakePreflight(deps: RunnerCloudDeps): Promise<boolean> {
  try {
    const { rows } = await deps.appUserPool.query<{ ok: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.runners') AND attname = 'preflight' AND NOT attisdropped) AS ok");
    return rows[0]?.ok === true;
  } catch {
    // fx-swallow-ok: a catalog read that fails says nothing about the column: the capability is simply not listed
    return false;
  }
}

/** True when migration 1122 is applied: `runner_facts.platform` exists. Read from the catalog, never assumed from the code's version; a failed read says no, so nothing is written and the capability is not listed. */
export async function runnersTakePlatform(deps: RunnerCloudDeps): Promise<boolean> {
  try {
    const { rows } = await deps.appUserPool.query<{ ok: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.runner_facts') AND attname = 'platform' AND NOT attisdropped) AND to_regproc('public.runner_facts_platform_record') IS NOT NULL AS ok");
    return rows[0]?.ok === true;
  } catch {
    // fx-swallow-ok: a catalog read that fails says nothing about the column: nothing is written and the capability is simply not listed
    return false;
  }
}

/** True when migration 1040 is applied: `runner_sandboxes_record` exists. Read from the catalog; a failed read lists nothing. */
export async function runnersTakeInventory(deps: RunnerCloudDeps): Promise<boolean> {
  try {
    const { rows } = await deps.appUserPool.query<{ ok: boolean }>("SELECT to_regproc('public.runner_sandboxes_record') IS NOT NULL AS ok");
    return rows[0]?.ok === true;
  } catch {
    // fx-swallow-ok: a catalog read that fails says nothing about the function: the capability is simply not listed
    return false;
  }
}

/** True when migration 1047 is applied: `runners.kvm` exists. Read from the catalog, never assumed from the code's version; a failed read lists nothing. */
export async function runnersTakeKvm(deps: RunnerCloudDeps): Promise<boolean> {
  try {
    const { rows } = await deps.appUserPool.query<{ ok: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.runners') AND attname = 'kvm' AND NOT attisdropped) AS ok");
    return rows[0]?.ok === true;
  } catch {
    // fx-swallow-ok: a catalog read that fails says nothing about the column: the capability is simply not listed
    return false;
  }
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

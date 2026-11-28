import { createHash } from "node:crypto";
import {
  STATE_CARRY_CHUNK_SHA_HEADER,
  STATE_CARRY_MAX_CHUNKS,
  StateCarryBeginBody,
  StateCarryEmptyBody,
  StateCarryFailBody,
  StateCarryReply,
  stateCarryBeginPath,
  stateCarryChunkPath,
  stateCarryFailPath,
  stateCarryImportedPath,
  stateCarrySealPath,
} from "@fulcrumaxe/runner-protocol";
import type { PoolClient } from "pg";
import type { StateCarrySealer } from "@fx/model-connection";
import { CARRY_CHUNK_BODY_BYTES, RunnerHttpError, asRunner, parseJsonBody, parseMessage, pgCode, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerHttpResponse } from "./http.js";
import { verifyRunnerRequest, withRunnerSession, type VerifiedRunner } from "./verifyRunnerRequest.js";

/**
 * D#845 MC-9b2: the five runner routes that carry an engine's state directory from the old machine to the new one (the storage and its definers are migration 1123). Every route is the signed runner door with a
 * single-use nonce; the runner is the one the signature names, and the database decides the rest: each definer (`state_carry_begin`, `_chunk_put`, `_seal`, `_fail`, `_chunk_take`, `_imported`) runs only in the
 * runner's own session, on its own delivered job of the right kind, and answers one refusal for every other case (a foreign job, a wrong state, a closed carry).
 *
 *   begin     POST .../carry/begin     the old machine's stop declares the size, the chunk count and the whole bundle's sha256 (once; the same again is a no-op).
 *   chunk     PUT  .../carry/chunk/:i  raw bytes, at most 4 MiB, with the chunk's sha256 in a header. The sha256 is checked BEFORE sealing; the chunk is sealed under the machine key with the AAD
 *             `account:carry:index` and only the sealed parts reach the database.
 *   seal      POST .../carry/seal      every index present and the sizes adding up: the carry is sealed, and nothing can be written to it after.
 *   fail      POST .../carry/fail      the export failed (a closed code); the content is deleted and the carry stays open for a person to decide.
 *   chunk     GET  .../carry/chunk/:i  the new machine's start takes a chunk once per job. The chunk is opened inside the same transaction as the take, so one that cannot be opened is not counted as taken.
 *   imported  POST .../carry/imported  the start came up with the memory: the content rows go and the carry closes.
 *
 * The carry id for the seal's AAD is the database's: `state_carry_job_carry` on upload, `o_carry_id` on take. No part of it comes from the request. Errors are fixed text; no chunk, key or sealed part is ever in a log line, a message or a response beyond the one chunk the target runner takes.
 */
const NO_STORE = { "cache-control": "no-store" } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHUNK_INDEX = /^(?:0|[1-9][0-9]?)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const OK = (): RunnerHttpResponse => ({ status: 200, body: StateCarryReply.parse({ recorded: true }), headers: NO_STORE });

/** The runner's own session, with the definers' refusals turned into fixed answers: 22023 (a foreign job, a wrong state, any other refusal) is 409 `carry_refused`, 55000 a second take, 23514 a value the table refuses. */
async function inSession<T>(deps: RunnerCloudDeps, runner: VerifiedRunner, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return asRunner(async () => {
    try {
      return await withRunnerSession(deps.appUserPool, runner, fn);
    } catch (error) {
      if (error instanceof RunnerHttpError) throw error;
      const code = pgCode(error);
      if (code === "22023") throw new RunnerHttpError(409, "carry_refused", "this carry does not take that from this job");
      if (code === "55000") throw new RunnerHttpError(409, "carry_fetched", "this job already took that chunk");
      if (code === "23514") throw new RunnerHttpError(400, "invalid_message", "the message does not match the protocol");
      throw error;
    }
  });
}

const sealerOf = (deps: RunnerCloudDeps): StateCarrySealer => {
  if (!deps.stateCarrySealer) throw new RunnerHttpError(503, "not_configured", "carrying the team's memory is not available right now");
  return deps.stateCarrySealer;
};
/** Runs a seal or an open: an unset machine key is 503, a chunk that does not open (tampered, another account, carry or place, wrong key) is 409. The cipher's own error is never kept. */
function sealing<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof RunnerHttpError) throw error;
    // fx-swallow-ok: the error names key material; only the fixed code the sealer put on it decides the answer
    if ((error as { code?: unknown } | null)?.code === "machine_kek_unset") throw new RunnerHttpError(503, "machine_kek_unset", "carrying the team's memory is not available right now");
    throw new RunnerHttpError(409, "carry_unreadable", "the chunk could not be opened");
  }
}

const jobOf = (jobId: string): string => {
  // After the signature, not before: an unsigned caller must not learn from a 404 which ids are well formed.
  if (!UUID.test(jobId)) throw new RunnerHttpError(404, "not_found", "no such job");
  return jobId.toLowerCase();
};
const indexOf = (index: string): number => {
  if (!CHUNK_INDEX.test(index) || Number(index) >= STATE_CARRY_MAX_CHUNKS) throw new RunnerHttpError(404, "not_found", "no such chunk");
  return Number(index);
};

export async function stateCarryBeginRun(deps: RunnerCloudDeps, req: RunnerHttpRequest, jobId: string): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, stateCarryBeginPath(jobId), req, { replay: "once" });
  const job = jobOf(jobId);
  const body = parseMessage(StateCarryBeginBody, parseJsonBody(req));
  await inSession(deps, runner, (client) => client.query("SELECT state_carry_begin($1::uuid, $2, $3, $4)", [job, body.bytes, body.chunks, body.sha256]));
  return OK();
}

export async function stateCarryChunkPutRun(deps: RunnerCloudDeps, req: RunnerHttpRequest, jobId: string, index: string): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, stateCarryChunkPath(jobId, index), req, { replay: "once", maxBodyBytes: CARRY_CHUNK_BODY_BYTES });
  const job = jobOf(jobId);
  const at = indexOf(index);
  const claimed = req.headers[STATE_CARRY_CHUNK_SHA_HEADER];
  if (claimed === undefined || !SHA256.test(claimed) || req.body.byteLength === 0) throw new RunnerHttpError(400, "invalid_message", "the message does not match the protocol");
  // Before anything is sealed or stored: the bytes are the bytes the runner said they were.
  const actual = createHash("sha256").update(req.body).digest("hex");
  if (actual !== claimed) throw new RunnerHttpError(400, "chunk_hash_mismatch", "the chunk does not match its sha256");
  // One transaction: the carry id is the job's own (the database names it), the chunk is sealed under it, and the same transaction stores it.
  await inSession(deps, runner, async (client) => {
    const carryId = (await client.query<{ id: string }>("SELECT state_carry_job_carry($1::uuid) AS id", [job])).rows[0]?.id;
    if (!carryId) throw new RunnerHttpError(409, "carry_refused", "this carry does not take that from this job");
    const sealed = sealing(() => sealerOf(deps).seal({ accountId: runner.accountId, carryId, index: at }, req.body));
    await client.query("SELECT state_carry_chunk_put($1::uuid, $2, $3, $4, $5, $6, $7, $8)", [job, at, req.body.byteLength, actual, sealed.kekVersion, sealed.nonce, sealed.wrappedDek, sealed.ciphertext]);
  });
  return OK();
}

export async function stateCarryChunkTakeRun(deps: RunnerCloudDeps, req: RunnerHttpRequest, jobId: string, index: string): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, stateCarryChunkPath(jobId, index), req, { replay: "once" });
  const job = jobOf(jobId);
  const at = indexOf(index);
  const chunk = await inSession(deps, runner, async (client) => {
    const { rows } = await client.query<{ o_size: number; o_sha256: string; o_kek_version: number; o_nonce: Buffer; o_wrapped_dek: Buffer; o_ciphertext: Buffer; o_carry_id: string }>("SELECT * FROM state_carry_chunk_take($1::uuid, $2)", [job, at]);
    const row = rows[0];
    if (!row) throw new RunnerHttpError(409, "carry_refused", "this carry does not take that from this job");
    // Opened in the take's own transaction: a chunk that cannot be opened (or a key that is unset) is not counted as taken.
    const plain = sealing(() => sealerOf(deps).open({ accountId: runner.accountId, carryId: row.o_carry_id, index: at }, { kekVersion: row.o_kek_version, nonce: row.o_nonce, wrappedDek: row.o_wrapped_dek, ciphertext: row.o_ciphertext }));
    if (plain.byteLength !== row.o_size || createHash("sha256").update(plain).digest("hex") !== row.o_sha256) throw new RunnerHttpError(409, "carry_unreadable", "the chunk could not be opened");
    return { plain, sha256: row.o_sha256 };
  });
  return { status: 200, body: null, binary: chunk.plain, headers: { ...NO_STORE, [STATE_CARRY_CHUNK_SHA_HEADER]: chunk.sha256 } };
}

export async function stateCarrySealRun(deps: RunnerCloudDeps, req: RunnerHttpRequest, jobId: string): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, stateCarrySealPath(jobId), req, { replay: "once" });
  const job = jobOf(jobId);
  parseMessage(StateCarryEmptyBody, parseJsonBody(req));
  await inSession(deps, runner, (client) => client.query("SELECT state_carry_seal($1::uuid)", [job]));
  return OK();
}

export async function stateCarryFailRun(deps: RunnerCloudDeps, req: RunnerHttpRequest, jobId: string): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, stateCarryFailPath(jobId), req, { replay: "once" });
  const job = jobOf(jobId);
  const body = parseMessage(StateCarryFailBody, parseJsonBody(req));
  await inSession(deps, runner, (client) => client.query("SELECT state_carry_fail($1::uuid, $2)", [job, body.code]));
  return OK();
}

export async function stateCarryImportedRun(deps: RunnerCloudDeps, req: RunnerHttpRequest, jobId: string): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, stateCarryImportedPath(jobId), req, { replay: "once" });
  const job = jobOf(jobId);
  parseMessage(StateCarryEmptyBody, parseJsonBody(req));
  await inSession(deps, runner, (client) => client.query("SELECT state_carry_imported($1::uuid)", [job]));
  return OK();
}

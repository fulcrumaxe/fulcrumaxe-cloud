import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  STATE_CARRY_CHUNK_BYTES,
  STATE_CARRY_CHUNK_SHA_HEADER,
  stateCarryBeginPath,
  stateCarryChunkPath,
  stateCarryFailPath,
  stateCarryImportedPath,
  stateCarrySealPath,
} from "@fulcrumaxe/runner-protocol";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { createStateCarrySealer, machineKekSource, type StateCarrySealer } from "@fx/model-connection";
import { CARRY_CHUNK_BODY_BYTES, MAX_BODY_BYTES, stateCarryBeginRun, stateCarryChunkPutRun, stateCarryChunkTakeRun, stateCarryFailRun, stateCarryImportedRun, stateCarrySealRun, type RunnerCloudDeps, type RunnerHttpRequest } from "../src/index.js";
import { harness, newKey, registerKey, respond, signed, type Harness, type TestKey } from "./helpers.js";

/**
 * [pg] D#845 MC-9b2: the state carry's five runner routes over the real HTTP path (the RFC 9421 signature, the single-use nonce), the real definers of migration 1123 as the runner login, row security forced, and
 * the real sealer under a test machine key. The jobs are rows as the cloud's own issuer leaves them (delivered), because the issuer for a carry stop and start is a later change.
 */
const wake = vi.hoisted(() => vi.fn(async (_accountId: string): Promise<void> => undefined));
vi.mock("@fx/core/src/pendingWork.js", async (original) => ({ ...(await original<typeof import("@fx/core/src/pendingWork.js")>()), markRunnerWork: wake }));
const KEY = { FX_MACHINE_KEK_V1: Buffer.alloc(32, 9).toString("base64") };
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const MIB4 = STATE_CARRY_CHUNK_BYTES;

describe("state carry routes [pg]", () => {
  let h: Harness;
  let sealer: StateCarrySealer;
  let sealCalls = 0;
  beforeAll(async () => {
    h = await harness();
    const real = createStateCarrySealer(machineKekSource(KEY));
    sealer = { seal: (...args) => (sealCalls++, real.seal(...args)), open: (...args) => real.open(...args) };
  });
  afterAll(() => h.close());
  const deps = (over: Partial<RunnerCloudDeps> = {}): RunnerCloudDeps => h.deps({ stateCarrySealer: sealer, ...over });

  interface Rig { a: SeedRefs; from: string; to: string; other: string; fromKey: TestKey; toKey: TestKey; otherKey: TestKey; carry: string }
  /** An account whose project moved from `from` to `to` (a third runner of the account sits by), with the move's cleanup and an open carry. */
  async function rig(own?: { a: SeedRefs; repoId: string }): Promise<Rig> {
    const base = own?.a ?? (await seedAccount(h.admin, randomUUID()));
    const a = { ...base, repoId: own?.repoId ?? base.repoId };
    const fromKey = newKey();
    const toKey = newKey();
    const otherKey = newKey();
    const from = await registerKey(h.admin, a.accountId, a.userId, fromKey);
    const to = await registerKey(h.admin, a.accountId, a.userId, toKey);
    const other = await registerKey(h.admin, a.accountId, a.userId, otherKey);
    await h.admin.query(`INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'person')`, [a.repoId, a.accountId, to]);
    const cleanup = await withTenant(h.appPool, a.accountId, a.userId, async (c) => (await c.query("SELECT machine_cleanup_request_move($1, $2) AS id", [a.repoId, from])).rows[0].id as string);
    const carry = await withTenant(h.appPool, a.accountId, a.userId, async (c) => (await c.query("SELECT state_carry_request($1, $2) AS id", [cleanup, to])).rows[0].id as string);
    return { a, from, to, other, fromKey, toKey, otherKey, carry };
  }
  /** A delivered job row, as the cloud's issuer would leave it. */
  async function job(r: Rig, kind: "engine_session_stop" | "engine_session_start", runnerId: string, args: Record<string, unknown>): Promise<string> {
    const id = randomUUID();
    const issued = new Date();
    const expires = new Date(issued.getTime() + 600_000);
    const body = { job: { job_id: id, kind, runner_id: runnerId, issued_at: issued.toISOString(), expires_at: expires.toISOString(), args } };
    await h.admin.query("SET session_replication_role = replica");
    try {
      await h.admin.query(`INSERT INTO machine_jobs (id, account_id, runner_id, repo_id, setup_id, kind, job, issued_at, expires_at) VALUES ($1, $2, $3, $4, NULL, $5, $6::jsonb, $7, $8)`, [id, r.a.accountId, runnerId, r.a.repoId, kind, JSON.stringify(body), issued, expires]);
    } finally {
      await h.admin.query("RESET session_replication_role");
    }
    await h.admin.query(`UPDATE machine_jobs SET state = 'superseded' WHERE account_id = $1 AND runner_id = $2 AND state = 'delivered'`, [r.a.accountId, runnerId]);
    await h.admin.query(`UPDATE machine_jobs SET state = 'delivered', delivered_at = issued_at WHERE id = $1`, [id]);
    return id;
  }
  const stop = (r: Rig) => job(r, "engine_session_stop", r.from, { reason: "move", operate_epoch: 0, carry: { id: r.carry } });
  const start = (r: Rig, bytes: number, chunks: number, whole: string) => job(r, "engine_session_start", r.to, { at_sha: "a".repeat(40), resume: false, operate_epoch: 0, carry: { id: r.carry, bytes, chunks, sha256: whole } });

  const json = (key: TestKey, path: string, body: unknown, run: (d: RunnerCloudDeps, q: RunnerHttpRequest, j: string) => ReturnType<typeof stateCarryBeginRun>, jobId: string, d = deps()) =>
    respond(() => run(d, signed(key, path, body), jobId));
  const begin = (r: Rig, jobId: string, bytes: number, chunks: number, whole = "c".repeat(64), key = r.fromKey) => json(key, stateCarryBeginPath(jobId), { bytes, chunks, sha256: whole }, stateCarryBeginRun, jobId);
  const sealRoute = (r: Rig, jobId: string, key = r.fromKey) => json(key, stateCarrySealPath(jobId), {}, stateCarrySealRun, jobId);
  const failRoute = (r: Rig, jobId: string, code: string, key = r.fromKey) => json(key, stateCarryFailPath(jobId), { code }, stateCarryFailRun, jobId);
  const importedRoute = (r: Rig, jobId: string, key = r.toKey) => json(key, stateCarryImportedPath(jobId), {}, stateCarryImportedRun, jobId);
  const put = (r: Rig, jobId: string, index: string | number, bytes: Buffer, o: { key?: TestKey; sha?: string; d?: RunnerCloudDeps; headers?: Record<string, string> } = {}) => {
    const req = signed(o.key ?? r.fromKey, stateCarryChunkPath(jobId, index), undefined, { method: "PUT", rawBody: bytes });
    req.headers = { ...req.headers, [STATE_CARRY_CHUNK_SHA_HEADER]: o.sha ?? sha(bytes), ...o.headers };
    return respond(() => stateCarryChunkPutRun(o.d ?? deps(), req, jobId, String(index)));
  };
  const take = (r: Rig, jobId: string, index: string | number, o: { key?: TestKey; d?: RunnerCloudDeps } = {}) => {
    const req = signed(o.key ?? r.toKey, stateCarryChunkPath(jobId, index), undefined, { method: "GET", rawBody: Buffer.alloc(0) });
    return respond(() => stateCarryChunkTakeRun(o.d ?? deps(), req, jobId, String(index)));
  };
  const carryRow = async (id: string) => (await h.admin.query("SELECT bytes, chunks, sha256, sealed_at, failure_code, closed_at, closed_reason FROM state_carries WHERE id = $1", [id])).rows[0];
  const chunkRows = async (id: string) => (await h.admin.query("SELECT idx, size, sha256, ciphertext, nonce, wrapped_dek, fetched_job_id FROM state_carry_chunks WHERE carry_id = $1 ORDER BY idx", [id])).rows as Array<{ idx: number; size: number; sha256: string; ciphertext: Buffer; nonce: Buffer; wrapped_dek: Buffer; fetched_job_id: string | null }>;
  const refused = (res: { status: number; body: unknown }) => expect(res).toMatchObject({ status: 409, body: { error: { code: "carry_refused" } } });

  /** A two-chunk bundle (4 MiB and 5 bytes) uploaded and sealed, with its start job delivered to the target. */
  async function sealed(r: Rig): Promise<{ stopJob: string; startJob: string; c0: Buffer; c1: Buffer }> {
    const c0 = randomBytes(MIB4);
    const c1 = Buffer.from("tail!");
    const stopJob = await stop(r);
    expect((await begin(r, stopJob, MIB4 + 5, 2, sha(Buffer.concat([c0, c1])))).status).toBe(200);
    expect((await put(r, stopJob, 0, c0)).status).toBe(200);
    expect((await put(r, stopJob, 1, c1)).status).toBe(200);
    expect((await sealRoute(r, stopJob)).status).toBe(200);
    return { stopJob, startJob: await start(r, MIB4 + 5, 2, sha(Buffer.concat([c0, c1]))), c0, c1 };
  }

  it("carries a bundle end to end: begin, a full 4 MiB chunk and a short one, seal, then each chunk taken once, imported, the content gone and the header kept", async () => {
    const r = await rig();
    const { stopJob, startJob, c0, c1 } = await sealed(r);
    expect(await carryRow(r.carry)).toMatchObject({ bytes: MIB4 + 5, chunks: 2, sealed_at: expect.any(Date), failure_code: null, closed_at: null });
    const rows = await chunkRows(r.carry);
    expect(rows.map((x) => [x.idx, x.size, x.sha256])).toEqual([[0, MIB4, sha(c0)], [1, 5, sha(c1)]]);
    // what is stored is sealed: no plaintext in the ciphertext, and a fresh nonce and wrapped key per chunk
    expect(rows[1]!.ciphertext.includes(c1)).toBe(false);
    expect(rows[0]!.nonce.equals(rows[1]!.nonce)).toBe(false);

    const got0 = await take(r, startJob, 0);
    expect(got0).toMatchObject({ status: 200, headers: { "cache-control": "no-store", [STATE_CARRY_CHUNK_SHA_HEADER]: sha(c0) } });
    expect(Buffer.from((got0 as { binary: Uint8Array }).binary).equals(c0)).toBe(true);
    const got1 = await take(r, startJob, 1);
    expect(Buffer.from((got1 as { binary: Uint8Array }).binary).equals(c1)).toBe(true);
    // a second take of the same index by the same job is refused, and costs nothing
    expect(await take(r, startJob, 0)).toMatchObject({ status: 409, body: { error: { code: "carry_fetched" } } });
    expect(stopJob).not.toBe(startJob);

    expect((await importedRoute(r, startJob)).status).toBe(200);
    expect(await carryRow(r.carry)).toMatchObject({ closed_reason: "imported", closed_at: expect.any(Date), bytes: MIB4 + 5 });
    expect(await chunkRows(r.carry)).toEqual([]);
    expect((await importedRoute(r, startJob)).status).toBe(200); // a lost answer is retried without harm
  });

  it("lets a later start job take a chunk again (a network failure mid-import recovers without the old machine)", async () => {
    const r = await rig();
    const { startJob, c1 } = await sealed(r);
    expect((await take(r, startJob, 1)).status).toBe(200);
    expect((await take(r, startJob, 1)).status).toBe(409);
    const retry = await start(r, MIB4 + 5, 2, "c".repeat(64));
    expect(Buffer.from(((await take(r, retry, 1)) as { binary: Uint8Array }).binary).equals(c1)).toBe(true);
  });

  it("a seal wakes the account's machines (so the start signed from the sealed carry reaches the new one), and a refused seal does not", async () => {
    const r = await rig();
    const stopJob = await stop(r);
    expect((await begin(r, stopJob, 5, 1)).status).toBe(200);
    wake.mockClear();
    refused(await sealRoute(r, stopJob)); // no chunk yet
    expect(wake).not.toHaveBeenCalled();
    expect((await put(r, stopJob, 0, Buffer.from("tail!"))).status).toBe(200);
    expect((await sealRoute(r, stopJob)).status).toBe(200);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith(r.a.accountId);
  });

  describe("route auth: a runner for its own job only", () => {
    it("answers an unsigned request, a bad signature and a key of no runner 401, and a replayed nonce 409, without touching the carry", async () => {
      const r = await rig();
      const stopJob = await stop(r);
      const unsigned = { method: "POST", headers: {}, body: Buffer.from(JSON.stringify({ bytes: 5, chunks: 1, sha256: "c".repeat(64) })) } as RunnerHttpRequest;
      expect((await respond(() => stateCarryBeginRun(deps(), unsigned, stopJob))).status).toBe(401);
      // signed for another job's path: the signature does not match the path the route checks
      const wrongPath = signed(r.fromKey, stateCarryBeginPath(randomUUID()), { bytes: 5, chunks: 1, sha256: "c".repeat(64) });
      expect((await respond(() => stateCarryBeginRun(deps(), wrongPath, stopJob))).status).toBe(401);
      expect((await begin(r, stopJob, 5, 1, "c".repeat(64), newKey())).status).toBe(401);
      const first = signed(r.fromKey, stateCarrySealPath(stopJob), {}, { nonce: "n".repeat(22) });
      await respond(() => stateCarrySealRun(deps(), first, stopJob));
      expect(await respond(() => stateCarrySealRun(deps(), first, stopJob))).toMatchObject({ status: 409, body: { error: { code: "nonce_reused" } } });
      expect(await carryRow(r.carry)).toMatchObject({ bytes: null, sealed_at: null });
    });

    it("refuses every other runner of the same account, and the target on the stop's routes and the source on the start's, and changes nothing", async () => {
      const r = await rig();
      const stopJob = await stop(r);
      const { startJob } = await sealed(await rig()); // another account's pair, unused here: its ids must not work for this one
      refused(await begin(r, stopJob, 5, 1, "c".repeat(64), r.otherKey));
      refused(await begin(r, stopJob, 5, 1, "c".repeat(64), r.toKey));
      expect(await carryRow(r.carry)).toMatchObject({ bytes: null });
      await begin(r, stopJob, 5, 1);
      const chunk = Buffer.from("hello");
      refused(await put(r, stopJob, 0, chunk, { key: r.otherKey }));
      refused(await put(r, stopJob, 0, chunk, { key: r.toKey }));
      expect(await chunkRows(r.carry)).toEqual([]);
      expect((await put(r, stopJob, 0, chunk)).status).toBe(200);
      refused(await sealRoute(r, stopJob, r.otherKey));
      refused(await failRoute(r, stopJob, "export_failed", r.toKey));
      expect(await carryRow(r.carry)).toMatchObject({ sealed_at: null, failure_code: null });
      expect((await sealRoute(r, stopJob)).status).toBe(200);
      const start1 = await start(r, 5, 1, "c".repeat(64));
      // the source machine cannot take, another runner cannot take or import, and another account's job id is nothing here
      refused(await take(r, start1, 0, { key: r.fromKey }));
      refused(await take(r, start1, 0, { key: r.otherKey }));
      refused(await importedRoute(r, start1, r.otherKey));
      refused(await importedRoute(r, start1, r.fromKey));
      refused(await take(r, startJob, 0));
      expect(await chunkRows(r.carry)).toHaveLength(1);
      expect((await chunkRows(r.carry))[0]!.fetched_job_id).toBeNull();
    });

    it("refuses a runner of another account holding another account's job id", async () => {
      const r = await rig();
      const stranger = await rig();
      const stopJob = await stop(r);
      refused(await begin(r, stopJob, 5, 1, "c".repeat(64), stranger.fromKey));
      refused(await sealRoute(r, stopJob, stranger.fromKey));
      expect(await carryRow(r.carry)).toMatchObject({ bytes: null });
    });

    it("refuses a job that is not delivered, one that is not a stop, and an id that is no job, with one answer", async () => {
      const r = await rig();
      const stopJob = await stop(r);
      await h.admin.query("UPDATE machine_jobs SET state = 'superseded' WHERE id = $1", [stopJob]);
      refused(await begin(r, stopJob, 5, 1));
      const startJob = await start(r, 5, 1, "c".repeat(64));
      refused(await json(r.toKey, stateCarryBeginPath(startJob), { bytes: 5, chunks: 1, sha256: "c".repeat(64) }, stateCarryBeginRun, startJob));
      refused(await begin(r, randomUUID(), 5, 1));
      expect(await json(r.fromKey, stateCarryBeginPath("not-an-id"), { bytes: 5, chunks: 1, sha256: "c".repeat(64) }, stateCarryBeginRun, "not-an-id")).toMatchObject({ status: 404 });
    });
  });

  describe("the chunk fences", () => {
    it("checks the chunk's sha256 BEFORE sealing: a wrong or malformed one is refused, nothing is sealed or stored", async () => {
      const r = await rig();
      const stopJob = await stop(r);
      await begin(r, stopJob, 5, 1);
      const before = sealCalls;
      expect(await put(r, stopJob, 0, Buffer.from("hello"), { sha: sha(Buffer.from("other")) })).toMatchObject({ status: 400, body: { error: { code: "chunk_hash_mismatch" } } });
      for (const bad of ["", "X".repeat(64), sha(Buffer.from("hello")).slice(1)]) expect((await put(r, stopJob, 0, Buffer.from("hello"), { sha: bad })).status, bad).toBe(400);
      expect((await put(r, stopJob, 0, Buffer.from("hello"), { headers: { [STATE_CARRY_CHUNK_SHA_HEADER]: "" } })).status).toBe(400);
      expect((await put(r, stopJob, 0, Buffer.alloc(0))).status).toBe(400);
      expect(sealCalls).toBe(before);
      expect(await chunkRows(r.carry)).toEqual([]);
    });

    it("refuses a size that is not the chunk's size for its place (a short middle chunk, a long last one), an index past the bundle and an index that is not a number", async () => {
      const r = await rig();
      const stopJob = await stop(r);
      await begin(r, stopJob, MIB4 + 5, 2);
      refused(await put(r, stopJob, 0, Buffer.alloc(MIB4 - 1, 1)));
      refused(await put(r, stopJob, 1, Buffer.alloc(6, 1)));
      refused(await put(r, stopJob, 2, Buffer.alloc(5, 1)));
      expect((await put(r, stopJob, 13, Buffer.alloc(5, 1))).status).toBe(404);
      expect((await put(r, stopJob, "x", Buffer.alloc(5, 1))).status).toBe(404);
      expect((await put(r, stopJob, "01", Buffer.alloc(5, 1))).status).toBe(404);
      expect(await chunkRows(r.carry)).toEqual([]);
    });

    it("sets the body limits: a 4 MiB chunk is accepted; 4 MiB + 1 is 413 before any signature work; every other route stays at 256 KiB", async () => {
      const r = await rig();
      const stopJob = await stop(r);
      await begin(r, stopJob, MIB4, 1);
      expect(CARRY_CHUNK_BODY_BYTES).toBe(MIB4);
      expect((await put(r, stopJob, 0, randomBytes(MIB4))).status).toBe(200);
      // an unsigned oversize body is told its size first, not its signature
      const huge = { method: "PUT", headers: {}, body: Buffer.alloc(MIB4 + 1) } as RunnerHttpRequest;
      expect(await respond(() => stateCarryChunkPutRun(deps(), huge, stopJob, "0"))).toMatchObject({ status: 413, body: { error: { code: "body_too_large" } } });
      expect((await put(r, stopJob, 0, randomBytes(MIB4 + 1))).status).toBe(413);
      for (const run of [stateCarryBeginRun, stateCarrySealRun, stateCarryFailRun, stateCarryImportedRun]) {
        const big = { method: "POST", headers: {}, body: Buffer.alloc(MAX_BODY_BYTES + 1) } as RunnerHttpRequest;
        expect(await respond(() => run(deps(), big, stopJob)), run.name).toMatchObject({ status: 413 });
      }
      const bigTake = signed(r.toKey, stateCarryChunkPath(stopJob, 0), undefined, { method: "GET", rawBody: Buffer.alloc(MAX_BODY_BYTES + 1) });
      expect((await respond(() => stateCarryChunkTakeRun(deps(), bigTake, stopJob, "0"))).status).toBe(413);
    });

    it("seals under the AAD account:carry:index with the carry the DATABASE names: a chunk row moved to another index, or to another carry of the same account, does not open, and a refused take is not counted", async () => {
      const r = await rig();
      const { startJob, c1 } = await sealed(r);
      expect(Buffer.from(((await take(r, startJob, 1)) as { binary: Uint8Array }).binary).equals(c1)).toBe(true);
      // a chunk row moved to another place under the same carry (index 1's sealed parts written to index 0's row) is unreadable there
      await h.admin.query(`UPDATE state_carry_chunks a SET nonce = b.nonce, wrapped_dek = b.wrapped_dek, ciphertext = b.ciphertext, size = b.size, sha256 = b.sha256 FROM state_carry_chunks b WHERE a.carry_id = $1 AND b.carry_id = $1 AND a.idx = 0 AND b.idx = 1`, [r.carry]);
      const later = await start(r, MIB4 + 5, 2, "c".repeat(64));
      expect(await take(r, later, 0)).toMatchObject({ status: 409, body: { error: { code: "carry_unreadable" } } });
    });

    it("a chunk row moved in the database from carry A to carry B of the same account fails to open on B's take (409 carry_unreadable) and is not counted as taken", async () => {
      const a = await rig();
      // carry B: a second repo of the same account, moved the same way, with its own runners and a sealed one-chunk bundle
      const repoId = randomUUID();
      await h.admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) SELECT $1, account_id, installation_id, gh_repo_id + 4242, product, 'acme', 'gadgets' FROM repos WHERE id = $2`, [repoId, a.a.repoId]);
      const b = await rig({ a: a.a, repoId });
      const bytes = Buffer.from("moved-bytes");
      const stopA = await stop(a);
      await begin(a, stopA, bytes.length, 1);
      await put(a, stopA, 0, bytes);
      await sealRoute(a, stopA);
      const stopB = await stop(b);
      await begin(b, stopB, bytes.length, 1);
      await put(b, stopB, 0, bytes);
      await sealRoute(b, stopB);
      await h.admin.query(`UPDATE state_carry_chunks x SET nonce = y.nonce, wrapped_dek = y.wrapped_dek, ciphertext = y.ciphertext, kek_version = y.kek_version FROM state_carry_chunks y WHERE x.carry_id = $1 AND y.carry_id = $2 AND x.idx = 0 AND y.idx = 0`, [b.carry, a.carry]);
      const startB = await start(b, bytes.length, 1, "c".repeat(64));
      expect(await take(b, startB, 0)).toMatchObject({ status: 409, body: { error: { code: "carry_unreadable" } } });
      expect((await chunkRows(b.carry))[0]!.fetched_job_id).toBeNull();
      // A's own chunk still opens for A
      const startA = await start(a, bytes.length, 1, "c".repeat(64));
      expect(Buffer.from(((await take(a, startA, 0)) as { binary: Uint8Array }).binary).equals(bytes)).toBe(true);
    });

    it("refuses a stored chunk whose bytes no longer match the sha256 recorded at upload, even if it opens", async () => {
      const r = await rig();
      const { startJob } = await sealed(r);
      await h.admin.query("UPDATE state_carry_chunks SET sha256 = $2 WHERE carry_id = $1 AND idx = 1", [r.carry, "d".repeat(64)]);
      expect(await take(r, startJob, 1)).toMatchObject({ status: 409, body: { error: { code: "carry_unreadable" } } });
    });
  });

  describe("the machine key", () => {
    it("answers an unset key 503 machine_kek_unset on upload and on take, stores nothing and counts no take", async () => {
      const r = await rig();
      const unset = deps({ stateCarrySealer: createStateCarrySealer(machineKekSource({})) });
      const stopJob = await stop(r);
      await begin(r, stopJob, 5, 1);
      expect(await put(r, stopJob, 0, Buffer.from("hello"), { d: unset })).toMatchObject({ status: 503, body: { error: { code: "machine_kek_unset" } } });
      expect(await chunkRows(r.carry)).toEqual([]);
      expect((await put(r, stopJob, 0, Buffer.from("hello"))).status).toBe(200);
      await sealRoute(r, stopJob);
      const startJob = await start(r, 5, 1, "c".repeat(64));
      expect(await take(r, startJob, 0, { d: unset })).toMatchObject({ status: 503, body: { error: { code: "machine_kek_unset" } } });
      expect((await take(r, startJob, 0)).status).toBe(200);
    });

    it("answers 503 not_configured when no sealer is wired, and never puts a nonce, a wrapped key or the plaintext in any response body", async () => {
      const r = await rig();
      const none = deps({ stateCarrySealer: null });
      const stopJob = await stop(r);
      await begin(r, stopJob, 5, 1);
      expect(await put(r, stopJob, 0, Buffer.from("hello"), { d: none })).toMatchObject({ status: 503, body: { error: { code: "not_configured" } } });
      const responses = [await begin(r, stopJob, 5, 1), await put(r, stopJob, 0, Buffer.from("hello")), await sealRoute(r, stopJob), await failRoute(r, stopJob, "link")];
      const [row] = await chunkRows(r.carry);
      const text = JSON.stringify(responses);
      for (const secret of [row!.nonce, row!.wrapped_dek, row!.ciphertext]) expect(text.includes(secret.toString("base64")) || text.includes(secret.toString("hex"))).toBe(false);
      expect(text).not.toContain(Buffer.from("hello").toString("base64"));
    });
  });

  describe("begin, seal, fail and imported", () => {
    it("takes the begin once with the same facts again as a no-op and refuses different ones, a size over 50 MiB and a chunk count that does not match", async () => {
      const r = await rig();
      const stopJob = await stop(r);
      expect((await begin(r, stopJob, MIB4 + 5, 2, "c".repeat(64))).status).toBe(200);
      expect((await begin(r, stopJob, MIB4 + 5, 2, "c".repeat(64))).status).toBe(200);
      refused(await begin(r, stopJob, MIB4 + 5, 2, "e".repeat(64)));
      for (const [bytes, chunks] of [[MIB4 + 5, 1], [0, 1], [50 * 1024 * 1024 + 1, 14]] as const) expect((await begin(r, stopJob, bytes, chunks)).status, `${bytes}/${chunks}`).toBe(400);
      expect((await json(r.fromKey, stateCarryBeginPath(stopJob), { bytes: 5, chunks: 1, sha256: "c".repeat(64), extra: 1 }, stateCarryBeginRun, stopJob)).status).toBe(400);
      expect(await carryRow(r.carry)).toMatchObject({ bytes: MIB4 + 5, chunks: 2, sha256: "c".repeat(64) });
    });

    it("refuses a seal while a chunk is missing, seals when every index is there, and refuses every write after the seal", async () => {
      const r = await rig();
      const stopJob = await stop(r);
      await begin(r, stopJob, MIB4 + 5, 2);
      await put(r, stopJob, 0, randomBytes(MIB4));
      refused(await sealRoute(r, stopJob));
      await put(r, stopJob, 1, Buffer.from("tail!"));
      expect((await sealRoute(r, stopJob)).status).toBe(200);
      refused(await put(r, stopJob, 1, Buffer.from("TAIL!")));
      refused(await sealRoute(r, stopJob));
      refused(await failRoute(r, stopJob, "link"));
      expect((await chunkRows(r.carry)).find((x) => x.idx === 1)!.size).toBe(5);
    });

    it("records an export failure with a closed code, deletes the content and leaves the carry open; a code outside the list is 400", async () => {
      const r = await rig();
      const stopJob = await stop(r);
      await begin(r, stopJob, 5, 1);
      await put(r, stopJob, 0, Buffer.from("hello"));
      for (const code of ["expired", "import_failed", "source_removed", "", "x"]) expect((await failRoute(r, stopJob, code)).status, code).toBe(400);
      expect(await failRoute(r, stopJob, "too_large")).toMatchObject({ status: 200, body: { recorded: true } });
      expect(await carryRow(r.carry)).toMatchObject({ failure_code: "too_large", closed_at: null });
      expect(await chunkRows(r.carry)).toEqual([]);
      refused(await put(r, stopJob, 0, Buffer.from("hello")));
    });

    it("refuses an imported before the seal, and a take from an unsealed or failed carry", async () => {
      const r = await rig();
      const stopJob = await stop(r);
      await begin(r, stopJob, 5, 1);
      const startJob = await start(r, 5, 1, "c".repeat(64));
      refused(await importedRoute(r, startJob));
      refused(await take(r, startJob, 0));
      await put(r, stopJob, 0, Buffer.from("hello"));
      await failRoute(r, stopJob, "link");
      refused(await take(r, startJob, 0));
      expect(await carryRow(r.carry)).toMatchObject({ closed_at: null, closed_reason: null });
    });
  });
});

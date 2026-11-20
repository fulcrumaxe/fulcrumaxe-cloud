import { randomUUID, generateKeyPairSync, type KeyObject } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { JobSignatureError, verifyEngineCommand, type EngineCommand, type SignedEngineCommand } from "@fulcrumaxe/runner-protocol";
import { createJobSigner } from "@fx/runner";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { ENGINE_COMMANDS_PULL_PATH, ackEngineCommand, engineCommandAckPath, pullEngineCommands, toResponse, type RunnerCloudDeps } from "../src/index.js";
import { harness, newKey, registerKey, signed, type Harness, type TestKey } from "./helpers.js";

/**
 * [pg] EB-8a: the runner's side of the engine command channel, POST /api/runner/engine/commands/pull and /:id/ack, against migration 1029.
 * The bridge tables the pull reads beside its own (settings, and the halt marker that migration 1031 adds) are built by their own rows; here each is a
 * table of the Spec's shape in a scratch schema that the route's pool lists before `public`, so it shadows a real table of the same name once that
 * exists. The commands table, its RLS and trigger, the routes and the signatures are the real thing.
 */
const SCRATCH = `eb8a_${Math.random().toString(36).slice(2, 10)}`;
const GH_A = 5_100_000 + Math.floor(Math.random() * 100_000);
const GH_A2 = GH_A + 1;
const KEY_ID = "test-signer-1";

describe("engine commands: pull and ack [pg]", () => {
  let h: Harness;
  let one: Pool;
  let A: SeedRefs;
  let B: SeedRefs;
  let key: TestKey;
  let runnerId: string;
  let keyOther: TestKey;
  let runnerOther: string;
  let keyB: TestKey;
  let signKey: KeyObject;
  let keyring: Record<string, KeyObject>;
  let repo2: string;
  const seqs = new Map<string, number>();

  const signer = () => createJobSigner({ keyId: KEY_ID, privateKey: signKey });
  const deps = (over: Partial<RunnerCloudDeps> = {}): RunnerCloudDeps => h.deps({ appUserPool: one, engineCommandSigner: async () => signer(), ...over });
  const tmp = (sql: string, args: unknown[] = []) => h.admin.query(sql.replace(/\b(engine_bridge_settings|engine_repo_controls)\b/g, `${SCRATCH}.$1`), args);
  const pull = (body: unknown = { repo_gh_ids: [GH_A], after_seq: {} }, k: TestKey = key, d: RunnerCloudDeps = deps()) => toResponse(() => pullEngineCommands(d, signed(k, ENGINE_COMMANDS_PULL_PATH, body)));
  const ack = (id: string, body: unknown, k: TestKey = key, d: RunnerCloudDeps = deps()) => toResponse(() => ackEngineCommand(d, signed(k, engineCommandAckPath(id), body), id));

  /** One command row, written as the admin role. `seq` counts up per runner and repo, the way the issue route hands it out. */
  async function command(over: { runner?: string; repo?: string; kind?: string; args?: object; state?: string; life?: string; issuedAgo?: string; account?: string; epoch?: number } = {}): Promise<string> {
    const runner = over.runner ?? runnerId;
    const repo = over.repo ?? A.repoId;
    const k = `${runner}:${repo}`;
    const seq = (seqs.get(k) ?? 0) + 1;
    seqs.set(k, seq);
    const state = over.state ?? "pending";
    const delivered = ["delivered", "applied", "refused", "not_confirmed"].includes(state);
    const acked = ["applied", "refused", "not_confirmed"].includes(state);
    const r = await h.admin.query<{ id: string }>(
      `INSERT INTO engine_commands (account_id, runner_id, repo_id, command_seq, kind, args, issued_by, issued_at, expires_at, state, refusal, delivered_at, acked_at, halt_epoch_at_issue)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, now() - $8::interval, now() - $8::interval + $9::interval, $10, $11, $12, $13, $14) RETURNING id`,
      [over.account ?? A.accountId, runner, repo, seq, over.kind ?? "start_day", JSON.stringify(over.args ?? {}), A.userId, over.issuedAgo ?? "0 seconds", over.life ?? "600 seconds", state, state === "refused" ? "ceiling" : null, delivered ? new Date() : null, acked ? new Date() : null, over.epoch ?? 2],
    );
    return r.rows[0]!.id;
  }
  const stateOf = async (id: string) => (await h.admin.query<{ state: string }>("SELECT state FROM engine_commands WHERE id = $1", [id])).rows[0]?.state;
  const audits = async (accountId = A.accountId) => (await h.admin.query("SELECT action, payload FROM audit_log WHERE account_id = $1 AND action LIKE 'engine_command.%' ORDER BY created_at", [accountId])).rows;
  const commandsOf = (res: { body: unknown }) => (res.body as { commands: SignedEngineCommand[] }).commands;
  const verified = (res: { body: unknown }, now?: Date): EngineCommand[] => commandsOf(res).map((c) => verifyEngineCommand(c, keyring, now));

  beforeAll(async () => {
    h = await harness();
    await h.admin.query(`CREATE SCHEMA ${SCRATCH}`);
    await h.admin.query(`GRANT USAGE ON SCHEMA ${SCRATCH} TO app_user`);
    one = createPool(process.env.RUNNER_CLOUD_DATABASE_URL_APP_USER!, { options: `-c search_path=${SCRATCH},public` });
    await tmp("CREATE TABLE engine_bridge_settings (account_id uuid PRIMARY KEY, watch_enabled boolean NOT NULL DEFAULT false, operate_enabled boolean NOT NULL DEFAULT false)");
    await tmp("CREATE TABLE engine_repo_controls (account_id uuid, repo_id uuid PRIMARY KEY, halted_at timestamptz, halt_epoch integer NOT NULL DEFAULT 0)");
    await h.admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${SCRATCH} TO app_user`);
    const pair = generateKeyPairSync("ed25519");
    signKey = pair.privateKey;
    keyring = { [KEY_ID]: pair.publicKey };
    A = await seedAccount(h.admin, randomUUID());
    B = await seedAccount(h.admin, randomUUID());
    key = newKey();
    runnerId = await registerKey(h.admin, A.accountId, A.userId, key);
    keyOther = newKey();
    runnerOther = await registerKey(h.admin, A.accountId, A.userId, keyOther);
    keyB = newKey();
    await registerKey(h.admin, B.accountId, B.userId, keyB);
    await h.admin.query("UPDATE repos SET gh_repo_id = $2, gh_owner = 'acme', gh_name = 'widgets', execution_mode = 'runner_local' WHERE id = $1", [A.repoId, GH_A]);
    repo2 = (await h.admin.query<{ id: string }>(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, NULL, $2, 'web', 'acme', 'second', 'runner_local') RETURNING id`, [A.accountId, GH_A2])).rows[0]!.id;
  });
  afterAll(async () => {
    await one.end();
    await h.admin.query(`DROP SCHEMA ${SCRATCH} CASCADE`);
    await h.close();
  });
  beforeEach(async () => {
    await h.admin.query("DELETE FROM engine_commands WHERE account_id = ANY ($1::uuid[])", [[A.accountId, B.accountId]]);
    await h.admin.query("DELETE FROM audit_log WHERE account_id = ANY ($1::uuid[]) AND action LIKE 'engine_command.%'", [[A.accountId, B.accountId]]).catch(() => undefined);
    seqs.clear();
    await h.admin.query("UPDATE runners SET revoked_at = NULL, allowed_repo_ids = $2::uuid[] WHERE id = $1", [runnerId, [A.repoId, repo2]]);
    await h.admin.query("UPDATE runners SET revoked_at = NULL, allowed_repo_ids = $2::uuid[] WHERE id = $1", [runnerOther, [A.repoId]]);
    await h.admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = ANY ($1::uuid[])", [[A.repoId, repo2]]);
    await tmp("TRUNCATE engine_bridge_settings");
    await tmp("TRUNCATE engine_repo_controls");
    await tmp("INSERT INTO engine_bridge_settings VALUES ($1, true, true)", [A.accountId]);
  });

  describe("the pull: the door", () => {
    it("an unsigned request, an unknown key, another runner's key on a revoked row are 401, a replayed request is refused (409), and nothing is delivered twice", async () => {
      const id = await command();
      expect((await toResponse(() => pullEngineCommands(deps(), { method: "POST", headers: {}, body: Buffer.from("{}") }))).status).toBe(401);
      expect((await pull(undefined, newKey())).status).toBe(401);
      const req = signed(key, ENGINE_COMMANDS_PULL_PATH, { repo_gh_ids: [GH_A], after_seq: {} });
      expect((await toResponse(() => pullEngineCommands(deps(), req))).status).toBe(200);
      expect((await toResponse(() => pullEngineCommands(deps(), req))).status).toBe(409);
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [runnerId]);
      expect((await pull()).status).toBe(401);
      expect(await stateOf(id)).toBe("delivered");
    });

    it("a body that does not match the protocol is 400 and delivers nothing", async () => {
      const id = await command();
      for (const bad of [{}, { repo_gh_ids: [], after_seq: {} }, { repo_gh_ids: [GH_A], after_seq: { "999": 1 } }, { repo_gh_ids: [GH_A, GH_A], after_seq: {} }, { repo_gh_ids: [GH_A], after_seq: {}, extra: 1 }]) {
        expect((await pull(bad)).status, JSON.stringify(bad)).toBe(400);
      }
      expect(await stateOf(id)).toBe("pending");
    });

    it("without a signing key it is 503 and nothing is delivered", async () => {
      const id = await command();
      expect((await pull(undefined, key, deps({ engineCommandSigner: null }))).status).toBe(503);
      expect((await pull(undefined, key, deps({ engineCommandSigner: async () => null }))).status).toBe(503);
      expect(await stateOf(id)).toBe("pending");
    });

    it("a signer that throws delivers nothing: the transaction rolls back", async () => {
      const id = await command();
      const broken = { keyId: KEY_ID, signEngineCommand: () => { throw new Error("hsm down"); } };
      expect((await pull(undefined, key, deps({ engineCommandSigner: async () => broken }))).status).toBe(500);
      expect(await stateOf(id)).toBe("pending");
    });
  });

  describe("the pull: what comes back", () => {
    it("returns the runner's pending commands, signed for this runner and repo, in sequence order, and marks them delivered", async () => {
      const a = await command({ kind: "pause_loop" });
      const b = await command({ kind: "answer_ask", args: { ask_id: "0123456789abcdef", choice: "approve", note: "ship it" } });
      const c = await command({ kind: "request_spawn", args: { role: "executor", discussion: 842 } });
      const res = await pull();
      expect(res.status).toBe(200);
      const got = verified(res);
      expect(got.map((g) => g.command_id)).toEqual([a, b, c]);
      expect(got.map((g) => g.command_seq)).toEqual([1, 2, 3]);
      for (const g of got) expect(g).toMatchObject({ v: 1, purpose: "engine_command_v1", runner_id: runnerId, repo_gh_id: GH_A, issued_by: A.userId, halt_epoch: 2 });
      expect(got[1]).toMatchObject({ kind: "answer_ask", args: { ask_id: "0123456789abcdef", choice: "approve", note: "ship it" } });
      expect(Date.parse(got[0]!.expires_at) - Date.parse(got[0]!.issued_at)).toBe(600_000);
      for (const id of [a, b, c]) expect(await stateOf(id)).toBe("delivered");
      const row = (await h.admin.query("SELECT delivered_at FROM engine_commands WHERE id = $1", [a])).rows[0];
      expect(row.delivered_at).not.toBeNull();
    });

    it("a command is delivered once: a second pull answers none", async () => {
      await command();
      expect(commandsOf(await pull())).toHaveLength(1);
      expect(commandsOf(await pull())).toHaveLength(0);
    });

    it("hands out at most 20, lowest sequence first, and the next pull the rest", async () => {
      for (let i = 0; i < 25; i++) await command({ kind: "pause_loop" });
      const first = verified(await pull());
      expect(first.map((c) => c.command_seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      expect(verified(await pull()).map((c) => c.command_seq)).toEqual([21, 22, 23, 24, 25]);
    });

    it("keeps to the sequence the runner already applied (`after_seq`)", async () => {
      await command({ kind: "pause_loop" });
      const keep = await command({ kind: "pause_loop" });
      const got = verified(await pull({ repo_gh_ids: [GH_A], after_seq: { [GH_A]: 1 } }));
      expect(got.map((c) => c.command_id)).toEqual([keep]);
    });

    it("a signature verifies only for that command: one flipped byte is bad_signature, and a late verification is expired", async () => {
      await command({ kind: "answer_ask", args: { ask_id: "0123456789abcdef", choice: "decline" } });
      const [c] = commandsOf(await pull());
      expect(() => verifyEngineCommand(c, keyring)).not.toThrow();
      const sig = c!.signature;
      const flipped = { ...c!, signature: `${sig.slice(0, 10)}${sig[10] === "A" ? "B" : "A"}${sig.slice(11)}` };
      expect(() => verifyEngineCommand(flipped, keyring)).toThrow(expect.objectContaining({ code: "bad_signature" }));
      const retargeted = { ...c!, command: { ...c!.command, runner_id: runnerOther } };
      expect(() => verifyEngineCommand(retargeted, keyring)).toThrow(expect.objectContaining({ code: "bad_signature" }));
      const wrongChoice = { ...c!, command: { ...c!.command, args: { ask_id: "0123456789abcdef", choice: "approve" } } };
      expect(() => verifyEngineCommand(wrongChoice, keyring)).toThrow(expect.objectContaining({ code: "bad_signature" }));
      expect(() => verifyEngineCommand(c, keyring, new Date(Date.now() + 11 * 60_000))).toThrow(JobSignatureError);
      expect(() => verifyEngineCommand(c, keyring, new Date(Date.now() + 11 * 60_000))).toThrow(expect.objectContaining({ code: "expired" }));
      expect(() => verifyEngineCommand(c, { other: keyring[KEY_ID]! })).toThrow(expect.objectContaining({ code: "unknown_key_id" }));
    });

    it("a command past its life becomes expired on the read and is never handed out", async () => {
      const dead = await command({ issuedAgo: "700 seconds", life: "600 seconds" });
      const live = await command();
      const res = await pull();
      expect(verified(res).map((c) => c.command_id)).toEqual([live]);
      expect(await stateOf(dead)).toBe("expired");
    });

    it("another runner of the account, and another account's runner, get none of it", async () => {
      const id = await command();
      expect(commandsOf(await pull({ repo_gh_ids: [GH_A], after_seq: {} }, keyOther))).toHaveLength(0);
      expect(commandsOf(await pull({ repo_gh_ids: [GH_A], after_seq: {} }, keyB))).toHaveLength(0);
      expect(await stateOf(id)).toBe("pending");
      expect(commandsOf(await pull())).toHaveLength(1);
    });

    it("a command for a repo the request did not name, or the runner no longer covers, or no longer runs locally, is not handed out", async () => {
      const other = await command({ repo: repo2 });
      const mine = await command();
      expect(verified(await pull()).map((c) => c.command_id)).toEqual([mine]);
      await h.admin.query("UPDATE repos SET execution_mode = 'sandbox' WHERE id = $1", [repo2]).catch(() => h.admin.query("UPDATE repos SET execution_mode = 'cloud' WHERE id = $1", [repo2]));
      expect(commandsOf(await pull({ repo_gh_ids: [GH_A2], after_seq: {} }))).toHaveLength(0);
      await h.admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [repo2]);
      await h.admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[] WHERE id = $1", [runnerId, [A.repoId]]);
      expect(commandsOf(await pull({ repo_gh_ids: [GH_A2], after_seq: {} }))).toHaveLength(0);
      expect(await stateOf(other)).toBe("pending");
    });

    it("answers `controls` for each named covered repo and `allowed_repos` for every repo the runner may bridge", async () => {
      const res = await pull({ repo_gh_ids: [GH_A, 1], after_seq: {} });
      expect(res.body).toMatchObject({
        controls: [{ repo_gh_id: GH_A, halt_epoch: 0, halted: false, operate_enabled: true }],
        allowed_repos: [{ repo_gh_id: GH_A, full_name: "acme/widgets" }, { repo_gh_id: GH_A2, full_name: "acme/second" }],
      });
      // Any one id is enough to learn the list, and an id the runner is not paired with leaves no trace in the answer.
      const probe = await pull({ repo_gh_ids: [1], after_seq: {} });
      expect(probe.body).toMatchObject({ commands: [], controls: [], allowed_repos: [{ repo_gh_id: GH_A }, { repo_gh_id: GH_A2 }] });
    });

    it("carries operate_enabled from the account's switches, and with operate off holds back every command", async () => {
      const ids = [await command(), await command({ kind: "pause_loop" }), await command({ kind: "stop_agent", args: { agent_id: "a-1" } })];
      await tmp("UPDATE engine_bridge_settings SET operate_enabled = false WHERE account_id = $1", [A.accountId]);
      const res = await pull();
      expect((res.body as { controls: Array<{ operate_enabled: boolean }> }).controls[0]!.operate_enabled).toBe(false);
      expect(commandsOf(res)).toHaveLength(0);
      for (const id of ids) expect(await stateOf(id)).toBe("pending");
      await tmp("UPDATE engine_bridge_settings SET operate_enabled = true, watch_enabled = false WHERE account_id = $1", [A.accountId]);
      const watchOff = await pull();
      expect(watchOff.body).toMatchObject({ controls: [{ operate_enabled: false }] });
      expect(commandsOf(watchOff)).toHaveLength(0);
      // Switched back on, the same commands (still alive) go out.
      await tmp("UPDATE engine_bridge_settings SET watch_enabled = true WHERE account_id = $1", [A.accountId]);
      expect(verified(await pull()).map((c) => c.command_id)).toEqual(ids);
    });

    it("carries the halt: its epoch and whether it holds, and withholds the start-like commands while it does", async () => {
      await tmp("INSERT INTO engine_repo_controls (account_id, repo_id, halted_at, halt_epoch) VALUES ($1, $2, now(), 3)", [A.accountId, A.repoId]);
      const kinds = ["start_day", "resume_loop", "request_spawn", "set_dial"] as const;
      const args: Record<string, object> = { request_spawn: { role: "executor", discussion: 1 }, set_dial: { dial_class: "agent.spawn", level: 1, ttl: "none" } };
      const start = [] as string[];
      for (const kind of kinds) start.push(await command({ kind, args: args[kind] ?? {}, epoch: 3 }));
      const pause = await command({ kind: "pause_loop" });
      const stop = await command({ kind: "stop_agent", args: { agent_id: "a-1" } });
      const answer = await command({ kind: "answer_ask", args: { ask_id: "0123456789abcdef", choice: "defer" } });
      const res = await pull();
      expect(res.body).toMatchObject({ controls: [{ repo_gh_id: GH_A, halt_epoch: 3, halted: true }] });
      expect(verified(res).map((c) => c.command_id)).toEqual([pause, stop, answer]);
      for (const id of start) expect(await stateOf(id)).toBe("pending");
      // Commands stamped with the current epoch go out once the halt is lifted.
      await tmp("UPDATE engine_repo_controls SET halted_at = NULL WHERE repo_id = $1", [A.repoId]);
      expect(verified(await pull()).map((c) => c.command_id)).toEqual(start);
    });

    it("never delivers a start-like command issued before a halt, even after the halt is cleared; the other kinds are unaffected", async () => {
      const kinds = ["start_day", "resume_loop", "request_spawn", "set_dial"] as const;
      const args: Record<string, object> = { request_spawn: { role: "executor", discussion: 1 }, set_dial: { dial_class: "agent.spawn", level: 1, ttl: "none" } };
      const before = [] as string[];
      for (const kind of kinds) before.push(await command({ kind, args: args[kind] ?? {}, epoch: 2 }));
      const pause = await command({ kind: "pause_loop", epoch: 2 });
      // The halt is set (epoch 3) and cleared between issue and pull.
      await tmp("INSERT INTO engine_repo_controls (account_id, repo_id, halted_at, halt_epoch) VALUES ($1, $2, NULL, 3)", [A.accountId, A.repoId]);
      const after = await command({ kind: "start_day", epoch: 3 });
      const res = await pull();
      expect(res.body).toMatchObject({ controls: [{ halt_epoch: 3, halted: false }] });
      expect(verified(res).map((c) => c.command_id)).toEqual([pause, after]);
      for (const id of before) expect(await stateOf(id)).toBe("pending");
      // Once their life is over they read as expired, never delivered.
      await h.admin.query("UPDATE engine_commands SET issued_at = now() - interval '700 seconds', expires_at = now() - interval '100 seconds' WHERE id = ANY($1::uuid[])", [before]);
      expect(commandsOf(await pull())).toHaveLength(0);
      for (const id of before) expect(await stateOf(id)).toBe("expired");
    });

    it("works with no halt table at all (before migration 1031): nothing is halted, epoch 0", async () => {
      await tmp("DROP TABLE engine_repo_controls");
      try {
        const id = await command();
        const res = await pull();
        expect(res.body).toMatchObject({ controls: [{ halt_epoch: 0, halted: false }] });
        expect(verified(res).map((c) => c.command_id)).toEqual([id]);
      } finally {
        await tmp("CREATE TABLE engine_repo_controls (account_id uuid, repo_id uuid PRIMARY KEY, halted_at timestamptz, halt_epoch integer NOT NULL DEFAULT 0)");
        await h.admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${SCRATCH} TO app_user`);
      }
    });

    it("two pulls at once hand each command to exactly one of them, in order", async () => {
      for (let i = 0; i < 6; i++) await command({ kind: "pause_loop" });
      const [x, y] = await Promise.all([pull(), pull()]);
      const all = [...commandsOf(x), ...commandsOf(y)].map((c) => c.command.command_seq).sort((p, q) => p - q);
      expect(all).toEqual([1, 2, 3, 4, 5, 6]);
    });
  });

  describe("the ack", () => {
    const delivered = async (over: Parameters<typeof command>[0] = {}) => command({ state: "delivered", ...over });

    it("records each outcome once, with a reason for a refusal, and writes one audit row of ids and enums", async () => {
      const a = await delivered({ kind: "pause_loop" });
      const r = await delivered({ kind: "start_day" });
      const n = await delivered({ kind: "stop_agent", args: { agent_id: "a-1" } });
      const e = await delivered({ kind: "resume_loop" });
      expect((await ack(a, { outcome: "applied" })).body).toEqual({ command_id: a, state: "applied" });
      expect((await ack(r, { outcome: "refused", refusal: "host_not_running" })).status).toBe(200);
      expect((await ack(n, { outcome: "not_confirmed" })).status).toBe(200);
      expect((await ack(e, { outcome: "expired" })).status).toBe(200);
      expect(await Promise.all([a, r, n, e].map(stateOf))).toEqual(["applied", "refused", "not_confirmed", "expired"]);
      const row = (await h.admin.query("SELECT refusal, acked_at FROM engine_commands WHERE id = $1", [r])).rows[0];
      expect(row).toMatchObject({ refusal: "host_not_running" });
      expect(row.acked_at).not.toBeNull();
      const rows = await audits();
      expect(rows).toHaveLength(4);
      expect(rows.map((x) => x.action)).toEqual(Array(4).fill("engine_command.acked"));
      expect(rows[1].payload).toEqual({ repo_id: A.repoId, command_id: r, kind: "start_day", outcome: "refused", refusal: "host_not_running" });
      expect(rows[0].payload).toEqual({ repo_id: A.repoId, command_id: a, kind: "pause_loop", outcome: "applied" });
    });

    it("the audit row names the person who registered the runner and never carries a note", async () => {
      const id = await delivered({ kind: "answer_ask", args: { ask_id: "0123456789abcdef", choice: "approve", note: "the secret plan" } });
      await ack(id, { outcome: "applied" });
      const row = (await h.admin.query("SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'engine_command.acked'", [A.accountId])).rows[0];
      expect(row.actor).toBe(A.userId);
      expect(JSON.stringify(row.payload)).not.toContain("secret");
    });

    it("a second ack is 409 and changes nothing; of two acks at once exactly one writes", async () => {
      const id = await delivered();
      expect((await ack(id, { outcome: "applied" })).status).toBe(200);
      expect(await ack(id, { outcome: "refused", refusal: "halted" })).toMatchObject({ status: 409 });
      expect(await stateOf(id)).toBe("applied");
      const race = await delivered();
      const results = await Promise.all([ack(race, { outcome: "applied" }), ack(race, { outcome: "refused", refusal: "ceiling" }), ack(race, { outcome: "not_confirmed" })]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
      expect((await audits()).length).toBe(2);
    });

    it("another runner of the account, another account's runner, an unknown id and a non-uuid are all 404", async () => {
      const id = await delivered();
      expect((await ack(id, { outcome: "applied" }, keyOther)).status).toBe(404);
      expect((await ack(id, { outcome: "applied" }, keyB)).status).toBe(404);
      expect((await ack(randomUUID(), { outcome: "applied" })).status).toBe(404);
      expect((await ack("not-a-uuid", { outcome: "applied" })).status).toBe(404);
      expect(await stateOf(id)).toBe("delivered");
      expect((await audits()).length).toBe(0);
    });

    it("an ack for a command never delivered is 409 not_delivered, for a cancelled or expired one too", async () => {
      const pending = await command();
      const res = await ack(pending, { outcome: "applied" });
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain("not_delivered");
      expect(await stateOf(pending)).toBe("pending");
      const cancelled = await command({ state: "cancelled" });
      expect((await ack(cancelled, { outcome: "applied" })).status).toBe(409);
    });

    it("a refusal needs its reason, an applied ack cannot carry one, and the body is closed", async () => {
      const id = await delivered();
      for (const bad of [{ outcome: "refused" }, { outcome: "applied", refusal: "halted" }, { outcome: "applied", extra: 1 }, { outcome: "done" }, { outcome: "refused", refusal: "because" }, {}]) {
        expect((await ack(id, bad)).status, JSON.stringify(bad)).toBe(400);
      }
      expect(await stateOf(id)).toBe("delivered");
    });

    it("an unsigned or revoked-runner ack is 401, a replayed or misdirected one is refused, and nothing changes twice", async () => {
      const id = await delivered();
      expect((await toResponse(() => ackEngineCommand(deps(), { method: "POST", headers: {}, body: Buffer.from('{"outcome":"applied"}') }, id))).status).toBe(401);
      const req = signed(key, engineCommandAckPath(id), { outcome: "applied" });
      expect((await toResponse(() => ackEngineCommand(deps(), req, id))).status).toBe(200);
      expect((await toResponse(() => ackEngineCommand(deps(), req, id))).status).toBe(409);
      // A signature made for another command's path does not carry over.
      const second = await delivered();
      const wrongPath = signed(key, engineCommandAckPath(id), { outcome: "applied" });
      expect((await toResponse(() => ackEngineCommand(deps(), wrongPath, second))).status).toBe(401);
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [runnerId]);
      expect((await ack(second, { outcome: "applied" })).status).toBe(401);
      expect(await stateOf(second)).toBe("delivered");
    });

    it("when the audit row cannot be written the ack is not stored and the answer is a 500", async () => {
      await h.admin.query(`CREATE TABLE ${SCRATCH}.audit_fail (account_id uuid PRIMARY KEY)`);
      await h.admin.query(
        `CREATE FUNCTION ${SCRATCH}.audit_fail_fn() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
         BEGIN IF EXISTS (SELECT 1 FROM ${SCRATCH}.audit_fail WHERE account_id = NEW.account_id) THEN RAISE EXCEPTION 'audit refused'; END IF; RETURN NEW; END $$`,
      );
      await h.admin.query(`CREATE TRIGGER ${SCRATCH}_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION ${SCRATCH}.audit_fail_fn()`);
      try {
        await h.admin.query(`INSERT INTO ${SCRATCH}.audit_fail VALUES ($1)`, [A.accountId]);
        const id = await delivered();
        expect((await ack(id, { outcome: "applied" })).status).toBe(500);
        expect(await stateOf(id)).toBe("delivered");
        expect((await audits()).length).toBe(0);
        await h.admin.query(`DELETE FROM ${SCRATCH}.audit_fail`);
        expect((await ack(id, { outcome: "applied" })).status).toBe(200);
        expect(await stateOf(id)).toBe("applied");
      } finally {
        await h.admin.query(`DROP TRIGGER ${SCRATCH}_audit_fail ON audit_log`);
      }
    });

    it("an ack long after the command expired is still taken (the engine may have applied it before)", async () => {
      const id = await delivered({ issuedAgo: "30 minutes", life: "600 seconds" });
      expect((await ack(id, { outcome: "applied" })).status).toBe(200);
    });
  });

  /** D#845 watch mode: `watch` is the one kind that is delivered while operate is off (ruling 11), and only to a runner that knows it, for a ticked repo, with the watch switch on. */
  describe("the pull: watch", () => {
    const until = () => new Date(Date.now() + 300_000).toISOString();
    const watchCommand = (over: { runner?: string; repo?: string } = {}) => command({ kind: "watch", args: { until: until() }, ...over });
    const setProtocol = (version: number | null, runner = runnerId) => h.admin.query("UPDATE runners SET protocol_version = $2 WHERE id = $1", [runner, version]);
    const tick = (repo = A.repoId) => h.admin.query("INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [A.accountId, repo]);
    const operateOff = () => tmp("UPDATE engine_bridge_settings SET operate_enabled = false WHERE account_id = $1", [A.accountId]);
    beforeEach(async () => {
      await h.admin.query("DELETE FROM engine_bridge_repos WHERE account_id = $1", [A.accountId]);
      await tick();
      await setProtocol(23);
    });
    afterAll(() => setProtocol(null));

    it("is delivered with operate off, signed, while every other kind is still held back", async () => {
      await operateOff();
      const watch = await watchCommand();
      const other = await command({ kind: "pause_loop" });
      const res = await pull();
      expect(res.status).toBe(200);
      expect(verified(res).map((c) => [c.kind, c.command_id])).toEqual([["watch", watch]]);
      expect(await stateOf(watch)).toBe("delivered");
      expect(await stateOf(other)).toBe("pending");
      expect(res.body).toMatchObject({ controls: [{ operate_enabled: false }] });
    });

    it("is delivered with operate on, in sequence order with the rest", async () => {
      const first = await command({ kind: "pause_loop" });
      const watch = await watchCommand();
      expect(verified(await pull()).map((c) => c.command_id)).toEqual([first, watch]);
    });

    it("is held (pending, not delivered) for a runner whose hello is below the watch protocol, or unknown, and goes out once it is at it", async () => {
      await operateOff();
      const watch = await watchCommand();
      for (const v of [22, 1, null]) {
        await setProtocol(v);
        expect(commandsOf(await pull()), String(v)).toEqual([]);
      }
      expect(await stateOf(watch)).toBe("pending");
      await setProtocol(23);
      expect(verified(await pull()).map((c) => c.command_id)).toEqual([watch]);
    });

    it("is held while the account's watch switch is off, even with operate on in the scratch row", async () => {
      await tmp("UPDATE engine_bridge_settings SET watch_enabled = false, operate_enabled = false WHERE account_id = $1", [A.accountId]);
      const watch = await watchCommand();
      expect(commandsOf(await pull())).toEqual([]);
      expect(await stateOf(watch)).toBe("pending");
    });

    it("is held for a repo that is not ticked, and delivered for the ticked one in the same pull", async () => {
      await operateOff();
      await h.admin.query("DELETE FROM engine_bridge_repos WHERE account_id = $1", [A.accountId]);
      await tick(repo2);
      const unticked = await watchCommand();
      const ticked = await watchCommand({ repo: repo2 });
      const res = await pull({ repo_gh_ids: [GH_A, GH_A2], after_seq: {} });
      expect(verified(res).map((c) => c.command_id)).toEqual([ticked]);
      expect(await stateOf(unticked)).toBe("pending");
    });

    it("never goes to another runner, and an expired one is not delivered", async () => {
      await operateOff();
      await setProtocol(23, runnerOther);
      const theirs = await watchCommand({ runner: runnerOther });
      const old = await command({ kind: "watch", args: { until: until() }, issuedAgo: "20 minutes", life: "600 seconds" });
      expect(commandsOf(await pull())).toEqual([]);
      expect(await stateOf(theirs)).toBe("pending");
      expect(await stateOf(old)).toBe("expired");
    });
  });
});

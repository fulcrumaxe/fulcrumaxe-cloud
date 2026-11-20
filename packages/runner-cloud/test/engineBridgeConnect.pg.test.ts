import { randomUUID, generateKeyPairSync, type KeyObject } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BRIDGE_ENABLE_MIN_PROTOCOL, verifyEngineCommand, type EngineCommand, type SignedEngineCommand } from "@fulcrumaxe/runner-protocol";
import { createJobSigner } from "@fx/runner";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { ENGINE_COMMANDS_PULL_PATH, ackEngineCommand, engineCommandAckPath, pullEngineCommands, toResponse, type RunnerCloudDeps } from "../src/index.js";
import { harness, newKey, registerKey, signed, type Harness, type TestKey } from "./helpers.js";

/**
 * [pg] D#845 ON-BR-2: the runner's side of Connect and Disconnect against migration 1042: the bridge commands are delivered to the runner with no operate switch and no engine session, are
 * never handed to the engine's own pull, wait for a hello at protocol 24, and are answered with a result; the runner's report of what it bridges is stored per runner and repo under RLS.
 */
const SCRATCH = `onbr2_${Math.random().toString(36).slice(2, 10)}`;
const GH_A = 6_100_000 + Math.floor(Math.random() * 100_000);
const GH_A2 = GH_A + 1;
const KEY_ID = "test-signer-1";
const ROOT = "/work/acme/widgets";

describe("engine bridge connect: pull, ack and report [pg]", () => {
  let h: Harness;
  let one: Pool;
  let A: SeedRefs;
  let B: SeedRefs;
  let key: TestKey;
  let runnerId: string;
  let keyB: TestKey;
  let runnerB: string;
  let signKey: KeyObject;
  let keyring: Record<string, KeyObject>;
  let repo2: string;
  const seqs = new Map<string, number>();

  const signer = () => createJobSigner({ keyId: KEY_ID, privateKey: signKey });
  const deps = (): RunnerCloudDeps => h.deps({ appUserPool: one, engineCommandSigner: async () => signer() });
  const tmp = (sql: string, args: unknown[] = []) => h.admin.query(sql.replace(/\b(engine_bridge_settings|engine_repo_controls)\b/g, `${SCRATCH}.$1`), args);
  const bridgePull = (extra: object = {}, k: TestKey = key) => toResponse(() => pullEngineCommands(deps(), signed(k, ENGINE_COMMANDS_PULL_PATH, { repo_gh_ids: [Number.MAX_SAFE_INTEGER], after_seq: {}, bridge_commands: true, ...extra })));
  const enginePull = (body: object = { repo_gh_ids: [GH_A], after_seq: {} }, k: TestKey = key) => toResponse(() => pullEngineCommands(deps(), signed(k, ENGINE_COMMANDS_PULL_PATH, body)));
  const ack = (id: string, body: unknown, k: TestKey = key) => toResponse(() => ackEngineCommand(deps(), signed(k, engineCommandAckPath(id), body), id));
  const commandsOf = (res: { body: unknown }) => (res.body as { commands: SignedEngineCommand[] }).commands;
  const verified = (res: { body: unknown }): EngineCommand[] => commandsOf(res).map((c) => verifyEngineCommand(c, keyring));

  async function command(over: { runner?: string; repo?: string; kind?: string; args?: object; state?: string; life?: string; account?: string } = {}): Promise<string> {
    const runner = over.runner ?? runnerId;
    const repo = over.repo ?? A.repoId;
    const k = `${runner}:${repo}`;
    const seq = (seqs.get(k) ?? 0) + 1;
    seqs.set(k, seq);
    const state = over.state ?? "pending";
    const r = await h.admin.query<{ id: string }>(
      `INSERT INTO engine_commands (account_id, runner_id, repo_id, command_seq, kind, args, issued_by, issued_at, expires_at, state, delivered_at, acked_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, now(), now() + $8::interval, $9, $10, NULL) RETURNING id`,
      [over.account ?? A.accountId, runner, repo, seq, over.kind ?? "bridge_enable", JSON.stringify(over.args ?? {}), A.userId, over.life ?? "600 seconds", state, state === "delivered" ? new Date() : null],
    );
    return r.rows[0]!.id;
  }
  const row = async (id: string) => (await h.admin.query("SELECT state, refusal, ack_result FROM engine_commands WHERE id = $1", [id])).rows[0] as { state: string; refusal: string | null; ack_result: Record<string, unknown> | null };
  const reports = async (accountId = A.accountId) => (await h.admin.query("SELECT runner_id, repo_id, root FROM engine_runner_bridges WHERE account_id = $1 ORDER BY repo_id", [accountId])).rows;
  const setProtocol = (id: string, v: number | null) => h.admin.query("UPDATE runners SET protocol_version = $2 WHERE id = $1", [id, v]);

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
    keyB = newKey();
    runnerB = await registerKey(h.admin, B.accountId, B.userId, keyB);
    await h.admin.query("UPDATE repos SET gh_repo_id = $2, gh_owner = 'acme', gh_name = 'widgets', execution_mode = 'runner_local' WHERE id = $1", [A.repoId, GH_A]);
    repo2 = (await h.admin.query<{ id: string }>(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, NULL, $2, 'web', 'acme', 'second', 'runner_local') RETURNING id`, [A.accountId, GH_A2])).rows[0]!.id;
  });
  afterAll(async () => {
    await one.end();
    await h.admin.query(`DROP SCHEMA ${SCRATCH} CASCADE`);
    await h.close();
  });
  beforeEach(async () => {
    await h.admin.query("DELETE FROM engine_runner_bridges WHERE account_id = ANY ($1::uuid[])", [[A.accountId, B.accountId]]);
    await h.admin.query("DELETE FROM engine_commands WHERE account_id = ANY ($1::uuid[])", [[A.accountId, B.accountId]]);
    seqs.clear();
    await h.admin.query("UPDATE runners SET revoked_at = NULL, allowed_repo_ids = $2::uuid[], protocol_version = 24 WHERE id = $1", [runnerId, [A.repoId, repo2]]);
    await h.admin.query("UPDATE runners SET protocol_version = 24 WHERE id = $1", [runnerB]);
    await tmp("TRUNCATE engine_bridge_settings");
    await tmp("TRUNCATE engine_repo_controls");
  });

  describe("delivery", () => {
    it("hands a bridge_enable to the runner with operate off and no engine session, signed for the runner and repo, with its folder inside the signature", async () => {
      expect(((await tmp("SELECT count(*)::int AS n FROM engine_bridge_settings")).rows[0] as { n: number }).n).toBe(0);
      const id = await command({ args: { repo_root: ROOT } });
      const res = await bridgePull();
      expect(res.status).toBe(200);
      const [cmd] = verified(res);
      expect(cmd).toMatchObject({ kind: "bridge_enable", command_id: id, runner_id: runnerId, repo_gh_id: GH_A, args: { repo_root: ROOT } });
      expect((await row(id)).state).toBe("delivered");
      // Delivered once.
      expect(commandsOf(await bridgePull())).toHaveLength(0);
      // A changed folder fails verification: the folder is inside the signature.
      const signedOne = commandsOf(res)[0]!;
      expect(() => verifyEngineCommand({ ...signedOne, command: { ...signedOne.command, args: { repo_root: "/work/acme/other" } } }, keyring)).toThrow();
    });

    it("hands over a command for a repo the runner does not name, and when operate is on too; the engine's own pull never gets one", async () => {
      await tmp("INSERT INTO engine_bridge_settings VALUES ($1, true, true)", [A.accountId]);
      const a = await command({ kind: "bridge_disable" });
      const b = await command({ repo: repo2 });
      const engineSide = await enginePull({ repo_gh_ids: [GH_A, GH_A2], after_seq: {} });
      expect(commandsOf(engineSide)).toHaveLength(0);
      expect((await row(a)).state).toBe("pending");
      const res = await bridgePull();
      expect(verified(res).map((c) => [c.kind, c.repo_gh_id]).sort()).toEqual([["bridge_disable", GH_A], ["bridge_enable", GH_A2]]);
      expect((await row(b)).state).toBe("delivered");
    });

    it("without bridge_commands nothing is delivered, and the other kinds still wait for operate", async () => {
      const id = await command();
      const other = await command({ kind: "pause_loop" });
      expect(commandsOf(await enginePull())).toHaveLength(0);
      const res = await bridgePull();
      expect(verified(res).map((c) => c.kind)).toEqual(["bridge_enable"]);
      expect((await row(id)).state).toBe("delivered");
      expect((await row(other)).state).toBe("pending");
      // Operate on: the engine kind comes, once, on the engine's own pull.
      await tmp("INSERT INTO engine_bridge_settings VALUES ($1, true, true)", [A.accountId]);
      expect(verified(await enginePull()).map((c) => c.kind)).toEqual(["pause_loop"]);
    });

    it("is never sent to a runner whose hello is below 24, and the command stays for it", async () => {
      const id = await command();
      for (const v of [20, 22, 23, null]) {
        await setProtocol(runnerId, v);
        const res = await bridgePull().catch(() => undefined);
        // An older hello's strict parse refuses the new key; either way nothing is delivered.
        expect(res === undefined || res.status !== 200, `protocol ${v}`).toBe(true);
        expect((await row(id)).state, `protocol ${v}`).toBe("pending");
      }
      await setProtocol(runnerId, BRIDGE_ENABLE_MIN_PROTOCOL);
      expect(verified(await bridgePull())).toHaveLength(1);
    });

    it("refuses the bridge fields from a hello below 24 with a 400 and delivers nothing", async () => {
      const id = await command();
      await setProtocol(runnerId, 23);
      for (const extra of [{}, { bridged: [] }]) {
        const res = await bridgePull(extra);
        expect(res.status, JSON.stringify(extra)).toBe(400);
      }
      expect((await enginePull()).status).toBe(200);
      expect((await row(id)).state).toBe("pending");
    });

    it("another runner's, another account's, an expired, a cancelled and a revoked runner's commands are not delivered", async () => {
      const other = await registerKey(h.admin, A.accountId, A.userId, newKey());
      await h.admin.query("UPDATE runners SET protocol_version = 24, allowed_repo_ids = $2::uuid[] WHERE id = $1", [other, [A.repoId]]);
      await command({ runner: other });
      await command({ life: "1 second" });
      await h.admin.query("UPDATE engine_commands SET expires_at = now() - interval '1 second', issued_at = now() - interval '2 seconds' WHERE runner_id = $1", [runnerId]);
      const cancelled = await command();
      await h.admin.query("UPDATE engine_commands SET state = 'cancelled' WHERE id = $1", [cancelled]);
      expect(commandsOf(await bridgePull())).toHaveLength(0);
      await command({ kind: "bridge_disable" });
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [runnerId]);
      expect((await bridgePull()).status).toBe(401);
    });
  });

  describe("the ack", () => {
    async function delivered(over: Parameters<typeof command>[0] = {}): Promise<string> {
      const id = await command(over);
      await bridgePull();
      return id;
    }

    it.each([
      ["connected", { outcome: "applied", result: "connected", root_tail: "acme/widgets" }, "applied", null],
      ["already_connected", { outcome: "applied", result: "already_connected" }, "applied", null],
      ["not_found", { outcome: "refused", refusal: "checkout_not_found", result: "not_found", skipped: ["/work/skipped/widgets"] }, "refused", "checkout_not_found"],
      ["ambiguous", { outcome: "refused", refusal: "checkout_ambiguous", result: "ambiguous", candidates: ["/work/a/widgets", "/work/b/widgets"] }, "refused", "checkout_ambiguous"],
      ["refused", { outcome: "refused", refusal: "state_dir_missing", result: "refused" }, "refused", "state_dir_missing"],
      ["incomplete", { outcome: "refused", refusal: "checkout_incomplete", result: "refused", candidates: ["/work/one/widgets"] }, "refused", "checkout_incomplete"],
    ])("stores the %s result with its folders", async (_name, body, state, refusal) => {
      const id = await delivered();
      const res = await ack(id, body);
      expect(res.status).toBe(200);
      const got = await row(id);
      expect(got).toMatchObject({ state, refusal });
      const stored = Object.fromEntries(Object.entries(body as Record<string, unknown>).filter(([k]) => k !== "outcome" && k !== "refusal"));
      expect(got.ack_result).toEqual(stored);
    });

    it("refuses a malformed result, a result on another kind, and an enable that was applied or refused for a bridge reason with none", async () => {
      const enable = await delivered();
      for (const bad of [{ outcome: "applied", result: "teleported" }, { outcome: "applied", result: "connected" }, { outcome: "refused", refusal: "checkout_ambiguous", result: "ambiguous", candidates: ["/work/a"] }, { outcome: "applied", result: "connected", root_tail: "a/b", extra: 1 }]) {
        expect((await ack(enable, bad)).status, JSON.stringify(bad)).toBe(400);
      }
      // Applied or refused for a bridge reason, with no result.
      expect((await ack(enable, { outcome: "applied" })).status).toBe(400);
      expect((await ack(enable, { outcome: "refused", refusal: "checkout_mismatch" })).status).toBe(400);
      expect((await row(enable)).state).toBe("delivered");
      // The existing refusals need none.
      expect((await ack(enable, { outcome: "refused", refusal: "seq_not_increasing" })).status).toBe(200);
      const disable = await delivered({ kind: "bridge_disable" });
      expect((await ack(disable, { outcome: "applied", result: "connected", root_tail: "a/b" })).status).toBe(400);
      expect((await ack(disable, { outcome: "applied" })).status).toBe(200);
    });

    it("ON-BR-4: a not_found with incomplete: true is stored whole from a runner at 26; a runner below 26 sending it is refused and nothing is stored; one without the key is stored as before", async () => {
      const body = { outcome: "refused", refusal: "checkout_not_found", result: "not_found", incomplete: true };
      const old = await delivered();
      expect((await ack(old, body)).status).toBe(400);
      expect(await row(old)).toMatchObject({ state: "delivered", ack_result: null });
      expect((await ack(old, { outcome: "refused", refusal: "checkout_not_found", result: "not_found" })).status).toBe(200);
      expect((await row(old)).ack_result).toEqual({ result: "not_found" });
      await setProtocol(runnerId, 26);
      try {
        const id = await delivered();
        expect((await ack(id, body)).status).toBe(200);
        expect(await row(id)).toMatchObject({ state: "refused", refusal: "checkout_not_found", ack_result: { result: "not_found", incomplete: true } });
        const withSkipped = await delivered();
        expect((await ack(withSkipped, { ...body, skipped: ["/work/skipped/widgets"] })).status).toBe(200);
        expect((await row(withSkipped)).ack_result).toEqual({ result: "not_found", skipped: ["/work/skipped/widgets"], incomplete: true });
        const amb = await delivered();
        expect((await ack(amb, { outcome: "refused", refusal: "checkout_ambiguous", result: "ambiguous", candidates: ["/work/a", "/work/b"], incomplete: true })).status).toBe(400);
      } finally {
        await setProtocol(runnerId, 24);
      }
    });

    it("ON-BR-4: the table itself holds incomplete to the boolean true on a not_found, and rows without it stay valid", async () => {
      const set = async (json: string) => {
        const id = await command();
        await h.admin.query("UPDATE engine_commands SET state = 'delivered', delivered_at = now() WHERE id = $1", [id]);
        return h.admin.query(`UPDATE engine_commands SET state = 'refused', refusal = 'checkout_not_found', acked_at = now(), ack_result = $2::jsonb WHERE id = $1`, [id, json]);
      };
      await expect(set('{"result":"not_found","incomplete":true}')).resolves.toBeTruthy();
      await expect(set('{"result":"not_found"}')).resolves.toBeTruthy();
      for (const bad of ['{"result":"not_found","incomplete":false}', '{"result":"not_found","incomplete":"true"}', '{"result":"not_found","incomplete":1}', '{"result":"ambiguous","candidates":["/work/a","/work/b"],"incomplete":true}', '{"result":"refused","incomplete":true}']) {
        await expect(set(bad), bad).rejects.toThrow();
      }
    });

    it("one ack per command, and another runner's ack is 404", async () => {
      const id = await delivered();
      expect((await ack(id, { outcome: "applied", result: "already_connected" }, keyB)).status).toBe(404);
      expect((await ack(id, { outcome: "applied", result: "already_connected" })).status).toBe(200);
      expect((await ack(id, { outcome: "applied", result: "already_connected" })).status).toBe(409);
    });

    it("a connect adds the runner's report for the repo and a disconnect removes it; the audit row holds no folder", async () => {
      const on = await delivered();
      await ack(on, { outcome: "applied", result: "connected", root_tail: "acme/widgets" });
      expect(await reports()).toEqual([{ runner_id: runnerId, repo_id: A.repoId, root: null }]);
      const off = await delivered({ kind: "bridge_disable" });
      await ack(off, { outcome: "applied" });
      expect(await reports()).toEqual([]);
      const log = (await h.admin.query("SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'engine_command.acked' AND payload ->> 'command_id' = ANY ($2::text[])", [A.accountId, [on, off]])).rows;
      expect(log).toHaveLength(2);
      expect(JSON.stringify(log)).not.toContain("acme/widgets");
      expect(JSON.stringify(log)).not.toContain("/work");
    });

    it("a refused enable adds no report", async () => {
      const id = await delivered();
      await ack(id, { outcome: "refused", refusal: "checkout_not_found", result: "not_found" });
      expect(await reports()).toEqual([]);
    });
  });

  describe("what the runner reports", () => {
    it("stores each repo with its checkout, replaces the set on the next report, and drops a repo the runner no longer lists", async () => {
      expect((await bridgePull({ bridged: [{ repo_gh_id: GH_A, root: ROOT }, { repo_gh_id: GH_A2 }] })).status).toBe(200);
      expect(await reports()).toHaveLength(2);
      expect((await h.admin.query("SELECT root FROM engine_runner_bridges WHERE repo_id = $1", [A.repoId])).rows[0]!.root).toBe(ROOT);
      expect((await h.admin.query("SELECT root FROM engine_runner_bridges WHERE repo_id = $1", [repo2])).rows[0]!.root).toBeNull();
      await bridgePull({ bridged: [{ repo_gh_id: GH_A, root: "/work/moved/widgets" }] });
      const left = await reports();
      expect(left).toEqual([{ runner_id: runnerId, repo_id: A.repoId, root: "/work/moved/widgets" }]);
      // An empty list is a runner that bridges nothing; an absent one changes nothing.
      await bridgePull();
      expect(await reports()).toHaveLength(1);
      await bridgePull({ bridged: [] });
      expect(await reports()).toEqual([]);
    });

    it("keeps only repos the runner is paired with; one it is not paired with, or another account's, is ignored", async () => {
      await h.admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[] WHERE id = $1", [runnerId, [A.repoId]]);
      await bridgePull({ bridged: [{ repo_gh_id: GH_A, root: ROOT }, { repo_gh_id: GH_A2, root: "/work/x/second" }, { repo_gh_id: 424242, root: "/work/y/z" }] });
      expect(await reports()).toEqual([{ runner_id: runnerId, repo_id: A.repoId, root: ROOT }]);
      expect(await reports(B.accountId)).toEqual([]);
    });

    it("is read under RLS: runner B's report never touches A's rows, and the RLS-bypassing client with a foreign account id reads none", async () => {
      await bridgePull({ bridged: [{ repo_gh_id: GH_A, root: ROOT }] });
      expect((await bridgePull({ bridged: [] }, keyB)).status).toBe(200);
      expect(await reports()).toHaveLength(1);
      expect(await reports(B.accountId)).toHaveLength(0);
      // The tenant's own view: account B reads no row of A's, A reads its own.
      const asB = await one.connect();
      try {
        await asB.query("BEGIN");
        await asB.query("SELECT set_config('app.account_id', $1, true)", [B.accountId]);
        expect((await asB.query("SELECT 1 FROM engine_runner_bridges")).rowCount).toBe(0);
        await asB.query("SELECT set_config('app.account_id', $1, true)", [A.accountId]);
        expect((await asB.query("SELECT 1 FROM engine_runner_bridges")).rowCount).toBe(1);
        // Without a runner session no one writes: not even an account's own member, and a runner session cannot write another runner's row.
        await expect(asB.query("INSERT INTO engine_runner_bridges (account_id, runner_id, repo_id, root) VALUES ($1, $2, $3, NULL)", [A.accountId, runnerId, repo2])).rejects.toThrow();
        await asB.query("ROLLBACK");
        await asB.query("BEGIN");
        await asB.query("SELECT set_config('app.account_id', $1, true)", [A.accountId]);
        await asB.query("SELECT set_config('app.runner_id', $1, true)", [randomUUID()]);
        expect((await asB.query("DELETE FROM engine_runner_bridges")).rowCount).toBe(0);
        expect((await asB.query("UPDATE engine_runner_bridges SET root = '/work/hijack/x'")).rowCount).toBe(0);
        await asB.query("ROLLBACK");
      } finally {
        asB.release();
      }
      expect((await h.admin.query("SELECT root FROM engine_runner_bridges WHERE account_id = $1", [A.accountId])).rows[0]!.root).toBe(ROOT);
    });

    it("removing the runner or the repo removes its report", async () => {
      await bridgePull({ bridged: [{ repo_gh_id: GH_A, root: ROOT }, { repo_gh_id: GH_A2, root: "/work/x/second" }] });
      await h.admin.query("DELETE FROM repos WHERE id = $1", [repo2]);
      expect(await reports()).toHaveLength(1);
      repo2 = (await h.admin.query<{ id: string }>(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, NULL, $2, 'web', 'acme', 'second', 'runner_local') RETURNING id`, [A.accountId, GH_A2])).rows[0]!.id;
      const extra = await registerKey(h.admin, A.accountId, A.userId, newKey());
      await h.admin.query("INSERT INTO engine_runner_bridges (account_id, runner_id, repo_id, root) VALUES ($1, $2, $3, '/work/z/z')", [A.accountId, extra, A.repoId]);
      await h.admin.query("DELETE FROM runners WHERE id = $1", [extra]);
      expect((await reports()).map((r) => r.runner_id)).toEqual([runnerId]);
    });

    it("refuses a root that is not a plain absolute folder at the table, whatever the route did", async () => {
      for (const bad of ["relative", "/work/../x", "/work/a\nb", "/work/a‮b", "/" + "a".repeat(1024)]) {
        await expect(h.admin.query("INSERT INTO engine_runner_bridges (account_id, runner_id, repo_id, root) VALUES ($1, $2, $3, $4)", [A.accountId, runnerId, A.repoId, bad]), JSON.stringify(bad).slice(0, 20)).rejects.toThrow();
      }
    });
  });

  describe("the table", () => {
    it("refuses a bridge command with a folder that is not a plain absolute one, a result on another kind, and a result that is not closed", async () => {
      for (const args of [{ repo_root: "relative" }, { repo_root: "/work/../x" }, { repo_root: "/work/a‮b" }, { repo_root: "/" + "a".repeat(1024) }, { repo_root: "/work/a", extra: 1 }]) {
        await expect(command({ args }), JSON.stringify(args).slice(0, 30)).rejects.toThrow();
      }
      await expect(command({ kind: "bridge_disable", args: { repo_root: "/work/a" } })).rejects.toThrow();
      const other = await command({ kind: "pause_loop" });
      await h.admin.query("UPDATE engine_commands SET state = 'delivered', delivered_at = now() WHERE id = $1", [other]);
      await expect(h.admin.query(`UPDATE engine_commands SET state = 'applied', acked_at = now(), ack_result = '{"result":"connected"}'::jsonb WHERE id = $1`, [other])).rejects.toThrow();
      const enable = await command();
      await h.admin.query("UPDATE engine_commands SET state = 'delivered', delivered_at = now() WHERE id = $1", [enable]);
      await expect(h.admin.query(`UPDATE engine_commands SET state = 'applied', acked_at = now(), ack_result = '{"result":"connected","path":"/x"}'::jsonb WHERE id = $1`, [enable])).rejects.toThrow();
      await expect(h.admin.query(`UPDATE engine_commands SET state = 'applied', acked_at = now(), ack_result = '{"result":"vanished"}'::jsonb WHERE id = $1`, [enable])).rejects.toThrow();
    });
  });
});

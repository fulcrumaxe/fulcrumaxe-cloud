import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ENGINE_DECISION_TYPES, ENGINE_SPEC_TAGS, getCatalogueEntry, decide, type Disposition, type EngineDecisionType, type PresetName } from "@fx/decisions";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { ENGINE_DECIDE_PATH, engineDecide, pgEngineDecidePorts, toResponse, type EngineDecideAuditEntry, type EngineDecidePorts, type RunnerCloudDeps } from "../src/index.js";
import { harness, newKey, registerKey, signed, type Harness, type TestKey } from "./helpers.js";

/**
 * [pg] EB-9a: POST /api/runner/engine/decide against migration 1030. The bridge tables the route reads (settings, repos, commands) and
 * EB-11a's controls are built by their own rows; here each is a table of the Spec's shape in a scratch schema that the route's pool lists
 * before `public`, so it shadows a real table of the same name once that exists. The decisions and answers tables, their RLS and the
 * route are the real thing.
 */
const SCRATCH = `eb9a_${Math.random().toString(36).slice(2, 10)}`;
const GH_REPO_ID = 4_242_000 + Math.floor(Math.random() * 100_000);
const PRESETS: PresetName[] = ["cautious", "balanced", "autonomous"];

describe("engine decide route [pg]", () => {
  let h: Harness;
  let one: Pool;
  let A: SeedRefs;
  let B: SeedRefs;
  let key: TestKey;
  let runnerId: string;
  let owner: string;
  let member: string;
  const audits: EngineDecideAuditEntry[] = [];
  let auditFail = false;

  const ports = (over: Partial<EngineDecidePorts> = {}): EngineDecidePorts => ({
    ...pgEngineDecidePorts,
    audit: async (client, entry) => {
      if (auditFail) throw new Error("audit down");
      await client.query("SELECT 1");
      audits.push(entry);
    },
    ...over,
  });
  const deps = (p: EngineDecidePorts | null = ports()): RunnerCloudDeps => h.deps({ appUserPool: one, engineDecide: p });
  const body = (over: Record<string, unknown> = {}) => ({ repo_gh_id: GH_REPO_ID, decision_type: "engine_merge", request_key: `merge:1:${randomUUID().slice(0, 8)}`, subject: { pr: 1 }, ...over });
  const ask = async (b: unknown = body(), d: RunnerCloudDeps = deps(), k: TestKey = key) => toResponse(() => engineDecide(d, signed(k, ENGINE_DECIDE_PATH, b)));
  const receipts = async (repoId = A.repoId) => (await h.admin.query("SELECT * FROM engine_decisions WHERE repo_id = $1 ORDER BY created_at", [repoId])).rows;
  const tmp = (sql: string, args: unknown[] = []) =>
    h.admin.query(sql.replace(/\b(engine_bridge_settings|engine_bridge_repos|engine_commands|engine_repo_controls)\b/g, `${SCRATCH}.$1`), args);

  const setDial = (type: EngineDecisionType, disposition: Disposition, preset: string | null = null) =>
    h.admin.query(
      `INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, preset, version, changed_by)
       VALUES ($1, $2, $3, $4, $5, (SELECT COALESCE(max(version), 0) + 1 FROM decision_settings WHERE repo_id = $2 AND decision_type = $3), $6)`,
      [A.accountId, A.repoId, type, disposition, preset, A.userId],
    );
  const dialUnder = (type: EngineDecisionType, preset: PresetName): Disposition => decide(getCatalogueEntry(type), { preset }, { type } as never).disposition;
  const applyPreset = async (preset: PresetName) => {
    for (const t of ENGINE_DECISION_TYPES) await setDial(t, dialUnder(t, preset), preset);
  };
  const asMember = <T>(who: string, fn: (c: PoolClient) => Promise<T>, accountId = A.accountId) => withTenant(h.appPool, accountId, who, fn);
  const answer = (who: string, decisionId: string, choice: string, by = who) =>
    asMember(who, (c) => c.query("INSERT INTO engine_decision_answers (account_id, decision_id, choice, answered_by) VALUES ($1, $2, $3, $4)", [A.accountId, decisionId, choice, by]));

  beforeAll(async () => {
    h = await harness();
    await h.admin.query(`CREATE SCHEMA ${SCRATCH}`);
    await h.admin.query(`GRANT USAGE ON SCHEMA ${SCRATCH} TO app_user`);
    one = createPool(process.env.RUNNER_CLOUD_DATABASE_URL_APP_USER!, { options: `-c search_path=${SCRATCH},public` });
    // The Spec's shapes, only the columns this route reads. 
    await tmp("CREATE TABLE engine_bridge_settings (account_id uuid PRIMARY KEY, watch_enabled boolean NOT NULL DEFAULT false, operate_enabled boolean NOT NULL DEFAULT false)");
    await tmp("CREATE TABLE engine_bridge_repos (account_id uuid NOT NULL, repo_id uuid NOT NULL)");
    await tmp(`CREATE TABLE engine_commands (id uuid PRIMARY KEY, account_id uuid, runner_id uuid, repo_id uuid, kind text, args jsonb, issued_by uuid, expires_at timestamptz, state text)`);
    await tmp("CREATE TABLE engine_repo_controls (account_id uuid, repo_id uuid PRIMARY KEY, halted_at timestamptz)");
    await h.admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${SCRATCH} TO app_user`);
    A = await seedAccount(h.admin, randomUUID());
    B = await seedAccount(h.admin, randomUUID());
    key = newKey();
    runnerId = await registerKey(h.admin, A.accountId, A.userId, key);
    owner = A.userId;
    member = randomUUID();
    await h.admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [member, `${member}@example.test`]);
    await h.admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')", [A.accountId, member]);
    await h.admin.query("UPDATE repos SET gh_repo_id = $2, execution_mode = 'runner_local' WHERE id = $1", [A.repoId, GH_REPO_ID]);
    await h.admin.query("UPDATE repos SET gh_repo_id = $2, execution_mode = 'runner_local' WHERE id = $1", [B.repoId, GH_REPO_ID]);
  });
  afterAll(async () => {
    await one.end();
    await h.admin.query(`DROP SCHEMA ${SCRATCH} CASCADE`);
    await h.close();
  });
  beforeEach(async () => {
    audits.length = 0;
    auditFail = false;
    await h.admin.query("UPDATE runners SET revoked_at = NULL, allowed_repo_ids = $2::uuid[] WHERE id = $1", [runnerId, [A.repoId]]);
    await h.admin.query("DELETE FROM engine_decisions WHERE account_id = ANY ($1::uuid[])", [[A.accountId, B.accountId]]);
    await h.admin.query("DELETE FROM decision_settings WHERE account_id = ANY ($1::uuid[])", [[A.accountId, B.accountId]]).catch(() => undefined);
    await tmp("TRUNCATE engine_bridge_settings");
    await tmp("TRUNCATE engine_bridge_repos");
    await tmp("TRUNCATE engine_commands");
    await tmp("TRUNCATE engine_repo_controls");
    await tmp("INSERT INTO engine_bridge_settings VALUES ($1, true, true)", [A.accountId]);
    await tmp("INSERT INTO engine_bridge_repos VALUES ($1, $2)", [A.accountId, A.repoId]);
  });

  describe("the door", () => {
    it("an unsigned request, a revoked runner and another key are 401, and nothing is written", async () => {
      expect((await toResponse(() => engineDecide(deps(), { method: "POST", headers: {}, body: Buffer.from(JSON.stringify(body())) }))).status).toBe(401);
      expect((await ask(body(), deps(), newKey())).status).toBe(401);
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [runnerId]);
      expect((await ask()).status).toBe(401);
      expect(await receipts()).toHaveLength(0);
      expect(audits).toHaveLength(0);
    });

    it("a replayed signature is refused (the nonce is single use)", async () => {
      const req = signed(key, ENGINE_DECIDE_PATH, body());
      expect((await toResponse(() => engineDecide(deps(), req))).status).toBe(200);
      expect((await toResponse(() => engineDecide(deps(), req))).status).toBe(409);
    });

    it("the body is strict: unknown keys, bad patterns, a tag on a merge, a free-text key and a non-uuid command id are 400, with nothing written", async () => {
      const cases: unknown[] = [
        null, [], { ...body(), extra: 1 }, body({ repo_gh_id: 0 }), body({ repo_gh_id: "1" }), body({ decision_type: "engine_other" }), body({ request_key: "has space" }),
        body({ request_key: "x".repeat(129) }), body({ subject: { pr: 1, message: "hi" } }), body({ subject: { pr: 0 } }), body({ subject: { head_sha: "ABC" } }),
        body({ subject: { role: "root" } }), body({ subject: { pr: 1, tag: "small" } }), body({ decision_type: "engine_spec_ready", subject: { discussion: 1, tag: "Small" } }),
        body({ command_id: "not-a-uuid" }), body({ subject: "x" }), body({ subject: { pr: 1.5 } }),
      ];
      for (const c of cases) expect((await ask(c)).status, JSON.stringify(c)).toBe(400);
      expect(await receipts()).toHaveLength(0);
      expect(audits).toHaveLength(0);
    });
  });

  describe("refusals fail closed, in order, and write nothing", () => {
    it("watch off, repo not enabled, repo not covered by the runner, repo not runner_local, operate off", async () => {
      const code = async () => ((await ask()).body as { error: { code: string } }).error.code;
      await tmp("UPDATE engine_bridge_settings SET watch_enabled = false");
      expect(await code()).toBe("engine_bridge_off");
      await tmp("UPDATE engine_bridge_settings SET watch_enabled = true, operate_enabled = false");
      expect(await code()).toBe("operate_off");
      await tmp("UPDATE engine_bridge_settings SET operate_enabled = true");
      await tmp("DELETE FROM engine_bridge_repos");
      expect(await code()).toBe("engine_repo_not_enabled");
      await tmp("INSERT INTO engine_bridge_repos VALUES ($1, $2)", [A.accountId, A.repoId]);
      await h.admin.query("UPDATE runners SET allowed_repo_ids = '{}' WHERE id = $1", [runnerId]);
      expect(await code()).toBe("engine_repo_not_enabled");
      await h.admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[] WHERE id = $1", [runnerId, [A.repoId]]);
      await h.admin.query("UPDATE repos SET execution_mode = 'sandbox' WHERE id = $1", [A.repoId]);
      expect(await code()).toBe("engine_repo_not_enabled");
      await h.admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [A.repoId]);
      expect((await ask()).status).toBe(200);
      await tmp("DELETE FROM engine_bridge_settings");
      expect(await code()).toBe("engine_bridge_off");
      expect(await receipts()).toHaveLength(1);
    });

    it("a repo of another account is not reachable: the runner's own account decides which repo a GitHub id names", async () => {
      await tmp("INSERT INTO engine_bridge_settings VALUES ($1, true, true)", [B.accountId]);
      await tmp("INSERT INTO engine_bridge_repos VALUES ($1, $2)", [B.accountId, B.repoId]);
      await h.admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[] WHERE id = $1", [runnerId, [B.repoId]]);
      const r = await ask();
      expect(r.status).toBe(403);
      expect(await receipts(B.repoId)).toHaveLength(0);
      expect(await receipts(A.repoId)).toHaveLength(0);
    });

    it("no audit writer configured is 503 before anything is read or written", async () => {
      const r = await ask(body(), deps({ ...pgEngineDecidePorts, audit: undefined }));
      expect(r.status).toBe(503);
      expect(await receipts()).toHaveLength(0);
    });

    it("a failing audit rolls the receipt back and answers 500 with no database text", async () => {
      auditFail = true;
      const r = await ask();
      expect(r.status).toBe(500);
      expect(JSON.stringify(r.body)).not.toMatch(/audit down/);
      expect(await receipts()).toHaveLength(0);
    });
  });

  describe("the real audit writer (EB-14's helper) in the same transaction", () => {
    const auditRows = async () => (await h.admin.query("SELECT actor, action, payload FROM audit_log WHERE account_id = $1 AND action = 'engine_decision.recorded' ORDER BY created_at", [A.accountId])).rows;
    beforeEach(async () => {
      await h.admin.query("DELETE FROM audit_log WHERE account_id = $1 AND action = 'engine_decision.recorded'", [A.accountId]).catch(() => undefined);
    });

    it("one row per decide, in the registrant's name, ids and enums only, replays included", async () => {
      await applyPreset("autonomous");
      const b = body({ request_key: "merge:20:aaa" });
      const before = (await auditRows()).length;
      const d = deps(pgEngineDecidePorts);
      expect((await ask(b, d)).status).toBe(200);
      expect((await ask(b, d)).status).toBe(200);
      const rows = (await auditRows()).slice(before);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ actor: A.userId, action: "engine_decision.recorded", payload: { repo_id: A.repoId, decision_type: "engine_merge", disposition: "act" } });
      expect(Object.keys(rows[0].payload).sort()).toEqual(["decision_type", "disposition", "repo_id"]);
    });

    it("a command-covered spawn records the command id", async () => {
      const c = randomUUID();
      await tmp("INSERT INTO engine_commands VALUES ($1, $2, $3, $4, 'request_spawn', $5::jsonb, $6, now() + interval '5 minutes', 'delivered')", [c, A.accountId, runnerId, A.repoId, JSON.stringify({ role: "executor", discussion: 7 }), owner]);
      const before = (await auditRows()).length;
      await ask(body({ decision_type: "engine_spawn", request_key: "spawn:aa", subject: { role: "executor", discussion: 7 }, command_id: c }), deps(pgEngineDecidePorts));
      expect((await auditRows()).slice(before)[0].payload).toMatchObject({ command_id: c, disposition: "act" });
    });

    it("a runner whose registrant is not a member of the account is not a runner at all: 401, no receipt", async () => {
      const lonely = randomUUID();
      await h.admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [lonely, `${lonely}@example.test`]);
      const k2 = newKey();
      const rid = await registerKey(h.admin, A.accountId, lonely, k2);
      await h.admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[] WHERE id = $1", [rid, [A.repoId]]);
      const r = await ask(body(), deps(pgEngineDecidePorts), k2);
      expect(r.status).toBe(401);
      expect(await receipts()).toHaveLength(0);
    });
  });

  describe("the dial decides: the table, every cell, through the route", () => {
    const expected: Record<string, Record<PresetName, Disposition>> = {
      engine_spawn: { cautious: "ask", balanced: "announce", autonomous: "act" },
      engine_merge: { cautious: "ask", balanced: "announce", autonomous: "act" },
      engine_spec_ready: { cautious: "ask", balanced: "ask", autonomous: "act" },
    };
    for (const type of ENGINE_DECISION_TYPES) {
      for (const preset of PRESETS) {
        it(`${type} under ${preset}`, async () => {
          await applyPreset(preset);
          const subject = type === "engine_spawn" ? { role: "executor", discussion: 7 } : type === "engine_merge" ? { pr: 9 } : { discussion: 7, tag: "small" };
          const r = await ask(body({ decision_type: type, subject }));
          expect(r.status).toBe(200);
          expect((r.body as { disposition: string }).disposition).toBe(expected[type]![preset]);
          const [row] = await receipts();
          expect(row).toMatchObject({ decision_type: type, disposition: expected[type]![preset], preset, catalogue_version: 11, resolved_via: null });
        });
      }
    }

    it("no dial row is the catalogue default, ask, with preset recorded as default", async () => {
      for (const type of ENGINE_DECISION_TYPES) {
        const r = await ask(body({ decision_type: type, subject: type === "engine_spec_ready" ? { discussion: 1, tag: "bug" } : { pr: 1 } }));
        expect((r.body as { disposition: string }).disposition).toBe("ask");
      }
      expect((await receipts()).map((x) => x.preset)).toEqual(["default", "default", "default"]);
    });

    it("a hand-set dial is recorded as an override, and a stored value the entry does not allow asks", async () => {
      await setDial("engine_merge", "act", null);
      expect(((await ask()).body as { disposition: string }).disposition).toBe("act");
      expect((await receipts())[0]).toMatchObject({ preset: "override" });
      await setDial("engine_spec_ready", "announce", null);
      const r = await ask(body({ decision_type: "engine_spec_ready", subject: { discussion: 1, tag: "small" } }));
      expect((r.body as { disposition: string }).disposition).toBe("ask");
    });

    const tagTable: Record<string, Record<PresetName, Disposition>> = {
      small: { cautious: "ask", balanced: "ask", autonomous: "act" },
      bug: { cautious: "ask", balanced: "ask", autonomous: "act" },
      doc: { cautious: "ask", balanced: "ask", autonomous: "act" },
      process: { cautious: "ask", balanced: "ask", autonomous: "act" },
      feature: { cautious: "ask", balanced: "ask", autonomous: "ask" },
      critical: { cautious: "ask", balanced: "ask", autonomous: "ask" },
      other: { cautious: "ask", balanced: "ask", autonomous: "ask" },
      missing: { cautious: "ask", balanced: "ask", autonomous: "ask" },
    };
    for (const tag of [...ENGINE_SPEC_TAGS, "missing"]) {
      for (const preset of PRESETS) {
        it(`engine_spec_ready, ${tag}, ${preset}`, async () => {
          await applyPreset(preset);
          const subject = tag === "missing" ? { discussion: 3 } : { discussion: 3, tag };
          const r = await ask(body({ decision_type: "engine_spec_ready", request_key: `spec:3:${tag}`, subject }));
          expect((r.body as { disposition: string }).disposition).toBe(tagTable[tag]![preset]);
          const [row] = await receipts();
          expect(row.resolved_via).toBe(tag === "feature" || tag === "critical" ? "start_parent_item" : null);
          expect(row.decision_type).toBe("engine_spec_ready");
        });
      }
    }
  });

  describe("the Spec tag (security review of the protocol): missing asks, unknown is refused", () => {
    it("a Spec decide with no tag asks at every preset, never acts, and records no start_parent_item", async () => {
      for (const preset of PRESETS) {
        await applyPreset(preset);
        const r = await ask(body({ decision_type: "engine_spec_ready", request_key: `spec:notag:${preset}`, subject: { discussion: 5 } }));
        expect(r.status).toBe(200);
        expect((r.body as { disposition: string }).disposition, preset).toBe("ask");
      }
      expect((await receipts()).every((row) => row.disposition === "ask" && row.resolved_via === null)).toBe(true);
    });

    it("an unknown, odd-cased or empty tag is 400 at parse and writes nothing, even under Autonomous", async () => {
      await applyPreset("autonomous");
      for (const tag of ["bogus", "Feature", "SMALL", "", " small", "small ", "feature,small", null, 3]) {
        const r = await ask(body({ decision_type: "engine_spec_ready", request_key: "spec:badtag", subject: { discussion: 5, tag } }));
        expect(r.status, String(tag)).toBe(400);
      }
      expect(await receipts()).toHaveLength(0);
      expect(audits).toHaveLength(0);
    });
  });

  describe("receipts: idempotent, bound to their subject, answered by a person", () => {
    it("the same key returns the same receipt, even after the dial changed", async () => {
      await applyPreset("autonomous");
      const b = body({ request_key: "merge:5:abc" });
      const first = (await ask(b)).body as { receipt_id: string; disposition: string };
      await applyPreset("cautious");
      const again = (await ask(b)).body as { receipt_id: string; disposition: string };
      expect(again).toMatchObject({ receipt_id: first.receipt_id, disposition: "act" });
      expect(await receipts()).toHaveLength(1);
      expect((await ask(body({ request_key: "merge:5:def" }))).body).toMatchObject({ disposition: "ask" });
      expect(await receipts()).toHaveLength(2);
    });

    it("the same key for a different subject is 409 and the first receipt stands", async () => {
      await ask(body({ request_key: "k1", subject: { pr: 1 } }));
      const r = await ask(body({ request_key: "k1", subject: { pr: 2 } }));
      expect(r.status).toBe(409);
      expect(await receipts()).toHaveLength(1);
      // key order in the subject does not matter
      await ask(body({ decision_type: "engine_spec_ready", request_key: "k2", subject: { tag: "small", discussion: 3 } }));
      expect((await ask(body({ decision_type: "engine_spec_ready", request_key: "k2", subject: { discussion: 3, tag: "small" } }))).status).toBe(200);
    });

    it("the same key under two decision types, and two repos, are separate receipts", async () => {
      await ask(body({ request_key: "same", decision_type: "engine_merge" }));
      await ask(body({ request_key: "same", decision_type: "engine_spawn", subject: { role: "executor", discussion: 1 } }));
      expect(await receipts()).toHaveLength(2);
    });

    it("an asked decision stays ask until an owner or admin answers; approve then acts, decline keeps asking", async () => {
      const b = body({ request_key: "merge:6:aaa", subject: { pr: 6 } });
      const asked = (await ask(b)).body as { receipt_id: string; ask_id: string; disposition: string; answered: string | null };
      expect(asked).toMatchObject({ disposition: "ask", answered: null });
      expect(asked.ask_id).toBe(asked.receipt_id);
      expect((await ask(b)).body).toMatchObject({ disposition: "ask", answered: null });
      await answer(owner, asked.receipt_id, "approve");
      expect((await ask(b)).body).toMatchObject({ disposition: "act", answered: "approve", receipt_id: asked.receipt_id });
      const b2 = body({ request_key: "merge:7:bbb", subject: { pr: 7 } });
      const second = (await ask(b2)).body as { receipt_id: string };
      await answer(owner, second.receipt_id, "decline");
      expect((await ask(b2)).body).toMatchObject({ disposition: "ask", answered: "decline" });
    });

    it("every decide is audited with ids and enums only, replays included", async () => {
      await applyPreset("autonomous");
      const b = body({ request_key: "merge:8:ccc" });
      const first = (await ask(b)).body as { receipt_id: string };
      await ask(b);
      expect(audits).toHaveLength(2);
      expect(audits[0]).toEqual({ action: "engine_decision.recorded", repoId: A.repoId, decisionType: "engine_merge", disposition: "act" });
      expect(Object.keys(audits[0]!).sort()).toEqual(["action", "decisionType", "disposition", "repoId"]);
      expect(first.receipt_id).toBeTruthy();
    });
  });

  describe("a person's own request_spawn is the decision (and only that one)", () => {
    const command = async (over: Record<string, unknown> = {}) => {
      const id = randomUUID();
      const v = { role: "executor", discussion: 7, kind: "request_spawn", state: "delivered", expires: "now() + interval '5 minutes'", runner: runnerId, repo: A.repoId, by: owner, ...over };
      await tmp(
        `INSERT INTO engine_commands VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, ${v.expires as string}, $8)`,
        [id, A.accountId, v.runner, v.repo, v.kind, JSON.stringify({ role: v.role, discussion: v.discussion }), v.by, v.state],
      );
      return id;
    };
    const spawn = (command_id: string | undefined, over: Record<string, unknown> = {}) =>
      ask(body({ decision_type: "engine_spawn", request_key: `spawn:${randomUUID().slice(0, 8)}`, subject: { role: "executor", discussion: 7 }, ...(command_id ? { command_id } : {}), ...over }));

    it("acts with the issuer's name even when the dial asks, once per command", async () => {
      const c = await command();
      const r = await spawn(c);
      expect(r.body).toMatchObject({ disposition: "act", answered: "approve" });
      const [row] = await receipts();
      expect(row).toMatchObject({ disposition: "act", answered_by: owner, answered: "approve", command_id: c });
      // one click, one start: the same command under a new key is decided by the dial
      expect((await spawn(c)).body).toMatchObject({ disposition: "ask", answered: null });
      expect(await receipts()).toHaveLength(2);
    });

    it("a different role or Discussion is ignored and the dial decides", async () => {
      const c = await command();
      expect((await spawn(c, { subject: { role: "code-reviewer", discussion: 7 } })).body).toMatchObject({ disposition: "ask", answered: null });
      expect((await spawn(c, { subject: { role: "executor", discussion: 8 } })).body).toMatchObject({ disposition: "ask", answered: null });
      expect((await spawn(c, { subject: { role: "executor" } })).body).toMatchObject({ disposition: "ask" });
    });

    it("an expired, cancelled, refused, pending, wrong-kind, wrong-runner or other-repo command does not count", async () => {
      for (const over of [{ expires: "now() - interval '1 second'" }, { state: "cancelled" }, { state: "refused" }, { state: "pending" }, { kind: "stop_agent" }, { runner: randomUUID() }, { repo: B.repoId }]) {
        const c = await command(over);
        expect((await spawn(c)).body, JSON.stringify(over)).toMatchObject({ disposition: "ask", answered: null });
      }
      expect(await spawn(randomUUID())).toMatchObject({ status: 200 });
    });

    it("a command id on a merge or a Spec is ignored", async () => {
      const c = await command();
      expect((await ask(body({ command_id: c }))).body).toMatchObject({ disposition: "ask" });
    });

    it("the command's own dial can still be acted on: under Autonomous the receipt has no person's name", async () => {
      await applyPreset("autonomous");
      const r = await spawn(undefined);
      expect(r.body).toMatchObject({ disposition: "act", answered: null });
      expect((await receipts())[0]).toMatchObject({ answered_by: null, command_id: null });
    });
  });

  describe("a halt refuses every decide, replays included, and writes no receipt", () => {
    it("answers ask with halted true, and a replay of an act while halted does not act", async () => {
      await applyPreset("autonomous");
      const b = body({ request_key: "merge:9:ddd" });
      expect((await ask(b)).body).toMatchObject({ disposition: "act", halted: false });
      await tmp("INSERT INTO engine_repo_controls VALUES ($1, $2, now())", [A.accountId, A.repoId]);
      expect((await ask(b)).body).toEqual({ disposition: "ask", receipt_id: null, ask_id: null, answered: null, halted: true });
      expect((await ask(body({ request_key: "merge:9:eee" }))).body).toMatchObject({ disposition: "ask", halted: true });
      expect(await receipts()).toHaveLength(1);
      await tmp("UPDATE engine_repo_controls SET halted_at = NULL");
      expect((await ask(b)).body).toMatchObject({ disposition: "act", halted: false });
    });

    it("a halt that commits between the read and the insert (the trigger's HX409) is the same refusal, with its own audit row and no receipt", async () => {
      await h.admin.query(`CREATE OR REPLACE FUNCTION engine_decisions_test_halt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'engine_halted' USING ERRCODE = 'HX409'; END $$`);
      await h.admin.query("CREATE TRIGGER engine_decisions_test_halt BEFORE INSERT ON engine_decisions FOR EACH ROW EXECUTE FUNCTION engine_decisions_test_halt()");
      try {
        const r = await ask();
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ disposition: "ask", receipt_id: null, ask_id: null, answered: null, halted: true });
        expect(await receipts()).toHaveLength(0);
        expect(audits).toEqual([{ action: "engine_decision.recorded", repoId: A.repoId, decisionType: "engine_merge", disposition: "ask" }]);
      } finally {
        await h.admin.query("DROP TRIGGER engine_decisions_test_halt ON engine_decisions");
        await h.admin.query("DROP FUNCTION engine_decisions_test_halt()");
      }
    });
  });

  describe("migration 1030: who may write what (RLS)", () => {
    const insertReceipt = (c: PoolClient, accountId = A.accountId, repoId = A.repoId, extra = "") =>
      c.query(
        `INSERT INTO engine_decisions (account_id, repo_id, decision_type, request_key, subject, disposition, catalogue_version, preset ${extra ? ", " + extra.split("=")[0] : ""})
         VALUES ($1, $2, 'engine_merge', $3, '{"pr":1}'::jsonb, 'act', 11, 'default' ${extra ? ", " + extra.split("=")[1] : ""})`,
        [accountId, repoId, `k:${randomUUID().slice(0, 8)}`],
      );

    it("a session (no runner marker) cannot insert a receipt, not even an owner", async () => {
      await expect(asMember(owner, (c) => insertReceipt(c))).rejects.toThrow(/row-level security/);
    });

    it("a runner session inserts only for its own account, and a revoked runner cannot", async () => {
      const inRunner = (id: string, accountId: string, repoId: string) =>
        withTenant(h.appPool, accountId, async (c) => {
          await c.query("SELECT set_config('app.runner_id', $1, true)", [id]);
          return insertReceipt(c, accountId, repoId);
        });
      await expect(inRunner(runnerId, A.accountId, A.repoId)).resolves.toBeTruthy();
      await expect(inRunner(runnerId, B.accountId, B.repoId)).rejects.toThrow(/row-level security/);
      await expect(inRunner(randomUUID(), A.accountId, A.repoId)).rejects.toThrow(/row-level security/);
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [runnerId]);
      await expect(inRunner(runnerId, A.accountId, A.repoId)).rejects.toThrow(/row-level security/);
    });

    it("the closed subject: free text, unknown keys and malformed values are refused by the table itself", async () => {
      await h.admin.query("UPDATE runners SET revoked_at = NULL WHERE id = $1", [runnerId]);
      for (const subject of ['{"message":"hi"}', '{"pr":"1"}', '{"pr":0}', '{"head_sha":"zz"}', '{"role":"root"}', '{"tag":"Feature"}', '[]', '"x"', '{"pr":1,"x":2}']) {
        await expect(
          h.admin.query(`INSERT INTO engine_decisions (account_id, repo_id, decision_type, request_key, subject, disposition, catalogue_version, preset) VALUES ($1, $2, 'engine_merge', $3, $4::jsonb, 'ask', 11, 'default')`, [A.accountId, A.repoId, `k${randomUUID().slice(0, 6)}`, subject]),
          subject,
        ).rejects.toThrow(/engine_decisions_subject_check|check constraint/);
      }
    });

    it("an answer needs an owner or admin, in their own name, on an asked decision, once; a member, a foreign account and a forged name are refused", async () => {
      const asked = ((await ask(body({ request_key: "merge:10:fff" }))).body as { receipt_id: string }).receipt_id;
      await expect(answer(member, asked, "approve")).rejects.toThrow(/row-level security/);
      await expect(answer(owner, asked, "approve", member)).rejects.toThrow(/row-level security/);
      await expect(answer(owner, asked, "maybe")).rejects.toThrow(/check constraint/);
      await expect(
        withTenant(h.appPool, B.accountId, B.userId, (c) => c.query("INSERT INTO engine_decision_answers (account_id, decision_id, choice, answered_by) VALUES ($1, $2, 'approve', $3)", [A.accountId, asked, B.userId])),
      ).rejects.toThrow(/row-level security/);
      await answer(owner, asked, "decline");
      await expect(answer(owner, asked, "approve")).rejects.toThrow(/duplicate key/);
      // a decision that was acted on is not asked, so it cannot be "answered"
      await applyPreset("autonomous");
      const acted = ((await ask(body({ request_key: "merge:11:ggg" }))).body as { receipt_id: string }).receipt_id;
      await expect(answer(owner, acted, "approve")).rejects.toThrow(/row-level security/);
    });

    it("a runner session cannot answer, even after the audit write has set the registrant as the acting user", async () => {
      const asked = ((await ask(body({ request_key: "merge:12:hhh" }))).body as { receipt_id: string }).receipt_id;
      await expect(
        asMember(owner, async (c) => {
          await c.query("SELECT set_config('app.runner_id', $1, true)", [runnerId]);
          return c.query("INSERT INTO engine_decision_answers (account_id, decision_id, choice, answered_by) VALUES ($1, $2, 'approve', $3)", [A.accountId, asked, owner]);
        }),
      ).rejects.toThrow(/row-level security/);
      await expect(answer(owner, asked, "approve")).resolves.toBeTruthy();
    });

    it("no UPDATE or DELETE for the app login, on either table", async () => {
      await applyPreset("autonomous");
      const id = ((await ask()).body as { receipt_id: string }).receipt_id;
      for (const sql of ["UPDATE engine_decisions SET disposition = 'ask'", "DELETE FROM engine_decisions", "DELETE FROM engine_decision_answers", "UPDATE engine_decision_answers SET choice = 'approve'"]) {
        await expect(asMember(owner, (c) => c.query(sql)), sql).rejects.toThrow(/permission denied/);
      }
      expect(id).toBeTruthy();
    });

    it("reads are tenant-scoped: another account sees none of A's receipts or answers", async () => {
      await ask();
      expect(await asMember(B.userId, async (c) => (await c.query("SELECT 1 FROM engine_decisions")).rowCount, B.accountId)).toBe(0);
      expect(await asMember(B.userId, async (c) => (await c.query("SELECT 1 FROM engine_decision_answers")).rowCount, B.accountId)).toBe(0);
      expect(await asMember(owner, async (c) => (await c.query("SELECT 1 FROM engine_decisions")).rowCount)).toBe(1);
    });

    it("the answered name needs the matching command, and one command covers one receipt", async () => {
      const cmd = randomUUID();
      const base = (extra: string) =>
        h.admin.query(`INSERT INTO engine_decisions (account_id, repo_id, decision_type, request_key, subject, disposition, catalogue_version, preset, ${extra}) VALUES ($1, $2, 'engine_spawn', $3, '{"role":"executor","discussion":1}'::jsonb, 'act', 11, 'default', $4, $5, $6)`, [A.accountId, A.repoId, `k${randomUUID().slice(0, 6)}`, owner, "approve", cmd]);
      await expect(h.admin.query(`INSERT INTO engine_decisions (account_id, repo_id, decision_type, request_key, subject, disposition, catalogue_version, preset, answered_by, answered) VALUES ($1, $2, 'engine_spawn', 'x1', '{}'::jsonb, 'act', 11, 'default', $3, 'approve')`, [A.accountId, A.repoId, owner])).rejects.toThrow(/check constraint/);
      await base("answered_by, answered, command_id");
      await expect(base("answered_by, answered, command_id")).rejects.toThrow(/duplicate key/);
    });
  });
});

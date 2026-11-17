import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { engineDialsTarget } from "@fulcrumaxe/runner-protocol";
import { CATALOGUE_VERSION, ENGINE_DECISION_TYPES, getCatalogueEntry, decide, type Disposition, type EngineDecisionType, type PresetName } from "@fx/decisions";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { engineDials, parseDialsQuery, pgEngineDialsPorts, toResponse, type EngineDialsPorts, type RunnerCloudDeps } from "../src/index.js";
import { catalogueResolver, defaultEngineDialsPorts } from "../src/engineDialsDefaults.js";
import { harness, newKey, registerKey, signed, type Harness, type TestKey } from "./helpers.js";

/**
 * [pg] EB-9b: GET /api/runner/engine/dials against the real dials, decisions and runner tables. EB-11a's controls table is built here in the Spec's shape in
 * a scratch schema that the route's pool lists before `public`, so it shadows a real one once that exists (the same arrangement as the decide route's test).
 */
const SCRATCH = `eb9b_${Math.random().toString(36).slice(2, 10)}`;
const GH_REPO_ID = 4_343_000 + Math.floor(Math.random() * 100_000);
const PRESETS: PresetName[] = ["cautious", "balanced", "autonomous"];

describe("engine dials route [pg]", () => {
  let h: Harness;
  let one: Pool;
  let A: SeedRefs;
  let B: SeedRefs;
  let key: TestKey;
  let runnerId: string;

  const deps = (pool: Pool = one): RunnerCloudDeps => h.deps({ appUserPool: pool });
  const ports = (over: Partial<EngineDialsPorts> = {}): EngineDialsPorts => ({ ...defaultEngineDialsPorts(), ...over });
  const query = (id: number = GH_REPO_ID): string => `?repo_gh_id=${id}`;
  const get = (id: number = GH_REPO_ID, k: TestKey = key) => signed(k, engineDialsTarget(id), undefined, { method: "GET", rawBody: Buffer.alloc(0) });
  const ask = async (id: number = GH_REPO_ID, o: { d?: RunnerCloudDeps; k?: TestKey; p?: EngineDialsPorts; search?: string } = {}) =>
    toResponse(() => engineDials(o.d ?? deps(), get(id, o.k ?? key), o.search ?? query(id), o.p ?? ports()));
  const tmp = (sql: string, args: unknown[] = []) => h.admin.query(sql.replace(/\b(engine_repo_controls)\b/g, `${SCRATCH}.$1`), args);

  const setDial = (type: EngineDecisionType, disposition: Disposition, preset: string | null = null) =>
    h.admin.query(
      `INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, preset, version, changed_by)
       VALUES ($1, $2, $3, $4, $5, (SELECT COALESCE(max(version), 0) + 1 FROM decision_settings WHERE repo_id = $2 AND decision_type = $3), $6)`,
      [A.accountId, A.repoId, type, disposition, preset, A.userId],
    );
  const dialUnder = (type: EngineDecisionType, preset: PresetName): Disposition => decide(getCatalogueEntry(type), { preset }, { type } as never).disposition;

  beforeAll(async () => {
    h = await harness();
    await h.admin.query(`CREATE SCHEMA ${SCRATCH}`);
    await h.admin.query(`GRANT USAGE ON SCHEMA ${SCRATCH} TO app_user`);
    one = createPool(process.env.RUNNER_CLOUD_DATABASE_URL_APP_USER!, { options: `-c search_path=${SCRATCH},public` });
    await tmp("CREATE TABLE engine_repo_controls (account_id uuid, repo_id uuid PRIMARY KEY, halted_at timestamptz, halt_epoch integer NOT NULL DEFAULT 0)");
    await h.admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${SCRATCH} TO app_user`);
    A = await seedAccount(h.admin, randomUUID());
    B = await seedAccount(h.admin, randomUUID());
    key = newKey();
    runnerId = await registerKey(h.admin, A.accountId, A.userId, key);
    await h.admin.query("UPDATE repos SET gh_repo_id = $2, execution_mode = 'runner_local' WHERE id = $1", [A.repoId, GH_REPO_ID]);
    await h.admin.query("UPDATE repos SET gh_repo_id = $2, execution_mode = 'runner_local' WHERE id = $1", [B.repoId, GH_REPO_ID + 1]);
  });
  afterAll(async () => {
    await one.end();
    await h.admin.query(`DROP SCHEMA ${SCRATCH} CASCADE`);
    await h.close();
  });
  beforeEach(async () => {
    await h.admin.query("UPDATE runners SET revoked_at = NULL, allowed_repo_ids = $2::uuid[] WHERE id = $1", [runnerId, [A.repoId]]);
    await h.admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [A.repoId]);
    await h.admin.query("DELETE FROM decision_settings WHERE account_id = ANY ($1::uuid[])", [[A.accountId, B.accountId]]).catch(() => undefined);
    await tmp("TRUNCATE engine_repo_controls");
  });

  describe("the answer", () => {
    it("a covered repo with no stored dial answers the catalogue's defaults, its version, epoch 0 and not halted", async () => {
      const r = await ask();
      expect(r.status).toBe(200);
      expect(r.body).toEqual({
        repo_gh_id: GH_REPO_ID,
        catalogue_version: CATALOGUE_VERSION,
        dispositions: Object.fromEntries(ENGINE_DECISION_TYPES.map((t) => [t, getCatalogueEntry(t)!.defaultDisposition])),
        halt_epoch: 0,
        halted: false,
        fetched_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      });
      expect(r.headers?.["cache-control"]).toBe("no-store");
    });

    it.each(PRESETS)("the %s preset's stored dials come back as the dispositions, one per decision type", async (preset) => {
      for (const t of ENGINE_DECISION_TYPES) await setDial(t, dialUnder(t, preset), preset);
      const r = await ask();
      expect((r.body as { dispositions: unknown }).dispositions).toEqual(Object.fromEntries(ENGINE_DECISION_TYPES.map((t) => [t, dialUnder(t, preset)])));
    });

    it("each decision type is read on its own: a stored spawn dial does not move merge", async () => {
      await setDial("engine_spawn", "act");
      const d = (await ask()).body as { dispositions: Record<string, string> };
      expect(d.dispositions.engine_spawn).toBe("act");
      expect(d.dispositions.engine_merge).toBe(getCatalogueEntry("engine_merge")!.defaultDisposition);
    });

    it("the newest stored dial wins, and a dial back on the default marker reads as the catalogue default", async () => {
      await setDial("engine_merge", "act", "autonomous");
      await setDial("engine_merge", "ask", "cautious");
      expect(((await ask()).body as { dispositions: Record<string, string> }).dispositions.engine_merge).toBe("ask");
    });

    it("the resolver is the decide route's: the same stored value gives the same disposition for spawn, merge and a small Spec", () => {
      for (const t of ENGINE_DECISION_TYPES) {
        for (const stored of [null, "ask", "announce", "act"] as const) {
          const entry = getCatalogueEntry(t)!;
          const expected = stored === null ? entry.defaultDisposition : entry.allowedDispositions.includes(stored) ? stored : "ask";
          expect(catalogueResolver.resolve(t, stored)).toBe(expected);
        }
      }
    });

    it("writes nothing: no decision receipt, no audit row, no setting", async () => {
      const before = async () => ({
        decisions: Number((await h.admin.query("SELECT count(*) FROM engine_decisions")).rows[0].count),
        settings: Number((await h.admin.query("SELECT count(*) FROM decision_settings")).rows[0].count),
        audit: Number((await h.admin.query("SELECT count(*) FROM audit_log WHERE account_id = $1", [A.accountId])).rows[0].count),
      });
      const was = await before();
      await ask();
      expect(await before()).toEqual(was);
    });
  });

  describe("halt", () => {
    // TODO(EB-11a, once migration 1031 / #992 merges): re-run these halt cases against the real, row-level-secured `engine_repo_controls` instead of the scratch
    // copy, including the case where the session's account does not match the row's. A row the session cannot see must never read as "not halted".
    it("without EB-11a's table (the real public schema has none yet) nothing is halted and the epoch is 0", async () => {
      const r = await ask(GH_REPO_ID, { d: deps(h.appPool) });
      expect(r.body).toMatchObject({ halted: false, halt_epoch: 0 });
    });

    it("a halted repo answers halted with its epoch; a cleared one answers not halted and keeps the epoch", async () => {
      await tmp("INSERT INTO engine_repo_controls (account_id, repo_id, halted_at, halt_epoch) VALUES ($1, $2, now(), 7)", [A.accountId, A.repoId]);
      expect((await ask()).body).toMatchObject({ halted: true, halt_epoch: 7 });
      await tmp("UPDATE engine_repo_controls SET halted_at = NULL");
      expect((await ask()).body).toMatchObject({ halted: false, halt_epoch: 7 });
    });

    it("a controls row with no epoch column reads as epoch 0 (and still reports its halt)", async () => {
      const own = ports({ halt: async () => ({ halted: true, epoch: 0 }) });
      expect((await ask(GH_REPO_ID, { p: own })).body).toMatchObject({ halted: true, halt_epoch: 0 });
    });

    it("another repo's halt does not show on this one", async () => {
      await tmp("INSERT INTO engine_repo_controls (account_id, repo_id, halted_at, halt_epoch) VALUES ($1, $2, now(), 4)", [B.accountId, B.repoId]);
      expect((await ask()).body).toMatchObject({ halted: false, halt_epoch: 0 });
    });
  });

  describe("coverage: every other repo is the same 404", () => {
    const notFound = (r: { status: number; body: unknown }) => {
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ error: { code: "not_found", message: "no such repo" } });
    };

    it("a repo that does not exist", async () => notFound(await ask(GH_REPO_ID + 999_999)));
    it("another account's repo", async () => notFound(await ask(GH_REPO_ID + 1)));
    it("a repo the runner is not allowed to cover", async () => {
      await h.admin.query("UPDATE runners SET allowed_repo_ids = '{}'::uuid[] WHERE id = $1", [runnerId]);
      notFound(await ask());
    });
    it("a repo that is not on a runner_local machine", async () => {
      await h.admin.query("UPDATE repos SET execution_mode = 'sandbox' WHERE id = $1", [A.repoId]);
      notFound(await ask());
    });
    it("all four give the same answer, so nothing tells which repos exist", async () => {
      const bodies = [await ask(GH_REPO_ID + 999_999), await ask(GH_REPO_ID + 1)].map((r) => JSON.stringify(r.body));
      expect(new Set(bodies).size).toBe(1);
    });
  });

  describe("the door", () => {
    it("an unsigned request is 401", async () => {
      const r = await toResponse(() => engineDials(deps(), { method: "GET", headers: {}, body: Buffer.alloc(0) }, query(), ports()));
      expect(r.status).toBe(401);
    });

    it("another key is 401", async () => expect((await ask(GH_REPO_ID, { k: newKey() })).status).toBe(401));

    it("a revoked runner is 401", async () => {
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [runnerId]);
      expect((await ask()).status).toBe(401);
    });

    it("a request signed for one repo and sent for another is 401: the query is inside the signature", async () => {
      const r = await toResponse(() => engineDials(deps(), get(GH_REPO_ID + 1), query(GH_REPO_ID), ports()));
      expect(r.status).toBe(401);
    });

    it("a signature made for the path with no query is 401", async () => {
      const bare = signed(key, "/api/runner/engine/dials", undefined, { method: "GET", rawBody: Buffer.alloc(0) });
      expect((await toResponse(() => engineDials(deps(), bare, query(), ports()))).status).toBe(401);
    });

    it("a signature made for another origin is 401", async () => {
      const wrong = signed(key, engineDialsTarget(GH_REPO_ID), undefined, { method: "GET", rawBody: Buffer.alloc(0), url: `https://other.example.test${engineDialsTarget(GH_REPO_ID)}` });
      expect((await toResponse(() => engineDials(deps(), wrong, query(), ports()))).status).toBe(401);
    });

    it("a stale signature is 401", async () => {
      const old = signed(key, engineDialsTarget(GH_REPO_ID), undefined, { method: "GET", rawBody: Buffer.alloc(0), created: Math.floor(Date.now() / 1000) - 3600 });
      expect((await toResponse(() => engineDials(deps(), old, query(), ports()))).status).toBe(401);
    });

    it("a nonce is usable once: the same signed request twice is 409 the second time", async () => {
      const req = get();
      expect((await toResponse(() => engineDials(deps(), req, query(), ports()))).status).toBe(200);
      const again = await toResponse(() => engineDials(deps(), req, query(), ports()));
      expect(again.status).toBe(409);
      expect(JSON.stringify(again.body)).toContain("nonce_reused");
    });

    it("a request with no nonce is 401", async () => {
      const req = get();
      const headers = { ...req.headers };
      const input = headers["signature-input"] as string;
      headers["signature-input"] = input.replace(/;nonce="[^"]*"/, "");
      expect((await toResponse(() => engineDials(deps(), { ...req, headers }, query(), ports()))).status).toBe(401);
    });

    it("any other method is 405, and a body is 400, before the signature is looked at", async () => {
      for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
        expect((await toResponse(() => engineDials(deps(), { ...get(), method }, query(), ports()))).status).toBe(405);
      }
      expect((await toResponse(() => engineDials(deps(), { ...get(), body: Buffer.from("{}") }, query(), ports()))).status).toBe(400);
    });

    it("the account and runner come from the key: a query cannot name another account", async () => {
      const r = await ask(GH_REPO_ID, { search: `?repo_gh_id=${GH_REPO_ID}&account_id=${B.accountId}` });
      expect(r.status).toBe(400);
    });
  });

  describe("the query is strict", () => {
    it.each([
      "",
      "?",
      "?repo_gh_id=",
      "?repo_gh_id=0",
      "?repo_gh_id=-5",
      "?repo_gh_id=007",
      "?repo_gh_id=1.5",
      "?repo_gh_id=1e3",
      "?repo_gh_id=0x10",
      "?repo_gh_id=%31",
      "?repo_gh_id=12abc",
      "?repo_gh_id=1&repo_gh_id=2",
      "?repo_gh_id=1&x=2",
      "?x=1&repo_gh_id=1",
      "?repo_gh_id=99999999999999999",
      "?repo_gh_id=9007199254740993",
      "?REPO_GH_ID=1",
      " ?repo_gh_id=1",
      "?repo_gh_id=1#frag",
    ])("%j is 400 and reads nothing", async (search) => {
      let reads = 0;
      const counting = ports({ covered: async () => { reads += 1; return null; } });
      const r = await toResponse(() => engineDials(deps(), get(), search, counting));
      expect(r.status).toBe(400);
      expect(reads).toBe(0);
    });

    it("parseDialsQuery takes only the canonical spelling", () => {
      expect(parseDialsQuery("?repo_gh_id=1")).toBe(1);
      expect(parseDialsQuery("?repo_gh_id=4343000")).toBe(4343000);
      expect(() => parseDialsQuery("?repo_gh_id=01")).toThrow();
    });
  });

  describe("the ports", () => {
    it("pgEngineDialsPorts takes the catalogue from outside: with a stand-in resolver the reply follows it and the version it names", async () => {
      const stand = pgEngineDialsPorts({ catalogueVersion: 99, resolve: () => "ask" });
      const r = await ask(GH_REPO_ID, { p: stand });
      expect(r.body).toMatchObject({ catalogue_version: 99, dispositions: { engine_spawn: "ask", engine_merge: "ask", engine_spec_ready: "ask" } });
    });

    it("a reply the schema refuses (an unknown disposition from a broken resolver) is a 500, never a body", async () => {
      const broken = ports({ resolver: { catalogueVersion: 1, resolve: () => "maybe" as never } });
      expect((await ask(GH_REPO_ID, { p: broken })).status).toBe(500);
    });

    it("the clock is the ports': fetched_at is the answer's own time", async () => {
      const fixed = ports({ now: () => new Date("2026-11-16T12:00:00.000Z") });
      expect((await ask(GH_REPO_ID, { p: fixed })).body).toMatchObject({ fetched_at: "2026-11-16T12:00:00.000Z" });
    });
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { HELLO_PATH, REGISTER_PATH, registerRunner, runnerHello } from "../src/index.js";
import { harness, insertCode, newKey, registerKey, respond, signed, type Harness } from "./helpers.js";

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const protocolDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "runner-protocol");
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(path.join(protocolDir, "test", "fixtures", name), "utf8")) as Record<string, unknown>;
const cp = (...codes: number[]) => String.fromCodePoint(...codes);

/** D#605 FL-2: the facts on hello and the name on register, through the real routes and the real definers. */
describe("facts on hello and the runner name on register [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const fresh = (): Promise<F2Fixture> => seedF2(h.admin);
  const factsRow = async (id: string) => (await h.admin.query("SELECT os, arch, mem_gb_bucket, cpus, sandbox_engine FROM runner_facts WHERE runner_id = $1", [id])).rows[0] ?? null;
  const settingsRow = async (id: string) => (await h.admin.query("SELECT name, labels, rank, paused_at, draining, updated_by FROM runner_settings WHERE runner_id = $1", [id])).rows[0] ?? null;
  const runnersOf = async (accountId: string) => (await h.admin.query("SELECT id FROM runners WHERE account_id = $1", [accountId])).rowCount;
  const hello = (key: ReturnType<typeof newKey>, body: unknown) => respond(() => runnerHello(h.deps(), signed(key, HELLO_PATH, body)));
  const register = (key: ReturnType<typeof newKey>, code: string, extra: Record<string, unknown> = {}) =>
    respond(() => registerRunner(h.deps(), signed(key, REGISTER_PATH, { code, public_key_jwk: key.jwk, ...extra })));
  const FACTS = (fixture("hello-facts.json") as { facts: Record<string, unknown> }).facts;
  const LEGACY_HELLO = fixture("hello-legacy.json");

  describe("hello (criterion 1)", () => {
    it("records the facts through the definer, and again on the next hello, for the signing runner only", async () => {
      const f = await fresh();
      const key = newKey();
      const id = await registerKey(h.admin, f.accountId, f.a1, key);
      const other = await registerKey(h.admin, f.accountId, f.a1, newKey());
      expect((await hello(key, fixture("hello-facts.json"))).status).toBe(200);
      expect(await factsRow(id)).toEqual({ os: "macos", arch: "arm64", mem_gb_bucket: 32, cpus: 12, sandbox_engine: "os_sandbox" });
      expect(await factsRow(other)).toBeNull();
      expect((await hello(key, { ...fixture("hello-facts.json"), facts: { ...FACTS, os: "linux", cpus: 4 } })).status).toBe(200);
      expect(await factsRow(id)).toMatchObject({ os: "linux", cpus: 4 });
    });

    it("still answers 200 to a hello without facts (an older runner), writes no facts, and keeps the versions it records", async () => {
      const f = await fresh();
      const key = newKey();
      const id = await registerKey(h.admin, f.accountId, f.a1, key);
      const res = await hello(key, LEGACY_HELLO);
      expect(res).toMatchObject({ status: 200, body: { protocol_version: 1 } });
      expect(await factsRow(id)).toBeNull();
      expect((await h.admin.query("SELECT binary_version, isolation FROM runners WHERE id = $1", [id])).rows[0]).toEqual({ binary_version: "0.4.2", isolation: "host_sandbox" });
    });

    it("refuses facts with an unknown key or a value outside its enum as 400 invalid_message, and changes nothing", async () => {
      const f = await fresh();
      const key = newKey();
      const id = await registerKey(h.admin, f.accountId, f.a1, key);
      await hello(key, fixture("hello-facts.json"));
      for (const bad of [{ ...FACTS, hostname: "box" }, { ...FACTS, os: "windows" }, { ...FACTS, mem_gb_bucket: 12 }, { ...FACTS, cpus: 0 }, { ...FACTS, sandbox_engine: "docker" }]) {
        const res = await hello(key, { ...LEGACY_HELLO, facts: bad });
        expect(res.status, JSON.stringify(bad)).toBe(400);
        expect(JSON.stringify(res.body)).toContain("invalid_message");
      }
      expect(await factsRow(id)).toEqual({ os: "macos", arch: "arm64", mem_gb_bucket: 32, cpus: 12, sandbox_engine: "os_sandbox" });
    });

    it("writes no facts for a revoked runner: the hello is 401 and its facts row stays as it was", async () => {
      const f = await fresh();
      const key = newKey();
      const id = await registerKey(h.admin, f.accountId, f.a1, key);
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [id]);
      expect((await hello(key, fixture("hello-facts.json"))).status).toBe(401);
      expect(await factsRow(id)).toBeNull();
    });
  });

  describe("register (criteria 2 and 3)", () => {
    it("writes the runner's name as the default name of the new row, and nothing else of its settings", async () => {
      const f = await fresh();
      const key = newKey();
      const res = await register(key, await insertCode(h.admin, f.accountId, f.a1), { name: "Studio Mac" });
      expect(res.status).toBe(201);
      const id = (res.body as { runner_id: string }).runner_id;
      expect(Object.keys(res.body as object).sort()).toEqual(["account_id", "credential_mode", "runner_id"]);
      expect(await settingsRow(id)).toEqual({ name: "Studio Mac", labels: [], rank: 0, paused_at: null, draining: false, updated_by: f.a1 });
    });

    it("accepts an older runner's register without a name, writes no settings row, and so reads as unnamed", async () => {
      const f = await fresh();
      const key = newKey();
      const res = await register(key, await insertCode(h.admin, f.accountId, f.a1));
      expect(res.status).toBe(201);
      expect(await settingsRow((res.body as { runner_id: string }).runner_id)).toBeNull();
    });

    it("refuses a name with a control or invisible character, an empty or blank one, or more than 64 characters, and registers no runner and spends no code", async () => {
      const f = await fresh();
      const code = await insertCode(h.admin, f.accountId, f.a1);
      for (const name of ["a\u0007b", "a\nb", "a‮b", "a​b", "", "   ", cp(0x2800), "n".repeat(65), "x".repeat(10_000), "a\ud800b", "\udc00", 7, null]) {
        const res = await register(newKey(), code, { name });
        expect(res.status, JSON.stringify(name).slice(0, 40)).toBe(400);
      }
      expect(await runnersOf(f.accountId)).toBe(0);
      // The same code still works: the refusals above spent nothing.
      expect((await register(newKey(), code, { name: "n".repeat(64) })).status).toBe(201);
    });

    it("stores the name exactly as sent (no trimming or repair), including spaces inside and unicode", async () => {
      const f = await fresh();
      const res = await register(newKey(), await insertCode(h.admin, f.accountId, f.a1), { name: "Büro  Desktop \u{1f600}" });
      expect(await settingsRow((res.body as { runner_id: string }).runner_id)).toMatchObject({ name: "Büro  Desktop \u{1f600}" });
    });
  });

  describe("runner_name_initial as a definer (the register path has no user)", () => {
    // The definer is reachable only inside the transaction that created the runner, and only once.
    it("refuses a runner created by an earlier transaction, so it can never rename", async () => {
      const f = await fresh();
      const id = await registerKey(h.admin, f.accountId, f.a1, newKey());
      const call = async () => {
        const c = await h.appPool.connect();
        try {
          await c.query("BEGIN");
          await c.query("SELECT set_config('app.account_id', $1, true)", [f.accountId]);
          await c.query("SELECT runner_name_initial($1::uuid, $2)", [id, "Takeover"]);
          await c.query("COMMIT");
        } catch (error) {
          await c.query("ROLLBACK");
          throw error;
        } finally {
          c.release();
        }
      };
      await expect(call()).rejects.toMatchObject({ code: "42501" });
      expect(await settingsRow(id)).toBeNull();
    });

    it("refuses a platform_ops login", async () => {
      const f = await fresh();
      const res = await register(newKey(), await insertCode(h.admin, f.accountId, f.a1), { name: "First" });
      const id = (res.body as { runner_id: string }).runner_id;
      const c = await h.opsPool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.account_id', $1, true)", [f.accountId]);
        await expect(c.query("SELECT runner_name_initial($1::uuid, $2)", [id, "Second"])).rejects.toMatchObject({ code: "42501" });
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
      expect(await settingsRow(id)).toMatchObject({ name: "First" });
    });

    // The cases below create the runner in the SAME transaction that calls the definer, as the register path does, so the only thing that can stop the
    // second write is the definer's own rule (a name is set once, a revoked runner is refused), not the "created by this transaction" test and not a
    // missing privilege. The admin connection makes the runner, then acts as app_user for the call.
    type Q = (sql: string, args?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
    const inTransaction = async <T,>(work: (q: Q) => Promise<T>): Promise<T> => {
      await h.admin.query("BEGIN");
      try {
        const out = await work((sql, args) => h.admin.query(sql, args));
        await h.admin.query("COMMIT");
        return out;
      } catch (error) {
        await h.admin.query("ROLLBACK");
        throw error;
      }
    };
    const callAs = async (q: Q, accountId: string, runner: string, name: string) => {
      await q("SET LOCAL ROLE app_user");
      await q("SELECT set_config('app.account_id', $1, true)", [accountId]);
      // On a refusal the transaction is aborted and the caller rolls back to its savepoint, which also restores the role.
      await q("SELECT runner_name_initial($1::uuid, $2)", [runner, name]);
      await q("RESET ROLE");
    };

    it("keeps the first name when it is called twice for a runner made in the same transaction", async () => {
      const f = await fresh();
      const id = await inTransaction(async (q) => {
        const runner = await insertRunner(h.admin, f.accountId, f.a1);
        await callAs(q, f.accountId, runner, "First");
        await callAs(q, f.accountId, runner, "Second");
        return runner;
      });
      expect(await settingsRow(id)).toMatchObject({ name: "First" });
    });

    it("keeps a name that was already set (by anyone) on a runner made in the same transaction", async () => {
      const f = await fresh();
      const id = await inTransaction(async (q) => {
        const runner = await insertRunner(h.admin, f.accountId, f.a1);
        await q("INSERT INTO runner_settings (runner_id, account_id, name, updated_by) VALUES ($1, $2, 'Chosen', $3)", [runner, f.accountId, f.o1]);
        await callAs(q, f.accountId, runner, "Default");
        return runner;
      });
      expect(await settingsRow(id)).toMatchObject({ name: "Chosen", updated_by: f.o1 });
    });

    it("refuses a runner that is already revoked even when it was made in the same transaction, and writes nothing", async () => {
      const f = await fresh();
      const rows = await inTransaction(async (q) => {
        const runner = await insertRunner(h.admin, f.accountId, f.a1);
        await q("UPDATE runners SET revoked_at = now() WHERE id = $1", [runner]);
        await q("SAVEPOINT before_call");
        await expect(callAs(q, f.accountId, runner, "Revived")).rejects.toMatchObject({ code: "42501" });
        await q("ROLLBACK TO SAVEPOINT before_call");
        await q("RESET ROLE");
        return (await q("SELECT 1 FROM runner_settings WHERE runner_id = $1", [runner])).rows.length;
      });
      expect(rows).toBe(0);
    });
  });

  describe("facts do not reach authorization (criterion 4)", () => {
    // The import graph of the request verifier, the ticket route and the job signer, followed through relative imports, never reaches the hello route
    // (the only reader of the facts definer) and never names the facts table or its definer.
    const importsOf = (file: string): string[] => [...readFileSync(file, "utf8").matchAll(/from\s+"(\.{1,2}\/[^"]+)\.js"/g)].map((m) => path.resolve(path.dirname(file), `${m[1]}.ts`));
    const closure = (entry: string): string[] => {
      const seen = new Set<string>();
      const walk = (file: string): void => {
        if (seen.has(file)) return;
        seen.add(file);
        for (const next of importsOf(file)) walk(next);
      };
      walk(entry);
      return [...seen];
    };
    it.each([
      [path.join(srcDir, "verifyRunnerRequest.ts")],
      [path.join(srcDir, "gitTicket.ts")],
      [path.join(protocolDir, "src", "jobSignature.ts")],
    ])("%s", (entry) => {
      const files = closure(entry);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        expect(path.basename(file), `${entry} reaches ${file}`).not.toBe("hello.ts");
        expect(readFileSync(file, "utf8"), file).not.toMatch(/runner_facts|runner_name_initial|\.facts\b/);
      }
    });
  });
});

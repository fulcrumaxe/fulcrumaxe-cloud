import { createPrivateKey, generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { jwkThumbprint, sha256Text, signJob, signRequest, type Ed25519Jwk, type Job, type LocalOnlyEvent } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient, type RunnerClient } from "@fulcrumaxe/fx-runner";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { getRunInsight } from "@fx/core/src/runs/insight.js";
import { createRunnerClaimFacade, type RunnerClaimFacade } from "../../src/runnerClaims.js";
import { createRunnerDoneFacade } from "../../src/runnerDone.js";
import { startCloudServer, type CloudServer } from "./harness/cloudServer.js";

/**
 * [pg] D#6 C42-1: a local runner's `tool_use` and `stage` events become the `agent.activity` and `run.stage` rows a sandbox run writes,
 * so the one reader (`readRunLines`) draws them. Every request here is signed by the runner's real client (`createRunnerClient`,
 * real Ed25519 signatures) and answered by the real events handler over HTTP, behind the real lease fence, on a real Postgres. The
 * fail-closed cases count `run_events` rows before and after.
 */
describe("runner progress at ingest [pg]", { timeout: 120_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  let cloud: CloudServer;
  let facade: RunnerClaimFacade;
  let A: SeedRefs;
  let runnerId: string;
  let key: TestKey;
  let client: RunnerClient;
  let seen: Array<{ url: string; init: RequestInit }>;
  let seqOf: Map<string, number>;
  const jobKey = generateKeyPairSync("ed25519").privateKey;
  const MODEL = "sonnet-5";

  interface TestKey {
    privateKey: KeyObject;
    publicJwk: { kty: "OKP"; crv: "Ed25519"; x: string };
    jkt: string;
  }
  const newKey = (): TestKey => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const jwk = publicKey.export({ format: "jwk" }) as { x: string };
    const publicJwk = { kty: "OKP", crv: "Ed25519", x: jwk.x } as const;
    return { privateKey: createPrivateKey(privateKey.export({ format: "pem", type: "pkcs8" })), publicJwk, jkt: jwkThumbprint(publicJwk as Ed25519Jwk) };
  };
  /** The runner's real client; every call it makes is also kept, so a test can send the very same signed request again. */
  const clientFor = (k: TestKey): RunnerClient =>
    createRunnerClient({
      origin: cloud.origin,
      key: k,
      now: () => new Date(),
      fetchFn: ((url: string, init: RequestInit) => {
        seen.push({ url, init });
        return fetch(url, init);
      }) as typeof fetch,
    });

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    facade = createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, randomBetween: (min) => min });
    const done = createRunnerDoneFacade(writerPool);
    cloud = await startCloudServer((origin) => ({ appUserPool: appPool, origin, failRunnerLeases: null, leases: { ...facade, ...done } as never }));
  });
  afterAll(async () => {
    await cloud?.close();
    admin?.release();
    for (const p of [adminPool, writerPool, appPool]) await p?.end();
  });
  beforeEach(async () => {
    seen = [];
    seqOf = new Map();
    A = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [A.repoId]);
    ({ runnerId, key } = await newRunner(A));
    client = clientFor(key);
  });

  async function newRunner(account: SeedRefs): Promise<{ runnerId: string; key: TestKey }> {
    const k = newKey();
    const id = await insertRunner(admin, account.accountId, account.userId, { jwk: k.publicJwk, jkt: k.jkt });
    await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = $3::text[] WHERE id = $1", [id, [account.repoId], ["executor", "code-reviewer"]]);
    return { runnerId: id, key: k };
  }
  async function pending(account: SeedRefs = A, role = "executor"): Promise<string> {
    const id = randomUUID();
    const job: Job = {
      schema_version: 1,
      job_id: randomUUID(),
      run_id: id,
      repo: { id: account.repoId, owner: "acme", name: "app", private: true },
      role: role as Job["role"],
      mode: "local",
      spec: null,
      task: { kind: role === "executor" ? "implement" : "advise", prompt: "p", prompt_sha256: sha256Text("p") },
      role_card: { text: "c", sha256: sha256Text("c") },
      role_tools_sha256: "a".repeat(64),
      continues: null,
      branch_prefix: "fx/",
      model_hint: null,
      issued_at: new Date(Date.now() - 1000).toISOString(),
      expires_at: new Date(Date.now() + 72 * 3_600_000).toISOString(),
      key_id: "k1",
    };
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id, job_signed, initiated_by, model)
       VALUES ($1, $2, $7, 'runner', 'pending', 'runner_local', $3, $4::jsonb, $5, $6)`,
      [id, account.accountId, account.repoId, JSON.stringify(signJob(job, jobKey)), account.userId, MODEL, role],
    );
    return id;
  }
  async function claimed(account: SeedRefs = A, id?: string, rid = runnerId): Promise<{ id: string; g: number }> {
    const runId = id ?? (await pending(account));
    const result = await facade.claimRunnerRun({ accountId: account.accountId, runnerId: rid });
    if (result.kind !== "claimed" || result.runId !== runId) throw new Error("not claimed");
    return { id: runId, g: result.leaseGeneration };
  }

  const T0 = Date.parse("2026-10-10T12:00:00.000Z");
  const ts = (ms: number): string => new Date(T0 + ms).toISOString();
  const nextSeq = (id: string): number => {
    const n = seqOf.get(id) ?? 0;
    seqOf.set(id, n + 1);
    return n;
  };
  const use = (id: string, ms: number, extra: object = {}): LocalOnlyEvent => ({ seq: nextSeq(id), ts: ts(ms), type: "tool_use", tool_name: "Bash", ...extra }) as LocalOnlyEvent;
  const ctx = () => ({ pool: appPool, principal: { accountId: A.accountId, userId: A.userId } });
  const lines = async (id: string): Promise<string[]> => (await getRunInsight(ctx(), id)).lines.map((l) => l.text).filter((t) => t !== "The run started");
  const count = async (id: string, where = "TRUE"): Promise<number> => (await admin.query(`SELECT count(*)::int AS n FROM run_events WHERE run_id = $1 AND ${where}`, [id])).rows[0].n;
  const activity = (id: string) => count(id, "kind = 'agent.activity'");
  /** Every run_events row of the account, so a refusal that wrote to ANY run shows. */
  const accountRows = async (accountId: string): Promise<number> => (await admin.query("SELECT count(*)::int AS n FROM run_events WHERE account_id = $1", [accountId])).rows[0].n;
  /** Sends in batches of 100, the protocol's maximum, and requires each to be accepted. */
  async function sendAll(id: string, g: number, events: LocalOnlyEvent[]): Promise<void> {
    for (let i = 0; i < events.length; i += 100) {
      const r = await client.events(id, g, events.slice(i, i + 100));
      expect(r.kind).toBe("ok");
    }
  }

  describe("what a stored batch becomes", () => {
    it("a test command is one runner.event and one agent.activity, and the shared reader says 'Ran tests: pnpm test'", async () => {
      const { id, g } = await claimed();
      const r = await client.events(id, g, [use(id, 0, { activity: { tool: "test", command: "pnpm test" } })]);
      expect(r.kind).toBe("ok");
      expect(await count(id, "kind = 'runner.event'")).toBe(1);
      expect(await activity(id)).toBe(1);
      expect(await lines(id)).toContain("Ran tests: pnpm test");
    });

    it("a command that carries a token is stored as its kind alone, shown as 'Running a command', and the token is in no payload", async () => {
      const { id, g } = await claimed();
      const token = `ghp_${"A".repeat(36)}`;
      await client.events(id, g, [use(id, 0, { activity: { tool: "command", command: `curl -H 'Authorization: Bearer ${token}' https://x.example` } })]);
      const row = (await admin.query("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'agent.activity'", [id])).rows[0];
      expect(row.payload).toEqual({ tool: "command" });
      expect(await lines(id)).toContain("Running a command");
      expect(await count(id, "payload::text LIKE '%ghp_%' OR payload::text LIKE '%Bearer%'")).toBe(0);
    });

    it("credential shapes only the clean check catches are in no run_events payload, raw rows included", async () => {
      const { id, g } = await claimed();
      // Built from parts so the repo's secret scanner does not read these made-up values as credentials.
      const pw = ["hunt", "er2"].join("");
      const awsKey = ["AbCdEf", "123"].join("");
      const secrets = [pw, awsKey];
      const commands = [`mysql -u root -p${pw} db`, `curl -u bob:${pw} https://x`, `app --pass${"word"} ${pw}`, `aws configure set aws_secret_${"access_key"} ${awsKey}`];
      await client.events(id, g, commands.map((command, i) => use(id, i * 1000, { activity: { tool: "command", command } })));
      for (const s of secrets) expect(await count(id, `payload::text LIKE '%${s}%'`), s).toBe(0);
      expect(await count(id, "kind = 'runner.event'")).toBe(4);
      const raw = await admin.query("SELECT payload->'activity' AS a FROM run_events WHERE run_id = $1 AND kind = 'runner.event' ORDER BY seq", [id]);
      expect(raw.rows.map((r) => r.a)).toEqual(commands.map(() => ({ tool: "command" })));
    });

    it("500 stage events store at most 3 raw rows and 3 stage rows", async () => {
      const { id, g } = await claimed();
      const names = ["workspace_ready", "cloned", "writing_result"];
      for (let b = 0; b < 5; b++) {
        const batch = Array.from({ length: 100 }, (_, i) => ({ seq: nextSeq(id), ts: ts((b * 100 + i) * 1000), type: "stage", stage: names[i % 3] }) as LocalOnlyEvent);
        expect((await client.events(id, g, batch)).kind).toBe("ok");
      }
      expect(await count(id, "kind = 'runner.event' AND payload->>'type' = 'stage'")).toBe(3);
      expect(await count(id, "kind = 'run.stage'")).toBe(3);
    });

    it("a late batch after done is still the stop reply; only its usage is stored, and no activity or stage row is written", async () => {
      await admin.query("UPDATE runners SET allowed_roles = ARRAY['performance-expert'] WHERE id = $1", [runnerId]);
      const id = await pending(A, "performance-expert");
      const { g } = await claimed(A, id);
      expect((await client.done({ runId: id, leaseGeneration: g })).kind).toBe("done");
      const before = await count(id);
      const r = await client.events(id, g, [
        use(id, 0, { activity: { tool: "read", path: "src/a.ts" } }),
        { seq: nextSeq(id), ts: ts(1000), type: "stage", stage: "cloned" } as LocalOnlyEvent,
        { seq: nextSeq(id), ts: ts(2000), type: "usage", usage: { input: 10, output: 5 } } as LocalOnlyEvent,
      ]);
      expect(r.kind).toBe("stop");
      expect(await count(id, "kind = 'runner.event' AND payload->>'type' = 'usage'")).toBe(1);
      expect(await count(id, "kind = 'runner.event' AND payload->>'type' <> 'usage'")).toBe(0);
      expect(await count(id, "kind IN ('agent.activity', 'run.stage')")).toBe(0);
      expect(await count(id)).toBe(before + 1);
    });

    it("an older runner's tool_use (no activity field) still gives kind-and-path lines", async () => {
      const { id, g } = await claimed();
      await client.events(id, g, [
        use(id, 0, { tool_name: "Read", file_path: "src/a.ts" }),
        use(id, 1000, { tool_name: "Grep" }),
        use(id, 2000, { tool_name: "LS" }),
        use(id, 3000, { tool_name: "Bash" }),
        use(id, 4000, { tool_name: "Edit", file_path: "src/a.ts" }),
        use(id, 5000, { tool_name: "Read", file_path: "/etc/passwd" }),
      ]);
      expect(await lines(id)).toEqual(["Reading src/a.ts", "Searching the code", "Looking through the repository", "Running a command"]);
    });

    it("stage workspace_ready sent twice gives exactly one run.stage sandbox_ready row, and the sandbox wording", async () => {
      const { id, g } = await claimed();
      const stage = (ms: number) => ({ seq: nextSeq(id), ts: ts(ms), type: "stage", stage: "workspace_ready" }) as LocalOnlyEvent;
      await client.events(id, g, [stage(0)]);
      await client.events(id, g, [stage(1000)]);
      const rows = (await admin.query("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.stage'", [id])).rows;
      expect(rows.map((r) => r.payload)).toEqual([{ stage: "sandbox_ready" }]);
      expect(await lines(id)).toContain("The secure sandbox is ready");
    });
  });

  describe("bounds", () => {
    it("300 events one second apart give 200 activity rows, and run_ended leaves one capped row that counts the rest", async () => {
      const { id, g } = await claimed();
      await sendAll(id, g, Array.from({ length: 300 }, (_, i) => use(id, i * 1000, { activity: { tool: "read", path: `src/f${i}.ts` } })));
      expect(await activity(id)).toBe(200);
      expect(await count(id, "kind = 'agent.activity.capped'")).toBe(0);
      expect((await client.events(id, g, [{ seq: nextSeq(id), ts: ts(400_000), type: "run_ended", reason: "agent_failed" } as LocalOnlyEvent])).kind).toBe("ok");
      expect(await count(id, "kind = 'agent.activity.capped'")).toBe(1);
      const dropped = (await admin.query("SELECT (payload->>'dropped')::int AS d FROM run_events WHERE run_id = $1 AND kind = 'agent.activity.capped'", [id])).rows[0].d;
      expect(dropped).toBeGreaterThanOrEqual(100);
    });

    it("a run that ends by done (not run_ended) also gets the capped row", async () => {
      await admin.query("UPDATE runners SET allowed_roles = ARRAY['performance-expert'] WHERE id = $1", [runnerId]);
      const id = await pending(A, "performance-expert");
      const { g } = await claimed(A, id);
      await sendAll(id, g, Array.from({ length: 210 }, (_, i) => use(id, i * 1000, { activity: { tool: "read", path: `src/f${i}.ts` } })));
      expect(await count(id, "kind = 'agent.activity.capped'")).toBe(0);
      expect((await client.done({ runId: id, leaseGeneration: g })).kind).toBe("done");
      expect(await count(id, "kind = 'agent.activity.capped'")).toBe(1);
    });

    it("10 events inside 250 ms give one row: the newest", async () => {
      const { id, g } = await claimed();
      await client.events(id, g, Array.from({ length: 10 }, (_, i) => use(id, i * 10, { activity: { tool: "read", path: `src/f${i}.ts` } })));
      expect(await activity(id)).toBe(1);
      expect(await lines(id)).toEqual(["Reading src/f9.ts"]);
    });

    it("sending the same batch again adds no row of any kind", async () => {
      const { id, g } = await claimed();
      const batch = [use(id, 0, { activity: { tool: "read", path: "src/a.ts" } }), use(id, 1000, { activity: { tool: "search", pattern: "x" } })];
      expect((await client.events(id, g, batch)).kind).toBe("ok");
      const before = await count(id);
      expect((await client.events(id, g, batch)).kind).toBe("seq_not_increasing");
      expect(await count(id)).toBe(before);
    });

    it("2,100 tool_use events store 2,000 runner.event rows, and a usage event after them is still stored", async () => {
      const { id, g } = await claimed();
      await sendAll(id, g, Array.from({ length: 2100 }, (_, i) => use(id, i * 1000, { tool_name: "Edit", file_path: `src/f${i}.ts` })));
      expect(await count(id, "kind = 'runner.event' AND payload->>'type' = 'tool_use'")).toBe(2000);
      expect((await client.events(id, g, [{ seq: nextSeq(id), ts: ts(3_000_000), type: "usage", usage: { input: 10, output: 5 } } as LocalOnlyEvent])).kind).toBe("ok");
      expect(await count(id, "kind = 'runner.event' AND payload->>'type' = 'usage'")).toBe(1);
    });
  });

  describe("fail closed: a refused request stores zero rows of any kind", () => {
    const body = (id: string, g: number) => JSON.stringify({ run_id: id, lease_generation: g, events: [use(id, 0, { activity: { tool: "command", command: "ls" } })] });
    const path = (id: string) => `/api/runner/runs/${id}/events`;
    const post = (id: string, payload: string, headers: Record<string, string> = {}) =>
      fetch(`${cloud.origin}${path(id)}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: payload });
    const signedBy = (k: TestKey, id: string, payload: string): Record<string, string> =>
      signRequest({ method: "POST", url: `${cloud.origin}${path(id)}`, body: Buffer.from(payload), privateKey: k.privateKey, keyid: k.jkt, nonce: randomBytes(16).toString("base64url"), created: Math.floor(Date.now() / 1000) }) as unknown as Record<string, string>;

    it("an unsigned request is 401", async () => {
      const { id, g } = await claimed();
      const before = await accountRows(A.accountId);
      expect((await post(id, body(id, g))).status).toBe(401);
      expect(await accountRows(A.accountId)).toBe(before);
    });

    it("a request signed by a key that is not this account's runner is 401", async () => {
      const { id, g } = await claimed();
      const before = await accountRows(A.accountId);
      const payload = body(id, g);
      expect((await post(id, payload, signedBy(newKey(), id, payload))).status).toBe(401);
      expect(await accountRows(A.accountId)).toBe(before);
    });

    it("a replayed signed request is refused (409 nonce_reused, the handler's existing answer) and adds nothing to the first one's rows", async () => {
      const { id, g } = await claimed();
      expect((await client.events(id, g, [use(id, 0, { activity: { tool: "command", command: "ls" } })])).kind).toBe("ok");
      const first = seen[seen.length - 1]!;
      const before = await accountRows(A.accountId);
      expect(before).toBeGreaterThan(0);
      const again = await fetch(first.url, first.init);
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({ error: { code: "nonce_reused" } });
      expect(await accountRows(A.accountId)).toBe(before);
    });

    it("a run this runner has not claimed (still pending) is a 409 stop", async () => {
      const id = await pending();
      const before = await accountRows(A.accountId);
      const r = await client.events(id, 1, [use(id, 0, { activity: { tool: "command", command: "ls" } })]);
      expect(r).toMatchObject({ kind: "stop" });
      expect(await accountRows(A.accountId)).toBe(before);
    });

    it("a run another runner of the same account holds is a 409 stop", async () => {
      const other = await newRunner(A);
      const { id, g } = await claimed(A, undefined, other.runnerId);
      const before = await accountRows(A.accountId);
      const r = await client.events(id, g, [use(id, 0, { activity: { tool: "command", command: "ls" } })]);
      expect(r).toMatchObject({ kind: "stop" });
      expect(await accountRows(A.accountId)).toBe(before);
    });

    it("a stale lease generation is a 409 stop", async () => {
      const { id, g } = await claimed();
      const before = await accountRows(A.accountId);
      const r = await client.events(id, g + 1, [use(id, 0, { activity: { tool: "command", command: "ls" } })]);
      expect(r).toMatchObject({ kind: "stop" });
      expect(await accountRows(A.accountId)).toBe(before);
    });

    it("another account's run, even held by that account's runner, stores nothing", async () => {
      const B = await seedAccount(admin, randomUUID());
      await admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [B.repoId]);
      const b = await newRunner(B);
      const { id, g } = await claimed(B, undefined, b.runnerId);
      const before = await accountRows(B.accountId);
      const r = await client.events(id, g, [use(id, 0, { activity: { tool: "command", command: "ls" } })]);
      expect(r.kind === "stop" || r.kind === "error").toBe(true);
      expect(await accountRows(B.accountId)).toBe(before);
    });
  });
});

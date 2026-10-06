import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAad, seal, type KekSource } from "@fx/model-connection";
import { buildFirewallPolicy, loadGithubForwardConfig } from "@fx/runner";
import { buildWorker, type BuildWorkerOptions } from "../src/compositionRoot.js";
import { createConnectionStatusPort, createDecryptTenantKey, createModelConnectionPort, ModelConnectionUnavailableError } from "../src/ports.js";
import type { WorkerPools } from "../src/pools.js";

const PLAINTEXT = "sk-tenant-plaintext-key-0123456789";
const ACCOUNT = randomUUID();
const OTHER_ACCOUNT = randomUUID();
const CONNECTION = randomUUID();
const KEK = randomBytes(32);
const kek: KekSource = {
  currentVersion: () => 1,
  keyFor(version) {
    if (version !== 1) throw new Error(`no KEK v${version}`);
    return KEK;
  },
};

function sealedFor(accountId: string, connectionId: string) {
  const s = seal({ kek: KEK, aad: buildAad(accountId, connectionId) }, PLAINTEXT);
  return { ciphertext: new Uint8Array(s.ciphertext), nonce: new Uint8Array(s.nonce), wrappedDek: new Uint8Array(s.wrappedDek), kekVersion: 1 };
}

interface Recorded {
  sql: string;
  params: unknown[];
}
/** A pool whose one client answers by SQL text and records every statement. */
function fakePool(answer: (sql: string, params: unknown[]) => Record<string, unknown>[]): { pool: Pool; log: Recorded[]; released: number } {
  const state = { pool: undefined as unknown as Pool, log: [] as Recorded[], released: 0 };
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      state.log.push({ sql, params });
      return { rows: answer(sql, params) };
    },
    release: () => {
      state.released++;
    },
  };
  state.pool = { connect: async () => client } as unknown as Pool;
  return state;
}

describe("decryptTenantKey (AAD = account + connection ids)", () => {
  const decrypt = createDecryptTenantKey(kek);

  it("opens a key sealed under the same account and connection", async () => {
    await expect(decrypt(sealedFor(ACCOUNT, CONNECTION), { accountId: ACCOUNT, connectionId: CONNECTION })).resolves.toBe(PLAINTEXT);
  });

  it("fails for another account or another connection row (a ciphertext copied elsewhere does not open)", async () => {
    const sealed = sealedFor(ACCOUNT, CONNECTION);
    await expect(decrypt(sealed, { accountId: OTHER_ACCOUNT, connectionId: CONNECTION })).rejects.toThrow();
    await expect(decrypt(sealed, { accountId: ACCOUNT, connectionId: randomUUID() })).rejects.toThrow();
  });

  it("fails for a KEK version the platform does not have, and for a tampered ciphertext", async () => {
    const sealed = sealedFor(ACCOUNT, CONNECTION);
    await expect(decrypt({ ...sealed, kekVersion: 2 }, { accountId: ACCOUNT, connectionId: CONNECTION })).rejects.toThrow();
    const tampered = { ...sealed, ciphertext: sealed.ciphertext.map((b, i) => (i === 0 ? b ^ 1 : b)) };
    await expect(decrypt(tampered, { accountId: ACCOUNT, connectionId: CONNECTION })).rejects.toThrow();
  });

  it("through buildFirewallPolicy the plaintext reaches only the model rule's non-enumerable authValue", async () => {
    const forward = loadGithubForwardConfig({ FX_GH_FORWARD_SUFFIX: "fixture.test", FX_GH_FORWARD_HOST: "gh-proxy.fixture.test" });
    const logs = ["log", "info", "warn", "error", "debug"].map((m) => vi.spyOn(console, m as "log").mockImplementation(() => {}));
    const rules = await buildFirewallPolicy(
      decrypt,
      { role: "executor", product: "team", provider: "ai_gateway", encryptedKey: sealedFor(ACCOUNT, CONNECTION), keyContext: { accountId: ACCOUNT, connectionId: CONNECTION } },
      { githubForward: forward, lookup: async () => [{ address: "140.82.112.3", family: 4 }] },
    );
    expect(JSON.stringify(rules)).not.toContain(PLAINTEXT);
    const holders = rules.filter((r) => (r as { authValue?: string }).authValue?.includes(PLAINTEXT));
    expect(holders.map((r) => r.purpose)).toEqual(["model"]);
    for (const spy of logs) expect(JSON.stringify(spy.mock.calls)).not.toContain(PLAINTEXT);
  });
});

describe("modelConnection port (ciphertext only, tenant-scoped)", () => {
  const row = { id: CONNECTION, provider: "ai_gateway", status: "ok", ...sealedFor(ACCOUNT, CONNECTION), kek_version: 1, wrappedDek: Buffer.from("w"), nonce: Buffer.from("n"), ciphertext: Buffer.from("c") };

  it("reads the account's row under its tenant scope and returns provider, connection id and ciphertext", async () => {
    const { pool, log } = fakePool((sql) => (sql.includes("FROM model_connections") ? [row] : []));
    const got = await createModelConnectionPort(pool).get(ACCOUNT);
    expect(got.provider).toBe("ai_gateway");
    expect(got.connectionId).toBe(CONNECTION);
    expect(got.encryptedKey.kekVersion).toBe(1);
    expect(JSON.stringify(got)).not.toContain(PLAINTEXT);
    const select = log.find((q) => q.sql.includes("FROM model_connections"))!;
    expect(select.params).toEqual([ACCOUNT]);
    expect(log.some((q) => q.params.includes(ACCOUNT) && q.sql.includes("set_config"))).toBe(true);
  });

  it("refuses a missing, broken or unknown-provider connection with one fixed error naming no account", async () => {
    for (const rows of [[], [{ ...row, status: "broken" }], [{ ...row, provider: "mystery" }]]) {
      const { pool } = fakePool((sql) => (sql.includes("FROM model_connections") ? rows : []));
      const err = await createModelConnectionPort(pool).get(ACCOUNT).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ModelConnectionUnavailableError);
      expect((err as Error).message).not.toContain(ACCOUNT);
    }
  });
});

describe("connectionStatus port (server-derived tenant from the run id)", () => {
  const RUN = randomUUID();
  const answer = (sql: string, params: unknown[]): Record<string, unknown>[] => {
    if (sql.startsWith("SELECT account_id FROM agent_runs")) return params[0] === RUN ? [{ account_id: ACCOUNT }] : [];
    if (sql.includes("INSERT")) return [{ id: randomUUID() }];
    return [];
  };

  it("looks the account up by run id and marks only that account, in one transaction", async () => {
    const fake = fakePool(answer);
    const { pool, log } = fake;
    await createConnectionStatusPort(pool).markBroken(RUN, 401);
    expect(log[0]!.sql).toBe("BEGIN");
    expect(log[1]).toEqual({ sql: "SELECT account_id FROM agent_runs WHERE id = $1", params: [RUN] });
    const writes = log.filter((q) => /^UPDATE (model_connections|accounts)/.test(q.sql));
    expect(writes).toHaveLength(2);
    for (const w of writes) expect(w.params[0]).toBe(ACCOUNT);
    expect(writes[0]!.params).toEqual([ACCOUNT, "401"]);
    expect(log.flatMap((q) => q.params)).not.toContain(OTHER_ACCOUNT);
    expect(log.at(-1)!.sql).toBe("COMMIT");
    expect(fake.released).toBe(1);
  });

  it("a run that does not exist marks nothing, rolls back and releases the client", async () => {
    const fake = fakePool(answer);
    const { pool, log } = fake;
    await expect(createConnectionStatusPort(pool).markBroken(randomUUID(), 403)).rejects.toThrow();
    expect(log.some((q) => q.sql.startsWith("UPDATE"))).toBe(false);
    expect(log.at(-1)!.sql).toBe("ROLLBACK");
    expect(fake.released).toBe(1);
  });
});

describe("buildWorker: production ports, targetOverrides and portLimits (H14c-3-2b)", () => {
  const closed = { n: 0 };
  afterEach(() => {
    closed.n = 0;
  });
  const runnerPool = fakePool(() => []).pool;
  const platformOpsPool = fakePool(() => []).pool;
  const pools: WorkerPools = { runnerPool, platformOpsPool, close: async () => void closed.n++ };
  const base = (over: Partial<BuildWorkerOptions> = {}): BuildWorkerOptions => ({
    env: { FX_GH_FORWARD_SUFFIX: "fixture.test", FX_GH_FORWARD_HOST: "gh-proxy.fixture.test" },
    vercel: { teamId: "t", projectId: "p", getToken: async () => "tok" },
    ports: { hooks: { resume: async () => {} } },
    kek,
    createPools: async () => pools,
    ...over,
  });

  it("builds with only `hooks` supplied: the three other ports are the production bodies", async () => {
    const worker = await buildWorker(base());
    const opened = await worker.targetDeps.decryptTenantKey(sealedFor(ACCOUNT, CONNECTION), { accountId: ACCOUNT, connectionId: CONNECTION });
    expect(opened).toBe(PLAINTEXT);
    await expect(worker.targetDeps.decryptTenantKey(sealedFor(ACCOUNT, CONNECTION), { accountId: OTHER_ACCOUNT, connectionId: CONNECTION })).rejects.toThrow();
  });

  it("an injected port replaces the production body", async () => {
    const decryptTenantKey = async () => "injected";
    const worker = await buildWorker(base({ ports: { hooks: { resume: async () => {} }, decryptTenantKey } }));
    expect(worker.targetDeps.decryptTenantKey).toBe(decryptTenantKey);
  });

  it("passes extensionPolicyFor and defaultTimeoutMs to the target, and nothing else a caller might add", async () => {
    const extensionPolicyFor = () => undefined;
    const evil = { extensionPolicyFor, defaultTimeoutMs: 1234, pool: {}, sandboxPort: {}, githubForward: {} } as unknown as NonNullable<BuildWorkerOptions["targetOverrides"]>;
    const worker = await buildWorker(base({ targetOverrides: evil }));
    expect(worker.targetDeps.extensionPolicyFor).toBe(extensionPolicyFor);
    expect(worker.targetDeps.defaultTimeoutMs).toBe(1234);
    expect(worker.targetDeps.pool).toBe(runnerPool);
    expect(worker.targetDeps.sandboxPort).toBe(worker.sandboxPort);
    expect(worker.targetDeps.githubForward).toBe(worker.githubForward);
  });

  it("validates portLimits at build (a bad value closes the pools and refuses), and accepts a valid override", async () => {
    await expect(buildWorker(base({ portLimits: { maxTurns: 0 } }))).rejects.toThrow(/maxTurns/);
    expect(closed.n).toBe(1);
    await expect(buildWorker(base({ portLimits: { maxTurns: 50, maxRunMs: 30 * 60_000 } }))).resolves.toBeDefined();
  });

  it("no plaintext outside the firewall step: the only source that opens a key is ports.ts, and it never logs", () => {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
    const opens = readdirSync(dir).filter((f) => /\bopen\b/.test(readFileSync(path.join(dir, f), "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "")) && /@fx\/model-connection/.test(readFileSync(path.join(dir, f), "utf8")));
    expect(opens).toEqual(["ports.ts"]);
    expect(readFileSync(path.join(dir, "ports.ts"), "utf8")).not.toMatch(/console\.|logger|JSON\.stringify/);
  });
});

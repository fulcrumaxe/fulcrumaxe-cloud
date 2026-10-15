import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { buildAad, connectionAad, seal, type KekSource } from "@fx/model-connection";
import { createConnectionStatusPort, createDecryptTenantKey, createModelConnectionPort } from "../src/ports.js";

/**
 * [pg] The three production ports against the real schema, grants and RLS: the runner login (app_user +
 * agent_run_writer) reads a tenant's own connection only; platform_ops resolves a run's account itself and marks
 * only that account's connection broken.
 */
const PLAINTEXT = "sk-tenant-plaintext-key-0123456789";
const KEK = randomBytes(32);
const kek: KekSource = { currentVersion: () => 1, keyFor: () => KEK };

let admin: Pool;
let runnerPool: Pool;
let opsPool: Pool;

interface Tenant {
  accountId: string;
  connectionId: string;
  runId: string;
}

async function seedTenant(): Promise<Tenant> {
  const t = { accountId: randomUUID(), connectionId: randomUUID(), runId: randomUUID() };
  await admin.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [t.accountId, `cus_${t.accountId}`]);
  const sealed = seal({ kek: KEK, aad: buildAad(t.accountId, t.connectionId) }, PLAINTEXT);
  await admin.query(
    `INSERT INTO model_connections (id, account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint, status)
     VALUES ($1, $2, 'ai_gateway', $3, $4, $5, 1, 'abcd', 'ok')`,
    [t.connectionId, t.accountId, sealed.ciphertext, sealed.nonce, sealed.wrappedDek],
  );
  await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'executor', 'production', 'running')`, [t.runId, t.accountId]);
  return t;
}

beforeAll(() => {
  admin = createPool(process.env.WORKER_DATABASE_URL!);
  runnerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
  opsPool = createPool(process.env.WORKER_DATABASE_URL_PLATFORM_OPS!);
});
afterAll(async () => {
  await Promise.all([admin.end(), runnerPool.end(), opsPool.end()]);
});

describe("[pg] modelConnection + decryptTenantKey", () => {
  it("returns the tenant's own connection and its ciphertext opens only under that account and connection", async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    const port = createModelConnectionPort(runnerPool);
    const decrypt = createDecryptTenantKey(kek);

    const got = await port.get(a.accountId);
    expect(got.connectionId).toBe(a.connectionId);
    await expect(decrypt(got.encryptedKey, { accountId: a.accountId, connectionId: got.connectionId })).resolves.toBe(PLAINTEXT);
    // Wrong AAD: the other tenant's ids, and the right account with the other tenant's connection row.
    await expect(decrypt(got.encryptedKey, { accountId: b.accountId, connectionId: got.connectionId })).rejects.toThrow();
    await expect(decrypt(got.encryptedKey, { accountId: a.accountId, connectionId: b.connectionId })).rejects.toThrow();
    expect((await port.get(b.accountId)).connectionId).toBe(b.connectionId);
  });

  it("D#221 MC1: a row sealed under AAD version 2 comes through the port with its sealing context and opens only under its kind", async () => {
    const t = await seedTenant();
    const sealed = seal({ kek: KEK, aad: connectionAad({ accountId: t.accountId, connectionId: t.connectionId, credentialKind: "ai_gateway", aadVersion: 2 }) }, PLAINTEXT);
    await admin.query(
      `UPDATE model_connections SET key_ciphertext = $2, key_nonce = $3, wrapped_dek = $4, aad_version = 2 WHERE id = $1`,
      [t.connectionId, sealed.ciphertext, sealed.nonce, sealed.wrappedDek],
    );
    const got = await createModelConnectionPort(runnerPool).get(t.accountId);
    expect([got.encryptedKey.credentialKind, got.encryptedKey.aadVersion]).toEqual(["ai_gateway", 2]);
    const decrypt = createDecryptTenantKey(kek);
    await expect(decrypt(got.encryptedKey, { accountId: t.accountId, connectionId: got.connectionId })).resolves.toBe(PLAINTEXT);
    // The same ciphertext presented as another kind, or as a version-1 row, does not open.
    await expect(decrypt({ ...got.encryptedKey, credentialKind: "anthropic" }, { accountId: t.accountId, connectionId: got.connectionId })).rejects.toThrow();
    await expect(decrypt({ ...got.encryptedKey, aadVersion: 1 }, { accountId: t.accountId, connectionId: got.connectionId })).rejects.toThrow();
  });

  it("D#221 MC1: an OpenAI connection is refused by the port until a backend can use it, and never reaches a run", async () => {
    const t = await seedTenant();
    await admin.query(
      `UPDATE model_connections SET provider = 'openai', credential_kind = 'openai_api_key', aad_version = 2, backend = 'codex' WHERE id = $1`,
      [t.connectionId],
    );
    await expect(createModelConnectionPort(runnerPool).get(t.accountId)).rejects.toThrow();
  });

  it("refuses an account with no connection and an account whose connection is broken", async () => {
    const port = createModelConnectionPort(runnerPool);
    await expect(port.get(randomUUID())).rejects.toThrow();
    const c = await seedTenant();
    await admin.query(`UPDATE model_connections SET status = 'broken' WHERE id = $1`, [c.connectionId]);
    await expect(port.get(c.accountId)).rejects.toThrow();
  });
});

describe("[pg] model-connection read with several rows for one account (H14c-3-2c)", () => {
  const port = () => createModelConnectionPort(runnerPool);
  async function account(): Promise<string> {
    const accountId = randomUUID();
    await admin.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [accountId, `cus_${accountId}`]);
    return accountId;
  }
  async function add(accountId: string, status: string, validatedAt: string | null): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO model_connections (id, account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint, status, last_validated_at)
       VALUES ($1, $2, 'ai_gateway', 'c', 'n', 'w', 1, 'abcd', $3, $4)`,
      [id, accountId, status, validatedAt],
    );
    return id;
  }

  it("prefers an ok connection whichever row was inserted first", async () => {
    const a = await account();
    await add(a, "unvalidated", null);
    const okA = await add(a, "ok", "2026-01-01T00:00:00Z");
    expect((await port().get(a)).connectionId).toBe(okA);
    const b = await account();
    const okB = await add(b, "ok", "2026-01-01T00:00:00Z");
    await add(b, "unvalidated", null);
    expect((await port().get(b)).connectionId).toBe(okB);
  });

  it("among ok connections takes the newest validation; a usable one beats a broken one; only-broken is refused", async () => {
    const a = await account();
    const newer = await add(a, "ok", "2026-03-01T00:00:00Z");
    await add(a, "ok", "2026-02-01T00:00:00Z");
    expect((await port().get(a)).connectionId).toBe(newer);
    const b = await account();
    await add(b, "broken", "2026-06-01T00:00:00Z");
    const usable = await add(b, "unvalidated", null);
    expect((await port().get(b)).connectionId).toBe(usable);
    const c = await account();
    await add(c, "broken", null);
    await expect(port().get(c)).rejects.toThrow();
  });
});

describe("[pg] connectionStatus.markBroken(runId)", () => {
  it("marks only the run's own account, derived server-side from agent_runs", async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    await createConnectionStatusPort(opsPool).markBroken(a.runId, 401);
    const state = async (t: Tenant) => {
      const { rows } = await admin.query(
        `SELECT m.status, m.last_error_code, (a.key_broken_at IS NOT NULL) AS paused
           FROM model_connections m JOIN accounts a ON a.id = m.account_id WHERE m.id = $1`,
        [t.connectionId],
      );
      return rows[0];
    };
    expect(await state(a)).toEqual({ status: "broken", last_error_code: "401", paused: true });
    expect(await state(b)).toEqual({ status: "ok", last_error_code: null, paused: false });
  });

  it("a run id that does not exist changes nothing", async () => {
    const c = await seedTenant();
    await expect(createConnectionStatusPort(opsPool).markBroken(randomUUID(), 403)).rejects.toThrow();
    const { rows } = await admin.query(`SELECT status FROM model_connections WHERE id = $1`, [c.connectionId]);
    expect(rows[0].status).toBe("ok");
  });
});

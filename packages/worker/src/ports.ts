import type { Pool } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { buildAad, markBrokenWithClient, open, type KekSource } from "@fx/model-connection";
import type { BrokenConnectionCode, ConnectionStatusPort, DecryptTenantKey, ModelConnectionPort } from "@fx/runner";

/**
 * D#2 H14c-3-2b: the production bodies of three of the four `WorkerPorts`
 * (the fourth, `hooks`, stays injected: its body is H14c-3-3). Package-private:
 * built inside `buildWorker` from the pools and never handed out.
 *
 * The tenant's plaintext key exists in exactly one place, the return value of
 * `decryptTenantKey`, which `buildFirewallPolicy` (packages/runner) alone
 * calls. Nothing here logs, caches, stores or returns it, and the model
 * connection port hands out ciphertext only.
 */

/** Thrown for a missing or unusable connection. Fixed message: no account id, no row, no driver text. */
export class ModelConnectionUnavailableError extends Error {
  constructor() {
    super("worker: the account has no usable model connection");
    this.name = "ModelConnectionUnavailableError";
  }
}

/**
 * Opens a sealed key with the platform KEK version the row names. The AAD is
 * built from the run's account and the connection row (the same
 * `accountId:rowId:model_key` the connect flow sealed it under), so a
 * ciphertext copied onto another account or row fails GCM authentication.
 */
export function createDecryptTenantKey(kek: KekSource): DecryptTenantKey {
  return async (encrypted, context) =>
    open(
      { kek: kek.keyFor(encrypted.kekVersion), aad: buildAad(context.accountId, context.connectionId) },
      {
        ciphertext: Buffer.from(encrypted.ciphertext),
        nonce: Buffer.from(encrypted.nonce),
        wrappedDek: Buffer.from(encrypted.wrappedDek),
      },
    );
}

interface ConnectionRow {
  id: string;
  provider: string;
  status: string;
  ciphertext: Buffer;
  nonce: Buffer;
  wrappedDek: Buffer;
  kek_version: number;
}

/** Reads the account's sealed key on the runner login's pool, inside the tenant's RLS scope. Ciphertext only. */
export function createModelConnectionPort(runnerPool: Pool): ModelConnectionPort {
  return {
    async get(accountId) {
      const row = await withTenant(runnerPool, accountId, async (client) => {
        const { rows } = await client.query<ConnectionRow>(
          `SELECT id, provider, status, key_ciphertext AS ciphertext, key_nonce AS nonce, wrapped_dek AS "wrappedDek", kek_version
             FROM model_connections WHERE account_id = $1
            ORDER BY CASE status WHEN 'ok' THEN 0 WHEN 'unvalidated' THEN 1 ELSE 2 END,
                     last_validated_at DESC NULLS LAST, created_at DESC, id DESC
            LIMIT 1`,
          [accountId],
        );
        return rows[0];
      });
      if (!row || row.status === "broken" || (row.provider !== "ai_gateway" && row.provider !== "anthropic")) {
        throw new ModelConnectionUnavailableError();
      }
      return {
        provider: row.provider,
        connectionId: row.id,
        encryptedKey: { ciphertext: row.ciphertext, nonce: row.nonce, wrappedDek: row.wrappedDek, kekVersion: row.kek_version },
      };
    },
  };
}

/**
 * The runner's `markBroken(runId, code)` keeps its run-id argument: the tenant
 * is derived here, from `agent_runs.account_id`, never chosen by the caller. On
 * the platform_ops pool (the only login allowed to write the connection's
 * status); the lookup and the write share one transaction.
 */
export function createConnectionStatusPort(platformOpsPool: Pool): ConnectionStatusPort {
  return {
    async markBroken(runId: string, code: BrokenConnectionCode): Promise<void> {
      const client = await platformOpsPool.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query<{ account_id: string }>("SELECT account_id FROM agent_runs WHERE id = $1", [runId]);
        const accountId = rows[0]?.account_id;
        if (!accountId) throw new Error("worker: markBroken for a run that does not exist");
        await markBrokenWithClient(client, accountId, code);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

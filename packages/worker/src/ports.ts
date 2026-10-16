import type { Pool, PoolClient } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { connectionAad, markBrokenWithClient, markCreditsExhaustedWithClient, open, type KekSource } from "@fx/model-connection";
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
 * built from the run's account, the connection row and the credential kind
 * (the same context the connect flow sealed it under), so a ciphertext copied
 * onto another account, row or kind fails GCM authentication.
 */
export function createDecryptTenantKey(kek: KekSource): DecryptTenantKey {
  return async (encrypted, context) =>
    open(
      {
        kek: kek.keyFor(encrypted.kekVersion),
        aad: connectionAad({
          accountId: context.accountId,
          connectionId: context.connectionId,
          credentialKind: encrypted.credentialKind,
          aadVersion: encrypted.aadVersion,
        }),
      },
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
  credential_kind: string;
  aad_version: number;
}

/** Reads the account's sealed key on the runner login's pool, inside the tenant's RLS scope. Ciphertext only. */
export function createModelConnectionPort(runnerPool: Pool): ModelConnectionPort {
  return {
    async get(accountId) {
      const row = await withTenant(runnerPool, accountId, async (client) => {
        const { rows } = await client.query<ConnectionRow>(
          `SELECT id, provider, status, key_ciphertext AS ciphertext, key_nonce AS nonce, wrapped_dek AS "wrappedDek", kek_version,
                  credential_kind, aad_version
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
        encryptedKey: {
          ciphertext: row.ciphertext,
          nonce: row.nonce,
          wrappedDek: row.wrappedDek,
          kekVersion: row.kek_version,
          credentialKind: row.credential_kind,
          aadVersion: row.aad_version,
        },
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
  /** One transaction: the owning account from the run row, then the write for it. Never an account id from the caller. */
  async function forRunsAccount(runId: string, write: (client: PoolClient, accountId: string) => Promise<unknown>): Promise<void> {
    const client = await platformOpsPool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ account_id: string }>("SELECT account_id FROM agent_runs WHERE id = $1", [runId]);
      const accountId = rows[0]?.account_id;
      if (!accountId) throw new Error("worker: connection status write for a run that does not exist");
      await write(client, accountId);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
  return {
    markBroken: (runId: string, code: BrokenConnectionCode): Promise<void> => forRunsAccount(runId, (client, accountId) => markBrokenWithClient(client, accountId, code)),
    // D#483 S5-k2: the out-of-credit answer. Same derivation of the tenant; a different write (the connection only, no account stop).
    markCreditsExhausted: (runId: string): Promise<void> => forRunsAccount(runId, (client, accountId) => markCreditsExhaustedWithClient(client, accountId)),
  };
}

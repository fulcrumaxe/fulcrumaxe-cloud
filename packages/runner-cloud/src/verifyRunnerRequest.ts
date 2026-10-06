import type { PoolClient } from "pg";
import {
  HttpSignatureError,
  verifyRunnerRequest as verifySignature,
  type Ed25519Jwk,
  type VerifiedSignature,
} from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";
import { isUsableEd25519Key } from "./strictEd25519.js";
import { MAX_BODY_BYTES, MAX_KEY_AGE_DAYS, NONCE_WINDOW_SECONDS, RunnerHttpError, type RunnerCloudDeps, type RunnerHttpRequest } from "./http.js";

/**
 * D#6 R2a: the one door every `/api/runner/*` request goes through (README.md lists the checks). It refuses an oversize
 * body (413) before any signature work, checks the signature against `origin + path` from configuration (never the Host
 * header), looks the key up on every request (a revoked runner is refused at once), refuses a small-order key and a key
 * over 90 days old, and, for a once-only endpoint, a nonce seen in the last 2 minutes. The tenant is the runner's own row.
 * Only a `VerifiedRunner` returned from here can be given to `withRunnerSession`.
 */

export interface VerifiedRunner {
  readonly runnerId: string;
  readonly accountId: string;
  readonly registeredBy: string;
  readonly credentialMode: string;
  /** The thumbprint of the key the request was verified against. */
  readonly jkt: string;
}

const minted = new WeakSet<object>();

function mint(runner: VerifiedRunner): VerifiedRunner {
  const frozen = Object.freeze({ ...runner });
  minted.add(frozen);
  return frozen;
}

interface RunnerRow {
  id: string;
  account_id: string;
  registered_by: string;
  credential_mode: string;
  public_key_jwk: Ed25519Jwk;
  jkt: string;
  created_at: Date;
  key_rotated_at: Date | null;
}

const UNAUTHORIZED = (): RunnerHttpError => new RunnerHttpError(401, "unauthorized", "the request is not signed by a registered runner");

/** The URL the signature must have been made for. Throws 503 when the origin is not configured. */
export function signedUrl(origin: string | undefined, path: string): string {
  let parsed: URL;
  try {
    parsed = new URL(origin ?? "");
  } catch {
    throw new RunnerHttpError(503, "not_configured", "the runner API has no configured origin");
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.pathname !== "/" || parsed.search !== "" || parsed.username !== "") {
    throw new RunnerHttpError(503, "not_configured", "the runner API has no configured origin");
  }
  return `${parsed.origin}${path}`;
}

type KeyResolver = (keyid: string) => Ed25519Jwk | undefined | Promise<Ed25519Jwk | undefined>;

async function checkSignature(deps: RunnerCloudDeps, path: string, req: RunnerHttpRequest, resolveKey: KeyResolver): Promise<VerifiedSignature> {
  if (req.body.byteLength > MAX_BODY_BYTES) throw new RunnerHttpError(413, "body_too_large", "the request body is too large");
  const url = signedUrl(deps.origin, path);
  try {
    return await verifySignature({ method: req.method, url, headers: req.headers, body: req.body }, resolveKey, deps.now?.());
  } catch (error) {
    if (error instanceof HttpSignatureError) throw UNAUTHORIZED();
    throw error;
  }
}

/** Verifies a request signed by an already registered runner. */
export async function verifyRunnerRequest(
  deps: RunnerCloudDeps,
  path: string,
  req: RunnerHttpRequest,
  options: { replay: "once" | "none" },
): Promise<VerifiedRunner> {
  const seen: { row?: RunnerRow } = {};
  const signature = await checkSignature(deps, path, req, async (keyid) => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(keyid)) return undefined;
    const { rows } = await deps.platformOpsPool.query<RunnerRow>(
      `SELECT id, account_id, registered_by, credential_mode, public_key_jwk, jkt, created_at, key_rotated_at
         FROM runners WHERE jkt = $1 AND revoked_at IS NULL`,
      [keyid],
    );
    const found = rows[0];
    if (!found || !isUsableEd25519Key(found.public_key_jwk.x)) return undefined;
    seen.row = found;
    return found.public_key_jwk;
  });
  const row = seen.row;
  if (!row) throw UNAUTHORIZED();

  const now = deps.now?.() ?? new Date();
  const keyAgeMs = now.getTime() - (row.key_rotated_at ?? row.created_at).getTime();
  if (keyAgeMs > MAX_KEY_AGE_DAYS * 86_400_000) {
    throw new RunnerHttpError(401, "reregister_required", "this runner's key is too old; register it again");
  }

  if (options.replay === "once") {
    if (!signature.nonce) throw UNAUTHORIZED();
    const client = await deps.platformOpsPool.connect();
    try {
      await client.query(`DELETE FROM runner_request_nonces WHERE seen_at < now() - make_interval(secs => $1)`, [NONCE_WINDOW_SECONDS]);
      const inserted = await client.query(
        `INSERT INTO runner_request_nonces (account_id, runner_id, nonce) VALUES ($1, $2, $3) ON CONFLICT (runner_id, nonce) DO NOTHING`,
        [row.account_id, row.id, signature.nonce],
      );
      if (inserted.rowCount === 0) throw new RunnerHttpError(409, "nonce_reused", "this request was already received");
    } finally {
      client.release();
    }
  }
  return mint({ runnerId: row.id, accountId: row.account_id, registeredBy: row.registered_by, credentialMode: row.credential_mode, jkt: row.jkt });
}

/**
 * Verifies a request signed by the key it carries (a registration, which has no runner row yet). Returns the key's
 * thumbprint. A small-order or malformed key is refused here as well.
 */
export async function verifySelfSignedRequest(deps: RunnerCloudDeps, path: string, req: RunnerHttpRequest, jwk: Ed25519Jwk): Promise<string> {
  if (!isUsableEd25519Key(jwk.x)) throw new RunnerHttpError(400, "invalid_key", "the public key is not usable");
  const signature = await checkSignature(deps, path, req, (keyid) => (keyid.length === 43 ? jwk : undefined));
  return signature.keyid;
}

/**
 * Runs `fn` in a tenant transaction with `app.runner_id` set to the verified runner's id, for that transaction only. This
 * is the ONLY place that sets it (session and API-token routes never do), which keeps 0712's `runner_rotate_key` and
 * `runner_self_revoke` out of a signed-in member's reach. Anything `verifyRunnerRequest` did not return is refused.
 */
export async function withRunnerSession<T>(pool: RunnerCloudDeps["appUserPool"], runner: VerifiedRunner, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!minted.has(runner)) throw new Error("withRunnerSession: not a verified runner");
  return withTenant(pool, runner.accountId, async (client) => {
    await client.query("SELECT set_config('app.runner_id', $1, true)", [runner.runnerId]);
    return fn(client);
  });
}

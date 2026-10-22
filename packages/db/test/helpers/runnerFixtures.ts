import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

/** A random Ed25519-shaped public JWK and its 43-character thumbprint stand-in. The DB checks shape, not the maths. */
export function fakeKey(): { jwk: { kty: string; crv: string; x: string }; jkt: string } {
  return { jwk: { kty: 'OKP', crv: 'Ed25519', x: randomBytes(32).toString('base64url') }, jkt: randomBytes(32).toString('base64url') };
}

export interface RunnerOverrides {
  id?: string;
  jwk?: unknown;
  jkt?: string;
  credentialMode?: string;
  isolation?: string | null;
  /** Leave the account on the plan it has (a test that reads the plan's spend figures needs a hosted plan). */
  keepPlan?: boolean;
  /** The protocol version the runner declared on hello (`runners.protocol_version`); left NULL (a runner that never said) when absent. A job gated above it is not offered to it. */
  protocolVersion?: number;
}

/** Inserts a runner as the admin role (RLS does not apply to it) and returns its id. */
export async function insertRunner(admin: PoolClient, accountId: string, registeredBy: string, o: RunnerOverrides = {}): Promise<string> {
  const key = fakeKey();
  const id = o.id ?? randomUUID();
  await admin.query(
    `INSERT INTO runners (id, account_id, registered_by, public_key_jwk, jkt, credential_mode, isolation)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
    [id, accountId, registeredBy, JSON.stringify(o.jwk ?? key.jwk), o.jkt ?? key.jkt, o.credentialMode ?? 'subscription', o.isolation ?? null],
  );
  if (o.protocolVersion !== undefined) await admin.query(`UPDATE runners SET protocol_version = $2 WHERE id = $1`, [id, o.protocolVersion]);
  // A seeded account is on a hosted plan, whose runner ceiling is the account's setting under its live runners (D#605 FL-12a). Tests that
  // exercise runners without that ceiling want the runner plan's flat one, so an account that still has the seed's plan moves to it here.
  // A test of the hosted ceiling sets its plan after this call.
  if (!o.keepPlan) await admin.query(`UPDATE accounts SET plan = 'runner' WHERE id = $1 AND plan = 'starter'`, [accountId]);
  return id;
}

export const sha256Hex = (): string => randomBytes(32).toString('hex');

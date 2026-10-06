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
  return id;
}

export const sha256Hex = (): string => randomBytes(32).toString('hex');

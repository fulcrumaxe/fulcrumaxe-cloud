import type { Pool } from 'pg';
import { withTenant } from './withTenant.js';

/**
 * Accessors for env_secret_refs and env_secret_access (D#5 E5b; the database
 * half is migrations/0675). Nothing here accepts, stores or returns a secret
 * value: a ref carries a `reference` (a pointer to where the value is held),
 * and the access ledger carries a name, a host and a count. Input objects are
 * checked for unknown keys, so a caller who passes `value` gets an error
 * instead of a silently dropped field.
 */

export type EnvSecretKind = 'brokered_http' | 'in_sandbox';

export interface EnvSecretRefInput {
  repoId: string;
  name: string;
  kind: EnvSecretKind;
  /** Required for brokered_http, absent for in_sandbox. */
  destinationHost?: string | null;
  reference: string;
}

export interface EnvSecretRef {
  id: string;
  repoId: string;
  name: string;
  kind: EnvSecretKind;
  destinationHost: string | null;
  reference: string;
}

export interface EnvSecretAccessInput {
  runId: string;
  secretName: string;
  destinationHost: string;
  requestCount: number;
}

export interface EnvSecretAccessTotal {
  secretName: string;
  destinationHost: string;
  requestCount: number;
}

type Ctx = { pool: Pool; accountId: string };

const REF_KEYS: ReadonlySet<string> = new Set(['repoId', 'name', 'kind', 'destinationHost', 'reference']);
const ACCESS_KEYS: ReadonlySet<string> = new Set(['runId', 'secretName', 'destinationHost', 'requestCount']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same rules as the reference_is_pointer CHECK in 0675: a scheme from a fixed list, then a path, and no credential shape. */
const REF_POINTER = /^(vault|env|broker):[A-Za-z0-9_./-]{1,200}$/;
/** The run-event redactor's credential shapes (core/events/redact.ts), plus rk_, xox, PEM headers and long runs. */
const REF_CREDENTIAL_SHAPES = new RegExp(
  'vck_[A-Za-z0-9_-]{10,}|ghs_[A-Za-z0-9]{20,}|sk_(?:live|test)_[A-Za-z0-9]{10,}|whsec_[0-9A-Za-z+/=_-]{20,}|fxat_[0-9A-Za-z]{49}|eyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}|gh[pour]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|rk_(?:live|test)_[A-Za-z0-9]{10,}|xox[abp]-[A-Za-z0-9-]{10,}|-----BEGIN|[A-Za-z0-9_+-]{40,}',
);

/** True when `reference` is a pointer (vault:, env: or broker: plus a path) and does not look like a credential. */
export function isSecretReference(reference: string): boolean {
  return REF_POINTER.test(reference) && !REF_CREDENTIAL_SHAPES.test(reference);
}

function rejectUnknownKeys(fn: string, input: object, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new TypeError(`${fn}: unknown field ${JSON.stringify(key)} (secret values are never accepted)`);
  }
}

function assertUuid(fn: string, label: string, value: string): void {
  if (!UUID_RE.test(value)) throw new TypeError(`${fn}: ${label} must be a UUID`);
}

interface RefRow {
  id: string;
  repo_id: string;
  name: string;
  kind: EnvSecretKind;
  destination_host: string | null;
  reference: string;
}

const toRef = (r: RefRow): EnvSecretRef => ({
  id: r.id,
  repoId: r.repo_id,
  name: r.name,
  kind: r.kind,
  destinationHost: r.destination_host,
  reference: r.reference,
});

/** Creates or replaces the named ref for a repo. The kind and host CHECKs are the database's. */
export async function putEnvSecretRef(ctx: Ctx, input: EnvSecretRefInput): Promise<EnvSecretRef> {
  rejectUnknownKeys('putEnvSecretRef', input, REF_KEYS);
  assertUuid('putEnvSecretRef', 'repoId', input.repoId);
  if (REF_CREDENTIAL_SHAPES.test(input.name) || !isSecretReference(input.reference)) {
    throw new TypeError('putEnvSecretRef: name must not look like a credential, and reference must be a vault:, env: or broker: pointer, never a credential');
  }
  return withTenant(ctx.pool, ctx.accountId, async (client) => {
    const res = await client.query<RefRow>(
      `INSERT INTO env_secret_refs (account_id, repo_id, name, kind, destination_host, reference)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)
       ON CONFLICT (account_id, repo_id, name)
       DO UPDATE SET kind = EXCLUDED.kind, destination_host = EXCLUDED.destination_host,
                     reference = EXCLUDED.reference, updated_at = now()
       RETURNING id, repo_id, name, kind, destination_host, reference`,
      [ctx.accountId, input.repoId, input.name, input.kind, input.destinationHost ?? null, input.reference],
    );
    return toRef(res.rows[0]!);
  });
}

/** The repo's secret set, by name. RLS scopes the read; the account filter is a second fence. */
export async function listEnvSecretRefs(ctx: Ctx, repoId: string): Promise<EnvSecretRef[]> {
  assertUuid('listEnvSecretRefs', 'repoId', repoId);
  return withTenant(ctx.pool, ctx.accountId, async (client) => {
    const res = await client.query<RefRow>(
      `SELECT id, repo_id, name, kind, destination_host, reference
         FROM env_secret_refs
        WHERE account_id = $1::uuid AND repo_id = $2::uuid
        ORDER BY name`,
      [ctx.accountId, repoId],
    );
    return res.rows.map(toRef);
  });
}

/** Removes a ref by name; returns whether one existed. */
export async function deleteEnvSecretRef(ctx: Ctx, repoId: string, name: string): Promise<boolean> {
  assertUuid('deleteEnvSecretRef', 'repoId', repoId);
  return withTenant(ctx.pool, ctx.accountId, async (client) => {
    const res = await client.query(
      `DELETE FROM env_secret_refs WHERE account_id = $1::uuid AND repo_id = $2::uuid AND name = $3`,
      [ctx.accountId, repoId, name],
    );
    return (res.rowCount ?? 0) > 0;
  });
}

/** Appends one ledger row: this run made `requestCount` requests with the named secret to the host. */
export async function recordEnvSecretAccess(ctx: Ctx, input: EnvSecretAccessInput): Promise<void> {
  rejectUnknownKeys('recordEnvSecretAccess', input, ACCESS_KEYS);
  assertUuid('recordEnvSecretAccess', 'runId', input.runId);
  if (REF_CREDENTIAL_SHAPES.test(input.secretName)) throw new TypeError('recordEnvSecretAccess: secretName looks like a credential');
  if (!Number.isInteger(input.requestCount) || input.requestCount < 1) {
    throw new RangeError('recordEnvSecretAccess: requestCount must be a positive integer');
  }
  await withTenant(ctx.pool, ctx.accountId, async (client) => {
    await client.query(
      `INSERT INTO env_secret_access (account_id, run_id, secret_name, destination_host, request_count)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5::integer)`,
      [ctx.accountId, input.runId, input.secretName, input.destinationHost, input.requestCount],
    );
  });
}

/** Per (secret, host) request totals for one run. */
export async function listEnvSecretAccess(ctx: Ctx, runId: string): Promise<EnvSecretAccessTotal[]> {
  assertUuid('listEnvSecretAccess', 'runId', runId);
  return withTenant(ctx.pool, ctx.accountId, async (client) => {
    const res = await client.query<{ secret_name: string; destination_host: string; total: string }>(
      `SELECT secret_name, destination_host, sum(request_count)::text AS total
         FROM env_secret_access
        WHERE account_id = $1::uuid AND run_id = $2::uuid
        GROUP BY secret_name, destination_host
        ORDER BY secret_name, destination_host`,
      [ctx.accountId, runId],
    );
    return res.rows.map((r) => ({ secretName: r.secret_name, destinationHost: r.destination_host, requestCount: Number(r.total) }));
  });
}

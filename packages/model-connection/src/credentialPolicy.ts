import type { PoolClient } from 'pg';
import { isKindEnabledWithClient, KILL_SWITCH_REFUSAL_REASON } from './killSwitch.js';
import { hasAcknowledgementWithClient } from './noticeAck.js';
import { isPlanPathKind } from './planKinds.js';
import { isCredentialKind, type CredentialKind } from './types.js';

/**
 * D#221 MC1: the per-backend credential policy (the Spec's credential matrix: backend x credential kind x where the run
 * happens). Checked when a connection is admitted, with the deciding refusal named.
 *
 * Closed on every axis: an unknown backend, an unknown kind or a pairing the matrix does not list is refused, never
 * allowed by default. The plan-based kinds (planKinds.ts) additionally need the kill switch ON and an acknowledgement of
 * the CURRENT notice version for that connection (killSwitch.ts, noticeAck.ts), wherever they run.
 *
 * Rows read as the matrix does:
 *  - claude-code: unchanged, an API key or the gateway key only. Never a plan sign-in.
 *  - codex: the OpenAI API key, the gateway key, a Business/Enterprise access token, and the ChatGPT plan (hosted only: on
 *    a customer's own machine the plan login never reaches us, so there is no stored credential to allow).
 *  - opencode: the gateway key and the OpenAI API key. Any plan sign-in is refused at Launch.
 */
export const CREDENTIAL_BACKENDS = ['claude-code', 'codex', 'opencode'] as const;
export type CredentialBackend = (typeof CREDENTIAL_BACKENDS)[number];

export function isCredentialBackend(value: unknown): value is CredentialBackend {
  return typeof value === 'string' && (CREDENTIAL_BACKENDS as readonly string[]).includes(value);
}

/** Where the run happens: our hosted sandboxes, or the customer's own machine (D#6). */
export type Placement = 'hosted' | 'self_hosted';

const BOTH: readonly Placement[] = ['hosted', 'self_hosted'];
const HOSTED_ONLY: readonly Placement[] = ['hosted'];

const MATRIX: Readonly<Record<CredentialBackend, Readonly<Partial<Record<CredentialKind, readonly Placement[]>>>>> = Object.freeze({
  'claude-code': { ai_gateway: BOTH, anthropic: BOTH },
  codex: { ai_gateway: BOTH, openai_api_key: BOTH, codex_access_token: BOTH, chatgpt_oauth: HOSTED_ONLY },
  opencode: { ai_gateway: BOTH, openai_api_key: BOTH },
});

/** The backend a connection of this kind is for when the caller names none. */
export function defaultBackendFor(kind: CredentialKind): CredentialBackend {
  return kind === 'ai_gateway' || kind === 'anthropic' ? 'claude-code' : 'codex';
}

export type PolicyRefusal = 'unknown_backend' | 'unknown_credential_kind' | 'unknown_placement' | 'credential_not_allowed';
export type AdmitRefusal = PolicyRefusal | typeof KILL_SWITCH_REFUSAL_REASON | 'notice_not_acknowledged';

export type PolicyDecision = { ok: true } | { ok: false; reason: PolicyRefusal };
export type AdmitDecision = { ok: true } | { ok: false; reason: AdmitRefusal };

export interface CredentialPolicyInput {
  backend: string;
  credentialKind: string;
  placement: string;
}

/** The matrix alone: pure, no database. Anything not listed is refused. */
export function checkCredentialPolicy(input: CredentialPolicyInput): PolicyDecision {
  const { backend, credentialKind, placement } = input;
  if (!isCredentialBackend(backend)) return { ok: false, reason: 'unknown_backend' };
  if (!isCredentialKind(credentialKind)) return { ok: false, reason: 'unknown_credential_kind' };
  if (placement !== 'hosted' && placement !== 'self_hosted') return { ok: false, reason: 'unknown_placement' };
  const allowedWhere = MATRIX[backend][credentialKind];
  return allowedWhere?.includes(placement) === true ? { ok: true } : { ok: false, reason: 'credential_not_allowed' };
}

export interface AdmitCredentialInput extends CredentialPolicyInput {
  /** The connection the credential belongs to (the notice acknowledgement is recorded against it). */
  connectionId: string;
}

/**
 * Admission of a credential for a backend: the matrix first, then, for a plan-based kind, the kill switch and the notice
 * acknowledgement. Reads both through `client`, which must be inside the tenant's transaction (the acknowledgement read is
 * RLS-scoped to it). Fails closed at each step and names the first refusal: a switch that is off or missing, or an
 * acknowledgement that is missing, is for another connection, or is of an older notice version, is a refusal.
 * Nothing is written.
 */
export async function admitCredential(client: PoolClient, input: AdmitCredentialInput): Promise<AdmitDecision> {
  const policy = checkCredentialPolicy(input);
  if (!policy.ok) return policy;
  if (!isPlanPathKind(input.credentialKind)) return { ok: true };
  if (!(await isKindEnabledWithClient(client, input.credentialKind))) {
    return { ok: false, reason: KILL_SWITCH_REFUSAL_REASON };
  }
  if (!(await hasAcknowledgementWithClient(client, input.connectionId, input.credentialKind))) {
    return { ok: false, reason: 'notice_not_acknowledged' };
  }
  return { ok: true };
}

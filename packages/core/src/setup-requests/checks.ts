import { ENV_NAME_RE, type SetupRequestCheckKind, type SetupRequestKind } from './kinds.js';
import { ENV_VAR_CHECK_ENVIRONMENT, type CheckReasonCode } from './copy.js';

/**
 * D#598 P8b: the automatic checks a setup request may name. There is one so far, `env_var_present`: is a variable's NAME set on a Vercel
 * project for the production environment. A check answers pass, or one reason code from the fixed list in copy.ts; it never throws, and a
 * provider that cannot be asked is `check_unavailable`, never a pass.
 *
 * It reads names only. The port below has no value in its answer, and {@link envEntriesFromVercelListing} drops every field of the
 * provider's listing except the name and the environments, so a value cannot reach a log, a row or a reply from this file.
 */

export interface VercelEnvEntry {
  name: string;
  /** The environments the variable is set for, as the provider names them (`production`, `preview`, `development`). */
  targets: readonly string[];
}

export type VercelEnvListing = { ok: true; entries: readonly VercelEnvEntry[] } | { ok: false };

/**
 * Where the check gets a project's variable NAMES. `available` is false for a source with no credential behind it: the status line then
 * tells the person the platform cannot check this one, and Mark done is the way on. Production is bound to {@link unavailableVercelEnvSource}
 * until the customer's own Vercel connection is built (P8d binds it).
 */
export interface VercelEnvSource {
  readonly available: boolean;
  listEnvNames(input: { accountId: string; project: string }): Promise<VercelEnvListing>;
}

export const unavailableVercelEnvSource: VercelEnvSource = {
  available: false,
  async listEnvNames() {
    return { ok: false };
  },
};

/**
 * The names and environments in the body of Vercel's project environment-variable listing (`{ envs: [{ key, target, ... }] }`), or null when
 * the body is not that shape. Everything else in an entry (a `value`, an `id`, a type, a comment) is dropped here and nowhere kept.
 */
export function envEntriesFromVercelListing(body: unknown): VercelEnvEntry[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const envs = (body as { envs?: unknown }).envs;
  if (!Array.isArray(envs)) return null;
  const entries: VercelEnvEntry[] = [];
  for (const raw of envs) {
    if (typeof raw !== 'object' || raw === null) return null;
    const { key, target } = raw as { key?: unknown; target?: unknown };
    if (typeof key !== 'string' || !ENV_NAME_RE.test(key)) return null;
    const list = typeof target === 'string' ? [target] : Array.isArray(target) ? target : null;
    if (list === null || !list.every((t) => typeof t === 'string')) return null;
    entries.push({ name: key, targets: list as string[] });
  }
  return entries;
}

export type CheckOutcome = { pass: true } | { pass: false; reason: CheckReasonCode };

export interface CheckableRequest {
  kind: SetupRequestKind;
  checkKind: SetupRequestCheckKind | null;
  /** The project's name. */
  target: string;
  envName: string | null;
}

/** Runs the request's check. `null` means the request names no check this file can run (nothing to do, not a failure). */
export async function runSetupRequestCheck(source: VercelEnvSource, accountId: string, request: CheckableRequest): Promise<CheckOutcome | null> {
  if (request.checkKind !== 'env_var_present' || request.kind !== 'env_var' || request.envName === null) return null;
  let listing: VercelEnvListing;
  try {
    listing = await source.listEnvNames({ accountId, project: request.target });
  } catch {
    // fx-swallow-ok: a provider that cannot be asked is the result (check_unavailable), reported to the person as such, never a pass
    return { pass: false, reason: 'check_unavailable' };
  }
  if (!listing.ok) return { pass: false, reason: 'check_unavailable' };
  const named = listing.entries.filter((e) => e.name === request.envName);
  if (named.length === 0) return { pass: false, reason: 'env_var_missing' };
  if (!named.some((e) => e.targets.includes(ENV_VAR_CHECK_ENVIRONMENT))) return { pass: false, reason: 'env_var_wrong_target' };
  return { pass: true };
}

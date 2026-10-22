import { ENV_NAME_RE, type SetupRequestCheckKind, type SetupRequestKind, type TargetEnvironment } from './kinds.js';
import type { CheckReasonCode } from './copy.js';

/**
 * D#598 P8b: the automatic checks a setup request may name. There is one so far, `env_var_present`: is a variable's NAME set on a Vercel
 * project for the environment the request names (`targetEnvironment`, D#598 P8d). A check answers pass, or one reason code from the fixed list
 * in copy.ts; it never throws, and a provider that cannot be asked is `check_unavailable`, never a pass.
 *
 * It reads names only. The port below has no value in its answer, and {@link parseVercelEnvPage} drops every field of the provider's
 * listing except the name and the environments, so a value cannot reach a log, a row or a reply from this file.
 */

export interface VercelEnvEntry {
  name: string;
  /** The environments the variable is set for, as the provider names them (`production`, `preview`, `development`). */
  targets: readonly string[];
}

/** `skipped` counts listing entries that were malformed and left out (never their content); absent means none. */
/**
 * `reason` on a failure says why the token could not read, when Vercel said so: 401 `token_rejected` (revoked or expired), 403 or 404 `token_cannot_read`
 * (this token cannot see this project). Anything else (timeouts, 5xx, bad bodies) carries none and stays `check_unavailable`.
 */
export type VercelEnvListing = { ok: true; entries: readonly VercelEnvEntry[]; skipped?: number } | { ok: false; reason?: 'token_rejected' | 'token_cannot_read' };

/**
 * Where the check gets a project's variable NAMES. `available` is false for a source with no credential behind it: the status line then
 * tells the person the platform cannot check this one, and Mark done is the way on. Production is bound to a source whose credential lookup
 * answers `unavailable` until the customer's own Vercel connection is built (P8d-2).
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
 * The names and environments in one page of Vercel's project environment-variable listing (`{ envs: [{ key, target, ... }], pagination }`),
 * or null when the body is not that shape. Everything else in an entry (a `value`, an `id`, a type, a comment) is dropped here and nowhere
 * kept. One malformed entry never nulls the page: an entry that is not an object or whose name is not a variable name is skipped and counted;
 * one with a good name and an unreadable `target` is kept with no environments (it is set, but not provably for any) and counted too.
 * `next` is the cursor for the following page, or null on the last.
 */
export function parseVercelEnvPage(body: unknown): { entries: VercelEnvEntry[]; skipped: number; next: number | null } | null {
  if (typeof body !== 'object' || body === null) return null;
  const { envs, pagination } = body as { envs?: unknown; pagination?: unknown };
  if (!Array.isArray(envs)) return null;
  const entries: VercelEnvEntry[] = [];
  let skipped = 0;
  for (const raw of envs) {
    const { key, target } = (typeof raw === 'object' && raw !== null ? raw : {}) as { key?: unknown; target?: unknown };
    if (typeof key !== 'string' || !ENV_NAME_RE.test(key)) {
      skipped += 1;
      continue;
    }
    const list = typeof target === 'string' ? [target] : Array.isArray(target) ? target : null;
    if (list === null || !list.every((t) => typeof t === 'string')) {
      skipped += 1;
      entries.push({ name: key, targets: [] });
      continue;
    }
    entries.push({ name: key, targets: list as string[] });
  }
  const next = typeof pagination === 'object' && pagination !== null ? (pagination as { next?: unknown }).next : null;
  return { entries, skipped, next: typeof next === 'number' && Number.isSafeInteger(next) ? next : null };
}

export type CheckOutcome = { pass: true } | { pass: false; reason: CheckReasonCode };

export interface CheckableRequest {
  kind: SetupRequestKind;
  checkKind: SetupRequestCheckKind | null;
  /** The project's name. */
  target: string;
  envName: string | null;
  /** The environment the variable must be set for. The reason sentence (copy.ts) is given this same field. */
  targetEnvironment: TargetEnvironment;
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
  if (!listing.ok) return { pass: false, reason: listing.reason ?? 'check_unavailable' };
  const named = listing.entries.filter((e) => e.name === request.envName);
  if (named.length === 0) return { pass: false, reason: 'env_var_missing' };
  if (!named.some((e) => e.targets.includes(request.targetEnvironment))) return { pass: false, reason: 'env_var_wrong_target' };
  return { pass: true };
}

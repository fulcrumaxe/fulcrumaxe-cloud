import { appUserPool } from "@fx/api/src/sse/pools.js";
import { bindVercelEnvSource, createVercelEnvSource, type VercelCredentialResolver } from "@fx/core/src/setup-requests/vercelEnvSource";
import { createVercelNamesReader } from "@fx/core/src/setup-requests/vercelNames";
import { createSealedVercelCredentials, envKekSource } from "@fx/model-connection";
import { createPinnedVercelFetch } from "./vercelPinnedFetch";

/**
 * D#598 P8d-1: where the setup-request env-var check gets a Vercel project's variable NAMES in production. It is the real HTTP adapter behind
 * an injected credential lookup, going out through the net-guarded, address-pinned fetch (lib/vercelPinnedFetch.ts), never the global one.
 * The lookup is the account's own sealed Vercel token (the "connect Vercel" connection kind, D#598 P8d-2; `createSealedVercelCredentials`). An account
 * with no connection, a rejected one, or a token that cannot be opened gets "unavailable": a request with an env-var check is told "We can't check this
 * one for you" and is resumed by Mark done. There is no platform-wide token and no setting for one. The pool and the key are built on first use, so
 * importing this file needs no database or key; with either missing the source reports itself unconfigured.
 * `bindVercelEnvSource` marks the check sweep pending when the source is able to answer, so requests already waiting get looked at.
 */
let sealed: VercelCredentialResolver | undefined;
const lookup = (): VercelCredentialResolver => (sealed ??= createSealedVercelCredentials({ pool: appUserPool(), kek: envKekSource() }));
const sealedCredentials: VercelCredentialResolver = {
  get configured(): boolean {
    try {
      return lookup().configured;
    } catch {
      // fx-swallow-ok: no database url or a bad key setting means no connection can be read; the source reports itself unconfigured
      return false;
    }
  },
  resolve: (accountId) => lookup().resolve(accountId),
  markRejected: (accountId, ref) => lookup().markRejected!(accountId, ref),
};

export const productionVercelEnvSource = bindVercelEnvSource(createVercelEnvSource({ credentials: sealedCredentials, fetch: createPinnedVercelFetch() }));

/** The fixed code the health detail carries while the source above cannot read anything. */
export const VERCEL_ENV_SOURCE_UNCONFIGURED = "vercel_env_source_unconfigured";

/** D#598 P8d-3a: the team and project names the connection screen shows, read with the same sealed token through the same pinned fetch. */
export const productionVercelNames = createVercelNamesReader({ credentials: sealedCredentials, fetch: createPinnedVercelFetch() });

import { bindVercelEnvSource, createVercelEnvSource, unavailableVercelCredentials } from "@fx/core/src/setup-requests/vercelEnvSource";
import { createPinnedVercelFetch } from "./vercelPinnedFetch";

/**
 * D#598 P8d-1: where the setup-request env-var check gets a Vercel project's variable NAMES in production. It is the real HTTP adapter behind
 * an injected credential lookup, going out through the net-guarded, address-pinned fetch (lib/vercelPinnedFetch.ts), never the global one.
 * The lookup is `unavailableVercelCredentials` until the "connect Vercel" connection kind exists (P8d-2, which replaces that one argument):
 * no account has a token, the source reports itself unavailable, and a request with an env-var check is told "We can't check this one for
 * you" and is resumed by Mark done. There is no platform-wide token and no setting for one.
 * `bindVercelEnvSource` marks the check sweep pending when the source is able to answer, so requests already waiting get looked at.
 */
export const productionVercelEnvSource = bindVercelEnvSource(createVercelEnvSource({ credentials: unavailableVercelCredentials, fetch: createPinnedVercelFetch() }));

/** The fixed code the health detail carries while the source above cannot read anything. */
export const VERCEL_ENV_SOURCE_UNCONFIGURED = "vercel_env_source_unconfigured";

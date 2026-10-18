import { unavailableVercelEnvSource, type VercelEnvSource } from "@fx/core/src/setup-requests/checks";

/**
 * D#598 P8b: where the setup-request env-var check gets a Vercel project's variable NAMES in production. Bound to "unavailable": the
 * customer's own Vercel connection (a sealed token, names only) is a later row (P8d) and replaces this one line. Until then a request
 * with an env-var check is told "We can't check this one for you" and is resumed by Mark done.
 */
export const productionVercelEnvSource: VercelEnvSource = unavailableVercelEnvSource;

/** The fixed code the health detail carries while the source above cannot read anything. */
export const VERCEL_ENV_SOURCE_UNCONFIGURED = "vercel_env_source_unconfigured";

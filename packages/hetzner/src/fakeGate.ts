/**
 * D#845 MC-13a: the two switches that let the Hetzner client talk to the staging fake instead of api.hetzner.cloud. Both are judged from the process
 * environment at call time. The fake is an explicit staging opt-in: staging runs as the Vercel project's production deployment, so VERCEL_ENV cannot tell
 * staging from production; FX_DEPLOY_KIND (the manifest's deploy kind, set to "staging" on the staging project) does.
 */
type Env = Readonly<Record<string, string | undefined>>;

/** True only when FX_MACHINE_PROVIDER_FAKE is exactly "1" and FX_DEPLOY_KIND is exactly "staging". An unset kind is not staging. */
export const fakeProviderAllowed = (env: Env): boolean => env.FX_MACHINE_PROVIDER_FAKE === "1" && env.FX_DEPLOY_KIND === "staging";

/** The misconfiguration /api/health names: the fake variable is set (to anything) on a deployment that is not staging; an unset kind counts as production. */
export const fakeProviderInProduction = (env: Env): boolean => (env.FX_MACHINE_PROVIDER_FAKE ?? "") !== "" && env.FX_DEPLOY_KIND !== "staging";

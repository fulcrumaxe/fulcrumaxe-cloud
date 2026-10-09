/**
 * The gh-proxy's identity settings, read once and checked hard. Every
 * problem throws, so the route denies requests (the route logs and
 * rethrows, see route.ts) instead of running with a weaker setting.
 *
 * - The expected sandbox project id comes from its own variable. It must
 *   never be VERCEL_PROJECT_ID: in the stripped proxy project that names the
 *   proxy project itself, not the project whose sandboxes call it.
 * - The OIDC issuer is pinned to `https://oidc.vercel.com/<VERCEL_TEAM_ID>`:
 *   the team ID form. Sandbox tokens carry the team ID in `iss`, not the
 *   team slug (proven live on staging, 2026-10-03; Vercel's docs write the
 *   placeholder as TEAM_SLUG, which is misleading for these tokens). The
 *   global issuer (`https://oidc.vercel.com`) and a slug-form value are
 *   refused at start with an error naming the variable. The key set must be
 *   that issuer's own `/.well-known/jwks`, so the two cannot drift apart.
 *
 * Source: https://vercel.com/docs/oidc ("Issuer mode") and
 * https://vercel.com/docs/oidc/reference ("OIDC token anatomy"): the key set
 * is the `jwks_uri` of the issuer's `/.well-known/openid-configuration`. The
 * docs do not spell the path out; the live discovery documents of the global
 * issuer and of a team issuer both give `<issuer>/.well-known/jwks`
 * (checked 2026-10-02).
 */

export class ProxyEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProxyEnvError";
  }
}

export interface ProxyOidcEnv {
  jwksUrl: string;
  issuer: string;
  teamId: string;
  sandboxProjectId: string;
}

const TEAM_ISSUER_RE = /^https:\/\/oidc\.vercel\.com\/[a-z0-9][a-z0-9_-]*$/i;

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (!value) throw new ProxyEnvError(`${name} must be set`);
  return value;
}

export function loadProxyOidcEnv(env: Readonly<Record<string, string | undefined>>): ProxyOidcEnv {
  const teamId = required(env, "VERCEL_TEAM_ID");
  const issuer = required(env, "VERCEL_OIDC_ISSUER");
  // The sandbox token's `iss` carries the team ID, not the team slug (proven live on staging
  // 2026-10-03), so the issuer must be exactly that. A slug-form value is a configuration error
  // here, at start, instead of a 401 `oidc_issuer` on every request.
  if (!TEAM_ISSUER_RE.test(issuer)) {
    throw new ProxyEnvError("VERCEL_OIDC_ISSUER must be the team issuer https://oidc.vercel.com/<VERCEL_TEAM_ID>");
  }
  if (issuer !== `https://oidc.vercel.com/${teamId}`) {
    throw new ProxyEnvError(
      "VERCEL_OIDC_ISSUER must end in the value of VERCEL_TEAM_ID (team_..., the team ID form), not the team slug",
    );
  }
  const jwksUrl = required(env, "VERCEL_OIDC_JWKS_URL");
  if (jwksUrl !== `${issuer}/.well-known/jwks`) {
    throw new ProxyEnvError("VERCEL_OIDC_JWKS_URL must be the issuer's /.well-known/jwks");
  }
  return {
    jwksUrl,
    issuer,
    teamId,
    sandboxProjectId: required(env, "FX_GH_PROXY_SANDBOX_PROJECT_ID"),
  };
}

/**
 * The runner path's two settings (D#6 R5a-2c). Unlike the OIDC settings above, a problem here must NOT stop the proxy: the sandbox path keeps
 * working and only the runner path answers 503. So this returns the problem (the setting's NAME, never its value) instead of throwing.
 * The issuer is the cloud origin the tickets name as `iss`; the key set is a JWKS of at most two Ed25519 public keys.
 */
export type RunnerTicketEnv =
  | { ok: true; jwks: unknown; issuer: string }
  | { ok: false; problem: "FX_GIT_TICKET_PUBLIC_JWKS" | "FX_GIT_TICKET_ISSUER" };

export function loadRunnerTicketEnv(env: Readonly<Record<string, string | undefined>>): RunnerTicketEnv {
  const issuer = env.FX_GIT_TICKET_ISSUER;
  let issuerOk = false;
  if (issuer) {
    try {
      issuerOk = new URL(issuer).origin === issuer;
    } catch {
      // fx-swallow-ok: a value that is not a URL is reported below by the setting's name
    }
  }
  if (!issuerOk || issuer === undefined) return { ok: false, problem: "FX_GIT_TICKET_ISSUER" };
  const raw = env.FX_GIT_TICKET_PUBLIC_JWKS;
  if (!raw) return { ok: false, problem: "FX_GIT_TICKET_PUBLIC_JWKS" };
  try {
    return { ok: true, jwks: JSON.parse(raw) as unknown, issuer };
  } catch {
    // fx-swallow-ok: a value that is not JSON is reported by the setting's name
    return { ok: false, problem: "FX_GIT_TICKET_PUBLIC_JWKS" };
  }
}

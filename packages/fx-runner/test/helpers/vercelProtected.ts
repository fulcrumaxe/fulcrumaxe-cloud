/**
 * The real answer of a Vercel project with Deployment Protection, captured from staging on 2026-10-09 for `POST /api/runner/register`
 * sent without a bypass: HTTP 401, `content-type: application/json`, this body. The long values (the SSO callback address, the `mcp`
 * hint) are shortened here the way they were when recorded; nothing the detection reads is shortened.
 */
export const VERCEL_PROTECTED_BODY = {
  error: { code: "401", message: "Protected deployment" },
  protection: {
    vercel_auth_enabled: true,
    vercel_auth_callback: "https://vercel.com/sso-api?url=https%3A%2F%2Fcloud-staging.example.vercel.app%2Fapi%2Frunner%2Fregister",
    auto_vercel_auth_redirect: true,
    password_enabled: false,
  },
  mcp: "This deployment is protected; ask the owner for access or a bypass.",
} as const;

/**
 * The shape of the protection answer to `GET /` (HTTP 401, JSON): five top-level keys, `access`, `error`, `mcp`, `message` and
 * `protection`, with `protection.vercel_auth_enabled` true and `error.message` "Protected deployment". Those two fields are the
 * captured ones; the values of `access`, `mcp` and `message` are stand-ins, since the detection reads only the two above.
 */
export const VERCEL_PROTECTED_ROOT_BODY = {
  access: { protected: true, bypass: "x-vercel-protection-bypass" },
  error: { code: "401", message: "Protected deployment" },
  mcp: "This deployment is protected; ask the owner for access or a bypass.",
  message: "Authentication required",
  protection: { vercel_auth_enabled: true, password_enabled: false },
} as const;

/** The same response as a `Response`, headers as the platform sends them. */
export function vercelProtectedResponse(): Response {
  return new Response(JSON.stringify(VERCEL_PROTECTED_BODY), { status: 401, headers: { "content-type": "application/json", server: "Vercel" } });
}

/** Our own cloud's 401 for a revoked runner: also served by Vercel, but a closed snake_case code and no `protection` object. */
export function ownCloud401Response(): Response {
  return new Response(JSON.stringify({ error: { code: "runner_revoked" } }), { status: 401, headers: { "content-type": "application/json", server: "Vercel" } });
}

import { jwtVerify, type JWTVerifyGetKey } from "jose";

/**
 * D#2 H13b, body criterion 3 (first half) / C19 item 5: the proxy verifies
 * the sandbox's `vercel-sandbox-oidc-token` before anything else runs.
 * This module only verifies the token and extracts claims -- it never
 * resolves `sandbox_name` to a run itself (`proxyDecision.ts`'s job, via
 * an injected resolver) and never talks to GitHub.
 *
 * The key resolver (`deps.jwks`) is injected so production uses
 * `createRemoteJWKSet` against Vercel's OIDC issuer, and tests sign a
 * throwaway keypair and verify against `createLocalJWKSet` -- no network
 * call, in production or in tests, happens inside this file itself.
 */

export interface SandboxOidcClaims {
  /** `agent_runs.sandbox_name` -- what the sandbox was launched as. */
  sandboxName: string;
  teamId: string;
  projectId: string;
  issuer: string;
  subject: string;
}

export type OidcVerifyErrorCode = "malformed" | "signature" | "issuer" | "audience" | "claims";

export class OidcVerifyError extends Error {
  readonly code: OidcVerifyErrorCode;
  constructor(code: OidcVerifyErrorCode) {
    // Fixed message, no `cause`, same shape as NetGuardError/
    // GithubForwardHostRefusedError -- never echoes the token or any
    // claim value into an error a caller might log.
    super(`oidcVerify: refused (${code})`);
    this.name = "OidcVerifyError";
    this.code = code;
  }
}

export interface OidcVerifyDeps {
  /** jose key resolver. Production: `createRemoteJWKSet(new URL(...))`. Tests: `createLocalJWKSet(testJwks)`. */
  jwks: JWTVerifyGetKey;
  /** The exact `iss` claim Vercel's sandbox OIDC token must carry for this team. */
  expectedIssuer: string;
  expectedTeamId: string;
  expectedProjectId: string;
  /**
   * D#2 Correction C28 §2: the exact `forwardURL` Vercel's sandbox firewall
   * mints this token's `aud` for -- `githubProxyForwardUrl(config)`, never
   * a separate audience setting. `aud` must be a JSON STRING byte-equal to
   * this value; an array `aud` is refused even when it contains the right
   * value (Vercel's own docs describe a single-value audience, so an array
   * form is never honest, whatever it contains).
   */
  expectedAudience: string;
  clockToleranceSec?: number;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Verifies `token`'s signature and issuer (jose's `jwtVerify`, which also
 * enforces `exp`/`nbf`), then checks `team_id`, `project_id` and the
 * presence of a `sandbox_name` claim itself -- all BEFORE returning
 * anything to the caller. A request whose declared values disagree with
 * the token's own signed claims never gets this far (B1, honest inputs):
 * every field this function returns comes from the verified JWT payload,
 * never from a header or query parameter the caller also sent.
 */
export async function verifySandboxOidcToken(
  token: string,
  deps: OidcVerifyDeps,
): Promise<SandboxOidcClaims> {
  if (!isNonEmptyString(token)) {
    throw new OidcVerifyError("malformed");
  }

  let payload: Record<string, unknown>;
  try {
    const result = await jwtVerify(token, deps.jwks, {
      issuer: deps.expectedIssuer,
      // D#2 C28 §2: pass the expected audience to jose's own claim check
      // too -- defense in depth, and it's what rejects a plain string
      // mismatch (jose throws JWTClaimValidationFailed with claim "aud").
      // It does NOT close the array case by itself: per the JWT spec, jose
      // accepts an `aud` ARRAY that merely *contains* the expected value,
      // which C28 explicitly refuses -- the manual `typeof payload.aud`
      // check below is what actually closes that.
      audience: deps.expectedAudience,
      // Security should-fix: pin the algorithm rather than relying only on
      // JWKS key-type matching (a remote JWKS entry may omit `alg`).
      algorithms: ["RS256"],
      clockTolerance: deps.clockToleranceSec ?? 5,
    });
    payload = result.payload;
  } catch (err) {
    // jose throws a distinct error class for a bad issuer/audience
    // (JWTClaimValidationFailed, which names the failing claim on `.claim`)
    // vs. a bad signature (JWSSignatureVerificationFailed) vs. a malformed
    // compact token (JWSInvalid) -- collapse all of it to "signature"
    // except the two claim cases we can name for sure.
    // Checked by `.code`, NOT `.name`: jose's own JOSEError base class sets
    // `this.name = this.constructor.name` (errors.js), which reads the
    // class's RUNTIME name -- exactly the identifier a bundler's minifier
    // renames. `next build`'s production bundle mangles it to something
    // like "e", so an `err.name === "JWTClaimValidationFailed"` string
    // check silently stops matching in production while passing every
    // unbundled unit test unchanged (caught live, on `next build` +
    // `next start`, not by any vitest run). `.code` is a literal string
    // data property (`static code = "ERR_..."`), never a class-name
    // reference, so it survives minification.
    if (err instanceof Error && (err as Error & { code?: string }).code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
      const claim = (err as Error & { claim?: unknown }).claim;
      throw new OidcVerifyError(claim === "aud" ? "audience" : "issuer");
    }
    throw new OidcVerifyError("signature");
  }

  const teamId = payload["team_id"];
  const projectId = payload["project_id"];
  const sandboxName = payload["sandbox_name"];
  const subject = payload["sub"];
  const issuer = payload["iss"];
  const audience = payload["aud"];

  // D#2 C28 §2: `aud` must be a JSON STRING byte-equal to the expected
  // forwardURL. `jwtVerify`'s own `audience` option above already rejects
  // a missing or plain-string-mismatched `aud` -- this closes the one gap
  // it leaves open by design: an array `aud` that CONTAINS the right
  // value, which the JWT spec (and so jose) treats as a match but C28
  // does not, because Vercel documents a single-value audience only.
  if (typeof audience !== "string" || audience !== deps.expectedAudience) {
    throw new OidcVerifyError("audience");
  }

  if (!isNonEmptyString(teamId) || teamId !== deps.expectedTeamId) {
    throw new OidcVerifyError("audience");
  }
  if (!isNonEmptyString(projectId) || projectId !== deps.expectedProjectId) {
    throw new OidcVerifyError("audience");
  }
  if (!isNonEmptyString(sandboxName) || !isNonEmptyString(subject) || !isNonEmptyString(issuer)) {
    throw new OidcVerifyError("claims");
  }

  return { sandboxName, teamId, projectId, issuer, subject };
}

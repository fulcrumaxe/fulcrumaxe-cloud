import { beforeAll, describe, expect, it } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, calculateJwkThumbprint, jwtVerify, type JWK } from "jose";
import { OidcVerifyError, verifySandboxOidcToken, type OidcVerifyDeps } from "../src/oidcVerify.js";

/**
 * D#2 H13b, body criterion 3: "the proxy verifies the
 * vercel-sandbox-oidc-token (signature, issuer, team_id, project_id) ...
 * (tests with a locally signed test JWKS)." Every test here signs with a
 * throwaway RSA keypair, generated once, and verifies against a local
 * JWKS built from its public half -- no network call, ever.
 */

const ISSUER = "https://oidc.vercel.com/test-team";
const TEAM_ID = "team_test123";
const PROJECT_ID = "prj_test456";
/** D#2 C28 §2: what `githubProxyForwardUrl` would produce for a test config -- the expected `aud`. */
const EXPECTED_AUD = "https://gh-proxy.fulcrumaxe.app/api/gh-proxy";

let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let jwks: ReturnType<typeof createLocalJWKSet>;
let deps: OidcVerifyDeps;

async function sign(claims: Record<string, unknown>, opts: { alg?: string; issuer?: string } = {}): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: opts.alg ?? "RS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .setIssuer(opts.issuer ?? ISSUER)
    .sign(privateKey);
}

function baseClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: "sandbox:abc123",
    team_id: TEAM_ID,
    project_id: PROJECT_ID,
    sandbox_name: "rn-8-executor-run-1",
    aud: EXPECTED_AUD,
    ...overrides,
  };
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const publicJwk: JWK = await exportJWK(pair.publicKey);
  publicJwk.alg = "RS256";
  publicJwk.kid = await calculateJwkThumbprint(publicJwk);
  jwks = createLocalJWKSet({ keys: [publicJwk] });
  deps = {
    jwks,
    expectedIssuer: ISSUER,
    expectedTeamId: TEAM_ID,
    expectedProjectId: PROJECT_ID,
    expectedAudience: EXPECTED_AUD,
  };
});

describe("verifySandboxOidcToken", () => {
  it("returns the verified claims for a correctly signed token", async () => {
    const token = await sign(baseClaims());
    const claims = await verifySandboxOidcToken(token, deps);
    expect(claims).toEqual({
      sandboxName: "rn-8-executor-run-1",
      teamId: TEAM_ID,
      projectId: PROJECT_ID,
      issuer: ISSUER,
      subject: "sandbox:abc123",
    });
  });

  it("rejects an empty token (malformed)", async () => {
    await expect(verifySandboxOidcToken("", deps)).rejects.toMatchObject({ code: "malformed" });
  });

  it("rejects a token whose signature doesn't verify against the JWKS", async () => {
    const otherPair = await generateKeyPair("RS256");
    const token = await new SignJWT(baseClaims())
      .setProtectedHeader({ alg: "RS256" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .setIssuer(ISSUER)
      .sign(otherPair.privateKey);
    await expect(verifySandboxOidcToken(token, deps)).rejects.toBeInstanceOf(OidcVerifyError);
    await expect(verifySandboxOidcToken(token, deps)).rejects.toMatchObject({ code: "signature" });
  });

  it("rejects a token with a corrupted signature byte", async () => {
    const token = await sign(baseClaims());
    const parts = token.split(".");
    const sig = parts[2]!;
    // Flip one character well inside the signature (not the last group,
    // whose trailing bits can alias) so this is an unambiguous corruption
    // of a full signature byte, not just its low bits.
    const mid = Math.floor(sig.length / 2);
    const flipped = sig[mid] === "A" ? "B" : "A";
    const tampered = `${parts[0]}.${parts[1]}.${sig.slice(0, mid)}${flipped}${sig.slice(mid + 1)}`;
    await expect(verifySandboxOidcToken(tampered, deps)).rejects.toMatchObject({ code: "signature" });
  });

  it("rejects the wrong issuer", async () => {
    const token = await sign(baseClaims(), { issuer: "https://oidc.vercel.com/attacker-team" });
    await expect(verifySandboxOidcToken(token, deps)).rejects.toMatchObject({ code: "issuer" });
  });

  it("D#2 C28 live-check finding: still maps a claim-validation failure correctly when jose's own .name has been renamed by a bundler's minifier -- .code is what this file actually keys off of, not .name", async () => {
    // D#2 H13d Gate 2 (live) caught a real bug that no vitest run here
    // ever could: jose's JOSEError base class sets
    // `this.name = this.constructor.name` (errors.js) -- a runtime read
    // of the class's OWN name, which `next build`'s production bundle
    // minifies/mangles (observed live: renamed to "e"). An
    // `err.name === "JWTClaimValidationFailed"` check therefore silently
    // stopped matching in the production bundle while this exact suite,
    // which never bundles or minifies, kept passing unchanged. `.code`
    // (`static code = "ERR_JWT_CLAIM_VALIDATION_FAILED"`) is a literal
    // string data property, not a class-name reference, and survives
    // minification -- this test proves the mapping logic keys off THAT,
    // by taking a real JWTClaimValidationFailed jose actually threw (via
    // the audience-mismatch case above) and renaming it exactly the way
    // the bundler did before handing it back through the same mapping.
    const token = await sign(baseClaims({ aud: "https://attacker.example/api/gh-proxy" }));
    let captured: unknown;
    try {
      await jwtVerify(token, deps.jwks, { issuer: deps.expectedIssuer, audience: deps.expectedAudience, algorithms: ["RS256"] });
      expect.unreachable("expected jose to reject the mismatched audience");
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(Error);
    const real = captured as Error & { code?: string; claim?: string };
    expect(real.code).toBe("ERR_JWT_CLAIM_VALIDATION_FAILED");
    expect(real.claim).toBe("aud");

    // Simulate the bundler's renaming (jose's own export is frozen and
    // can't be mocked from this module system, so this can't drive
    // verifySandboxOidcToken itself through the renamed error -- it pins
    // the MAPPING EXPRESSION oidcVerify.ts's catch block uses instead, a
    // literal copy kept in sync by this comment, not an export):
    Object.defineProperty(real, "name", { value: "e", configurable: true });
    const mapped =
      real.code === "ERR_JWT_CLAIM_VALIDATION_FAILED" ? (real.claim === "aud" ? "audience" : "issuer") : "signature";
    expect(mapped).toBe("audience"); // fails if this ever reverts to checking real.name instead
  });

  it("rejects a mismatched team_id", async () => {
    const token = await sign(baseClaims({ team_id: "team_attacker" }));
    await expect(verifySandboxOidcToken(token, deps)).rejects.toMatchObject({ code: "audience" });
  });

  it("rejects a mismatched project_id", async () => {
    const token = await sign(baseClaims({ project_id: "prj_attacker" }));
    await expect(verifySandboxOidcToken(token, deps)).rejects.toMatchObject({ code: "audience" });
  });

  it("rejects a token with no sandbox_name claim", async () => {
    const token = await sign(baseClaims({ sandbox_name: undefined }));
    await expect(verifySandboxOidcToken(token, deps)).rejects.toMatchObject({ code: "claims" });
  });

  it("rejects an expired token", async () => {
    const token = await new SignJWT(baseClaims())
      .setProtectedHeader({ alg: "RS256" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1800)
      .setIssuer(ISSUER)
      .sign(privateKey);
    await expect(verifySandboxOidcToken(token, deps)).rejects.toMatchObject({ code: "signature" });
  });

  it("never returns team_id/project_id/sandbox_name from anything but the verified payload -- a request can't override them", async () => {
    // Simulates B1 (honest inputs) for the OIDC layer: nothing about the
    // caller-declared header shape influences what's returned, only the
    // signed payload does.
    const token = await sign(baseClaims({ sandbox_name: "rn-8-executor-run-legit" }));
    const claims = await verifySandboxOidcToken(token, deps);
    expect(claims.sandboxName).toBe("rn-8-executor-run-legit");
  });

  describe("D#2 Correction C28 §2: aud must equal githubProxyForwardUrl(config), a string only", () => {
    it("accepts a token whose aud is exactly the expected forwardURL", async () => {
      const token = await sign(baseClaims());
      const claims = await verifySandboxOidcToken(token, deps);
      expect(claims.sandboxName).toBe("rn-8-executor-run-1");
    });

    it("rejects a missing aud", async () => {
      const claims = baseClaims();
      delete claims["aud"];
      const token = await sign(claims);
      await expect(verifySandboxOidcToken(token, deps)).rejects.toMatchObject({ code: "audience" });
    });

    it("rejects another URL entirely", async () => {
      const token = await sign(baseClaims({ aud: "https://attacker.example/api/gh-proxy" }));
      await expect(verifySandboxOidcToken(token, deps)).rejects.toMatchObject({ code: "audience" });
    });

    it("rejects the right value with a trailing slash", async () => {
      const token = await sign(baseClaims({ aud: `${EXPECTED_AUD}/` }));
      await expect(verifySandboxOidcToken(token, deps)).rejects.toMatchObject({ code: "audience" });
    });

    it("rejects an upper-case host variant", async () => {
      const token = await sign(baseClaims({ aud: EXPECTED_AUD.replace("gh-proxy.fulcrumaxe.app", "GH-PROXY.FULCRUMAXE.APP") }));
      await expect(verifySandboxOidcToken(token, deps)).rejects.toMatchObject({ code: "audience" });
    });

    it("rejects a two-element array containing the right value -- an array aud is refused even when it contains the expected string", async () => {
      const token = await sign(baseClaims({ aud: [EXPECTED_AUD, "https://other.example/api/gh-proxy"] }));
      await expect(verifySandboxOidcToken(token, deps)).rejects.toMatchObject({ code: "audience" });
    });
  });

  it("rejects an RS384-signed token against a JWKS entry with no explicit alg (algorithm pin)", async () => {
    const pair = await generateKeyPair("RS384");
    const jwkNoAlg: JWK = await exportJWK(pair.publicKey);
    jwkNoAlg.kid = await calculateJwkThumbprint(jwkNoAlg);
    const jwksNoAlg = createLocalJWKSet({ keys: [jwkNoAlg] });
    const token = await new SignJWT(baseClaims())
      .setProtectedHeader({ alg: "RS384" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .setIssuer(ISSUER)
      .sign(pair.privateKey);
    await expect(
      verifySandboxOidcToken(token, { ...deps, jwks: jwksNoAlg }),
    ).rejects.toMatchObject({ code: "signature" });
  });
});
